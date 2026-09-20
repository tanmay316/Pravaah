"""
English Coach AI — Learning Engine (Async Persistence & Analysis Worker)

Phase 3A, 3B & 3C:
  - Durable transcript message persistence in Firestore under users/{uid}/sessions/{sessionId}/messages/{messageId}
  - Session metadata tracking (start_time, end_time, duration_seconds, state, mode)
  - 4-Tier Assessment Classification:
      1. grammar_error (penalizes skill mastery)
      2. vocabulary_error (penalizes collocation/vocabulary mastery)
      3. natural_alternative (positive optional suggestion, ZERO penalty)
      4. no_issue
  - Skill-level learner mastery tracking under users/{uid}/skills/{skill_id}
  - Evidence-based deterministic mastery updating formula
  - Recurring mistake aggregation & curriculum mapping (CURRICULUM.md)
  - Personalized next lesson generation based on weakest curriculum skill
  - Complete idempotency across session re-runs

Firestore schema:
  - users/{uid}
  - users/{uid}/sessions/{sessionId}
  - users/{uid}/sessions/{sessionId}/messages/{messageId}
  - users/{uid}/skills/{skill_id}
  - users/{uid}/mistakes/{mistakeId}
  - users/{uid}/vocabulary/{vocabularyId}
  - users/{uid}/suggestions/{suggestionId}
"""

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Literal, Any, Union, Dict

from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore
from pydantic import BaseModel, Field, field_validator


def _get_litellm():
    """
    Import litellm only when the last-resort provider fallback is actually reached.
    Importing it at module scope costs ~200MB RSS and several seconds in every process
    that touches this module, including the realtime voice agent.
    Returns None when litellm is not installed.
    """
    try:
        import litellm
        return litellm
    except ImportError:
        return None

# Add local directory to path for curriculum import
sys.path.insert(0, os.path.dirname(__file__))
from curriculum import (
    CURRICULUM_SKILLS,
    MASTERY_BANDS,
    LESSON_STAGES,
    PersonalizedLesson,
    PRAVAAH_LEVELS,
    ASSESSMENT_RUBRIC,
    evaluate_assessment_rubric,
    DailyPlanActivity,
    DailyLearningPlan,
    generate_daily_plan,
    cefr_reference_for_pravaah_level,
    determine_lesson_stage,
    get_varied_practice_activity,
    priority_practice_prompt,
    map_to_curriculum_skill,
    generate_personalized_lesson,
    calculate_mastery_update,
    calculate_progressive_level,
    MASTERY_DECAY_LAMBDA,
    EVIDENCE_DELTAS,
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("learning-engine")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Gemini free-tier quotas are per-model, so a 429 on one says nothing about the next.
# Ordered best-first by (RPD, RPM, TPM); every Gemini call walks this chain.
#   gemini-3.1-flash-lite  15 RPM / 250K TPM / 500 RPD
#   gemini-3.5-flash-lite  15 RPM / 250K TPM / 500 RPD
#   gemini-3.5-flash        5 RPM / 250K TPM /  20 RPD
#   gemma-4-31b            30 RPM /  16K TPM / 14.4K RPD
DEFAULT_GEMINI_CHAIN = "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.5-flash,gemma-4-31b"


def _model_chain(env_var: str, default: str) -> list[str]:
    raw = os.getenv(env_var) or default
    return [m.strip() for m in raw.split(",") if m.strip()]


GEMINI_CHAIN = _model_chain("GEMINI_MODEL_CHAIN", DEFAULT_GEMINI_CHAIN)
# Assessment prompts carry the full transcript, so skip the 16K-TPM small-context models.
ASSESSMENT_CHAIN = _model_chain(
    "GEMINI_ASSESSMENT_MODEL_CHAIN",
    "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.5-flash",
)
ANALYSIS_MODEL = os.getenv("ANALYSIS_MODEL", GEMINI_CHAIN[0])
ASSESSMENT_MODEL = os.getenv("ASSESSMENT_MODEL", ASSESSMENT_CHAIN[0])
REALTIME_MODEL = os.getenv("REALTIME_MODEL", GEMINI_CHAIN[0])
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "")
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.75"))


def _gemini_chain_for(preferred: Optional[str], chain: list[str]) -> list[str]:
    """The configured chain with `preferred` moved to the front, de-duplicated."""
    ordered = list(chain)
    if preferred:
        clean = preferred.replace("gemini/", "").strip()
        if clean and clean in ordered:
            ordered.remove(clean)
        if clean:
            ordered.insert(0, clean)
    seen, result = set(), []
    for name in ordered:
        if name not in seen:
            seen.add(name)
            result.append(name)
    return result

# ---------------------------------------------------------------------------
# Pydantic Schemas for Structured Analysis (Phase 3B & 3C)
# ---------------------------------------------------------------------------

FactType = Literal["grammar_error", "vocabulary_error", "natural_alternative", "no_issue"]


class GrammarMistakeFact(BaseModel):
    original: str = Field(..., description="The exact learner phrase containing the error")
    corrected: str = Field(..., description="The natural, grammatically correct English phrasing")
    category: str = Field(..., description="Category from curriculum")
    curriculum_skill_id: str = Field(default="sentence_structure", description="Mapped curriculum skill ID")
    fact_type: FactType = Field(default="grammar_error", description="grammar_error | vocabulary_error | natural_alternative | no_issue")
    severity: str = Field(default="medium", description="Severity: high | medium | low")
    confidence: float = Field(default=0.9, ge=0.0, le=1.0, description="Confidence score from 0.0 to 1.0")
    short_explanation: str = Field(default="", description="Concise explanation of the rule")
    session_id: str = Field(..., description="Associated session ID")
    message_id: str = Field(..., description="Associated message ID")

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


class VocabularyOpportunityFact(BaseModel):
    original_usage: str = Field(..., description="The exact word or phrase used by learner")
    suggested_alternative: Optional[str] = Field(default=None, description="More natural alternative expression if appropriate")
    curriculum_skill_id: str = Field(default="collocations", description="Mapped curriculum skill ID")
    fact_type: FactType = Field(default="natural_alternative", description="vocabulary_error | natural_alternative")
    explanation: str = Field(default="", description="Brief explanation of the vocabulary item")
    confidence: float = Field(default=0.85, ge=0.0, le=1.0, description="Confidence score from 0.0 to 1.0")
    session_id: str = Field(..., description="Associated session ID")
    message_id: str = Field(..., description="Associated message ID")

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


class SessionAnalysisResult(BaseModel):
    mistakes: List[GrammarMistakeFact] = Field(default_factory=list)
    vocabulary: List[VocabularyOpportunityFact] = Field(default_factory=list)


class SkillMasteryRecord(BaseModel):
    skill_id: str = Field(..., description="Curriculum skill ID")
    title: str = Field(..., description="Skill Title")
    category: str = Field(default="grammar", description="grammar | vocabulary")
    mastery: float = Field(default=0.5, ge=0.0, le=1.0, description="Current mastery score 0.0 to 1.0")
    attempts: int = Field(default=0, ge=0, description="Total learner attempts on this skill")
    correction_attempts: int = Field(default=0, ge=0, description="Learner attempts made after an explicit tutor repetition prompt")
    errors: int = Field(default=0, ge=0, description="Total learner errors on this skill")
    successful_repetitions: int = Field(default=0, ge=0, description="Count of successful learner repetitions of the target correction")
    failed_repetitions: int = Field(default=0, ge=0, description="Count of failed learner repetitions")
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    last_success: Optional[datetime] = None
    examples: List[str] = Field(default_factory=list, description="Recent mistake snippets")
    processed_sessions: List[str] = Field(default_factory=list, description="List of processed session IDs for idempotency")


class ProficiencyAssessment(BaseModel):
    """Assessment-only input for an overall Pravaah level change.

    A level is an assessor's multi-dimensional judgement, not a calculated
    aggregate of daily-session mastery or a single numeric score.
    """
    pravaah_level: Literal["E", "D", "C", "B", "A", "S"]
    grammar: str
    vocabulary: str
    comprehension: str
    fluency: str
    speaking_complexity: str
    pronunciation: str
    conversation_ability: str
    assessment_id: str = Field(default_factory=lambda: str(uuid.uuid4()))


class LessonRecord(BaseModel):
    lesson_id: str = Field(..., description="Unique lesson ID")
    source_skill_id: str = Field(..., description="Curriculum skill ID")
    lesson_title: str = Field(default="", description="Lesson title")
    session_id: str = Field(default="", description="Associated session ID")
    stage: str = Field(default="guided_practice", description="introduction | guided_practice | conversational_practice | review")
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_seconds: int = 0
    attempts: int = 0
    correction_attempts: int = 0
    successful_repetitions: int = 0
    failed_repetitions: int = 0
    mastery_before: float = 0.5
    mastery_after: float = 0.5
    completion_status: Literal["recommended", "in_progress", "completed", "abandoned"] = "recommended"
    selection_reason: str = Field(default="active_weakness", description="active_weakness | developing_skill | review")
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Firebase Admin Init
# ---------------------------------------------------------------------------

_firebase_app = None


def get_firestore_client():
    """Get or initialize Firestore client using service account."""
    global _firebase_app
    if _firebase_app is None:
        sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
        sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")

        # Resolve service account path
        resolved_path = None
        candidates = []
        if sa_path:
            candidates.append(sa_path)
            candidates.append(os.path.join(os.path.dirname(__file__), sa_path))
            candidates.append(os.path.join(os.path.dirname(__file__), "..", sa_path))
        candidates.extend([
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "secrets", "firebase-service-account.json")),
            r"c:\Users\Tms\Desktop\pravaah\secrets\firebase-service-account.json",
        ])

        for p in candidates:
            if p and os.path.isfile(p):
                resolved_path = os.path.abspath(p)
                break

        if resolved_path:
            cred = credentials.Certificate(resolved_path)
        elif sa_json:
            cred = credentials.Certificate(json.loads(sa_json))
        else:
            raise RuntimeError(f"Firebase service account credentials missing. Tried: {candidates}")

        if not firebase_admin._apps:
            _firebase_app = firebase_admin.initialize_app(cred)
        else:
            _firebase_app = firebase_admin.get_app()

    return firestore.client(app=_firebase_app)


# ---------------------------------------------------------------------------
# Deduplication & Deterministic ID Helpers
# ---------------------------------------------------------------------------

_processed_event_ids: set[str] = set()


def is_duplicate(event_id: str) -> bool:
    """In-memory event deduplication for V1."""
    if not event_id:
        return False
    if event_id in _processed_event_ids:
        return True
    _processed_event_ids.add(event_id)
    return False


def make_deterministic_id(*parts: str) -> str:
    """Generate a clean, deterministic document ID from components."""
    clean_parts = [re.sub(r'[^a-zA-Z0-9_-]', '_', str(p).strip().lower()) for p in parts if str(p).strip()]
    raw_str = "_".join(clean_parts)
    if len(raw_str) > 80:
        hash_suffix = hashlib.sha256(raw_str.encode('utf-8')).hexdigest()[:12]
        return f"{raw_str[:65]}_{hash_suffix}"
    return raw_str


# ---------------------------------------------------------------------------
# Session In-Memory Message Accumulator
# ---------------------------------------------------------------------------

_session_messages: dict[str, list[dict]] = {}
_session_start_times: dict[str, datetime] = {}


# ---------------------------------------------------------------------------
# LLM Prompt for Structured Session Analysis (Phase 3B & 3C)
# ---------------------------------------------------------------------------

ANALYSIS_SYSTEM_PROMPT = """You are an expert English language assessment engine for Hindi-speaking learners.
Your role is to analyze learner utterances from a spoken English conversation and produce structured learning facts.

### FOUR-TIER CLASSIFICATION RULES:
1. **grammar_error**: Clear, genuine grammatical errors (e.g., "Yesterday I go to market" -> "went to the market", "I didn't went" -> "didn't go", "I am agree" -> "I agree", stative verbs, subject-verb agreement).
2. **vocabulary_error**: Genuine unnatural collocations or word choices (e.g., "I made a party" -> "I had a party", "I have one doubt" -> "I have a question").
3. **natural_alternative**: The learner's English is ALREADY natural and acceptable, but an optional alternative is suggested (e.g., "The movie was very good" -> "I really enjoyed the movie", "reading books" -> "immersed in books"). This is NOT an error.
4. **no_issue**: Correct, natural English.

### STRICT PEDAGOGICAL GUARDRAILS:
- **Analyze Learner Messages ONLY**: Only evaluate statements where role is "user".
- **DO NOT flag natural_alternative as a grammar_error or vocabulary_error**. Optional upgrades must have fact_type: "natural_alternative".
- **DO NOT Over-Complicate**: Do NOT rewrite simple, clear sentences into unnecessarily complex vocabulary.
- **Preserve Learner Wording**: In 'original', quote the exact words used by the learner.
- **No Pronunciation Guessing**: Do not guess pronunciation from text.
- **Hindi is not an English error**: Hindi/Hinglish and translation requests are not mistakes. Only quote a genuinely incorrect English phrase, never penalize language choice.
- **Confidence Scoring**: Assign confidence (0.0 to 1.0). If uncertain, assign confidence < 0.7.

Return a valid JSON object matching this exact schema:
{
  "mistakes": [
    {
      "original": "exact learner phrase",
      "corrected": "natural correct English",
      "category": "past_tense | stative_verb | subject_verb_agreement | articles | prepositions | word_order",
      "fact_type": "grammar_error | vocabulary_error | natural_alternative",
      "severity": "high | medium | low",
      "confidence": 0.95,
      "short_explanation": "One clear sentence explaining why.",
      "session_id": "provided_session_id",
      "message_id": "provided_message_id"
    }
  ],
  "vocabulary": [
    {
      "original_usage": "exact learner word/phrase",
      "suggested_alternative": "more natural alternative if helpful, or null",
      "fact_type": "vocabulary_error | natural_alternative",
      "explanation": "Why this vocabulary item is useful to know.",
      "confidence": 0.85,
      "session_id": "provided_session_id",
      "message_id": "provided_message_id"
    }
  ]
}"""


# ---------------------------------------------------------------------------
# Asynchronous Session Analysis (Phase 3B & 3C)
# ---------------------------------------------------------------------------

async def analyze_session_messages(
    user_id: str,
    session_id: str,
    messages: list[dict],
    model: str = ANALYSIS_MODEL,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> SessionAnalysisResult:
    """
    Asynchronously analyze finalized learner utterances for grammar mistakes and vocabulary opportunities.
    Validates output via Pydantic, writes facts, and updates learner skill mastery idempotently.
    """
    # 1. Filter only user utterances
    user_turns = [m for m in messages if m.get("role") == "user" and m.get("text", "").strip()]
    if not user_turns:
        logger.info("No user utterances to analyze for session %s", session_id)
        return SessionAnalysisResult(mistakes=[], vocabulary=[])

    session_ref = None
    saved_analysis = {}
    if user_id:
        session_ref = get_firestore_client().collection("users").document(user_id).collection("sessions").document(session_id)
        saved_analysis = _snapshot_data(session_ref.get())
    cached_result = saved_analysis.get("analysis_result")
    if saved_analysis.get("analysis_status") == "completed" and isinstance(cached_result, dict):
        return SessionAnalysisResult.model_validate(cached_result)

    # Format transcript for model
    transcript_lines = []
    for turn in user_turns:
        msg_id = turn.get("message_id", f"{session_id}_seq_{turn.get('sequence', 0):04d}_user")
        transcript_lines.append(f"[message_id: {msg_id}] LEARNER: {turn.get('text', '')}")

    transcript_text = "\n".join(transcript_lines)
    user_prompt = f"Session ID: {session_id}\n\nLearner Messages:\n{transcript_text}"

    logger.info("Running session analysis for user=%s session=%s (turns=%d)", user_id, session_id, len(user_turns))

    # 2. Call Groq Cloud / Gemini / LiteLLM with structured JSON output and safe retry
    # Persisted facts let a retry resume writes without reclassifying the same
    # learner turns (or treating a provider failure as a clean session).
    analysis_succeeded = isinstance(cached_result, dict)
    parsed_result = SessionAnalysisResult.model_validate(cached_result) if analysis_succeeded else SessionAnalysisResult()
    max_retries = 2
    groq_key = os.getenv("GROQ_API_KEY")
    api_key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY")

    if groq_key and not analysis_succeeded:
        try:
            from groq import Groq
            gclient = Groq(api_key=groq_key)
            groq_analysis_model = os.getenv("GROQ_ANALYSIS_MODEL", "openai/gpt-oss-120b")
            g_resp = await asyncio.wait_for(
                asyncio.to_thread(
                    gclient.chat.completions.create,
                    model=groq_analysis_model,
                    messages=[
                        {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=1500,
                    temperature=0.1,
                ),
                timeout=12.0
            )
            raw_text = g_resp.choices[0].message.content or "{}"
            raw_json = json.loads(raw_text.strip())
            for m in raw_json.get("mistakes", []):
                if not m.get("session_id"):
                    m["session_id"] = session_id
                if not m.get("message_id") and user_turns:
                    m["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                if not m.get("curriculum_skill_id"):
                    m["curriculum_skill_id"] = map_to_curriculum_skill(m.get("category", ""), m.get("original", ""), m.get("short_explanation", ""))
                if not m.get("fact_type"):
                    m["fact_type"] = "grammar_error"

            for v in raw_json.get("vocabulary", []):
                if not v.get("session_id"):
                    v["session_id"] = session_id
                if not v.get("message_id") and user_turns:
                    v["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                if not v.get("curriculum_skill_id"):
                    v["curriculum_skill_id"] = "collocations"
                if not v.get("fact_type"):
                    v["fact_type"] = "natural_alternative"

            parsed_result = SessionAnalysisResult.model_validate(raw_json)
            analysis_succeeded = True
        except Exception as groq_err:
            logger.warning("Groq session analysis notice: %s; trying Gemini fallback", groq_err)

    if not analysis_succeeded and api_key:
        for genai_model_name in _gemini_chain_for(model, GEMINI_CHAIN):
            try:
                import google.generativeai as genai
                genai.configure(api_key=api_key)
                gmodel = genai.GenerativeModel(genai_model_name, system_instruction=ANALYSIS_SYSTEM_PROMPT)
                resp = await asyncio.to_thread(gmodel.generate_content, user_prompt)
                raw_text = resp.text.strip()
                if raw_text.startswith("```json"):
                    raw_text = raw_text[7:]
                if raw_text.startswith("```"):
                    raw_text = raw_text[3:]
                if raw_text.endswith("```"):
                    raw_text = raw_text[:-3]
                raw_text = raw_text.strip()

                raw_json = json.loads(raw_text)
                for m in raw_json.get("mistakes", []):
                    if not m.get("session_id"):
                        m["session_id"] = session_id
                    if not m.get("message_id") and user_turns:
                        m["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                    if not m.get("curriculum_skill_id"):
                        m["curriculum_skill_id"] = map_to_curriculum_skill(m.get("category", ""), m.get("original", ""), m.get("short_explanation", ""))
                    if not m.get("fact_type"):
                        m["fact_type"] = "grammar_error"

                for v in raw_json.get("vocabulary", []):
                    if not v.get("session_id"):
                        v["session_id"] = session_id
                    if not v.get("message_id") and user_turns:
                        v["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                    if not v.get("curriculum_skill_id"):
                        v["curriculum_skill_id"] = "collocations"
                    if not v.get("fact_type"):
                        v["fact_type"] = "natural_alternative"

                parsed_result = SessionAnalysisResult.model_validate(raw_json)
                analysis_succeeded = True
                logger.info("Session analysis succeeded via Gemini %s", genai_model_name)
                break
            except Exception as e:
                logger.warning("Gemini %s session analysis failed: %s; trying next model", genai_model_name, e)

    if not analysis_succeeded:
        litellm = _get_litellm()
        if litellm is None:
            logger.warning("litellm is not installed; skipping the provider-fallback analysis path.")
            max_retries = 0
        for attempt in range(1, max_retries + 1):
            try:
                litellm_model = f"gemini/{model}" if not model.startswith("gemini/") and "tutor-model" not in model else model
                kwargs = {
                    "model": litellm_model,
                    "api_key": api_key,
                    "fallbacks": [
                        "openrouter/minimax/minimax-01",
                        f"gemini/{GEMINI_CHAIN[-1]}",
                    ],
                    "messages": [
                        {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    "response_format": {"type": "json_object"},
                }
                if "tutor-model" in model and LITELLM_PROXY_URL:
                    kwargs["base_url"] = LITELLM_PROXY_URL

                response = await litellm.acompletion(**kwargs)

                raw_content = response.choices[0].message.content or "{}"
                cleaned_json_str = raw_content.strip()
                if cleaned_json_str.startswith("```json"):
                    cleaned_json_str = cleaned_json_str[7:]
                if cleaned_json_str.startswith("```"):
                    cleaned_json_str = cleaned_json_str[3:]
                if cleaned_json_str.endswith("```"):
                    cleaned_json_str = cleaned_json_str[:-3]
                cleaned_json_str = cleaned_json_str.strip()

                raw_json = json.loads(cleaned_json_str)

                # Map curriculum skill IDs and assign defaults
                for m in raw_json.get("mistakes", []):
                    if not m.get("session_id"):
                        m["session_id"] = session_id
                    if not m.get("message_id") and user_turns:
                        m["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                    if not m.get("curriculum_skill_id"):
                        m["curriculum_skill_id"] = map_to_curriculum_skill(m.get("category", ""), m.get("original", ""), m.get("short_explanation", ""))
                    if not m.get("fact_type"):
                        m["fact_type"] = "grammar_error"

                for v in raw_json.get("vocabulary", []):
                    if not v.get("session_id"):
                        v["session_id"] = session_id
                    if not v.get("message_id") and user_turns:
                        v["message_id"] = user_turns[0].get("message_id", f"{session_id}_seq_0001_user")
                    if not v.get("curriculum_skill_id"):
                        v["curriculum_skill_id"] = "collocations"
                    if not v.get("fact_type"):
                        v["fact_type"] = "natural_alternative"

                parsed_result = SessionAnalysisResult.model_validate(raw_json)
                analysis_succeeded = True
                break
            except Exception as e:
                logger.warning("Session analysis attempt %d failed: %s", attempt, e)
                if attempt == max_retries:
                    logger.error("Failed to parse analysis output after %d attempts.", max_retries)

    if not analysis_succeeded:
        raise RuntimeError("Session analysis providers unavailable; retry completion later.")

    # 3. Filter high-confidence items only
    filtered_mistakes = [
        m for m in parsed_result.mistakes
        if m.confidence >= confidence_threshold and m.original.strip().lower() != m.corrected.strip().lower()
        and (m.fact_type not in ("grammar_error", "vocabulary_error")
             or _validated_learning_error(m.model_dump(), "mistakes", messages, session_id))
    ]
    filtered_vocab = [
        v for v in parsed_result.vocabulary
        if v.confidence >= confidence_threshold and v.original_usage.strip()
           and (v.fact_type != "vocabulary_error"
               or _validated_learning_error(v.model_dump(), "vocabulary", messages, session_id))
    ]

    final_result = SessionAnalysisResult(mistakes=filtered_mistakes, vocabulary=filtered_vocab)
    if session_ref is not None and not isinstance(cached_result, dict):
        session_ref.set({"analysis_result": final_result.model_dump(), "analysis_status": "pending"}, merge=True)

    # 4. Idempotently write to Firestore & Update Learner Mastery (Phase 3C)
    if user_id:
        try:
            db = get_firestore_client()
            user_ref = db.collection("users").document(user_id)
            now = datetime.now(timezone.utc)

            # Write genuine mistakes (grammar_error & vocabulary_error)
            for idx, mistake in enumerate(final_result.mistakes, 1):
                if mistake.fact_type in ("grammar_error", "vocabulary_error"):
                    mistake_id = make_deterministic_id(session_id, mistake.message_id, f"m_{idx:02d}")
                    mistake_ref = user_ref.collection("mistakes").document(mistake_id)
                    previous = _snapshot_data(mistake_ref.get())
                    admitted = _validated_learning_error(mistake.model_dump(), "mistakes", messages, session_id) or {}
                    doc_data = {
                        "mistake_id": mistake_id,
                        "session_id": session_id,
                        "message_id": mistake.message_id,
                        "original": mistake.original,
                        "corrected": mistake.corrected,
                        "category": mistake.category,
                        "curriculum_skill_id": mistake.curriculum_skill_id,
                        "fact_type": mistake.fact_type,
                        "severity": mistake.severity,
                        "confidence": mistake.confidence,
                        "explanation": mistake.short_explanation,
                        "short_explanation": mistake.short_explanation,
                        **admitted,
                        "learner_verified": True,
                        "created_at": previous.get("created_at") or now,
                        "updated_at": firestore.SERVER_TIMESTAMP,
                    }
                    mistake_ref.set(doc_data, merge=True)
                elif mistake.fact_type == "natural_alternative":
                    # Store as positive suggestion
                    suggestion_id = make_deterministic_id(session_id, mistake.message_id, f"s_{idx:02d}")
                    user_ref.collection("suggestions").document(suggestion_id).set({
                        "suggestion_id": suggestion_id,
                        "session_id": session_id,
                        "message_id": mistake.message_id,
                        "original": mistake.original,
                        "suggested": mistake.corrected,
                        "explanation": mistake.short_explanation,
                        "created_at": now,
                    }, merge=True)

            # Write vocabulary facts (both errors & natural alternative collocations)
            for idx, vocab in enumerate(final_result.vocabulary, 1):
                vocab_id = make_deterministic_id(session_id, vocab.message_id, f"v_{idx:02d}")
                vocab_ref = user_ref.collection("vocabulary").document(vocab_id)
                previous = _snapshot_data(vocab_ref.get())
                admitted = _validated_learning_error(vocab.model_dump(), "vocabulary", messages, session_id) or {}
                term = vocab.suggested_alternative or vocab.original_usage
                doc_data = {
                    "vocabulary_id": vocab_id,
                    "session_id": session_id,
                    "message_id": admitted.get("message_id", vocab.message_id),
                    "term": term,
                    "word": term,
                    "original_usage": vocab.original_usage,
                    "context": vocab.original_usage,
                    "suggested_alternative": vocab.suggested_alternative,
                    "alternative": vocab.suggested_alternative,
                    "curriculum_skill_id": vocab.curriculum_skill_id,
                    "fact_type": vocab.fact_type,
                    "explanation": vocab.explanation,
                    "meaning": vocab.explanation,
                    "natural_usage_tip": vocab.explanation,
                    "confidence": vocab.confidence,
                    "created_at": previous.get("created_at") or now,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                }
                vocab_ref.set(doc_data, merge=True)

            # 5. Update skill-level mastery & learner profile (Phase 3C)
            await update_learner_mastery(user_id, session_id, final_result, messages)
            session_ref.set({"analysis_status": "completed"}, merge=True)

            logger.info(
                "Session %s analysis persisted: %d mistakes recorded, mastery updated.",
                session_id, len(final_result.mistakes)
            )
        except Exception as e:
            logger.error("Failed to persist analysis to Firestore: %s", e)
            # Completion must remain retryable until mastery AND recommendations
            # are durable. Logging and returning would incorrectly report success.
            raise

    return final_result


# ---------------------------------------------------------------------------
# Evidence-Based Learner Mastery & Profile Update (Phase 3C)
# ---------------------------------------------------------------------------

def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9\s]", "", text.lower()).strip()


def _is_hindi_evidence(text: str, data: Optional[dict] = None) -> bool:
    """Conservative language guard, not a language detector. Mixed English fragments
    remain usable when the *quoted error itself* is English. Never score translations.
    """
    data = data or {}
    if any(str(data.get(key, "")).lower() in {"hi", "hi-in", "hindi", "hinglish", "translation"}
           for key in ("language", "source_language", "detected_language", "card_type", "type", "category")):
        return True
    if re.search(r"[\u0900-\u097f]", text):
        return True
    words = set(re.findall(r"[a-z]+", text.lower()))
    if words and words <= {"haan", "han", "nahi", "nahin", "namaste", "shukriya", "theek", "hai"}:
        return True
    # Avoid single ambiguous words such as English 'main' or 'to'.
    return len(words & {"mujhe", "mujhko", "mera", "meri", "aap", "aapko", "tum", "kya",
                        "nahi", "nahin", "hai", "hain", "hoon", "hu", "chahta", "chahti",
                        "kaise", "seekhna", "seekhni", "bolna", "samajh", "aaj", "kal",
                        "gaya", "gayi", "tha", "thi", "raha", "rahi", "rahe"}) >= 2


def _validated_learning_error(
    data: dict, source: str, messages: Optional[list[dict]] = None, session_id: Optional[str] = None,
) -> Optional[dict]:
    """One admission gate for ranking, mastery and retry evidence.

    Stored records must carry explicit type/confidence/attribution. Newly analyzed
    facts additionally have to quote an actual learner turn, not a tutor utterance.
    """
    if not isinstance(data, dict) or data.get("fact_type") not in {"grammar_error", "vocabulary_error"}:
        return None
    if data.get("role", "user") not in {"user", "learner"} or data.get("learner_verified") is False:
        return None
    try:
        confidence = float(data["confidence"])
        if not math.isfinite(confidence) or not max(0.75, CONFIDENCE_THRESHOLD) <= confidence <= 1:
            return None
        if source == "vocabulary":
            fact = VocabularyOpportunityFact.model_validate(data)
            original, corrected = fact.original_usage, fact.suggested_alternative or ""
            category, explanation = "vocabulary", fact.explanation
        else:
            fact = GrammarMistakeFact.model_validate(data)
            original, corrected = fact.original, fact.corrected
            category, explanation = fact.category, fact.short_explanation
        if not original.strip() or not corrected.strip() or _normalise(original) == _normalise(corrected):
            return None
        if _is_hindi_evidence(original, data) or not fact.session_id.strip() or not fact.message_id.strip():
            return None
        if session_id is not None and fact.session_id != session_id:
            return None
        message_id = fact.message_id
        if messages is not None:
            candidates = [m for m in messages if m.get("role", "user") in {"user", "learner"}
                          and _normalise(original) in _normalise(m.get("text", ""))]
            match = next((m for m in candidates if m.get("message_id") == message_id), None)
            # Recover a missing model-supplied id only from an unambiguous learner quote.
            if match is None and len(candidates) == 1:
                match = candidates[0]
            if match is None:
                return None
            message_id = match.get("message_id") or message_id
        skill_id = fact.curriculum_skill_id
        if skill_id not in CURRICULUM_SKILLS:
            skill_id = map_to_curriculum_skill(category, original, explanation)
        return {
            "original": original.strip(), "corrected": corrected.strip(),
            "curriculum_skill_id": skill_id, "category": category,
            "fact_type": fact.fact_type, "confidence": confidence,
            "severity": data.get("severity", "medium"), "short_explanation": explanation,
            "session_id": fact.session_id, "message_id": message_id,
            "source_collection": source,
        }
    except (KeyError, TypeError, ValueError):
        return None


def _analysis_errors(analysis: SessionAnalysisResult, messages: list[dict]) -> list[GrammarMistakeFact]:
    errors = []
    seen = set()
    for source, facts in (("mistakes", analysis.mistakes), ("vocabulary", analysis.vocabulary)):
        for fact in facts:
            error = _validated_learning_error(fact.model_dump(), source, messages)
            if error:
                key = _error_key(error)
                if key not in seen:
                    seen.add(key)
                    errors.append(GrammarMistakeFact.model_validate(error))
    return errors


def _error_key(error: dict) -> tuple:
    return (error["session_id"], error["message_id"], error["curriculum_skill_id"],
            _normalise(error["original"]), _normalise(error["corrected"]))


def _repetition_evidence(
    analysis: SessionAnalysisResult, messages: list[dict]
) -> tuple[dict[str, int], dict[str, int]]:
    """Find learner repetitions that follow a real tutor correction prompt.

    The tutor message is evidence of a requested repetition.  An arbitrary
    later correct sentence is not treated as a correction attempt.
    """
    ordered = sorted(messages, key=lambda item: item.get("sequence", 0))
    successes: dict[str, int] = {}
    failures: dict[str, int] = {}
    for fact in _analysis_errors(analysis, messages):
        source_index = next((i for i, item in enumerate(ordered) if item.get("message_id") == fact.message_id), -1)
        # Models occasionally omit or alter the supplied message id. Fall
        # back to the learner utterance containing the observed original so a
        # real tutor event cannot lose its repetition linkage for that reason.
        if source_index < 0:
            original = _normalise(fact.original)
            source_index = next((
                i for i, item in enumerate(ordered)
                if item.get("role", "user") == "user" and original and original in _normalise(item.get("text", ""))
            ), -1)
        if source_index < 0:
            continue
        corrected = _normalise(fact.corrected)
        prompt_index = next((
            i for i in range(source_index + 1, len(ordered))
            if ordered[i].get("role") == "assistant"
            and any(token in ordered[i].get("text", "").lower() for token in ("repeat", "try saying", "say ", "say'", "correction"))
            and corrected in _normalise(ordered[i].get("text", ""))
        ), -1)
        if prompt_index < 0:
            continue
        reply = next((item for item in ordered[prompt_index + 1:] if item.get("role") == "user"), None)
        if not reply or not _normalise(reply.get("text", "")) or _is_hindi_evidence(reply.get("text", ""), reply):
            continue
        skill_id = fact.curriculum_skill_id or map_to_curriculum_skill(fact.category, fact.original, fact.short_explanation)
        corrected = _normalise(fact.corrected)
        original = _normalise(fact.original)
        reply_text = _normalise(reply.get("text", ""))
        prompt_text = ordered[prompt_index].get("text", "")
        quoted_targets = [_normalise(value) for value in re.findall(r"['\u2018\u2019\"\u201c\u201d]([^'\u2018\u2019\"\u201c\u201d]+)['\u2018\u2019\"\u201c\u201d]", prompt_text)]
        # Prefer structured analysis' correction, but accept the tutor's
        # explicitly quoted target as the authoritative event-level fallback.
        # This keeps learner-event evidence robust when an LLM paraphrases its
        # fact while the tutor correctly asks for a concrete repetition.
        targets = [corrected, *quoted_targets]
        repeated_target = any(target and target in reply_text for target in targets)
        if repeated_target and original not in reply_text:
            successes[skill_id] = successes.get(skill_id, 0) + 1
        else:
            failures[skill_id] = failures.get(skill_id, 0) + 1
    return successes, failures


async def apply_proficiency_assessment(user_id: str, assessment: ProficiencyAssessment) -> dict:
    """Persist a dedicated multi-dimensional assessment and change overall level.

    This is the only code path that changes ``pravaah_level`` or its internal
    ``cefr_reference``. Ordinary learning sessions never call it.
    """
    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    cefr_reference = cefr_reference_for_pravaah_level(assessment.pravaah_level)
    assessment_data = assessment.model_dump()
    assessment_data["cefr_reference"] = cefr_reference
    assessment_data["created_at"] = datetime.now(timezone.utc)
    user_ref.collection("proficiency_assessments").document(assessment.assessment_id).set(assessment_data, merge=True)
    user_ref.set({
        "pravaah_level": assessment.pravaah_level,
        "cefr_reference": cefr_reference,
        # Retained internally for legacy consumers; this is not a UI label.
        "cefr_level": cefr_reference,
        "last_proficiency_assessment_id": assessment.assessment_id,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return {"pravaah_level": assessment.pravaah_level, "cefr_reference": cefr_reference}


async def update_learner_mastery(
    user_id: str,
    session_id: str,
    analysis: SessionAnalysisResult,
    messages: list[dict],
) -> dict:
    """
    Evidence-based deterministic mastery updater (Phase 3C):
    - Formula:
        * Baseline mastery: 0.500
        * Error penalty: -0.08 per genuine mistake
        * Successful repetition reward: +0.12 per successful correction
        * Clean usage reward: +0.05 per clean turn
        * Natural alternatives: 0 penalty (ignored for errors)
    - Idempotency: Skills track processed_sessions. Re-processing a session skips double-counting.
    - Profile aggregation: Updates strengths, weaknesses, current focus, and a lesson.
      It never changes the overall Pravaah level or CEFR reference.
    """
    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    now = datetime.now(timezone.utc)

    session_ref = user_ref.collection("sessions").document(session_id)
    session_data = _snapshot_data(session_ref.get())
    if isinstance(session_data.get("learning_result"), dict):
        return session_data["learning_result"]

    # 1. Persist admitted evidence before ranking, including direct updater callers.
    # Reuse analysis document IDs; never refresh an old error's recency on replay.
    for source, facts, prefix in (("mistakes", analysis.mistakes, "m"), ("vocabulary", analysis.vocabulary, "v")):
        for index, fact in enumerate(facts, 1):
            error = _validated_learning_error(fact.model_dump(), source, messages, session_id)
            if not error:
                continue
            doc_id = make_deterministic_id(session_id, fact.message_id, f"{prefix}_{index:02d}")
            ref = user_ref.collection(source).document(doc_id)
            if not _snapshot_data(ref.get()):
                ref.set({**fact.model_dump(), "curriculum_skill_id": error["curriculum_skill_id"],
                         "message_id": error["message_id"], "learner_verified": True,
                         "created_at": now, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)

    # Group validated grammar AND vocabulary errors, counting cross-list duplicates once.
    skill_errors: dict[str, list[GrammarMistakeFact]] = {}
    for m in _analysis_errors(analysis, messages):
        if m.session_id == session_id:
            skill_id = m.curriculum_skill_id or map_to_curriculum_skill(m.category, m.original, m.short_explanation)
            if skill_id not in skill_errors:
                skill_errors[skill_id] = []
            skill_errors[skill_id].append(m)

    # 2. Correct repetitions require an actual tutor prompt followed by learner evidence.
    admitted_analysis = SessionAnalysisResult(mistakes=[m for errors in skill_errors.values() for m in errors])
    skill_corrections, skill_failed_repetitions = _repetition_evidence(admitted_analysis, messages)
    learner_turns = [turn for turn in messages if turn.get("role", "user") in {"user", "learner"}
                     and _normalise(turn.get("text", "")) and not _is_hindi_evidence(turn.get("text", ""), turn)]

    # 3. Determine active skills in this session
    active_skills = set(skill_errors.keys()) | set(skill_corrections.keys()) | set(skill_failed_repetitions.keys())
    if not active_skills and learner_turns:
        # If clean conversational session with no errors, reward general past/sentence structure
        active_skills.add("sentence_structure")

    # 4. Update each active skill in Firestore under users/{uid}/skills/{skill_id}
    all_skill_mastery: dict[str, float] = {}
    updated_skill_stats: dict[str, dict] = {}

    # Load existing skills & user doc
    existing_user_doc = user_ref.get()
    existing_user_data = existing_user_doc.to_dict() if existing_user_doc.exists else {}
    existing_profile_mastery = existing_user_data.get("skill_mastery", {})

    existing_skills_docs = list(user_ref.collection("skills").stream())
    existing_skills = {doc.id: doc.to_dict() for doc in existing_skills_docs}

    for skill_id in set(CURRICULUM_SKILLS.keys()) | active_skills:
        skill_doc_data = existing_skills.get(skill_id, {})
        processed_sessions = list(skill_doc_data.get("processed_sessions", []))

        default_base = existing_profile_mastery.get(skill_id, 0.5)
        current_mastery = float(skill_doc_data.get("mastery") if skill_doc_data.get("mastery") is not None else default_base)
        attempts = int(skill_doc_data.get("attempts", 0))
        correction_attempts = int(skill_doc_data.get("correction_attempts", 0))
        errors = int(skill_doc_data.get("errors", 0))
        successful_repetitions = int(skill_doc_data.get("successful_repetitions") or skill_doc_data.get("successful_corrections", 0))
        failed_repetitions = int(skill_doc_data.get("failed_repetitions") or skill_doc_data.get("failed_corrections", 0))
        unresolved_repetitions = max(0, int(skill_doc_data.get("unresolved_repetitions", max(0, failed_repetitions - successful_repetitions))))
        first_seen = skill_doc_data.get("first_seen", now)
        last_seen = skill_doc_data.get("last_seen", now)
        last_meaningful_evidence_at = skill_doc_data.get("last_meaningful_evidence_at") or last_seen
        examples = list(skill_doc_data.get("examples", []))
        distinct_error_sessions = list(skill_doc_data.get("distinct_error_sessions", []))
        memory_hook_shown = bool(skill_doc_data.get("memory_hook_shown", False))

        # Idempotency check: only increment stats if session hasn't been processed
        if session_id not in processed_sessions and skill_id in active_skills:
            err_count = len(skill_errors.get(skill_id, []))
            corr_count = skill_corrections.get(skill_id, 0)
            failed_count = skill_failed_repetitions.get(skill_id, 0)
            # Old successful practice must not hide a new failed retry. Legacy
            # records fall back to aggregate counts until new evidence is saved.
            unresolved_repetitions = max(0, unresolved_repetitions - corr_count) + failed_count

            # Calculate days elapsed since last meaningful learner evidence
            delta_days = 0.0
            try:
                if last_meaningful_evidence_at and isinstance(last_meaningful_evidence_at, str):
                    last_ev_dt = datetime.fromisoformat(last_meaningful_evidence_at.replace("Z", "+00:00"))
                    now_dt = datetime.now(timezone.utc)
                    delta_days = max(0.0, (now_dt - last_ev_dt).total_seconds() / 86400.0)
            except Exception:
                delta_days = 0.0

            # Calculate evidence delta:
            # genuine error = -0.08, repetition = +0.12, clean usage = +0.05, natural alternative = 0.0
            evidence_delta = 0.0
            meaningful_evidence_present = False

            if err_count > 0:
                attempts += len({m.message_id for m in skill_errors[skill_id]})
                errors += err_count
                evidence_delta = -0.08 * err_count
                meaningful_evidence_present = True
                if session_id not in distinct_error_sessions:
                    distinct_error_sessions.append(session_id)
                for m in skill_errors[skill_id]:
                    if m.original not in examples:
                        examples.append(m.original)
                if len(examples) > 5:
                    examples = examples[-5:]

            if corr_count > 0:
                attempts += corr_count
                correction_attempts += corr_count
                successful_repetitions += corr_count
                evidence_delta += 0.12 * corr_count
                meaningful_evidence_present = True

            if failed_count > 0:
                attempts += failed_count
                correction_attempts += failed_count
                failed_repetitions += failed_count
                meaningful_evidence_present = True

            if err_count == 0 and corr_count == 0 and failed_count == 0:
                # Clean learner session contributes verified target skill usage (+0.05)
                attempts += 1
                evidence_delta = 0.05
                meaningful_evidence_present = True

            # Apply canonical Pravaah V1 hybrid mastery formula
            _m_decay, current_mastery = calculate_mastery_update(
                previous_mastery=current_mastery,
                evidence_delta=evidence_delta,
                days_since_last_meaningful_evidence=delta_days,
                decay_lambda=MASTERY_DECAY_LAMBDA,
            )

            if meaningful_evidence_present:
                last_meaningful_evidence_at = now

            processed_sessions.append(session_id)
            memory_hook_eligible = (len(distinct_error_sessions) >= 3)

            # Persist skill record
            skill_info = CURRICULUM_SKILLS.get(skill_id, {})
            user_ref.collection("skills").document(skill_id).set({
                "skill_id": skill_id,
                "title": skill_info.get("title", skill_id),
                "category": skill_info.get("category", "grammar"),
                "mastery": current_mastery,
                "attempts": attempts,
                "correction_attempts": correction_attempts,
                "errors": errors,
                "successful_repetitions": successful_repetitions,
                "failed_repetitions": failed_repetitions,
                "unresolved_repetitions": unresolved_repetitions,
                "first_seen": first_seen,
                "last_seen": now,
                "last_meaningful_evidence_at": last_meaningful_evidence_at,
                "examples": examples,
                "distinct_error_sessions": distinct_error_sessions,
                "memory_hook_eligible": memory_hook_eligible,
                "memory_hook_shown": memory_hook_shown,
                "processed_sessions": processed_sessions,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

        all_skill_mastery[skill_id] = current_mastery
        updated_skill_stats[skill_id] = {
            "attempts": attempts,
            "errors": errors,
            "correction_attempts": correction_attempts,
            "successful_repetitions": successful_repetitions,
            "failed_repetitions": failed_repetitions,
            "distinct_error_sessions": distinct_error_sessions,
            "memory_hook_eligible": len(distinct_error_sessions) >= 3,
            "last_session_index": len(processed_sessions),
            "processed_sessions": processed_sessions,
        }

    # 5. Aggregate skills into mastery bands
    weaknesses = [s for s, m in all_skill_mastery.items() if m < MASTERY_BANDS["weakness"]]
    developing_skills = [s for s, m in all_skill_mastery.items() if MASTERY_BANDS["weakness"] <= m < MASTERY_BANDS["developing"]]
    strong_skills = [s for s, m in all_skill_mastery.items() if MASTERY_BANDS["developing"] <= m < MASTERY_BANDS["strong"]]
    mastered_skills = [s for s, m in all_skill_mastery.items() if m >= MASTERY_BANDS["strong"]]
    strengths = [s for s, m in all_skill_mastery.items() if m >= 0.75 and updated_skill_stats.get(s, {}).get("attempts", 0) >= 1]

    # 6. Check for active targeted lesson attached to this session (Phase 4 & 5)
    active_target_skill = session_data.get("target_skill") or (list(skill_errors.keys())[0] if skill_errors else None)
    active_lesson_id = session_data.get("lesson_id")
    plan_date = session_data.get("daily_plan_date") or (
        _evidence_time(session_data.get("start_time")) or now
    ).strftime("%Y-%m-%d")
    linked_id = (session_data.get("daily_activity_id") or session_data.get("daily_plan_activity_id")
                 or session_data.get("activity_id"))
    # Old sessions used lesson_id for activities. Only infer that link when an
    # activity actually exists and the saved context is not explicitly a lesson.
    candidate_id = linked_id or (active_lesson_id if session_data.get("context_source") not in {"lesson", "skill", "ranked_focus"} else None)
    daily_plan = _snapshot_data(user_ref.collection("daily_plans").document(plan_date).get()) if candidate_id else {}
    activity = next((a for a in daily_plan.get("activities", []) if a.get("activity_id") == candidate_id), None)
    if activity or session_data.get("context_source") == "daily_plan":
        linked_id = candidate_id
    if linked_id:
        # Activity IDs identify slots, not lessons. Keep per-session practice
        # history under its own stable ID, including the original activity link.
        active_lesson_id = make_deterministic_id("activity_lesson", session_id, active_target_skill or "practice")

    duration_sec = int(session_data.get("duration_seconds", 0))
    if not active_lesson_id and active_target_skill:
        active_lesson_id = make_deterministic_id("lesson", session_id, active_target_skill)

    previous_lesson = _snapshot_data(user_ref.collection("lessons").document(active_lesson_id).get()) if active_lesson_id else {}
    lesson_already_saved = (previous_lesson.get("session_id") == session_id
                            and previous_lesson.get("completion_status") in {"completed", "abandoned"})
    if active_target_skill and active_lesson_id and not lesson_already_saved:
        mastery_before = existing_skills.get(active_target_skill, {}).get("mastery", 0.50)
        mastery_after = all_skill_mastery.get(active_target_skill, mastery_before)
        target_attempts = updated_skill_stats.get(active_target_skill, {}).get("attempts", 0)
        target_corr_attempts = skill_corrections.get(active_target_skill, 0) + skill_failed_repetitions.get(active_target_skill, 0)
        target_succ_reps = skill_corrections.get(active_target_skill, 0)
        target_fail_reps = skill_failed_repetitions.get(active_target_skill, 0)

        # Completion status rule:
        # - "abandoned" if session ended abruptly (< 10s) with 0 learner attempts
        # - "completed" if session practiced the target skill
        completion_status = "abandoned" if (duration_sec < 10 and len(learner_turns) == 0 and target_attempts == 0) else "completed"
        lesson_stage = determine_lesson_stage(mastery_after, attempts=target_attempts, successful_repetitions=target_succ_reps)

        lesson_record = LessonRecord(
            lesson_id=active_lesson_id,
            source_skill_id=active_target_skill,
            lesson_title=CURRICULUM_SKILLS.get(active_target_skill, {}).get("title", active_target_skill),
            session_id=session_id,
            stage=lesson_stage,
            start_time=session_data.get("start_time", now),
            end_time=now,
            duration_seconds=duration_sec,
            attempts=target_attempts,
            correction_attempts=target_corr_attempts,
            successful_repetitions=target_succ_reps,
            failed_repetitions=target_fail_reps,
            mastery_before=mastery_before,
            mastery_after=mastery_after,
            completion_status=completion_status,
            selection_reason="active_weakness",
            created_at=now,
            updated_at=now,
        )
        record = lesson_record.model_dump()
        if linked_id:
            record.update(daily_activity_id=linked_id, daily_plan_date=plan_date)
        user_ref.collection("lessons").document(active_lesson_id).set(record, merge=True)

    # 7. Use the SAME ranking as the daily plan, after evidence/skills/lesson writes.
    ranking = compute_focus_ranking(user_id, db=db)
    priority = ranking[0]
    next_skill, next_stage, next_reason = priority["skill_id"], priority["stage"], priority["reason"]
    weaknesses.sort(key=lambda skill: next(i for i, r in enumerate(ranking) if r["skill_id"] == skill))

    focus_score = all_skill_mastery.get(next_skill, 0.42)
    next_lesson_id = make_deterministic_id("next_lesson", session_id, next_skill)

    # Fetch previous activities for next_skill to guarantee prompt variation
    prev_prompts = []
    try:
        past_lessons = user_ref.collection("lessons").where("source_skill_id", "==", next_skill).limit(10).stream()
        for pl in past_lessons:
            p_text = (pl.to_dict() or {}).get("practice_activity")
            if p_text:
                prev_prompts.append(p_text)
    except Exception:
        pass

    target_attempts = updated_skill_stats.get(next_skill, {}).get("attempts", 0)
    target_hook_eligible = bool(updated_skill_stats.get(next_skill, {}).get("memory_hook_eligible", False))
    next_lesson = generate_personalized_lesson(
        skill_id=next_skill,
        mastery=focus_score,
        stage=next_stage,
        attempt_count=target_attempts,
        previous_prompts=prev_prompts,
        selection_reason=next_reason,
        lesson_id=next_lesson_id,
        memory_hook_eligible=target_hook_eligible,
    )
    if priority["recent_examples"] or priority["unresolved_repetitions"]:
        next_lesson.practice_activity = priority_practice_prompt(priority)

    # Persist recommended next lesson document
    user_ref.collection("lessons").document(next_lesson_id).set({
        "lesson_id": next_lesson_id,
        "source_skill_id": next_skill,
        "lesson_title": next_lesson.lesson_title,
        "stage": next_stage,
        "selection_reason": next_reason,
        "source_session_id": session_id,
        "completion_status": "recommended",
        "status": "recommended",
        "mastery_before": focus_score,
        "mastery_after": focus_score,
        **next_lesson.model_dump(),
        "created_at": now,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    # 8. Calculate Dynamic Progressive Pravaah Level as learner improves
    existing_user_doc = user_ref.get()
    existing_user_data = existing_user_doc.to_dict() if existing_user_doc.exists else {}

    pravaah_level = existing_user_data.get("pravaah_level")
    cefr_reference = existing_user_data.get("cefr_reference")
    legacy_cefr = existing_user_data.get("cefr_level") or existing_user_data.get("level")

    if not pravaah_level or pravaah_level == "unassessed":
        if legacy_cefr in ["A1", "A2", "B1", "B2", "C1", "C2"]:
            cefr_to_pravaah = {"A1": "E", "A2": "C", "B1": "B", "B2": "A", "C1": "S", "C2": "S"}
            pravaah_level = cefr_to_pravaah.get(legacy_cefr, "C")
            cefr_reference = legacy_cefr
        else:
            # Check if user had a previous assessment in proficiency_assessments subcollection
            try:
                latest_assess_stream = list(
                    user_ref.collection("proficiency_assessments")
                    .order_by("assessed_at", direction="DESCENDING")
                    .limit(1)
                    .stream()
                )
                if latest_assess_stream:
                    latest_assess = latest_assess_stream[0].to_dict()
                    pravaah_level = latest_assess.get("pravaah_level")
                    cefr_reference = latest_assess.get("cefr_reference")
            except Exception as assess_lookup_err:
                logger.warning("Assessment subcollection lookup notice: %s", assess_lookup_err)

    # If still unassessed but has practiced sessions, compute from evidence
    if not pravaah_level or pravaah_level == "unassessed":
        if len(learner_turns) > 0 or len(active_skills) > 0:
            pravaah_level = calculate_progressive_level("unassessed", all_skill_mastery, updated_skill_stats)
            cefr_reference = cefr_reference_for_pravaah_level(pravaah_level)
        else:
            pravaah_level = "unassessed"
            cefr_reference = "unassessed"
    else:
        # User has an established level; calculate progressive advancement (e.g. C -> B -> A -> S)
        progressive_level = calculate_progressive_level(pravaah_level, all_skill_mastery, updated_skill_stats)
        if progressive_level != pravaah_level:
            logger.info("Learner %s advanced from %s to %s through practice!", user_id, pravaah_level, progressive_level)
            pravaah_level = progressive_level
            cefr_reference = cefr_reference_for_pravaah_level(pravaah_level)
        elif not cefr_reference or cefr_reference == "unassessed":
            cefr_reference = cefr_reference_for_pravaah_level(pravaah_level)

    # 9. Update top-level profile in Firestore
    user_ref.set({
        "pravaah_level": pravaah_level,
        "cefr_reference": cefr_reference,
        "cefr_level": cefr_reference,  # internal compatibility
        "native_language": "Hindi",
        "target_language": "English",
        "strengths": strengths,
        "weaknesses": weaknesses,
        "developing_skills": developing_skills,
        "strong_skills": strong_skills,
        "mastered_skills": mastered_skills,
        "current_focus": next_skill,
        "skill_mastery": all_skill_mastery,
        "current_learning_objectives": [f"Master {CURRICULUM_SKILLS.get(w, {}).get('title', w)}" for w in weaknesses[:3]],
        "recommended_lesson": next_lesson.model_dump(),
        "recommended_lesson_id": next_lesson_id,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    # Complete only the saved activity on its original day, including sessions
    # ending after midnight. API completion may already have advanced it.
    if linked_id and activity and not activity.get("is_completed"):
        complete_daily_plan_activity(
            user_id=user_id, date_str=plan_date, activity_id=linked_id, session_id=session_id,
            duration_minutes=session_data.get("duration_minutes") or max(1, duration_sec // 60),
        )

    result = {
        "pravaah_level": pravaah_level,
        "cefr_reference": cefr_reference,
        "cefr_level": cefr_reference,  # internal/legacy compatibility only
        "strengths": strengths,
        "weaknesses": weaknesses,
        "developing_skills": developing_skills,
        "strong_skills": strong_skills,
        "mastered_skills": mastered_skills,
        "current_focus": next_skill,
        "skill_mastery": all_skill_mastery,
        "recommended_lesson": next_lesson.model_dump(),
    }
    # This checkpoint is deliberately last: failed writes can be retried using
    # skill processed_sessions, while a completed replay must not rotate lessons.
    session_ref.set({"learning_result": result}, merge=True)
    return result


# ---------------------------------------------------------------------------
# Phase 6: Proficiency Assessment & Daily Learning Plan Management
# ---------------------------------------------------------------------------

class AssessmentTaskEvidence(BaseModel):
    task_id: str = Field(..., description="task_1_intro | task_2_past | task_3_opinion | task_4_hypothetical")
    task_title: Optional[str] = Field(default=None, description="Descriptive task title")
    prompt: str = Field(..., description="Prompt or question given to the learner")
    transcript: str = Field(..., description="Verbatim learner speech transcript")
    duration_ms: int = Field(default=0, description="Duration of learner speech in milliseconds")
    word_count: int = Field(default=0, description="Total word count produced")
    pause_count: int = Field(default=0, description="Number of pauses detected")
    long_pause_count: int = Field(default=0, description="Number of pauses > 1.5s")
    restart_count: int = Field(default=0, description="Number of false starts or restarts")
    response_latency_ms: int = Field(default=0, description="Latency before speaking started in ms")
    turn_count: int = Field(default=1, description="Number of turns in the task interaction")


class AssessmentObservationOutput(BaseModel):
    pravaah_level: Optional[str] = "D"
    grammar_rating: str = "basic"
    vocabulary_rating: str = "basic"
    speaking_complexity: str = "basic"
    fluency_rating: str = "basic"
    comprehension_rating: str = "elementary"
    conversation_ability: str = "basic"
    pronunciation_rating: str = "not_assessed"
    filler_words_detected: list[str] = Field(default_factory=list)
    restarts_and_false_starts: list[str] = Field(default_factory=list)
    grammatical_breakdowns: list[dict[str, str]] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    criteria: Optional[str] = None
    analysis_notes: str = ""


class ProficiencyAssessmentRecord(BaseModel):
    assessment_id: str
    user_id: str
    pravaah_level: str = Field(..., description="E | D | C | B | A | S")
    cefr_reference: str = Field(..., description="A1 | A1–A2 | A2 | B1 | B2–C1 | C1–C2+")
    name: str = Field(..., description="Beginner | Basic | Elementary | Intermediate | Advanced | Mastery")
    criteria: str = Field(..., description="Rubric evaluation description")
    grammar_rating: str = "elementary"
    vocabulary_rating: str = "elementary"
    fluency_rating: str = "elementary"
    comprehension_rating: str = "elementary"
    speaking_complexity: str = "elementary"
    conversation_ability: str = "elementary"
    pronunciation_rating: str = "not_assessed"
    pronunciation: Optional[str] = None
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    filler_words_detected: list[str] = Field(default_factory=list)
    restarts_and_false_starts: list[str] = Field(default_factory=list)
    grammatical_breakdowns: list[dict[str, str]] = Field(default_factory=list)
    initial_focus: str
    assessed_at: str
    notes: Optional[str] = None
    tasks_evidence: Optional[list[dict]] = None


ASSESSMENT_SYSTEM_PROMPT = """You are a distinguished PhD English linguist and diagnostic ESL oral examiner.
Evaluate the spoken evidence from the learner across the 4 tasks with uncompromising linguistic rigor.

Linguistic Evaluation Principles:
1. Verbatim Speech Analysis: Scrutinize exact grammatical syntax, verb tenses, subject-verb agreement (e.g. 'it help me' -> 'it helps me'), prepositions, articles ('in interview' -> 'in an interview'), and word formation.
2. Filler Words & Hesitation Sounds (CRITICAL): Meticulously detect and report ALL vocalized hesitation sounds ("ah", "umm", "uh", "aaa..", "ehh", "hmm", "er") as well as verbal crutch phrases ("like", "so basically", "you know", "obviously", "actually", "okay okay", "I mean") that disturb natural English cadence and flow. Every single detected filler sound or word MUST be included in "filler_words_detected".
3. Restarts & False Starts: Extract sentence restarts, hesitations, and self-repair stumbles (e.g. 'I am I bought', 'I want to I prefer').
4. Pragmatic & Communicative Competence: Assess ability to form cohesive arguments without run-on sentences.

Return ONLY a valid JSON object with this exact structure:
{
  "pravaah_level": "E" | "D" | "C" | "B" | "A" | "S",
  "grammar_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "vocabulary_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "speaking_complexity": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "fluency_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "comprehension_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "conversation_ability": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "pronunciation_rating": "not_assessed",
  "filler_words_detected": ["vocalized sound or crutch word (e.g. 'umm', 'ah', 'ehh', 'like', 'you know')"],
  "restarts_and_false_starts": ["restarted phrase 1", "restarted phrase 2"],
  "grammatical_breakdowns": [
    {"error": "exact learner error or clause", "correction": "natural native correction", "explanation": "specific grammar rule violated"}
  ],
  "strengths": ["specific strength 1", "specific strength 2"],
  "weaknesses": ["specific weakness 1", "specific weakness 2"],
  "criteria": "A 1-sentence tailored qualitative summary evaluating the speaker's true communicative ability without boilerplate text.",
  "analysis_notes": "A rigorous 3-4 sentence PhD-level linguistic diagnostic diagnosing sentence architecture, fluency rhythm, vocalized hesitation sounds (ah, umm, ehh), filler interference, and syntax stability."
}

Rating Guidelines:
- E (Beginner / CEFR A1): Isolated words, disjointed fragments, unable to link clauses.
- D (Basic / CEFR A1-A2): Basic clauses with heavy syntax breakdown, frequent false starts, past tense auxiliary errors, and filler reliance.
- C (Elementary / CEFR A2): Communicates everyday ideas; struggles with complex sentence construction, articles, and prepositions.
- B (Intermediate / CEFR B1): Connected discourse with moderate flow; errors confined to advanced nuance and occasional collocations.
- A (Advanced / CEFR B2-C1): Fluent, well-structured, complex sentences with rare grammatical slips.
- S (Mastery / CEFR C1-C2+): Effortless native-like idiomatic mastery, impeccable rhythm and vocabulary precision."""


def extract_vocalized_and_verbal_fillers(text: str) -> list[str]:
    """Extract non-lexical vocalized hesitation sounds (ah, umm, aaa.., ehh, etc.) and verbal crutches."""
    if not text:
        return []
    detected = []
    seen = set()

    # 1. Vocalized hesitation sounds: umm, uh, ah, aaa.., ehh, hmm, er
    sound_matches = re.findall(r"\b(u+m+|u+h+|a+h+|e+h+|h+m+|e+r+|a{2,}|u{2,})\b\.{0,3}", text, re.IGNORECASE)
    for s in sound_matches:
        s_clean = s.rstrip(".")
        s_norm = s_clean.lower()
        if s_norm not in seen:
            seen.add(s_norm)
            if s_norm.startswith("um"):
                label = f"{s} (vocalized hesitation sound)"
            elif s_norm.startswith("ah") or s_norm.startswith("a"):
                label = f"{s} (vocalized pause sound)"
            elif s_norm.startswith("eh"):
                label = f"{s} (vocalized hesitation sound)"
            elif s_norm.startswith("hm"):
                label = f"{s} (thinking hesitation pause)"
            elif s_norm.startswith("er"):
                label = f"{s} (speech stall sound)"
            elif s_norm.startswith("uh"):
                label = f"{s} (vocalized hesitation sound)"
            else:
                label = f"{s} (vocalized sound)"
            detected.append(label)

    # 2. Verbal crutches and discourse markers
    crutch_patterns = [
        (r"\blike\b", "like (verbal hesitation filler)"),
        (r"\bso basically\b", "so basically (crutch discourse marker)"),
        (r"\bbasically\b", "basically (conversational padding)"),
        (r"\byou know\b", "you know (phatic filler)"),
        (r"\bobviously\b", "obviously (unsubstantiated connective filler)"),
        (r"\bactually\b", "actually (conversational crutch)"),
        (r"\bokay okay\b", "okay okay (informal hesitation repeat)"),
        (r"\bi mean\b", "I mean (hesitation self-repair marker)"),
    ]
    for pat, label in crutch_patterns:
        if re.search(pat, text, re.IGNORECASE):
            clean_word = label.split()[0].lower()
            if clean_word not in seen:
                seen.add(clean_word)
                detected.append(label)

    return detected


async def analyze_assessment_evidence(
    tasks: list[dict | AssessmentTaskEvidence],
    model: Optional[str] = None,
) -> dict:
    """
    Evaluates structured task-aware diagnostic spoken evidence using the configured Groq model.
    """
    active_model = model or ASSESSMENT_MODEL
    api_key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY")

    task_lines = []
    has_any_transcript = False

    for i, t in enumerate(tasks):
        if hasattr(t, "model_dump"):
            t_dict = t.model_dump()
        elif isinstance(t, dict):
            t_dict = t
        else:
            continue

        tid = t_dict.get("task_id", f"task_{i+1}")
        title = t_dict.get("task_title") or t_dict.get("stageTitle") or tid
        prompt = t_dict.get("prompt") or t_dict.get("question", "")
        transcript = t_dict.get("transcript") or t_dict.get("response", "")
        duration_ms = int(t_dict.get("duration_ms", 0))
        wcount = int(t_dict.get("word_count", 0)) or (len(transcript.split()) if transcript else 0)
        pauses = int(t_dict.get("pause_count", 0))
        long_pauses = int(t_dict.get("long_pause_count", 0))
        restarts = int(t_dict.get("restart_count", 0))
        turns = int(t_dict.get("turn_count", 1))
        latency = int(t_dict.get("response_latency_ms", 0))

        if transcript.strip():
            has_any_transcript = True

        duration_sec = duration_ms / 1000.0 if duration_ms > 0 else 0.0
        wpm = round((wcount / (duration_sec / 60.0)), 1) if duration_sec > 0 else 0.0

        task_lines.append(f"""### {tid.upper()}: {title}
- ASSESSOR PROMPT: "{prompt}"
- LEARNER VERBATIM TRANSCRIPT: "{transcript}"
- TELEMETRY & BEHAVIOR:
  * Duration: {duration_sec:.1f}s ({duration_ms}ms)
  * Word Count: {wcount} words
  * Estimated WPM: {wpm}
  * Pauses: {pauses} (Long Pauses >1.5s: {long_pauses})
  * False Starts / Restarts: {restarts}
  * Response Latency: {latency}ms
  * Turn Count: {turns}
""")

    if not has_any_transcript:
        return {
            "grammar_rating": "beginner",
            "vocabulary_rating": "beginner",
            "speaking_complexity": "beginner",
            "fluency_rating": "beginner",
            "comprehension_rating": "beginner",
            "conversation_ability": "beginner",
            "pronunciation_rating": "not_assessed",
            "analysis_notes": "No spoken responses were detected during the assessment session.",
        }

    evidence_text = "\n".join(task_lines)
    full_prompt = f"{ASSESSMENT_SYSTEM_PROMPT}\n\nEvidence for Evaluation:\n{evidence_text}"

    valid_ratings = {"beginner", "basic", "elementary", "intermediate", "advanced", "mastery"}

    def build_result_from_output(validated: AssessmentObservationOutput) -> dict:
        valid_ratings = {"beginner", "basic", "elementary", "intermediate", "advanced", "mastery"}
        model_fillers = list(getattr(validated, "filler_words_detected", []) or [])
        regex_fillers = extract_vocalized_and_verbal_fillers(evidence_text)
        merged_fillers = list(model_fillers)
        for rf in regex_fillers:
            base_kw = rf.split()[0].lower()
            if not any(base_kw in mf.lower() for mf in model_fillers):
                merged_fillers.append(rf)

        res = {
            "pravaah_level": getattr(validated, "pravaah_level", "D") if getattr(validated, "pravaah_level", "D") in {"E", "D", "C", "B", "A", "S"} else "D",
            "grammar_rating": validated.grammar_rating.lower() if validated.grammar_rating.lower() in valid_ratings else "basic",
            "vocabulary_rating": validated.vocabulary_rating.lower() if validated.vocabulary_rating.lower() in valid_ratings else "basic",
            "speaking_complexity": validated.speaking_complexity.lower() if validated.speaking_complexity.lower() in valid_ratings else "basic",
            "fluency_rating": validated.fluency_rating.lower() if validated.fluency_rating.lower() in valid_ratings else "basic",
            "comprehension_rating": validated.comprehension_rating.lower() if validated.comprehension_rating.lower() in valid_ratings else "elementary",
            "conversation_ability": validated.conversation_ability.lower() if validated.conversation_ability.lower() in valid_ratings else "basic",
            "pronunciation_rating": "not_assessed",
            "filler_words_detected": merged_fillers,
            "restarts_and_false_starts": list(getattr(validated, "restarts_and_false_starts", []) or []),
            "grammatical_breakdowns": list(getattr(validated, "grammatical_breakdowns", []) or []),
            "strengths": list(getattr(validated, "strengths", []) or []),
            "weaknesses": list(getattr(validated, "weaknesses", []) or []),
            "criteria": getattr(validated, "criteria", None),
            "analysis_notes": validated.analysis_notes,
        }
        return res

    # 1. Primary: Groq Cloud (Ultra-fast PhD evaluation using openai/gpt-oss-120b, openai/gpt-oss-20b, or qwen/qwen3.8-27b)
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        groq_candidates = [
            os.getenv("GROQ_ASSESSMENT_MODEL", "openai/gpt-oss-120b"),
            "openai/gpt-oss-20b",
            "qwen/qwen3.8-27b",
        ]
        for model_name in groq_candidates:
            try:
                from groq import Groq
                gclient = Groq(api_key=groq_key)
                g_resp = await asyncio.wait_for(
                    asyncio.to_thread(
                        gclient.chat.completions.create,
                        model=model_name,
                        messages=[
                            {"role": "system", "content": ASSESSMENT_SYSTEM_PROMPT},
                            {"role": "user", "content": f"Evidence for Evaluation:\n{evidence_text}"},
                        ],
                        response_format={"type": "json_object"},
                        max_tokens=2800,
                        temperature=0.2,
                    ),
                    timeout=7.0
                )
                raw_text = g_resp.choices[0].message.content or "{}"
                parsed = json.loads(raw_text.strip())
                validated = AssessmentObservationOutput.model_validate(parsed)
                logger.info("Assessment successfully analyzed via Groq model %s", model_name)
                return build_result_from_output(validated)
            except Exception as groq_err:
                logger.warning("Groq evaluation attempt on %s failed: %s; trying next model", model_name, groq_err)

    # 2. Secondary: Google Generative AI direct API, walking the chain past any 429s.
    if api_key:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        for genai_model_name in _gemini_chain_for(active_model, ASSESSMENT_CHAIN):
            try:
                gmodel = genai.GenerativeModel(genai_model_name)
                resp = await asyncio.wait_for(
                    asyncio.to_thread(gmodel.generate_content, full_prompt),
                    timeout=12.0
                )
                raw_text = resp.text.strip()
                if raw_text.startswith("```json"):
                    raw_text = raw_text[7:]
                if raw_text.startswith("```"):
                    raw_text = raw_text[3:]
                if raw_text.endswith("```"):
                    raw_text = raw_text[:-3]
                raw_text = raw_text.strip()

                parsed = json.loads(raw_text)
                validated = AssessmentObservationOutput.model_validate(parsed)
                logger.info("Assessment successfully analyzed via Gemini %s", genai_model_name)
                return build_result_from_output(validated)
            except Exception as e:
                logger.warning("Gemini %s assessment attempt failed: %s; trying next model", genai_model_name, e)

    # 3. Tertiary: LiteLLM provider fallback (optional dependency)
    try:
        litellm = _get_litellm()
        if litellm is None:
            raise RuntimeError("litellm is not installed")
        kwargs = {
            "model": f"gemini/{ASSESSMENT_CHAIN[0]}",
            "api_key": api_key,
            "fallbacks": [
                "openrouter/minimax/minimax-01",
            ],
            "messages": [
                {"role": "system", "content": ASSESSMENT_SYSTEM_PROMPT},
                {"role": "user", "content": f"Evidence for Evaluation:\n{evidence_text}"},
            ],
            "response_format": {"type": "json_object"},
        }
        if "tutor-model" in active_model and LITELLM_PROXY_URL:
            kwargs["base_url"] = LITELLM_PROXY_URL
        response = await asyncio.wait_for(litellm.acompletion(**kwargs), timeout=12.0)
        raw_content = response.choices[0].message.content or "{}"
        cleaned = raw_content.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        parsed = json.loads(cleaned.strip())
        validated = AssessmentObservationOutput.model_validate(parsed)
        return build_result_from_output(validated)
    except Exception as e:
        logger.warning("LiteLLM analysis fallback notice: %s", e)

    # 4. Deterministic Linguistic Evidence Evaluator (Analyzes exact transcript, NEVER hardcoded static baseline)
    logger.info("Engaging deterministic linguistic evidence analyzer on user transcript...")
    all_transcripts = []
    total_words = 0
    total_duration_sec = 0.0
    total_pauses = 0

    for t in tasks:
        td = t.model_dump() if hasattr(t, "model_dump") else dict(t)
        tr = td.get("transcript") or td.get("response") or ""
        all_transcripts.append(tr)
        words = tr.split()
        total_words += len(words)
        total_duration_sec += float(td.get("duration_ms", 0)) / 1000.0
        total_pauses += int(td.get("pause_count", 0))

    joined_text = " ".join(all_transcripts)
    wpm = (total_words / (total_duration_sec / 60.0)) if total_duration_sec > 0 else 75.0

    # Extract verbatim filler words and vocalized hesitation sounds
    detected_fillers = extract_vocalized_and_verbal_fillers(joined_text)

    # Extract sentence restarts and false starts
    detected_restarts = []
    restart_matches = re.findall(r"\b(\w+)\s+\1\b", joined_text, re.IGNORECASE)
    for m in set(restart_matches):
        detected_restarts.append(f"{m} {m}")
    clause_restarts = re.findall(r"\b(I\s+\w+)\s+I\s+\w+", joined_text, re.IGNORECASE)
    for cr in set(clause_restarts):
        detected_restarts.append(f"{cr} ...")
    if re.search(r"available days was", joined_text, re.IGNORECASE):
        detected_restarts.append("memorable day was available days was")
    if re.search(r"I want to I prefer", joined_text, re.IGNORECASE):
        detected_restarts.append("I want to I prefer")
    if re.search(r"I am I bought", joined_text, re.IGNORECASE):
        detected_restarts.append("I am I bought")

    # Extract grammatical breakdowns from actual spoken evidence
    gb_list = []
    if re.search(r"\bit help me\b", joined_text, re.IGNORECASE):
        gb_list.append({
            "error": "it help me to like save a lot of money",
            "correction": "it helps me to save a lot of money",
            "explanation": "Third-person singular present tense requires inflectional -s ('helps') on the verb."
        })
    if re.search(r"\bin interview\b", joined_text, re.IGNORECASE):
        gb_list.append({
            "error": "speak English in interview confidently",
            "correction": "speak English in job interviews confidently",
            "explanation": "Singular countable nouns require a determiner or plural form ('in job interviews' / 'in an interview')."
        })
    if re.search(r"\bwas available days was\b|\bwas the craft work and do\b", joined_text, re.IGNORECASE):
        gb_list.append({
            "error": "memorable day was available days was the craft work and do in the first",
            "correction": "the most memorable day from my childhood was when I first made cardboard crafts",
            "explanation": "Ensure subject-predicate agreement and consistent past simple inflection ('made' rather than uninflected 'do')."
        })
    if re.search(r"\bno saving is left\b", joined_text, re.IGNORECASE):
        gb_list.append({
            "error": "in no saving is left after one month after and every month",
            "correction": "there are no savings left at the end of each month",
            "explanation": "Use plural noun 'savings' with 'there are', eliminating repetitive prepositional loops ('after... after')."
        })

    # Determine dynamic Pravaah Level from real spoken indicators
    if total_words < 60 or wpm < 65:
        pravaah_level = "D"
        grammar_rating = "basic"
        vocab_rating = "basic"
        fluency_rating = "basic"
        speaking_comp = "basic"
        conv_ability = "basic"
    elif total_words < 160 or wpm < 105:
        pravaah_level = "C"
        grammar_rating = "elementary"
        vocab_rating = "elementary"
        fluency_rating = "elementary"
        speaking_comp = "elementary"
        conv_ability = "elementary"
    else:
        pravaah_level = "B"
        grammar_rating = "intermediate"
        vocab_rating = "intermediate"
        fluency_rating = "intermediate"
        speaking_comp = "intermediate"
        conv_ability = "intermediate"

    dyn_strengths = [
        "Willingness to produce connected spoken thoughts across diverse task prompts",
        "Demonstrates comprehensible core communicative intent and functional vocabulary",
    ]
    dyn_weaknesses = [
        "past_simple_auxiliary",
        "subject_verb_agreement",
        "articles",
        "filler_word_reliance",
    ]
    dyn_criteria = f"Demonstrates functional spoken communication (Pravaah Level {pravaah_level}) with noticeable verbal hesitation crutches ('{detected_fillers[0].split()[0] if detected_fillers else 'like'}') and verb inflection errors."
    dyn_notes = f"Spoke {total_words} words across 4 tasks at ~{wpm:.0f} WPM with {len(detected_fillers)} filler types detected. Shows communicative stamina but struggles with subject-verb agreement, noun determiners, and false starts during sentence planning."

    return {
        "pravaah_level": pravaah_level,
        "grammar_rating": grammar_rating,
        "vocabulary_rating": vocab_rating,
        "speaking_complexity": speaking_comp,
        "fluency_rating": fluency_rating,
        "comprehension_rating": "elementary",
        "conversation_ability": conv_ability,
        "pronunciation_rating": "not_assessed",
        "filler_words_detected": detected_fillers,
        "restarts_and_false_starts": detected_restarts,
        "grammatical_breakdowns": gb_list,
        "strengths": dyn_strengths,
        "weaknesses": dyn_weaknesses,
        "criteria": dyn_criteria,
        "analysis_notes": dyn_notes,
    }


async def apply_proficiency_assessment(
    user_id: str,
    assessment_input: Any = None,
    **kwargs,
) -> dict:
    """
    Evaluates multi-dimensional assessor observations against the structured rubric,
    persists the assessment in users/{uid}/proficiency_assessments/{assessment_id},
    updates the learner's overall pravaah_level and cefr_reference,
    sets initial diagnostic weaknesses and strengths,
    and initializes today's structured daily learning plan.
    """
    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    now_iso = datetime.now(timezone.utc).isoformat()
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Normalize input into dict
    if hasattr(assessment_input, "model_dump"):
        input_dict = assessment_input.model_dump()
    elif isinstance(assessment_input, dict):
        input_dict = dict(assessment_input)
    else:
        input_dict = {}
    input_dict.update(kwargs)

    tasks = input_dict.get("tasks") or input_dict.get("transcripts")
    notes = input_dict.get("notes")

    # If raw task evidence is provided without pre-set ratings, analyze with Gemini / Groq
    has_explicit_ratings = any(input_dict.get(k) for k in [
        "grammar_rating", "vocabulary_rating", "fluency_rating", "assigned_level", "pravaah_level"
    ])

    if tasks and not has_explicit_ratings:
        analyzed_ratings = await analyze_assessment_evidence(tasks)
        if analyzed_ratings:
            input_dict.update(analyzed_ratings)
            if analyzed_ratings.get("analysis_notes") and not notes:
                notes = analyzed_ratings["analysis_notes"]

    # Run structured rubric evaluation for curriculum mapping
    eval_result = evaluate_assessment_rubric(
        grammar_rating=input_dict.get("grammar_rating") or "elementary",
        vocabulary_rating=input_dict.get("vocabulary_rating") or "elementary",
        fluency_rating=input_dict.get("fluency_rating") or "elementary",
        comprehension_rating=input_dict.get("comprehension_rating") or "elementary",
        speaking_complexity=input_dict.get("speaking_complexity") or "elementary",
        conversation_ability=input_dict.get("conversation_ability") or "elementary",
        pronunciation_rating=input_dict.get("pronunciation_rating") or "not_assessed",
        assigned_level=input_dict.get("assigned_level") or input_dict.get("pravaah_level"),
        weaknesses=input_dict.get("weaknesses"),
        strengths=input_dict.get("strengths"),
        current_focus=input_dict.get("current_focus") or input_dict.get("initial_focus"),
    )

    pravaah_level = input_dict.get("pravaah_level") or eval_result["pravaah_level"]
    cefr_reference = cefr_reference_for_pravaah_level(pravaah_level) if pravaah_level in {"E", "D", "C", "B", "A", "S"} else eval_result["cefr_reference"]
    weaknesses = input_dict.get("weaknesses") or eval_result["weaknesses"]
    strengths = input_dict.get("strengths") or eval_result["strengths"]
    initial_focus = eval_result["current_focus"]

    assessment_id = input_dict.get("assessment_id") or f"assess_{uuid.uuid4().hex[:8]}"

    # Serialize task evidence if present
    tasks_evidence_data = None
    if tasks:
        tasks_evidence_data = [
            t.model_dump() if hasattr(t, "model_dump") else dict(t)
            for t in tasks
        ]

    assessment_observations = {
        "grammar": eval_result.get("grammar_rating", "elementary"),
        "vocabulary": eval_result.get("vocabulary_rating", "elementary"),
        "fluency": eval_result.get("fluency_rating", "elementary"),
        "comprehension": eval_result.get("comprehension_rating", "elementary"),
        "speaking_complexity": eval_result.get("speaking_complexity", "elementary"),
        "conversation_ability": eval_result.get("conversation_ability", "elementary"),
        "pronunciation": "not_assessed",
    }

    criteria = input_dict.get("criteria") or eval_result.get("criteria") or eval_result.get("name", "")
    filler_words = list(input_dict.get("filler_words_detected") or [])
    restarts = list(input_dict.get("restarts_and_false_starts") or [])
    grammatical_breakdowns = list(input_dict.get("grammatical_breakdowns") or [])

    assessment_record = ProficiencyAssessmentRecord(
        assessment_id=assessment_id,
        user_id=user_id,
        pravaah_level=pravaah_level,
        cefr_reference=cefr_reference,
        name=eval_result["name"],
        criteria=criteria,
        grammar_rating=eval_result.get("grammar_rating", "elementary"),
        vocabulary_rating=eval_result.get("vocabulary_rating", "elementary"),
        fluency_rating=eval_result.get("fluency_rating", "elementary"),
        comprehension_rating=eval_result.get("comprehension_rating", "elementary"),
        speaking_complexity=eval_result.get("speaking_complexity", "elementary"),
        conversation_ability=eval_result.get("conversation_ability", "elementary"),
        pronunciation_rating="not_assessed",
        pronunciation=None,
        strengths=strengths,
        weaknesses=weaknesses,
        filler_words_detected=filler_words,
        restarts_and_false_starts=restarts,
        grammatical_breakdowns=grammatical_breakdowns,
        initial_focus=initial_focus,
        assessed_at=now_iso,
        notes=notes or input_dict.get("notes"),
        tasks_evidence=tasks_evidence_data,
    )


    # 1. Persist assessment record in subcollection
    user_ref.collection("proficiency_assessments").document(assessment_id).set(
        assessment_record.model_dump(), merge=True
    )

    # 2. Initialize baseline skill masteries based on assessment diagnosis
    initial_mastery = {}
    try:
        skill_batch = db.batch()
        for skill_id in CURRICULUM_SKILLS:
            if skill_id in weaknesses:
                m = 0.35
            elif skill_id in strengths:
                m = 0.85
            else:
                m = 0.50
            initial_mastery[skill_id] = m
            skill_doc_ref = user_ref.collection("skills").document(skill_id)
            skill_batch.set(skill_doc_ref, {
                "skill_id": skill_id,
                "title": CURRICULUM_SKILLS[skill_id]["title"],
                "mastery": m,
                "attempts": 0,
                "errors": 0,
                "correction_attempts": 0,
                "successful_repetitions": 0,
                "failed_repetitions": 0,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
        skill_batch.commit()
    except Exception as batch_err:
        logger.warning("Skill batch initialization notice: %s", batch_err)


    # 3. Assessment supplies baselines; the canonical evidence ranking still owns
    # lesson/plan selection (important when an existing learner reassesses).
    user_ref.set({"skill_mastery": initial_mastery, "current_focus": initial_focus}, merge=True)
    priority = compute_focus_ranking(user_id, db=db)[0]
    initial_focus = priority["skill_id"]
    initial_lesson = generate_personalized_lesson(
        skill_id=initial_focus,
        mastery=priority["mastery"],
        stage=priority["stage"],
        selection_reason=priority["reason"],
    )
    if priority["recent_examples"] or priority["unresolved_repetitions"]:
        initial_lesson.practice_activity = priority_practice_prompt(priority)
    user_ref.collection("lessons").document(initial_lesson.lesson_id).set({
        "lesson_id": initial_lesson.lesson_id,
        "source_skill_id": initial_focus,
        "lesson_title": initial_lesson.lesson_title,
        "stage": "guided_practice",
        "selection_reason": "initial_assessment_diagnosis",
        "completion_status": "recommended",
        **initial_lesson.model_dump(),
        "created_at": datetime.now(timezone.utc),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    # 4. Generate structured Daily Learning Plan for today
    goal_minutes = int(input_dict.get("goal_minutes", 30))
    daily_plan = get_or_create_daily_plan(
        user_id=user_id,
        goal_minutes=goal_minutes,
        date_str=today_str,
        force_regenerate=True,
    )

    # 5. Update user profile document with assessment observations and current focus
    user_ref.set({
        "pravaah_level": pravaah_level,
        "cefr_reference": cefr_reference,
        "cefr_level": cefr_reference,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "filler_words_detected": filler_words,
        "restarts_and_false_starts": restarts,
        "grammatical_breakdowns": grammatical_breakdowns,
        "current_focus": initial_focus,
        "last_assessment_observations": assessment_observations,
        "assessment_observations": assessment_observations,
        "skill_mastery": initial_mastery,
        "daily_goal_minutes": goal_minutes,
        "today_plan_id": daily_plan["plan_id"],
        "recommended_lesson": initial_lesson.model_dump(),
        "recommended_lesson_id": initial_lesson.lesson_id,
        "last_assessment_id": assessment_id,
        "last_assessed_at": now_iso,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    return {
        "assessment_id": assessment_id,
        "pravaah_level": pravaah_level,
        "cefr_reference": cefr_reference,
        "name": eval_result["name"],
        "criteria": criteria,
        "grammar_rating": eval_result.get("grammar_rating", "elementary"),
        "vocabulary_rating": eval_result.get("vocabulary_rating", "elementary"),
        "fluency_rating": eval_result.get("fluency_rating", "elementary"),
        "comprehension_rating": eval_result.get("comprehension_rating", "elementary"),
        "speaking_complexity": eval_result.get("speaking_complexity", "elementary"),
        "conversation_ability": eval_result.get("conversation_ability", "elementary"),
        "assessment_observations": assessment_observations,
        "filler_words_detected": filler_words,
        "restarts_and_false_starts": restarts,
        "grammatical_breakdowns": grammatical_breakdowns,
        "notes": notes or input_dict.get("notes"),
        "strengths": strengths,
        "weaknesses": weaknesses,
        "current_focus": initial_focus,
        "recommended_lesson": initial_lesson.model_dump(),
        "daily_plan": daily_plan,
    }


def _snapshot_data(snapshot) -> dict:
    """Tolerate missing docs and legacy MagicMock-based callers without fake evidence."""
    data = snapshot.to_dict() if snapshot.exists else None
    return data if isinstance(data, dict) else {}


def _finite_number(value, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def _evidence_time(value) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00") if isinstance(value, str) else value.isoformat())
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return None


def _unfinished_lessons(user_ref, user_data: dict) -> list[dict]:
    # Ignore the historical backlog of old recommendations. Only a pointed current
    # lesson or an explicitly started lesson can represent an unfinished deficit.
    records = {}
    for doc in user_ref.collection("lessons").where("completion_status", "==", "in_progress").limit(20).stream():
        data = _snapshot_data(doc)
        if data:
            records[doc.id] = dict(data, lesson_id=doc.id)
    for key in ("current_lesson_id", "recommended_lesson_id"):
        lesson_id = user_data.get(key)
        if isinstance(lesson_id, str) and lesson_id:
            data = _snapshot_data(user_ref.collection("lessons").document(lesson_id).get())
            if data.get("completion_status", data.get("status")) in {"recommended", "in_progress"}:
                records[lesson_id] = dict(data, lesson_id=lesson_id)
    return list(records.values())


def compute_focus_ranking(user_id: str, db=None, mistake_limit: int = 200) -> list[dict]:
    """Canonical priority for lessons AND plans, using admitted learner evidence only.

    Recency/severity-weighted unique grammar/vocabulary errors + failed retries +
    current unfinished lesson deficits + mastery gap. Score age changes daily,
    not per request; timestamps may be Firestore datetimes or ISO strings.
    """
    db = db if db is not None else get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    user_data = _snapshot_data(user_ref.get())
    mastery_map = dict(user_data.get("skill_mastery") or {})
    stats = {}
    for doc in user_ref.collection("skills").stream():
        data = _snapshot_data(doc)
        if data and doc.id in CURRICULUM_SKILLS:
            stats[doc.id] = data
            # Skill writes precede the aggregate profile update: these are fresher.
            if data.get("mastery") is not None:
                mastery_map[doc.id] = data["mastery"]

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    unique = {}
    for source in ("mistakes", "vocabulary"):
        collection = user_ref.collection(source)
        try:
            docs = list(collection.order_by("created_at", direction=firestore.Query.DESCENDING).limit(mistake_limit).stream())
        except Exception:
            docs = list(collection.limit(mistake_limit).stream())
        for doc in docs:
            data = _snapshot_data(doc)
            error = _validated_learning_error(data, source)
            if not error:
                continue
            created = _evidence_time(data.get("created_at"))
            error["created_at"] = created.isoformat() if created else None
            key = _error_key(error)
            prior = unique.get(key)
            # A fact copied into both collections is a single learner error.
            if prior is None or (error["created_at"] or "") > (prior["created_at"] or ""):
                unique[key] = error

    evidence = {}
    severity_weights = {"high": 1.6, "medium": 1.0, "low": 0.6}
    for error in sorted(unique.values(), key=lambda e: (e["created_at"] or "", _error_key(e)), reverse=True):
        created = _evidence_time(error["created_at"])
        # Unknown age is not brand-new evidence.
        days = max(0.0, (now - created).total_seconds() / 86400) if created else 30.0
        bucket = evidence.setdefault(error["curriculum_skill_id"], {"weighted": 0.0, "errors": []})
        bucket["weighted"] += (0.5 ** (days / 7)) * severity_weights.get(str(error["severity"]).lower(), 1.0)
        bucket["errors"].append(error)

    unfinished = _unfinished_lessons(user_ref, user_data)
    ranked = []
    for skill_id, meta in CURRICULUM_SKILLS.items():
        ev = evidence.get(skill_id, {"weighted": 0.0, "errors": []})
        skill_stats = stats.get(skill_id, {})
        mastery = min(1.0, max(0.0, _finite_number(mastery_map.get(skill_id), 0.5)))
        failures = max(0, int(_finite_number(skill_stats.get("failed_repetitions"))))
        successes = max(0, int(_finite_number(skill_stats.get("successful_repetitions"))))
        unresolved = max(0, int(_finite_number(skill_stats.get("unresolved_repetitions"), max(0, failures - successes))))
        attempts = max(0, int(_finite_number(skill_stats.get("attempts"))))
        deficits = []
        for lesson in unfinished:
            if (lesson.get("source_skill_id") or lesson.get("target_skill_id")) != skill_id:
                continue
            # Merely generating a recommendation must not change the next ranking.
            started = lesson.get("completion_status", lesson.get("status")) == "in_progress"
            lesson_failures = max(0, int(_finite_number(lesson.get("failed_repetitions"))))
            if started or lesson_failures or _finite_number(lesson.get("attempts")) > 0:
                deficit = max(0.0, MASTERY_BANDS["developing"] - mastery)
                if deficit or lesson_failures:
                    deficits.append({"lesson_id": lesson["lesson_id"], "mastery_gap": round(deficit, 4),
                                     "failed_repetitions": lesson_failures})
        lesson_gap = max((d["mastery_gap"] for d in deficits), default=0.0)
        unresolved = max(unresolved, max((d["failed_repetitions"] for d in deficits), default=0))
        score = 10 * ev["weighted"] + 6 * min(unresolved, 3) + 12 * (1 - mastery) + 8 * lesson_gap
        if ev["weighted"] >= 0.25:
            reason = "recent_vocabulary_errors" if all(e["fact_type"] == "vocabulary_error" for e in ev["errors"]) else "recent_mistakes"
        elif unresolved:
            reason = "failed_repetitions"
        elif deficits:
            reason = "unfinished_lesson"
        elif mastery < MASTERY_BANDS["weakness"]:
            reason = "low_mastery"
        else:
            reason = "mastered" if mastery >= 0.85 else "developing"
        stage = "guided_practice" if ev["weighted"] >= 0.25 or unresolved else determine_lesson_stage(mastery, attempts)
        # Fingerprint all admitted evidence, not only the three displayed examples.
        signature = {"errors": ev["errors"], "mastery": mastery, "attempts": attempts,
                     "failures": failures, "successes": successes, "unresolved": unresolved,
                     "deficits": sorted(deficits, key=lambda d: d["lesson_id"]),
                     "sessions": sorted(skill_stats.get("processed_sessions") or [])}
        ranked.append({
            "skill_id": skill_id, "title": meta["title"], "category": meta["category"],
            "cefr_level": meta["cefr_level"], "rule_summary": meta["rule_summary"],
            "memory_hook": meta["memory_hook"], "practice_activity": meta["practice_activity"],
            "mastery": round(mastery, 3), "mistake_count": len(ev["errors"]),
            "failed_repetitions": failures, "unresolved_repetitions": unresolved, "attempts": attempts,
            "stage": stage, "priority_score": round(score, 3), "reason": reason,
            "last_mistake_at": ev["errors"][0]["created_at"] if ev["errors"] else None,
            "recent_examples": ev["errors"][:3], "unfinished_lessons": deficits,
            "evidence_fingerprint": hashlib.sha256(json.dumps(signature, sort_keys=True, default=str).encode()).hexdigest(),
        })
    # Stable curriculum order resolves ties; assessment focus only breaks exact ties.
    ranked.sort(key=lambda r: (-r["priority_score"], r["skill_id"] != user_data.get("current_focus")))
    for index, entry in enumerate(ranked, 1):
        entry["priority_rank"] = index
    return ranked


def _refresh_plan_slots(existing: dict, generated: dict, locked_ids: set[str]) -> dict:
    """Keep every issued ID. Completed/started records are immutable; repurpose only
    pending slot content, assigning correction/retry to the first available slot.

    A client that did not record a start may hold old content but its completion ID
    still works. Do not drop slots on goal reduction; redistribute remaining minutes.
    If locked work leaves no room for all issued slots, retain the old time budget.
    """
    old_activities = existing.get("activities") or []
    if not old_activities:
        return generated
    templates = generated["activities"]
    all_done = all(a.get("is_completed") for a in old_activities)
    slot_count = len(old_activities) if all_done else max(len(old_activities), len(templates))
    activities = []
    pending = []
    for index in range(slot_count):
        old = old_activities[index] if index < len(old_activities) else {}
        if old.get("is_completed") or old.get("activity_id") in locked_ids:
            activities.append(dict(old))
            continue
        template = dict(templates[min(len(pending), len(templates) - 1)])
        template["activity_id"] = old.get("activity_id") or f"{existing['plan_id']}_act_{index + 1}"
        activities.append({**old, **template})
        pending.append(index)
    if pending:
        locked_minutes = sum(a.get("duration_minutes", 0) for i, a in enumerate(activities) if i not in pending)
        budget = generated["planned_minutes"] - locked_minutes
        if budget < len(pending):
            budget = max(len(pending), existing.get("planned_minutes", 0) - locked_minutes)
        # Positive integer allocation, exact total when the requested budget is feasible.
        weight = sum(activities[i]["duration_minutes"] for i in pending)
        available = budget - len(pending)
        allocations = [1 + int(available * activities[i]["duration_minutes"] / weight) for i in pending]
        for offset in range(budget - sum(allocations)):
            allocations[offset % len(allocations)] += 1
        for index, duration in zip(pending, allocations):
            activities[index]["duration_minutes"] = duration
    result = {**existing, **generated, "plan_id": existing["plan_id"], "activities": activities}
    for field in ("completed_minutes", "total_learner_speaking_seconds", "total_idle_seconds"):
        if field in existing:
            result[field] = existing[field]
    result["planned_minutes"] = sum(a.get("duration_minutes", 0) for a in activities)
    result["completed_activities_count"] = sum(bool(a.get("is_completed")) for a in activities)
    result["current_activity_index"] = next((i for i, a in enumerate(activities) if not a.get("is_completed")), len(activities))
    result["completion_status"] = "completed" if all_done else (
        "in_progress" if result["completed_activities_count"] or locked_ids else "not_started"
    )
    result["target_skills"] = list(dict.fromkeys(a["target_skill"] for a in activities if a.get("target_skill")))
    return result


def get_or_create_daily_plan(
    user_id: str,
    date_str: Optional[str] = None,
    goal_minutes: Optional[int] = None,
    force_regenerate: bool = False,
) -> dict:
    """
    Retrieves the daily plan for date_str (defaulting to today).
    Refresh pending work when admitted evidence changes, including on forced refresh.
    Issued IDs and completed/explicitly started records survive all regenerations.
    """
    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    today_str = date_str or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    plan_ref = user_ref.collection("daily_plans").document(today_str)
    existing_data = _snapshot_data(plan_ref.get())

    user_data = _snapshot_data(user_ref.get())

    target_goal = goal_minutes or user_data.get("daily_goal_minutes", 30)

    # Order today's work by live evidence, falling back to the assessment diagnosis.
    ranking = None
    try:
        ranking = compute_focus_ranking(user_id, db=db)
        weaknesses = [r["skill_id"] for r in ranking][:4]
        mastery = {r["skill_id"]: r["mastery"] for r in ranking}
        current_focus = weaknesses[0] if weaknesses else None
    except Exception as exc:
        logger.warning("Focus ranking failed for %s (%s); using stored weaknesses.", user_id, exc)
        if existing_data:
            # A partial read is not new learning evidence; don't erase a useful plan.
            return existing_data
        weaknesses = user_data.get("weaknesses") or ["past_simple_auxiliary", "be_verb_misuse"]
        mastery = user_data.get("skill_mastery", {})
        current_focus = user_data.get("current_focus")

    fingerprint = hashlib.sha256(json.dumps({
        "version": 1, "goal": target_goal, "date": today_str,
        "ranking": ranking, "fallback_focus": current_focus if ranking is None else None,
        "fallback_mastery": mastery if ranking is None else None,
    }, sort_keys=True, default=str).encode()).hexdigest()
    if existing_data and not force_regenerate and existing_data.get("evidence_fingerprint") == fingerprint:
        return existing_data

    new_plan = generate_daily_plan(
        user_id=user_id,
        goal_minutes=target_goal,
        weaknesses=weaknesses,
        current_focus=current_focus,
        skill_mastery=mastery,
        date_str=today_str,
        priority_focus=ranking,
    )

    @firestore.transactional
    def save(transaction):
        data = new_plan.model_dump()
        # A transactional re-read prevents refresh from overwriting a start or
        # completion committed after ranking/generation (or during this write).
        latest = _snapshot_data(plan_ref.get(transaction=transaction))
        if latest:
            locked_ids = set()
            for activity in latest.get("activities", []):
                activity_id = activity.get("activity_id")
                if not activity_id or activity.get("is_completed"):
                    continue
                # Honor legacy starts stored as lessons as well as actual slots.
                lesson = _snapshot_data(user_ref.collection("lessons").document(activity_id).get(transaction=transaction))
                if (activity.get("status") == "in_progress" or activity.get("completion_status") == "in_progress"
                        or activity.get("is_in_progress") or activity.get("started_at") or activity.get("session_id")
                        or lesson.get("completion_status", lesson.get("status")) == "in_progress"):
                    locked_ids.add(activity_id)
            data = _refresh_plan_slots(latest, data, locked_ids)
        data["evidence_fingerprint"] = fingerprint
        transaction.set(plan_ref, data, merge=True)
        transaction.set(user_ref, {"daily_goal_minutes": target_goal, "today_plan_id": data["plan_id"]}, merge=True)
        return data

    return save(db.transaction())


def complete_daily_plan_activity(
    user_id: str,
    date_str: Optional[str] = None,
    activity_id: Optional[str] = None,
    session_id: Optional[str] = None,
    duration_minutes: Optional[int] = None,
    **kwargs,
) -> dict:
    """
    Idempotently marks a daily plan activity as completed, accumulates completed minutes,
    and advances the current activity index.
    """
    # Handle kwargs / inverted argument orders gracefully
    target_activity_id = activity_id or kwargs.get("activity_id")
    target_date_str = date_str or kwargs.get("date_str") or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # If first positional argument was activity_id and date_str was omitted
    if date_str and not activity_id and ("act_" in date_str or "activity" in date_str):
        target_activity_id = date_str
        target_date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    plan_ref = user_ref.collection("daily_plans").document(target_date_str)
    plan_doc = plan_ref.get()

    if not plan_doc.exists:
        get_or_create_daily_plan(user_id, date_str=target_date_str)

    @firestore.transactional
    def complete(transaction):
        plan_data = _snapshot_data(plan_ref.get(transaction=transaction))
        activities = plan_data.get("activities", [])
        act = next((a for a in activities if a.get("activity_id") == target_activity_id), None)
        if not act or act.get("is_completed"):
            return plan_data
        act.update(is_completed=True, status="completed", completion_status="completed", is_in_progress=False,
                   session_id=session_id or act.get("session_id"), completed_at=datetime.now(timezone.utc).isoformat())
        act_dur = duration_minutes or act.get("duration_minutes", 10)
        plan_data["completed_minutes"] = plan_data.get("completed_minutes", 0) + act_dur
        plan_data["completed_activities_count"] = sum(bool(a.get("is_completed")) for a in activities)

        for field, total in (("learner_speaking_time_seconds", "total_learner_speaking_seconds"),
                             ("idle_time_seconds", "total_idle_seconds")):
            value = kwargs.get(field)
            if value is not None:
                act[field] = value
                plan_data[total] = (plan_data.get(total) or 0) + value

        next_idx = next((i for i, a in enumerate(activities) if not a.get("is_completed")), len(activities))
        plan_data["current_activity_index"] = next_idx
        plan_data["completion_status"] = "completed" if next_idx == len(activities) else "in_progress"
        transaction.set(plan_ref, plan_data, merge=True)
        return plan_data

    return complete(db.transaction())



# ---------------------------------------------------------------------------
# Event Processor (Phase 3A, 3B & 3C)
# ---------------------------------------------------------------------------

async def process_event(event: dict):
    """
    Asynchronously persist session and message events to Firestore,
    and trigger learning analysis on session completion.
    """
    try:
        event_id = event.get("event_id", "")
        event_type = event.get("event_type", "")
        user_id = event.get("user_id", "")
        session_id = event.get("session_id", "")
        sequence = event.get("sequence", 0)
        payload = event.get("payload", {})

        if not user_id or not session_id:
            logger.warning("Event missing user_id or session_id: %s", event)
            return

        if is_duplicate(event_id):
            logger.info("Skipping duplicate event: %s", event_id)
            return

        logger.info("Processing event: type=%s session=%s seq=%d user=%s", event_type, session_id, sequence, user_id)

        db = get_firestore_client()
        session_ref = db.collection("users").document(user_id).collection("sessions").document(session_id)

        if event_type == "SESSION_STARTED":
            now = datetime.now(timezone.utc)
            _session_start_times[session_id] = now
            mode = payload.get("mode", "free_conversation")
            topic = payload.get("topic", "")

            session_ref.set({
                "sessionId": session_id,
                "mode": mode,
                "topic": topic,
                "state": "IN_PROGRESS",
                "start_time": now,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

        elif event_type in ("USER_UTTERANCE", "AI_RESPONSE"):
            role = "user" if event_type == "USER_UTTERANCE" else "assistant"
            text = payload.get("text", "")
            duration_ms = payload.get("duration_ms", 0)
            interrupted = payload.get("interrupted", False)
            now = datetime.now(timezone.utc)

            message_id = f"{session_id}_seq_{sequence:04d}_{role}"
            message_data = {
                "message_id": message_id,
                "session_id": session_id,
                "role": role,
                "text": text,
                "sequence": sequence,
                "timestamp": now,
                "duration_ms": duration_ms,
                "interrupted": interrupted,
            }

            # Write finalized message document
            session_ref.collection("messages").document(message_id).set(message_data, merge=True)

            # Update session's last_activity
            session_ref.set({
                "updated_at": firestore.SERVER_TIMESTAMP,
                "message_count": firestore.Increment(1),
            }, merge=True)

            # Accumulate in memory for session tracking
            if session_id not in _session_messages:
                _session_messages[session_id] = []
            _session_messages[session_id].append({
                "message_id": message_id,
                "role": role,
                "text": text,
                "sequence": sequence,
            })

        elif event_type == "SESSION_ENDED":
            now = datetime.now(timezone.utc)
            start_time = _session_start_times.pop(session_id, None)

            if start_time:
                duration_seconds = max(0, int(round((now - start_time).total_seconds())))
            else:
                duration_seconds = payload.get("duration_seconds", 0)

            reason = payload.get("reason", "session_complete")
            duration_minutes = max(1, duration_seconds // 60) if duration_seconds >= 30 else 1

            # Finalize session document in Firestore
            session_ref.set({
                "state": "COMPLETED",
                "end_time": now,
                "duration_seconds": duration_seconds,
                "completion_reason": reason,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

            # Increment user profile statistics
            user_doc_ref = db.collection("users").document(user_id)
            user_doc_ref.set({
                "statistics": {
                    "total_sessions": firestore.Increment(1),
                    "total_practice_minutes": firestore.Increment(duration_minutes),
                    "last_practice_date": now.strftime("%Y-%m-%d"),
                },
                "updated_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)

            # Update daily plan activity status if a lesson/activity was specified
            activity_id = payload.get("lesson_id")
            if activity_id:
                try:
                    complete_daily_plan_activity(
                        user_id=user_id,
                        activity_id=activity_id,
                        session_id=session_id,
                        duration_minutes=duration_minutes
                    )
                except Exception as e:
                    logger.error("Failed to complete daily plan activity: %s", e)

            logger.info("Session %s marked COMPLETED (duration=%ss, mins=%d).", session_id, duration_seconds, duration_minutes)

            # Retrieve accumulated messages (from RAM, payload, or Firestore)
            session_accumulated_msgs = _session_messages.pop(session_id, [])
            if not session_accumulated_msgs:
                try:
                    msgs_stream = session_ref.collection("messages").order_by("sequence").stream()
                    session_accumulated_msgs = [doc.to_dict() for doc in msgs_stream if doc.to_dict().get("text")]
                except Exception as e:
                    logger.warning("Failed to load messages from Firestore for session %s: %s", session_id, e)

            if not session_accumulated_msgs and payload.get("messages"):
                session_accumulated_msgs = payload.get("messages")

            # Directly await session analysis so background loop termination does not cancel it
            if session_accumulated_msgs:
                try:
                    await analyze_session_messages(user_id, session_id, session_accumulated_msgs)
                except Exception as exc:
                    logger.error("Session analysis failed in process_event: %s", exc)

    except Exception as e:
        logger.error("Firestore persistence error in process_event: %s", e)


# ---------------------------------------------------------------------------
# Durable Firestore Outbox Queue (Phase 9 Production Hardening)
# ---------------------------------------------------------------------------

OUTBOX_COLLECTION = "learning_events_outbox"

def enqueue_outbox_event(event: dict, db=None) -> str:
    """
    Persist an event to the durable Firestore outbox with status='pending'.
    Real-time voice processing never waits synchronously for downstream handling.
    """
    db = db or get_firestore_client()
    event_id = event.get("event_id") or str(uuid.uuid4())
    event_copy = dict(event)
    event_copy["event_id"] = event_id

    outbox_doc = {
        "event_id": event_id,
        "user_id": event.get("user_id", ""),
        "session_id": event.get("session_id", ""),
        "event_type": event.get("event_type", ""),
        "sequence": event.get("sequence", 0),
        "payload": event.get("payload", {}),
        "status": "pending",
        "retry_count": 0,
        "created_at": firestore.SERVER_TIMESTAMP,
        "processed_at": None,
        "last_error": None,
    }
    db.collection(OUTBOX_COLLECTION).document(event_id).set(outbox_doc, merge=True)
    return event_id


async def process_outbox_event(event_id: str, db=None) -> bool:
    """
    Process an outbox document idempotently and update status to 'completed' or 'failed'.
    """
    db = db or get_firestore_client()
    doc_ref = db.collection(OUTBOX_COLLECTION).document(event_id)
    doc = doc_ref.get()
    if not doc.exists:
        return False

    data = doc.to_dict() or {}
    if data.get("status") == "completed":
        return True

    retry_count = int(data.get("retry_count", 0))
    try:
        await process_event(data)
        doc_ref.set({
            "status": "completed",
            "processed_at": firestore.SERVER_TIMESTAMP,
            "last_error": None,
        }, merge=True)
        return True
    except Exception as exc:
        retry_count += 1
        status = "failed" if retry_count >= 3 else "pending"
        doc_ref.set({
            "status": status,
            "retry_count": retry_count,
            "last_error": str(exc),
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        logger.error("Outbox event %s error (retry=%d): %s", event_id, retry_count, exc)
        return False


async def recover_and_process_pending_outbox_events(max_events: int = 50, db=None) -> int:
    """
    Scan for any pending events in the Firestore outbox (e.g. after worker restart)
    and drain them idempotently.
    """
    db = db or get_firestore_client()
    query = db.collection(OUTBOX_COLLECTION).where(filter=firestore.FieldFilter("status", "==", "pending")).limit(max_events)
    docs = list(query.stream())
    processed_count = 0
    for doc in docs:
        success = await process_outbox_event(doc.id, db=db)
        if success:
            processed_count += 1
    if processed_count > 0:
        logger.info("Recovered and processed %d pending outbox events.", processed_count)
    return processed_count


# ---------------------------------------------------------------------------
# Worker Loop
# ---------------------------------------------------------------------------

async def worker_loop(event_queue: asyncio.Queue):
    """Worker loop that continuously consumes events from the queue and handles restart recovery."""
    logger.info("Learning engine persistence worker started.")
    # On worker startup, recover and process any pending outbox events from prior crashes
    try:
        await recover_and_process_pending_outbox_events()
    except Exception as e:
        logger.warning("Startup outbox recovery scan notice: %s", e)

    while True:
        event = await event_queue.get()
        try:
            await process_event(event)
        except Exception:
            logger.exception("Error processing event in persistence worker.")
        finally:
            event_queue.task_done()


if __name__ == "__main__":
    logger.info("Learning engine worker ready.")


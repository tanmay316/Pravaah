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
# Lazy import genai only if needed as fallback

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
    select_next_adaptive_skill,
    map_to_curriculum_skill,
    generate_personalized_lesson,
    calculate_mastery_update,
    MASTERY_DECAY_LAMBDA,
    EVIDENCE_DELTAS,
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("learning-engine")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ANALYSIS_MODEL = os.getenv("ANALYSIS_MODEL", "gemini-3.5-flash-lite")
ASSESSMENT_MODEL = os.getenv("ASSESSMENT_MODEL", "gemini-3.5-flash-lite")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gemini-2.5-flash")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "")
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.75"))

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

    # Format transcript for model
    transcript_lines = []
    for turn in user_turns:
        msg_id = turn.get("message_id", f"{session_id}_seq_{turn.get('sequence', 0):04d}_user")
        transcript_lines.append(f"[message_id: {msg_id}] LEARNER: {turn.get('text', '')}")

    transcript_text = "\n".join(transcript_lines)
    user_prompt = f"Session ID: {session_id}\n\nLearner Messages:\n{transcript_text}"

    logger.info("Running session analysis for user=%s session=%s (turns=%d)", user_id, session_id, len(user_turns))

    # 2. Call Groq Cloud / Gemini / LiteLLM with structured JSON output and safe retry
    parsed_result = SessionAnalysisResult(mistakes=[], vocabulary=[])
    max_retries = 2
    groq_key = os.getenv("GROQ_API_KEY")
    api_key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY")

    if groq_key:
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
        except Exception as groq_err:
            logger.warning("Groq session analysis notice: %s; trying Gemini fallback", groq_err)

    if not parsed_result.mistakes and not parsed_result.vocabulary and api_key:
        try:
            genai_model_name = model.replace("gemini/", "").replace("gemini-3.5-flash-lite", "gemini-2.5-flash")
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
        except Exception as e:
            logger.warning("Direct genai session analysis failed: %s; falling back to litellm", e)

    if not parsed_result.mistakes and not parsed_result.vocabulary:
        for attempt in range(1, max_retries + 1):
            try:
                litellm_model = f"gemini/{model}" if not model.startswith("gemini/") and "tutor-model" not in model else model
                kwargs = {
                    "model": litellm_model,
                    "api_key": api_key,
                    "fallbacks": [
                        "openrouter/minimax/minimax-01",
                        "gemini/gemini-2.5-flash",
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
                break
            except Exception as e:
                logger.warning("Session analysis attempt %d failed: %s", attempt, e)
                if attempt == max_retries:
                    logger.error("Failed to parse analysis output after %d attempts.", max_retries)
                    return SessionAnalysisResult(mistakes=[], vocabulary=[])

    # 3. Filter high-confidence items only
    filtered_mistakes = [
        m for m in parsed_result.mistakes
        if m.confidence >= confidence_threshold and m.original.strip().lower() != m.corrected.strip().lower()
    ]
    filtered_vocab = [
        v for v in parsed_result.vocabulary
        if v.confidence >= confidence_threshold and v.original_usage.strip()
    ]

    final_result = SessionAnalysisResult(mistakes=filtered_mistakes, vocabulary=filtered_vocab)

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
                        "created_at": now,
                        "updated_at": firestore.SERVER_TIMESTAMP,
                    }
                    user_ref.collection("mistakes").document(mistake_id).set(doc_data, merge=True)
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
                term = vocab.suggested_alternative or vocab.original_usage
                doc_data = {
                    "vocabulary_id": vocab_id,
                    "session_id": session_id,
                    "message_id": vocab.message_id,
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
                    "created_at": now,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                }
                user_ref.collection("vocabulary").document(vocab_id).set(doc_data, merge=True)

            # 5. Update skill-level mastery & learner profile (Phase 3C)
            await update_learner_mastery(user_id, session_id, final_result, messages)

            logger.info(
                "Session %s analysis persisted: %d mistakes recorded, mastery updated.",
                session_id, len(final_result.mistakes)
            )
        except Exception as e:
            logger.error("Failed to persist analysis to Firestore: %s", e)

    return final_result


# ---------------------------------------------------------------------------
# Evidence-Based Learner Mastery & Profile Update (Phase 3C)
# ---------------------------------------------------------------------------

def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9\s]", "", text.lower()).strip()


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
    for fact in analysis.mistakes:
        if fact.fact_type not in ("grammar_error", "vocabulary_error", "natural_alternative"):
            continue
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
        prompt_index = next((
            i for i in range(source_index + 1, len(ordered))
            if ordered[i].get("role") == "assistant"
            and any(token in ordered[i].get("text", "").lower() for token in ("repeat", "try saying", "say ", "say'", "correction"))
        ), -1)
        if prompt_index < 0:
            continue
        reply = next((item for item in ordered[prompt_index + 1:] if item.get("role") == "user"), None)
        if not reply:
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

    # 1. Group mistakes by curriculum skill ID (only genuine errors)
    skill_errors: dict[str, list[GrammarMistakeFact]] = {}
    for m in analysis.mistakes:
        if m.fact_type in ("grammar_error", "vocabulary_error"):
            skill_id = m.curriculum_skill_id or map_to_curriculum_skill(m.category, m.original, m.short_explanation)
            if skill_id not in skill_errors:
                skill_errors[skill_id] = []
            skill_errors[skill_id].append(m)

    # 2. Correct repetitions require an actual tutor prompt followed by learner evidence.
    skill_corrections, skill_failed_repetitions = _repetition_evidence(analysis, messages)
    learner_turns = [turn for turn in messages if turn.get("role", "user") == "user"]

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
    session_doc = user_ref.collection("sessions").document(session_id).get()
    session_data = session_doc.to_dict() if session_doc.exists else {}
    active_target_skill = session_data.get("target_skill") or (list(skill_errors.keys())[0] if skill_errors else None)
    active_lesson_id = session_data.get("lesson_id")

    duration_sec = int(session_data.get("duration_seconds", 0))
    if not active_lesson_id and active_target_skill:
        active_lesson_id = make_deterministic_id("lesson", session_id, active_target_skill)

    if active_target_skill and active_lesson_id:
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
        user_ref.collection("lessons").document(active_lesson_id).set(lesson_record.model_dump(), merge=True)

    # 7. Adaptive Skill & Lesson Selection (Phase 5)
    # Estimate total session count from user skills processed sessions
    all_sess = set()
    for s_data in updated_skill_stats.values():
        all_sess.update(s_data.get("processed_sessions", []))
    session_count = max(len(all_sess), 1)

    # Run deterministic adaptive selector
    next_skill, next_stage, next_reason = select_next_adaptive_skill(
        all_skill_mastery,
        skill_stats=updated_skill_stats,
        just_completed_skill=active_target_skill,
        session_count=session_count,
    )

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

    # 8. Preserve Pravaah Level & CEFR Reference (Unassessed default for new learners)
    existing_user_doc = user_ref.get()
    existing_user_data = existing_user_doc.to_dict() if existing_user_doc.exists else {}

    # Explicit initial state: "unassessed" if no dedicated onboarding/assessment occurred
    pravaah_level = existing_user_data.get("pravaah_level")
    cefr_reference = existing_user_data.get("cefr_reference")
    legacy_cefr = existing_user_data.get("cefr_level") or existing_user_data.get("level")

    if not pravaah_level:
        if legacy_cefr in ["A1", "A2", "B1", "B2", "C1", "C2"]:
            cefr_to_pravaah = {"A1": "E", "A2": "C", "B1": "B", "B2": "A", "C1": "S", "C2": "S"}
            pravaah_level = cefr_to_pravaah.get(legacy_cefr, "C")
            cefr_reference = legacy_cefr
        else:
            pravaah_level = "unassessed"
            cefr_reference = "unassessed"
    elif not cefr_reference or cefr_reference == "unassessed":
        cefr_reference = cefr_reference_for_pravaah_level(pravaah_level) if pravaah_level != "unassessed" else "unassessed"

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

    # Phase 6: Auto-update today's active daily plan if session practiced an activity
    try:
        today_str = now.strftime("%Y-%m-%d")
        daily_plan_doc = user_ref.collection("daily_plans").document(today_str).get()
        if daily_plan_doc.exists:
            dp_data = daily_plan_doc.to_dict() or {}
            curr_idx = dp_data.get("current_activity_index", 0)
            acts = dp_data.get("activities", [])
            if 0 <= curr_idx < len(acts):
                curr_act = acts[curr_idx]
                if not curr_act.get("is_completed"):
                    complete_daily_plan_activity(
                        user_id=user_id,
                        date_str=today_str,
                        activity_id=curr_act.get("activity_id"),
                        session_id=session_id,
                        duration_minutes=int(round(duration_sec / 60)) or curr_act.get("duration_minutes", 10),
                    )
    except Exception as e:
        logger.warning("Could not auto-advance daily plan: %s", e)

    return {
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
    grammar_rating: str = "elementary"
    vocabulary_rating: str = "elementary"
    speaking_complexity: str = "elementary"
    fluency_rating: str = "elementary"
    comprehension_rating: str = "elementary"
    conversation_ability: str = "elementary"
    pronunciation_rating: str = "not_assessed"
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
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    initial_focus: str
    assessed_at: str
    notes: Optional[str] = None
    tasks_evidence: Optional[list[dict]] = None


ASSESSMENT_SYSTEM_PROMPT = """You are an expert diagnostic ESL assessor evaluating a Hindi-speaking learner's spoken English proficiency.

You are evaluating evidence from 4 diagnostic tasks:
- Task 1: Introduction & Daily Routine (Target A1/A2: present simple stability, basic everyday vocabulary, immediate responsiveness)
- Task 2: Past Experience & Storytelling (Target A2/B1: past tense auxiliaries like did/didn't + base verb, irregular verbs, narrative sequencing)
- Task 3: Opinion & Reasoning (Target B1/B2: stative verbs, connectors, comparative phrasing, argumentation depth)
- Task 4: Hypothetical & Complex Discussion (Target B2/C1: conditionals, modal verbs, complex sentences, nuance)

Assess the learner across these 6 linguistic and conversational dimensions:
1. Grammar Accuracy: (From verbatim transcripts) Tense usage, subject-verb agreement, auxiliary verbs, articles, prepositions. Check for common Hindi-English patterns (e.g. 'didn't went', 'I am agree', 'he don't know', 'I am having').
2. Vocabulary & Collocations: (From transcripts) Range, precision, appropriate word choices, natural collocations.
3. Speaking Complexity: (From transcripts) Sentence structure, coordination vs subordination, phrase length.
4. Fluency & Hesitation: (From BOTH transcript AND telemetry) Consider pause count, long pauses (>1.5s), WPM, restarts/false starts, and response latency.
5. Comprehension: (From transcript against prompt) Did the learner directly understand and address the specific task prompt?
6. Conversational Ability: (From turn behavior + transcript) Topic elaboration, conversational responsiveness.
(NOTE: Pronunciation is NOT evaluated from text/telemetry in V1. Set pronunciation_rating to "not_assessed").

Return a valid JSON object with EXACTLY this structure:
{
  "grammar_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "vocabulary_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "speaking_complexity": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "fluency_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "comprehension_rating": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "conversation_ability": "beginner" | "basic" | "elementary" | "intermediate" | "advanced" | "mastery",
  "pronunciation_rating": "not_assessed",
  "analysis_notes": "<2-3 sentence qualitative diagnostic summary detailing specific grammatical and fluency observations>"
}

Rating Guidelines:
- beginner (E / A1): Fragmented phrases, isolated words, frequent basic errors in agreement or basic vocabulary.
- basic (D / A1-A2): Basic connected sentences with effort; frequent past tense auxiliary errors (e.g. didn't went) or be-verb misuse.
- elementary (C / A2): Handles everyday topics; frequent errors in past tense, stative verbs, or prepositions.
- intermediate (B / B1): Comfortable on familiar topics; errors mostly in prepositions, nuance, or natural collocations.
- advanced (A / B2-C1): Fluent, complex sentences; minor collocation refinement needed.
- mastery (S / C1-C2+): Near-native precision, effortless fluency, broad idiom and vocabulary range.

Return ONLY the JSON object, no other text."""


async def analyze_assessment_evidence(
    tasks: list[dict | AssessmentTaskEvidence],
    model: Optional[str] = None,
) -> dict:
    """
    Evaluates structured task-aware diagnostic spoken evidence using the configured Gemini model.
    """
    import google.generativeai as genai

    active_model = model or os.getenv("ANALYSIS_MODEL", "gemini-2.5-flash")
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

    # 1. Primary: Groq Cloud (Ultra-fast evaluation using openai/gpt-oss-120b or openai/gpt-oss-20b)
    groq_key = os.getenv("GROQ_API_KEY") or "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"
    if groq_key:
        try:
            from groq import Groq
            gclient = Groq(api_key=groq_key)
            groq_assess_model = os.getenv("GROQ_ASSESSMENT_MODEL", "openai/gpt-oss-120b")
            g_resp = await asyncio.wait_for(
                asyncio.to_thread(
                    gclient.chat.completions.create,
                    model=groq_assess_model,
                    messages=[
                        {"role": "system", "content": ASSESSMENT_SYSTEM_PROMPT},
                        {"role": "user", "content": f"Evidence for Evaluation:\n{evidence_text}"},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=1000,
                    temperature=0.2,
                ),
                timeout=12.0
            )
            raw_text = g_resp.choices[0].message.content or "{}"
            parsed = json.loads(raw_text.strip())
            validated = AssessmentObservationOutput.model_validate(parsed)
            result = {}
            for k in ["grammar_rating", "vocabulary_rating", "speaking_complexity", "fluency_rating", "comprehension_rating", "conversation_ability"]:
                val = getattr(validated, k, "elementary").lower()
                result[k] = val if val in valid_ratings else "elementary"
            result["pronunciation_rating"] = "not_assessed"
            result["analysis_notes"] = validated.analysis_notes
            return result
        except Exception as groq_err:
            logger.warning("Groq assessment evaluation notice for gpt-oss-120b: %s; trying gpt-oss-20b fallback", groq_err)
            try:
                from groq import Groq
                gclient = Groq(api_key=groq_key)
                g_resp = await asyncio.wait_for(
                    asyncio.to_thread(
                        gclient.chat.completions.create,
                        model="openai/gpt-oss-20b",
                        messages=[
                            {"role": "system", "content": ASSESSMENT_SYSTEM_PROMPT},
                            {"role": "user", "content": f"Evidence for Evaluation:\n{evidence_text}"},
                        ],
                        response_format={"type": "json_object"},
                        max_tokens=800,
                        temperature=0.2,
                    ),
                    timeout=8.0
                )
                raw_text = g_resp.choices[0].message.content or "{}"
                parsed = json.loads(raw_text.strip())
                validated = AssessmentObservationOutput.model_validate(parsed)
                result = {}
                for k in ["grammar_rating", "vocabulary_rating", "speaking_complexity", "fluency_rating", "comprehension_rating", "conversation_ability"]:
                    val = getattr(validated, k, "elementary").lower()
                    result[k] = val if val in valid_ratings else "elementary"
                result["pronunciation_rating"] = "not_assessed"
                result["analysis_notes"] = validated.analysis_notes
                return result
            except Exception as fallback_err:
                logger.warning("Groq fallback failed: %s; trying Gemini", fallback_err)

    # 2. Secondary: Google Generative AI
    if api_key:
        try:
            import google.generativeai as genai
            genai_model_name = active_model.replace("gemini/", "").replace("gemini-3.5-flash-lite", "gemini-2.5-flash")
            genai.configure(api_key=api_key)
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

            result = {}
            for k in ["grammar_rating", "vocabulary_rating", "speaking_complexity", "fluency_rating", "comprehension_rating", "conversation_ability"]:
                val = getattr(validated, k, "elementary").lower()
                result[k] = val if val in valid_ratings else "elementary"
            result["pronunciation_rating"] = "not_assessed"
            result["analysis_notes"] = validated.analysis_notes
            return result
        except Exception as e:
            logger.warning("Generative AI assessment analysis notice: %s", e)

    # 3. Fallback to litellm if direct calls failed
    try:
        kwargs = {
            "model": "gemini/gemini-2.5-flash",
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
        result = {}
        for k in ["grammar_rating", "vocabulary_rating", "speaking_complexity", "fluency_rating", "comprehension_rating", "conversation_ability"]:
            val = getattr(validated, k, "elementary").lower()
            result[k] = val if val in valid_ratings else "elementary"
        result["pronunciation_rating"] = "not_assessed"
        result["analysis_notes"] = validated.analysis_notes
        return result
    except Exception as e:
        logger.error("All assessment analysis fallbacks failed: %s; returning baseline rubric", e)
        return {
            "grammar_rating": "elementary",
            "vocabulary_rating": "elementary",
            "speaking_complexity": "elementary",
            "fluency_rating": "elementary",
            "comprehension_rating": "elementary",
            "conversation_ability": "elementary",
            "pronunciation_rating": "not_assessed",
            "analysis_notes": "Diagnostic analysis evaluated via baseline rubric standards.",
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

    # If raw task evidence is provided without pre-set ratings, analyze with Gemini
    has_explicit_ratings = any(input_dict.get(k) for k in [
        "grammar_rating", "vocabulary_rating", "fluency_rating", "assigned_level", "pravaah_level"
    ])

    if tasks and not has_explicit_ratings:
        analyzed_ratings = await analyze_assessment_evidence(tasks)
        if analyzed_ratings:
            input_dict.update(analyzed_ratings)
            if analyzed_ratings.get("analysis_notes") and not notes:
                notes = analyzed_ratings["analysis_notes"]

    # Run structured rubric evaluation
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
        current_focus=input_dict.get("current_focus") or input_dict.get("initial_focus"),
    )

    pravaah_level = eval_result["pravaah_level"]
    cefr_reference = eval_result["cefr_reference"]
    weaknesses = eval_result["weaknesses"]
    strengths = eval_result["strengths"]
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

    assessment_record = ProficiencyAssessmentRecord(
        assessment_id=assessment_id,
        user_id=user_id,
        pravaah_level=pravaah_level,
        cefr_reference=cefr_reference,
        name=eval_result["name"],
        criteria=eval_result["criteria"],
        grammar_rating=eval_result.get("grammar_rating", "elementary"),
        vocabulary_rating=eval_result.get("vocabulary_rating", "elementary"),
        fluency_rating=eval_result.get("fluency_rating", "elementary"),
        comprehension_rating=eval_result.get("comprehension_rating", "elementary"),
        speaking_complexity=eval_result.get("speaking_complexity", "elementary"),
        conversation_ability=eval_result.get("conversation_ability", "elementary"),
        pronunciation_rating="not_assessed",
        strengths=strengths,
        weaknesses=weaknesses,
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


    # 3. Generate initial personalized lesson for initial focus
    initial_lesson = generate_personalized_lesson(
        skill_id=initial_focus,
        mastery=initial_mastery.get(initial_focus, 0.35),
        stage="guided_practice",
        selection_reason="initial_assessment_diagnosis",
    )
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
    daily_plan = generate_daily_plan(
        user_id=user_id,
        goal_minutes=goal_minutes,
        weaknesses=weaknesses,
        current_focus=initial_focus,
        skill_mastery=initial_mastery,
        date_str=today_str,
    )
    user_ref.collection("daily_plans").document(today_str).set(
        daily_plan.model_dump(), merge=True
    )

    # 5. Update user profile document with assessment observations and current focus
    user_ref.set({
        "pravaah_level": pravaah_level,
        "cefr_reference": cefr_reference,
        "cefr_level": cefr_reference,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "current_focus": initial_focus,
        "last_assessment_observations": assessment_observations,
        "assessment_observations": assessment_observations,
        "skill_mastery": initial_mastery,
        "daily_goal_minutes": goal_minutes,
        "today_plan_id": daily_plan.plan_id,
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
        "criteria": eval_result["criteria"],
        "grammar_rating": eval_result.get("grammar_rating", "elementary"),
        "vocabulary_rating": eval_result.get("vocabulary_rating", "elementary"),
        "fluency_rating": eval_result.get("fluency_rating", "elementary"),
        "comprehension_rating": eval_result.get("comprehension_rating", "elementary"),
        "speaking_complexity": eval_result.get("speaking_complexity", "elementary"),
        "conversation_ability": eval_result.get("conversation_ability", "elementary"),
        "pronunciation_rating": "not_assessed",
        "assessment_observations": assessment_observations,
        "pronunciation": eval_result.get("pronunciation", "Not assessed in V1 (audio-level phonetic analysis deferred)"),
        "notes": notes or input_dict.get("notes"),
        "strengths": strengths,
        "weaknesses": weaknesses,
        "current_focus": initial_focus,
        "recommended_lesson": initial_lesson.model_dump(),
        "daily_plan": daily_plan.model_dump(),
    }


def get_or_create_daily_plan(
    user_id: str,
    date_str: Optional[str] = None,
    goal_minutes: Optional[int] = None,
) -> dict:
    """
    Retrieves the daily plan for date_str (defaulting to today).
    If no plan exists, generates a fresh, structured plan tailored to user's weaknesses and goal.
    """
    db = get_firestore_client()
    user_ref = db.collection("users").document(user_id)
    today_str = date_str or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    plan_ref = user_ref.collection("daily_plans").document(today_str)
    plan_doc = plan_ref.get()

    user_doc = user_ref.get()
    user_data = user_doc.to_dict() if user_doc.exists else {}

    target_goal = goal_minutes or user_data.get("daily_goal_minutes", 30)

    if plan_doc.exists:
        existing_data = plan_doc.to_dict()
        if not goal_minutes or existing_data.get("goal_minutes") == target_goal:
            return existing_data

    # Generate new plan
    weaknesses = user_data.get("weaknesses", ["past_simple_auxiliary", "be_verb_misuse"])
    mastery = user_data.get("skill_mastery", {})
    new_plan = generate_daily_plan(
        user_id=user_id,
        goal_minutes=target_goal,
        weaknesses=weaknesses,
        skill_mastery=mastery,
        date_str=today_str,
    )
    plan_ref.set(new_plan.model_dump(), merge=True)
    user_ref.set({"daily_goal_minutes": target_goal, "today_plan_id": new_plan.plan_id}, merge=True)
    return new_plan.model_dump()


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
        plan_data = get_or_create_daily_plan(user_id, date_str=target_date_str)
    else:
        plan_data = plan_doc.to_dict()

    activities = plan_data.get("activities", [])
    now_iso = datetime.now(timezone.utc).isoformat()

    updated = False
    for act in activities:
        if act.get("activity_id") == target_activity_id:
            if not act.get("is_completed"):
                act["is_completed"] = True
                act["session_id"] = session_id or act.get("session_id")
                act["completed_at"] = now_iso
                act_dur = duration_minutes or act.get("duration_minutes", 10)
                plan_data["completed_minutes"] = plan_data.get("completed_minutes", 0) + act_dur
                plan_data["completed_activities_count"] = plan_data.get("completed_activities_count", 0) + 1

                learner_speaking_time_seconds = kwargs.get("learner_speaking_time_seconds")
                idle_time_seconds = kwargs.get("idle_time_seconds")
                if learner_speaking_time_seconds is not None:
                    act["learner_speaking_time_seconds"] = learner_speaking_time_seconds
                    plan_data["total_learner_speaking_seconds"] = (plan_data.get("total_learner_speaking_seconds") or 0) + learner_speaking_time_seconds
                if idle_time_seconds is not None:
                    act["idle_time_seconds"] = idle_time_seconds
                    plan_data["total_idle_seconds"] = (plan_data.get("total_idle_seconds") or 0) + idle_time_seconds

                updated = True
            break

    # Calculate next uncompleted activity index
    next_idx = len(activities)
    for i, act in enumerate(activities):
        if not act.get("is_completed"):
            next_idx = i
            break

    plan_data["current_activity_index"] = next_idx
    if next_idx >= len(activities):
        plan_data["completion_status"] = "completed"
    elif plan_data.get("completed_activities_count", 0) > 0:
        plan_data["completion_status"] = "in_progress"

    plan_ref.set(plan_data, merge=True)
    return plan_data



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


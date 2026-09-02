"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Ultra-low-latency realtime pipeline:
  Learner mic → LiveKit/WebRTC → Groq Whisper STT
    → Google Gemini Flash Lite → Edge-TTS Streaming → LiveKit → Learner speaker

Architecture rules:
  - Uses AgentSession (NOT deprecated VoicePipelineAgent)
  - Firestore / LangGraph / analytics NEVER block the voice response
  - Events are dispatched asynchronously to the learning engine
  - No model/provider IDs hardcoded in business logic
  - Grammar analysis runs OFF the critical path (parallel, never blocks reply)
  - Replies capped to 1-2 sentences for fast TTS + pedagogy
"""

import asyncio
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.plugins import google, groq, openai
from telemetry import record_turn_telemetry

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pravaah-voice-agent")

# ---------------------------------------------------------------------------
# Configuration (from environment / LiteLLM proxy)
# ---------------------------------------------------------------------------

LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-pravaah-dev-key")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gemini-2.5-flash")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gemini-2.5-flash")

# TTS Configuration
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "kokoro")
KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "http://localhost:8880/v1")
KOKORO_VOICE = os.getenv("KOKORO_VOICE", "hf_alpha")

# ---------------------------------------------------------------------------
# Tutor system prompt — optimized for low-latency + natural recasts
# ---------------------------------------------------------------------------

TUTOR_SYSTEM_PROMPT = """You are Pravaah Coach, an English speaking tutor for Hindi-speaking learners.

Your goal: help the learner become fluent and accurate in spoken English through natural conversation.

## Core Rules (STRICT)
- Keep ALL replies to 1-2 sentences maximum (under 25 words). This is critical for voice latency.
- Output ONLY clean plain text. NEVER use markdown: no asterisks, hashtags, bullet points, or special formatting.
- Ask at most ONE question per turn. Never stack multiple questions.
- Speak mostly in English. Use Hindi/Hinglish ONLY for explanations of corrections.

## When User Speaks Hindi
If the learner says something in Hindi (like "mujhe English seekhni hai" or "main theek hoon"):
- Do NOT ask them to repeat in English.
- Instead, naturally show them the English version: "In English, you can say: 'I want to learn English.' Now you try!"
- Be encouraging. Hindi input means they're trying — help them bridge to English.

## Correction Style: Natural Recasts (FAST PATH)
When the learner makes a meaningful English mistake:
1. Do NOT lecture or run grammar analysis. Just naturally recast the corrected version in your reply.
2. Use a brief friendly cue: "Small correction:" or "Almost!" or "A more natural way:"
3. Show the correct sentence clearly.
4. Explain WHY in Hinglish (Hindi using English letters). Example: "Kyunki past tense mein 'did' ke saath base form use hota hai."
5. Then ask ONE follow-up question to continue the conversation.

Example correction flow:
  User: "I didn't went to school"
  You: "Small correction: 'I didn't go to school.' Kyunki 'did' ke baad hamesha base form aati hai. What did you do instead?"

## Do NOT Ask to Repeat
- Do NOT say "Can you repeat that?" or "Say it again" unless the user's audio was genuinely unclear.
- Instead of asking for repetition, naturally model the correct form and move the conversation forward.
- If you do need the user to practice a specific phrase, say the exact phrase clearly: "Try saying: 'I have two brothers.'"

## Common Hindi-English Mistakes to Watch
- "I am having two brothers" → "I have two brothers" (stative verbs)
- "He don't know" → "He doesn't know" (subject-verb agreement)
- "I didn't went" → "I didn't go" (past simple + auxiliary)
- "I am agree" → "I agree" (be verb + main verb)
- "Discuss about this" → "Discuss this" (preposition error)
- "She is knowing him" → "She knows him" (stative verbs)
When these appear, briefly explain the rule in Hinglish.

## Do NOT
- Ask more than ONE question per turn
- Interrupt mid-sentence
- Turn conversation into a grammar lecture
- Correct tiny accent/wording differences
- Use markdown formatting of any kind
- Give long responses (keep it SHORT)

## Personality
Be warm, patient, encouraging, conversational. Celebrate successes naturally. Never judgmental.

Correct at the earliest natural point AFTER the learner finishes their turn."""


# ---------------------------------------------------------------------------
_sequence_counter: int = 0


def next_sequence() -> int:
    global _sequence_counter
    _sequence_counter += 1
    return _sequence_counter


def make_event(
    event_type: str,
    user_id: str,
    session_id: str,
    payload: dict,
) -> dict:
    """Create a standardized event with idempotency metadata."""
    return {
        "event_id": str(uuid.uuid4()),
        "event_version": 1,
        "event_type": event_type,
        "user_id": user_id,
        "session_id": session_id,
        "sequence": next_sequence(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


async def _process_event_async(event: dict):
    """Asynchronously persist learning event without blocking conversation turn."""
    try:
        if process_outbox_event is not None and event.get("event_id"):
            await process_outbox_event(event["event_id"])
        elif process_event is not None:
            await process_event(event)
    except Exception as exc:
        logger.warning("Background event persistence notice: %s", exc)


async def emit_event(event: dict):
    """Dispatch event to durable outbox and background processor."""
    if enqueue_outbox_event is not None:
        try:
            await asyncio.to_thread(enqueue_outbox_event, event)
        except Exception as exc:
            logger.warning("Outbox enqueue notice for event %s: %s", event.get("event_id"), exc)
    logger.info(
        "Event: %s seq=%d session=%s",
        event["event_type"],
        event["sequence"],
        event["session_id"],
    )
    asyncio.create_task(_process_event_async(event))


# ---------------------------------------------------------------------------
# Telemetry — TTFA and per-stage latencies
# ---------------------------------------------------------------------------

class TurnTelemetry:
    """Track per-turn latency metrics."""

    def __init__(self):
        self.turn_end_time: float = 0.0
        self.stt_final_time: float = 0.0
        self.llm_first_token_time: float = 0.0
        self.tts_first_audio_time: float = 0.0

    def mark_turn_end(self):
        self.turn_end_time = time.monotonic()

    def mark_stt_final(self):
        self.stt_final_time = time.monotonic()

    def mark_llm_first_token(self):
        self.llm_first_token_time = time.monotonic()

    def mark_tts_first_audio(self):
        self.tts_first_audio_time = time.monotonic()

    def report(self) -> dict:
        """Return latency metrics in milliseconds."""
        metrics = {}
        if self.turn_end_time > 0:
            if self.stt_final_time > 0:
                metrics["stt_final_ms"] = round(
                    (self.stt_final_time - self.turn_end_time) * 1000, 1
                )
            if self.llm_first_token_time > 0:
                metrics["llm_first_token_ms"] = round(
                    (self.llm_first_token_time - self.stt_final_time) * 1000, 1
                )
            if self.tts_first_audio_time > 0:
                metrics["tts_first_audio_ms"] = round(
                    (self.tts_first_audio_time - self.llm_first_token_time) * 1000, 1
                )
                metrics["ttfa_ms"] = round(
                    (self.tts_first_audio_time - self.turn_end_time) * 1000, 1
                )
        return metrics


# ---------------------------------------------------------------------------
# English Tutor Agent
# ---------------------------------------------------------------------------

class EnglishTutor(Agent):
    """
    Pravaah English Tutor — LiveKit Agents 1.x Agent class.

    Implements the active correction tutor behavior from AI.md.
    Emits events for the async learning engine.
    """

    def __init__(
        self,
        user_id: str,
        session_id: str,
        target_skill: str | None = None,
        lesson_context: dict | None = None,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.target_skill = target_skill or (lesson_context.get("target_skill") if lesson_context else None)
        self.lesson_context = lesson_context or {}
        self._telemetry = TurnTelemetry()

        focus_instruction = ""
        if self.lesson_context.get("mode") == "assessment":
            focus_instruction = """

## Diagnostic Assessment Mode
You are conducting an initial spoken English diagnostic assessment for a new learner.
Guidelines:
1. Be extremely encouraging, welcoming, and warm.
2. The assessment evaluates 4 core tasks:
   - Task 1: Introduction and Daily Routine (A1/A2)
   - Task 2: Past Experience and Storytelling (A2/B1)
   - Task 3: Opinion and Reasoning (B1/B2)
   - Task 4: Hypothetical and Complex Discussion (B2/C1)
3. DO NOT correct grammar during assessment. Let the learner speak freely.
4. Listen attentively and acknowledge warmly before guiding to the next question."""
        elif self.lesson_context.get("mode") == "roleplay":
            scenario = self.lesson_context.get("scenario", "Job Interview")
            role = self.lesson_context.get("tutor_role", "Hiring Manager")
            focus_instruction = f"""

## Roleplay Mode: {scenario}
- Your Character: {role}
- Stay in character at all times.
- Keep turns to 1-2 sentences. Ask ONE question per turn.
- If the learner hesitates more than 5 seconds, provide a supportive in-character prompt.
- Do NOT break character unless explicitly asked."""
        elif self.target_skill:
            title = self.lesson_context.get("lesson_title", self.target_skill)
            rule = self.lesson_context.get("rule_summary", "")
            practice = self.lesson_context.get("practice_activity", "")
            stage = self.lesson_context.get("stage", "guided_practice")
            mastery = self.lesson_context.get("mastery_score", 0.5)
            hook_text = ""
            if self.lesson_context.get("memory_hook_eligible") and self.lesson_context.get("memory_hook"):
                hook_text = f"\n- Memory Hook: {self.lesson_context.get('memory_hook')} (Use once if learner repeats error)."

            stage_guidelines = {
                "introduction": "Introduce the concept gently with a clear example before inviting the learner's first attempt.",
                "guided_practice": "Lead with the practice prompt. Model the correct phrase clearly if they make an error.",
                "conversational_practice": "Carry out an engaging dialogue; weave the target skill naturally.",
                "review": "Casually verify retention through natural conversation.",
            }.get(stage, "Conduct lively speaking practice.")

            focus_instruction = f"""

## Targeted Practice Session: {title} (Stage: {stage.replace('_', ' ').title()})
- Target Skill: {self.target_skill}
- Mastery: {round(mastery * 100)}%
- Rule: {rule}
- Practice: {practice}{hook_text}

Session Guidelines:
1. {stage_guidelines}
2. Use conversational questions to elicit the target pattern.
3. No grammar lectures. Keep it a lively conversation.
4. Prioritize corrections on errors relating to {self.target_skill}.
5. When correcting, state the correct phrase clearly and explain in Hinglish.
6. Celebrate success warmly!"""

        super().__init__(instructions=TUTOR_SYSTEM_PROMPT + focus_instruction)

    async def on_enter(self) -> None:
        """Called when the agent enters the session."""
        session_mode = self.lesson_context.get("mode") or ("grammar_practice" if self.target_skill else "free_conversation")
        await emit_event(make_event(
            "SESSION_STARTED",
            self.user_id,
            self.session_id,
            {
                "mode": session_mode,
                "target_skill": self.target_skill,
                "lesson_id": self.lesson_context.get("lesson_id"),
            },
        ))
        logger.info("Session started: %s (target_skill=%s)", self.session_id, self.target_skill)

    async def on_exit(self) -> None:
        """Called when the agent exits the session."""
        await emit_event(make_event(
            "SESSION_ENDED",
            self.user_id,
            self.session_id,
            {
                "reason": "session_complete",
                "target_skill": self.target_skill,
                "lesson_id": self.lesson_context.get("lesson_id"),
            },
        ))
        logger.info("Session ended: %s", self.session_id)

    async def on_user_turn_completed(
        self, turn_ctx, new_message
    ) -> None:
        """
        Called after the user finishes speaking and STT produces final text.
        Emit the USER_UTTERANCE event asynchronously.
        """
        user_text = new_message.text_content if hasattr(new_message, 'text_content') else str(new_message)

        self._telemetry = TurnTelemetry()
        self._telemetry.mark_turn_end()

        await emit_event(make_event(
            "USER_UTTERANCE",
            self.user_id,
            self.session_id,
            {"text": user_text},
        ))

        logger.info("User said: %s", user_text[:80])

    async def on_agent_speech_started(self) -> None:
        """Called when the agent starts speaking (TTS first audio)."""
        self._telemetry.mark_tts_first_audio()
        metrics = self._telemetry.report()
        if metrics:
            logger.info("Turn telemetry: %s", metrics)

    async def on_agent_speech_interrupted(self) -> None:
        """Called when the learner interrupts (barge-in)."""
        logger.info("Barge-in detected — halting agent speech.")

    async def on_agent_turn_completed(
        self, turn_ctx, new_message
    ) -> None:
        """
        Called after the agent finishes its response.
        Emit the AI_RESPONSE event asynchronously.
        """
        agent_text = new_message.text_content if hasattr(new_message, 'text_content') else str(new_message)
        metrics = self._telemetry.report()

        # Emit structured telemetry record (with PII & secret redaction)
        turn_seq = getattr(new_message, 'sequence', 0) if hasattr(new_message, 'sequence') else 0
        record_turn_telemetry(
            session_id=self.session_id,
            turn_id=f"{self.session_id}_seq_{turn_seq:04d}",
            provider="litellm",
            model=REALTIME_MODEL,
            ttfa_ms=metrics.get("ttfa_ms"),
            stt_latency_ms=metrics.get("stt_final_ms"),
            ttft_ms=metrics.get("llm_first_token_ms"),
            tts_latency_ms=metrics.get("tts_first_audio_ms"),
            interrupted=False,
        )

        await emit_event(make_event(
            "AI_RESPONSE",
            self.user_id,
            self.session_id,
            {
                "text": agent_text,
                "interrupted": False,
                "telemetry": metrics,
            },
        ))

        logger.info("Agent said: %s", agent_text[:80])


# ---------------------------------------------------------------------------
# Agent entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext):
    """LiveKit Agents entrypoint — creates and starts the AgentSession."""

    if recover_and_process_pending_outbox_events is not None:
        try:
            asyncio.create_task(recover_and_process_pending_outbox_events())
        except Exception as exc:
            logger.warning("Outbox startup recovery notice: %s", exc)

    await ctx.connect()

    # Extract user/session metadata from room name or participant metadata
    room = ctx.room
    room_name = room.name or ""
    # Room name format: session_{session_id}
    session_id = room_name.removeprefix("session_") if room_name.startswith("session_") else room_name

    # Wait for the authenticated learner to join
    participant = await ctx.wait_for_participant()
    user_id = participant.identity

    # Read lesson target context selected by the learner — run in background thread
    target_skill = None
    lesson_context = {}

    async def _load_lesson_context():
        nonlocal target_skill, lesson_context
        if process_event is None:
            return
        try:
            def read_target_context():
                from worker import get_firestore_client
                from curriculum import CURRICULUM_SKILLS
                doc = get_firestore_client().collection("users").document(user_id).collection("sessions").document(session_id).get()
                data = doc.to_dict() or {} if doc.exists else {}
                mode = data.get("mode", "free_conversation")
                skill = data.get("target_skill")
                lesson_id = data.get("lesson_id")
                ctx_data = {"mode": mode}
                if skill:
                    skill_meta = CURRICULUM_SKILLS.get(skill, {})
                    ctx_data.update({
                        "target_skill": skill,
                        "lesson_id": lesson_id,
                        "lesson_title": skill_meta.get("title", skill),
                        "rule_summary": skill_meta.get("rule_summary", ""),
                        "practice_activity": skill_meta.get("practice_activity", ""),
                    })
                elif mode == "assessment":
                    ctx_data.update({
                        "lesson_title": "Spoken English Diagnostic Assessment",
                    })
                return skill, ctx_data
            target_skill, lesson_context = await asyncio.to_thread(read_target_context)
        except Exception as exc:
            logger.warning("Could not load lesson target for session %s: %s", session_id, exc)

    # Load lesson context (with a short timeout to not delay greeting too much)
    try:
        await asyncio.wait_for(_load_lesson_context(), timeout=3.0)
    except asyncio.TimeoutError:
        logger.warning("Lesson context load timed out after 3s, using defaults")

    logger.info(
        "Agent joined room=%s session=%s user=%s (target_skill=%s, mode=%s)",
        room_name,
        session_id,
        user_id,
        target_skill,
        lesson_context.get("mode", "free_conversation"),
    )

    # --- Build the STT → LLM → TTS pipeline ---

    # STT: Groq Whisper Turbo — ultra-low latency (~100ms)
    # Using multilingual model with English bias (handles Hindi fallback without 2 STT passes)
    stt = groq.STT(
        model="whisper-large-v3-turbo",
        language="en",
    )

    # LLM Priority: Gemini > OpenRouter > NVIDIA > LiteLLM
    gemini_key = os.getenv("GEMINI_API_KEY")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    nvidia_key = os.getenv("NVIDIA_API_KEY")

    if gemini_key:
        llm = google.LLM(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key,
            temperature=0.6,
        )
        logger.info("LLM: Google Gemini 3.5 Flash Lite")
    elif openrouter_key:
        llm = openai.LLM(
            model="minimax/minimax-m3:free",
            base_url="https://openrouter.ai/api/v1",
            api_key=openrouter_key,
        )
        logger.info("LLM: OpenRouter (minimax/minimax-m3:free)")
    elif nvidia_key:
        llm = openai.LLM(
            model="nvidia/nemotron-3.5-lightning-30b-a3b",
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=nvidia_key,
        )
        logger.info("LLM: NVIDIA Nemotron")
    else:
        llm = openai.LLM(
            model=REALTIME_MODEL,
            base_url=LITELLM_PROXY_URL,
            api_key=LITELLM_PROXY_KEY,
        )
        logger.info("LLM: LiteLLM proxy at %s", LITELLM_PROXY_URL)

    # TTS: Fast streaming Edge-TTS via local server (pre-warmed cache)
    tts = openai.TTS(
        model="tts-1",
        voice="en-IN-NeerjaNeural",
        api_key="not-needed",
        base_url="http://localhost:8880/v1",
    )
    logger.info("TTS: Indian Neural Voice (en-IN-NeerjaNeural) at http://localhost:8880/v1")

    # --- Create the AgentSession with fast turn detection ---
    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.3,       # Fast 300ms turn commit
        max_endpointing_delay=1.0,
        preemptive_generation=True,       # Speculative LLM on partial transcript
        allow_interruptions=True,         # Instant barge-in
        min_interruption_duration=0.25,
        resume_false_interruption=True,
    )

    # --- Create the tutor agent ---
    tutor = EnglishTutor(
        user_id=user_id,
        session_id=session_id,
        target_skill=target_skill,
        lesson_context=lesson_context,
    )

    # Listen for participant disconnect to cleanly finalize session
    @room.on("participant_disconnected")
    def on_participant_disconnected(p):
        if p.identity == user_id:
            logger.info("Learner %s disconnected. Finalizing session %s.", user_id, session_id)
            asyncio.create_task(emit_event(make_event(
                "SESSION_ENDED",
                user_id,
                session_id,
                {
                    "reason": "learner_disconnected",
                    "target_skill": target_skill,
                    "lesson_id": lesson_context.get("lesson_id"),
                    "mode": lesson_context.get("mode"),
                },
            )))

    await session.start(
        room=room,
        agent=tutor,
    )

    # Instant greeting — short text for fast TTS (pre-warmed in cache)
    greeting_text = "Hello! Welcome to your English speaking session. How are you doing today?"

    if lesson_context.get("mode") == "assessment":
        greeting_text = (
            "Welcome to your Pravaah spoken assessment! "
            "Could you tell me a little about yourself?"
        )
    elif lesson_context and lesson_context.get("practice_activity"):
        title = lesson_context.get("lesson_title", "conversation")
        greeting_text = f"Hello! Today we will practice {title}. Are you ready?"

    # Minimal delay for WebRTC audio track setup
    await asyncio.sleep(0.3)

    # Speak the greeting directly (instant playback, 0s LLM delay)
    await session.say(greeting_text, allow_interruptions=True)

    logger.info("Tutor agent started and greeted for session %s", session_id)


# ---------------------------------------------------------------------------
# Learning engine consumer (runs in background)
# ---------------------------------------------------------------------------

# Import learning engine persistence processor & outbox methods
_learning_engine_dir = os.path.join(os.path.dirname(__file__), "..", "learning-engine")
if _learning_engine_dir not in sys.path:
    sys.path.insert(0, os.path.abspath(_learning_engine_dir))

try:
    from worker import (
        process_event,
        enqueue_outbox_event,
        process_outbox_event,
        recover_and_process_pending_outbox_events,
    )
    logger.info("Learning engine persistence worker imported successfully.")
except Exception as _e:
    logger.warning("Could not import learning engine process_event: %s", _e)
    process_event = None
    enqueue_outbox_event = None
    process_outbox_event = None
    recover_and_process_pending_outbox_events = None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(entrypoint_fnc=entrypoint),
    )

"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Realtime pipeline:
  Learner mic → LiveKit/WebRTC → Silero VAD → Groq Whisper STT
    → LiteLLM (Gemini 3.5 Flash-Lite) → Kokoro TTS → LiveKit → Learner speaker

Architecture rules:
  - Uses AgentSession (NOT deprecated VoicePipelineAgent)
  - Firestore / LangGraph / analytics NEVER block the voice response
  - Events are dispatched asynchronously to the learning engine
  - No model/provider IDs hardcoded in business logic
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
    inference,
)
from livekit.plugins import google, groq, openai, silero
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

# TTS Configuration — Kokoro (OSS, primary) or Google Cloud TTS (optional fallback)
# TTS_PROVIDER: "kokoro" (default, requires Kokoro-FastAPI on localhost:8880)
#               "google" (optional, requires GOOGLE_APPLICATION_CREDENTIALS)
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "kokoro")
KOKORO_BASE_URL = os.getenv("KOKORO_BASE_URL", "http://localhost:8880/v1")
KOKORO_VOICE = os.getenv("KOKORO_VOICE", "hf_alpha")

# ---------------------------------------------------------------------------
# Tutor system prompt (derived from AI.md)
# ---------------------------------------------------------------------------

TUTOR_SYSTEM_PROMPT = """You are an English speaking tutor for a Hindi-speaking learner.

Your primary goal is to help the learner become more fluent and accurate in spoken English through natural conversation.

You are both:
- a natural conversation partner
- an active English teacher

## Default Conversation Behavior
- Speak mostly English. Adapt vocabulary, sentence length, and complexity to the learner's level.
- Use Hindi only when the learner explicitly asks, clearly doesn't understand, or is stuck.
- After clarification, return to English. Keep responses concise (2-3 sentences max).
- **STRICT SINGLE-QUESTION RULE**: Ask at most ONE direct conversational question per turn. Never stack multiple questions in a single response (e.g. ask "What did you do yesterday?", NOT "What did you do yesterday, where did you go, and who were you with?").

## Active Correction Behavior
When the learner makes a meaningful English mistake, correct it naturally.
Do NOT silently ignore important recurring mistakes. Do NOT correct every tiny imperfection.

Prioritize mistakes that are:
1. Grammatically important
2. Repeated by the learner
3. Likely to affect natural communication
4. Related to the current lesson
5. Useful for the learner's current level

## Correction Pattern
When correcting an important mistake:
1. Use a friendly phrase: "Small correction.", "Almost!", "A more natural way to say that is..."
2. Show the correct sentence clearly in English.
3. Explain WHY simply. YOU MUST EXPLAIN THE REASON IN HINGLISH (Hindi using English alphabet, e.g., "Kyunki past tense mein verb ka second form use hota hai"). This makes it easy for the learner to understand without sounding unnatural with the English voice.
4. Ask the learner to repeat the corrected sentence when the mistake is important.
5. If they get it right, praise warmly using natural phrasing (e.g. "Perfect, that was very clear and natural!" or "Exactly right, well done!"). Avoid flat, isolated 1-2 word outputs.
6. Return to the conversation immediately with ONE natural follow-up question.

## Repeated-Mistake Memory Hooks
When a learner struggles with a recurring grammar mistake across multiple sessions and has Hindi support enabled:
- You may offer a concise 1-sentence Hindi/Hinglish memory hook (e.g. "Remember: did/didn't ke saath hamesha verb ki base form lagti hai — say 'didn't go', not 'didn't went'.").
- Only provide the memory hook once when pedagogically helpful; do NOT repeat the same memory hook every turn.

## Roleplay Silence Rescue
In roleplay mode:
- If the learner is silent for >5 seconds or hesitates, STAY IN CHARACTER.
- Provide a helpful, supportive in-character prompt (e.g. Hiring Manager: "Take your time. Whenever you're ready, tell me about your background." / Barista: "No rush at all! Take a moment — what can I get started for you today?").
- Do NOT break character or switch to generic tutor language unless explicitly requested.

## Hindi-Speaker Patterns to Watch
Recognize common Hindi-English patterns:
- "I am having two brothers" → "I have two brothers" (stative verbs)
- "He don't know" → "He doesn't know" (subject-verb agreement)
- "I didn't went" → "I didn't go" (past simple + auxiliary)
- "I am agree" → "I agree" (be verb + main verb)
- "Discuss about this" → "Discuss this" (preposition error)
- "She is knowing him" → "She knows him" (stative verbs)
When these appear, explain the underlying English rule simply.

## Do NOT
- Ask more than ONE question in a single response
- Interrupt the learner mid-sentence to correct grammar
- Turn every conversation into a grammar lecture
- Correct tiny wording differences, accents, or harmless shortcuts
- Invent mistakes or claim uncertain style preferences are grammar errors
- Fabricate learner history or previous mistakes

## Strict Spoken Voice & Latency Rules
- Output clean conversational plain text ONLY. NEVER use markdown symbols like asterisks (**), hashtags (#), or bullet points, as they confuse the speech engine and add delay.
- Keep all responses SHORT and punchy: strictly 1 to 2 sentences (maximum 20-25 words total).
- Always end your turn with ONE clear, short question to keep the conversation moving naturally.

## Personality
Be patient, encouraging, friendly, conversational, supportive, and teacher-like when correction is needed. Never judgmental. Celebrate successful corrections warmly.

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
You are currently conducting an initial spoken English diagnostic assessment for a new learner.
Guidelines:
1. Be extremely encouraging, welcoming, and warm.
2. The assessment evaluates 4 core tasks:
   - Task 1: Introduction & Daily Routine (A1/A2)
   - Task 2: Past Experience & Storytelling (A2/B1)
   - Task 3: Opinion & Reasoning (B1/B2)
   - Task 4: Hypothetical & Complex Discussion (B2/C1)
3. DO NOT interrupt the learner mid-sentence and DO NOT correct grammar mistakes during this assessment session. Let the learner speak freely and naturally so we can evaluate their authentic speaking ability.
4. Listen attentively and acknowledge their answers warmly with brief encouraging remarks (e.g. "Thank you for sharing that!", "Great job.") before guiding them to the next question."""
        elif self.lesson_context.get("mode") == "roleplay":
            scenario = self.lesson_context.get("scenario", "Job Interview")
            role = self.lesson_context.get("tutor_role", "Hiring Manager")
            focus_instruction = f"""

## Roleplay Mode: {scenario}
- Your Character / Role: {role}
- Scenario: Natural, interactive spoken roleplay scenario.

Roleplay Guidelines:
1. Stay in character at all times. Embody the {role} naturally.
2. Keep turns conversational and concise (2-3 sentences max).
3. STRICT SINGLE-QUESTION RULE: Ask at most ONE conversational question per turn.
4. Silence Rescue: If the learner hesitates or stays silent for >5 seconds, provide a supportive in-character prompt (e.g. "Take your time. Whenever you're ready, tell me about..."). Do NOT break character or switch to generic tutor mode unless explicitly asked.
5. Natural Feedback: Maintain the immersion while offering friendly encouragement."""
        elif self.target_skill:
            title = self.lesson_context.get("lesson_title", self.target_skill)
            rule = self.lesson_context.get("rule_summary", "")
            practice = self.lesson_context.get("practice_activity", "")
            stage = self.lesson_context.get("stage", "guided_practice")
            mastery = self.lesson_context.get("mastery_score", 0.5)
            hook_text = ""
            if self.lesson_context.get("memory_hook_eligible") and self.lesson_context.get("memory_hook"):
                hook_text = f"\n- Recurring Error Memory Hook: {self.lesson_context.get('memory_hook')} (Use once if learner repeats error)."

            stage_guidelines = {
                "introduction": "This is an introductory lesson. Introduce the concept gently with a clear, short example before inviting the learner's first attempt.",
                "guided_practice": "This is guided practice. Lead with the practice prompt and prompt for repetition upon mistakes using quotes (e.g. \"Say '...' Can you repeat that?\").",
                "conversational_practice": "This is conversational practice. Carry out an engaging back-and-forth dialogue; weave the target skill naturally into the discussion.",
                "review": "This is a review check-in for a strong skill. Casually verify retention through natural conversation without overwhelming the learner.",
            }.get(stage, "Conduct lively, natural speaking practice.")

            focus_instruction = f"""

## Targeted Practice Session: {title} (Stage: {stage.replace('_', ' ').title()})
- Target Skill: `{self.target_skill}`
- Current Learner Mastery: {round(mastery * 100)}%
- Rule Summary: {rule}
- Practice Prompt to Elicit: {practice}{hook_text}

Targeted Session Guidelines:
1. Stage Approach: {stage_guidelines}
2. Conversational Elicitation: Lead naturally with conversational questions that encourage the learner to use the target pattern (e.g. "{practice}").
3. No Lectures: Do NOT give long grammar lectures or treat this as a worksheet. Keep it a lively, natural speaking conversation.
4. Skill Prioritization: Prioritize active corrections on errors relating to `{self.target_skill}`.
5. Prompted Repetition: When correcting an error on `{self.target_skill}`, state the correct phrase clearly in quotes and invite the learner to repeat it (e.g. "Say 'I didn't go.' Can you repeat that?").
6. Celebrate Success: Acknowledge and praise the learner warmly when they produce or repeat the correct pattern!"""

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

    # Read lesson target context selected by the learner
    target_skill = None
    lesson_context = {}
    if process_event is not None:
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

    logger.info(
        "Agent joined room=%s session=%s user=%s (target_skill=%s, mode=%s)",
        room_name,
        session_id,
        user_id,
        target_skill,
        lesson_context.get("mode", "free_conversation"),
    )

    # --- Build the STT → LLM → TTS pipeline ---

    # STT: Groq Whisper Turbo - ultra-low latency (~100ms)
    stt = groq.STT(
        model="whisper-large-v3-turbo",
        language="en",
    )

    # LLM Priority Hierarchy:
    # 1. Primary: Google Gemini Flash Lite
    # 2. Fallback 1: OpenRouter (MiniMax M3 / Mini)
    # 3. Fallback 2: NVIDIA Nemotron
    # 4. Fallback 3: LiteLLM Proxy
    gemini_key = os.getenv("GEMINI_API_KEY")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    nvidia_key = os.getenv("NVIDIA_API_KEY")

    if gemini_key:
        llm = google.LLM(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key,
            temperature=0.6,
        )
        logger.info("LLM [Primary]: Google Gemini 3.5 Flash lite")
    elif openrouter_key:
        llm = openai.LLM(
            model="minimax/minimax-m3:free",
            base_url="https://openrouter.ai/api/v1",
            api_key=openrouter_key,
        )
        logger.info("LLM [Fallback 1]: OpenRouter (minimax/minimax-m3:free)")
    elif nvidia_key:
        llm = openai.LLM(
            model="nvidia/nemotron-3.5-lightning-30b-a3b",
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=nvidia_key,
        )
        logger.info("LLM [Fallback 2]: NVIDIA Nemotron (nemotron-3.5-lightning-30b-a3b)")
    else:
        llm = openai.LLM(
            model=REALTIME_MODEL,
            base_url=LITELLM_PROXY_URL,
            api_key=LITELLM_PROXY_KEY,
        )
        logger.info("LLM [Fallback 3]: LiteLLM proxy at %s", LITELLM_PROXY_URL)

    # Fast, Natural Indian Voice TTS via local server (Edge-TTS / Kokoro)
    tts = openai.TTS(
        model="tts-1",
        voice="en-IN-NeerjaNeural",
        api_key="not-needed",
        base_url="http://localhost:8880/v1",
    )
    logger.info("TTS [Primary]: Indian Neural Voice (en-IN-NeerjaNeural) at http://localhost:8880/v1")

    # --- Create the AgentSession with Low-Latency Turn Detection ---
    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.3, # Fast 300ms turn commit
        max_endpointing_delay=1.0,
        preemptive_generation=True, # Speculative LLM execution on partial transcript
        allow_interruptions=True,   # Instant barge-in on user speech
        min_interruption_duration=0.25,
        resume_false_interruption=True,
    )

    # --- Start the tutor ---
    tutor = EnglishTutor(
        user_id=user_id,
        session_id=session_id,
        target_skill=target_skill,
        lesson_context=lesson_context,
    )

    # Listen for participant disconnect to cleanly finalize session & trigger analysis
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

    # Instant greeting — tailor warmly to mode / objective
    if lesson_context.get("mode") == "assessment":
        greeting_text = (
            "Welcome to your Pravaah spoken assessment! I will ask you four questions. "
            "Please speak as naturally as you can. Let's begin: Could you tell me a little about yourself and why you want to practice English?"
        )
    elif lesson_context and lesson_context.get("practice_activity"):
        greeting_text = (
            f"Hello! Welcome to today's lesson on {lesson_context.get('lesson_title', 'conversation')}. "
            "How are you doing today, and are you ready to practice?"
        )
    else:
        greeting_text = "Hello! Welcome to your English speaking session. How are you doing today, and what would you like to talk about?"

    # Small delay for WebRTC audio track setup
    await asyncio.sleep(0.5)
    
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

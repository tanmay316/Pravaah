"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Two-Path Parallel Architecture:
  1. FAST PATH (Audio Response ~1s):
     - LLM replies conversationally in 1 short sentence (max 15-20 words).
     - No grammar parsing or lecture generation in the voice response loop.
     - Instant audio playback with Neural Indian English TTS.

  2. PARALLEL PATH (UI Feedback & Deep Analysis):
     - Background async task analyzes grammar & vocabulary in parallel.
     - Automatically emits interactive UI correction cards over WebRTC data channel.
     - Zero audio lag / zero blocking on the voice critical path.

  3. NOISE & VAD GATING:
     - Silero VAD filters fan noise, background hum, and room echo.
     - Groq Whisper with detect_language=True for authentic Hindi & English transcription.
"""

import asyncio
import json
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
from livekit.plugins import google, groq, openai, silero

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pravaah-voice-agent")

LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-pravaah-dev-key")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gemini-2.5-flash")

# ---------------------------------------------------------------------------
# Fast Conversational System Prompt (Fast Path)
# ---------------------------------------------------------------------------

TUTOR_SYSTEM_PROMPT = """You are Pravaah Coach, a friendly, encouraging English speaking partner.

Your goal is natural back-and-forth English conversation.

## Critical Voice Rules:
- Reply in strictly 1 to 2 short sentences (maximum 15-20 words total).
- Always end with ONE natural conversational question to keep the dialogue moving.
- Output clean spoken plain text ONLY (no asterisks, no bullet points, no markdown).
- Do NOT lecture or give long grammar explanations. Just converse naturally.

## Handling Hindi Input:
If the learner speaks in Hindi (e.g. "मैं इंग्लिश सीखना चाहता हूँ" or "main theek hoon"):
- Warmly show how to say it in English, then ask a follow-up question:
  "In English you can say: 'I want to learn English.' What topics do you like?"

## Tone:
Warm, energetic, supportive, friendly."""


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


def _run_sync_event(event: dict):
    try:
        if enqueue_outbox_event is not None:
            enqueue_outbox_event(event)
        if process_event is not None:
            asyncio.run(process_event(event))
    except Exception as exc:
        logger.debug("Background persistence notice: %s", exc)


async def emit_event(event: dict):
    logger.info("Event: %s seq=%d session=%s", event["event_type"], event["sequence"], event["session_id"])
    asyncio.create_task(asyncio.to_thread(_run_sync_event, event))


async def broadcast_ui_turn(room, speaker: str, text: str):
    """Publish real-time bilingual transcript directly to client WebRTC data channel."""
    if not room or not text:
        return
    try:
        payload = json.dumps({
            "type": "turn",
            "speaker": speaker,
            "text": text,
            "timestamp": datetime.now().strftime("%I:%M %p"),
        }).encode("utf-8")
        await room.local_participant.publish_data(payload)
    except Exception as exc:
        logger.debug("UI broadcast note: %s", exc)


# ---------------------------------------------------------------------------
# Parallel Path: Async Background Grammar & Accuracy Analysis
# ---------------------------------------------------------------------------

async def run_parallel_accuracy_check(room, text: str, user_id: str, session_id: str):
    """
    Executes in parallel in a background thread while the voice reply is playing.
    Detects grammar/vocabulary errors and emits visual correction cards to the UI.
    """
    if not text or len(text.strip().split()) < 2:
        return

    # Skip pure simple greetings
    clean_lower = text.strip().lower()
    if clean_lower in ["hello", "hi", "hey", "yes", "no", "okay", "thank you", "thanks"]:
        return

    try:
        def _analyze():
            import google.generativeai as genai
            gemini_key = os.getenv("GEMINI_API_KEY")
            if not gemini_key:
                return None
            genai.configure(api_key=gemini_key)
            model = genai.GenerativeModel("gemini-2.5-flash")
            prompt = f"""You are an English language accuracy analyzer for an Indian English learner.
Learner utterance: "{text}"

Determine if there is a noticeable grammatical error, awkward phrasing, or common Hindi-English mistake (e.g. "didn't went", "I am having two brothers", "he don't", "I am agree").

If there IS an error:
Return JSON:
{{
  "has_error": true,
  "original": "{text}",
  "corrected": "<natural English sentence>",
  "explanation": "<1 short sentence explanation in Hinglish (Hindi in English alphabet)>"
}}

If there is NO meaningful error:
Return JSON:
{{ "has_error": false }}

JSON ONLY:"""
            res = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
            return json.loads(res.text.strip())

        analysis = await asyncio.to_thread(_analyze)
        if analysis and analysis.get("has_error") and analysis.get("corrected"):
            logger.info("Parallel correction card emitted: '%s' -> '%s'", analysis.get("original"), analysis.get("corrected"))
            if room:
                payload = json.dumps({
                    "type": "correction",
                    "original": analysis.get("original", text),
                    "corrected": analysis.get("corrected", ""),
                    "explanation": analysis.get("explanation", ""),
                }).encode("utf-8")
                await room.local_participant.publish_data(payload)
    except Exception as exc:
        logger.debug("Parallel analysis notice: %s", exc)


# ---------------------------------------------------------------------------
# English Tutor Agent
# ---------------------------------------------------------------------------

class EnglishTutor(Agent):
    def __init__(
        self,
        user_id: str,
        session_id: str,
        room=None,
        target_skill: str | None = None,
        lesson_context: dict | None = None,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.room = room
        self.target_skill = target_skill or (lesson_context.get("target_skill") if lesson_context else None)
        self.lesson_context = lesson_context or {}

        focus_instruction = ""
        if self.lesson_context.get("mode") == "assessment":
            focus_instruction = "\n## Assessment Mode: Ask 4 short progressive questions. Be warm and encouraging."
        elif self.target_skill:
            title = self.lesson_context.get("lesson_title", self.target_skill)
            focus_instruction = f"\n## Focus Topic: {title}. Weave questions related to {title} naturally."

        super().__init__(instructions=TUTOR_SYSTEM_PROMPT + focus_instruction)

    async def on_enter(self) -> None:
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

    async def on_exit(self) -> None:
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

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        user_text = new_message.text_content if hasattr(new_message, 'text_content') else str(new_message)
        logger.info("Learner: %s", user_text)

        # 1. Trigger parallel accuracy analysis off the voice critical path
        if self.room:
            asyncio.create_task(run_parallel_accuracy_check(self.room, user_text, self.user_id, self.session_id))

        # 2. Persist event asynchronously
        await emit_event(make_event(
            "USER_UTTERANCE",
            self.user_id,
            self.session_id,
            {"text": user_text},
        ))


# ---------------------------------------------------------------------------
# Agent entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext):
    """LiveKit Agents entrypoint — ultra-low latency conversational setup."""

    await ctx.connect()
    room = ctx.room
    room_name = room.name or ""
    session_id = room_name.removeprefix("session_") if room_name.startswith("session_") else room_name

    # Wait for the authenticated learner
    participant = await ctx.wait_for_participant()
    user_id = participant.identity

    target_skill = None
    lesson_context = {}

    # Quick lesson metadata lookup in background
    try:
        def _read_meta():
            from worker import get_firestore_client
            from curriculum import CURRICULUM_SKILLS
            doc = get_firestore_client().collection("users").document(user_id).collection("sessions").document(session_id).get()
            if doc.exists:
                d = doc.to_dict() or {}
                m = d.get("mode", "free_conversation")
                sk = d.get("target_skill")
                ctx_d = {"mode": m}
                if sk and sk in CURRICULUM_SKILLS:
                    meta = CURRICULUM_SKILLS[sk]
                    ctx_d.update({
                        "target_skill": sk,
                        "lesson_id": d.get("lesson_id"),
                        "lesson_title": meta.get("title", sk),
                        "rule_summary": meta.get("rule_summary", ""),
                        "practice_activity": meta.get("practice_activity", ""),
                    })
                return sk, ctx_d
            return None, {"mode": "free_conversation"}

        target_skill, lesson_context = await asyncio.wait_for(
            asyncio.to_thread(_read_meta), timeout=1.0
        )
    except Exception:
        lesson_context = {"mode": "free_conversation"}

    logger.info("Session ready: room=%s user=%s mode=%s", room_name, user_id, lesson_context.get("mode"))

    # 1. Silero VAD — filters ambient noise, fan hum & silence
    vad = silero.VAD.load(
        min_speech_duration=0.25,
        min_silence_duration=0.5,
    )

    # 2. STT: Groq Whisper Turbo with detect_language=True & bilingual prompt
    stt = groq.STT(
        model="whisper-large-v3-turbo",
        detect_language=True,
        prompt="नमस्ते, मैं इंग्लिश बोलना सीखना चाहता हूँ। Hello, I want to practice speaking English fluently.",
    )

    # 3. LLM: Google Gemini 3.5 Flash Lite (ultra-fast 15-word conversational responses)
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        llm = google.LLM(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key,
            temperature=0.4,
        )
    else:
        llm = openai.LLM(
            model=REALTIME_MODEL,
            base_url=LITELLM_PROXY_URL,
            api_key=LITELLM_PROXY_KEY,
        )

    # 4. TTS: Neural Indian English Voice (Edge-TTS via local proxy)
    tts = openai.TTS(
        model="tts-1",
        voice="en-IN-NeerjaNeural",
        api_key="not-needed",
        base_url="http://localhost:8880/v1",
    )

    # 5. AgentSession with fast turn commitment & preemptive generation
    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.3,
        max_endpointing_delay=0.75,
        preemptive_generation=True,
        allow_interruptions=True,
        min_interruption_duration=0.3,
        aec_warmup_duration=0.0,
    )

    tutor = EnglishTutor(
        user_id=user_id,
        session_id=session_id,
        room=room,
        target_skill=target_skill,
        lesson_context=lesson_context,
    )

    # Automatic real-time UI transcript sync for EVERY turn (user and assistant)
    @session.on("conversation_item_added")
    def on_item_added(event):
        try:
            item = getattr(event, "item", None)
            if not item:
                return
            role = getattr(item, "role", None)
            text = getattr(item, "text_content", None) or getattr(item, "content", "")
            if isinstance(text, list):
                text = " ".join([str(c) for c in text])
            text = str(text).strip()
            if not text:
                return
            speaker = "learner" if role == "user" else "tutor"
            logger.info("Transcript broadcast [%s]: %s", speaker, text[:60])
            asyncio.create_task(broadcast_ui_turn(room, speaker, text))
        except Exception as exc:
            logger.debug("conversation_item_added broadcast note: %s", exc)

    # Listen for disconnect
    @room.on("participant_disconnected")
    def on_disconnect(p):
        if p.identity == user_id:
            logger.info("Learner disconnected: %s", session_id)
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

    # Start agent session
    await session.start(
        room=room,
        agent=tutor,
    )

    # Greeting message
    greeting_text = "Hello! Welcome to your English speaking practice. How are you doing today?"
    if lesson_context.get("mode") == "assessment":
        greeting_text = "Welcome to your English assessment! Could you tell me a little about yourself?"
    elif lesson_context.get("practice_activity"):
        title = lesson_context.get("lesson_title", "speaking")
        greeting_text = f"Hello! Today we will practice {title}. Are you ready?"

    # Instant greeting upon WebRTC track stabilization (<0.3s)
    logger.info("Delivering greeting for session %s", session_id)
    await asyncio.sleep(0.3)
    await session.say(greeting_text, allow_interruptions=True)


# ---------------------------------------------------------------------------
# Background imports
# ---------------------------------------------------------------------------

_learning_engine_dir = os.path.join(os.path.dirname(__file__), "..", "learning-engine")
if _learning_engine_dir not in sys.path:
    sys.path.insert(0, os.path.abspath(_learning_engine_dir))

try:
    from worker import (
        process_event,
        enqueue_outbox_event,
    )
except Exception:
    process_event = None
    enqueue_outbox_event = None


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(entrypoint_fnc=entrypoint),
    )

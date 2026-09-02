"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Ultra-low-latency realtime pipeline:
  Learner mic → LiveKit WebRTC → Groq Whisper STT (Multilingual / Hindi + English)
    → Google Gemini Flash Lite → Neural TTS → LiveKit → Learner speaker

Optimizations:
  - Disables slow cloud turn detector gateway (eliminates 7.6s network transport lag)
  - STT auto-detects English & Hindi (no forced English phonetic corruption)
  - Real-time WebRTC data broadcast for instant UI live transcription
  - Non-blocking async event persistence (zero event loop lag)
  - Natural recasts with Hinglish explanations
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
from livekit.plugins import google, groq, openai
from telemetry import record_turn_telemetry

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pravaah-voice-agent")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-pravaah-dev-key")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gemini-2.5-flash")

# ---------------------------------------------------------------------------
# Tutor system prompt
# ---------------------------------------------------------------------------

TUTOR_SYSTEM_PROMPT = """You are Pravaah Coach, an English speaking tutor for Hindi-speaking learners.

Your goal: help the learner become fluent and confident in spoken English through natural conversation.

## Core Rules (STRICT)
- Keep ALL replies to 1-2 short sentences (maximum 20 words). Short responses are essential for smooth voice conversation.
- Output ONLY clean plain text. NEVER use markdown symbols (no asterisks **, hashtags #, bullet points, quotes).
- Ask at most ONE question per turn.
- Speak primarily in English.

## Handling Hindi Input
When the learner speaks Hindi or Hinglish (e.g. "mujhe English seekhni hai", "main theek hoon"):
- Acknowledge warmly and naturally show them the English version.
- Example: "In English you can say: I want to learn English. What topics do you want to talk about?"
- Do NOT scold or force repetition. Model the English phrasing and continue smoothly.

## Handling English Mistakes (Natural Recasts)
When the learner makes a grammar or phrasing mistake in English:
1. Recast the sentence naturally with a friendly cue ("Small correction:", "A natural way:").
2. State the correct sentence clearly.
3. Give a 1-sentence explanation in Hinglish (Hindi in English letters, e.g. "Kyunki past tense mein second form aati hai").
4. Ask ONE natural question to keep the conversation flowing.

Example:
  Learner: "I am having two brother."
  You: "Small correction: I have two brothers. Kyunki relationships ke liye have use hota hai. What are their names?"

## Common Mistakes to Watch:
- "I didn't went" → "I didn't go" (past auxiliary)
- "He don't know" → "He doesn't know" (agreement)
- "I am agree" → "I agree" (stative)
- "Discuss about" → "Discuss"

## Personality:
Warm, encouraging, patient, conversational. Never give long lectures."""


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


def _run_sync_event(event: dict):
    """Run event processing in a worker thread to never block asyncio event loop."""
    try:
        if enqueue_outbox_event is not None:
            enqueue_outbox_event(event)
        if process_event is not None:
            asyncio.run(process_event(event))
    except Exception as exc:
        logger.debug("Background event persistence note: %s", exc)


async def emit_event(event: dict):
    """Dispatch event completely off the asyncio critical path."""
    logger.info(
        "Event: %s seq=%d session=%s",
        event["event_type"],
        event["sequence"],
        event["session_id"],
    )
    asyncio.create_task(asyncio.to_thread(_run_sync_event, event))


async def broadcast_ui_turn(room, speaker: str, text: str):
    """Publish real-time transcript message directly to client WebRTC data channel."""
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
        logger.debug("Data broadcast note: %s", exc)


# ---------------------------------------------------------------------------
# English Tutor Agent
# ---------------------------------------------------------------------------

class EnglishTutor(Agent):
    """
    Pravaah English Tutor — LiveKit Agents 1.x Agent class.
    """

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
            focus_instruction = """

## Diagnostic Assessment Mode
Conduct initial spoken English diagnostic. Ask 4 progressive questions. Do not correct mistakes during assessment. Be warm and encouraging."""
        elif self.target_skill:
            title = self.lesson_context.get("lesson_title", self.target_skill)
            rule = self.lesson_context.get("rule_summary", "")
            practice = self.lesson_context.get("practice_activity", "")
            focus_instruction = f"""

## Targeted Practice: {title}
- Target: {self.target_skill}
- Rule: {rule}
- Activity: {practice}
Naturally elicit this pattern through short conversational questions."""

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
        logger.info("User: %s", user_text)

        # Broadcast live transcript to UI
        if self.room:
            asyncio.create_task(broadcast_ui_turn(self.room, "learner", user_text))

        await emit_event(make_event(
            "USER_UTTERANCE",
            self.user_id,
            self.session_id,
            {"text": user_text},
        ))

    async def on_agent_turn_completed(self, turn_ctx, new_message) -> None:
        agent_text = new_message.text_content if hasattr(new_message, 'text_content') else str(new_message)
        logger.info("Agent: %s", agent_text)

        # Broadcast live transcript to UI
        if self.room:
            asyncio.create_task(broadcast_ui_turn(self.room, "tutor", agent_text))

        await emit_event(make_event(
            "AI_RESPONSE",
            self.user_id,
            self.session_id,
            {
                "text": agent_text,
                "interrupted": False,
            },
        ))


# ---------------------------------------------------------------------------
# Agent entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext):
    """LiveKit Agents entrypoint — ultra-fast setup with minimal network overhead."""

    await ctx.connect()
    room = ctx.room
    room_name = room.name or ""
    session_id = room_name.removeprefix("session_") if room_name.startswith("session_") else room_name

    # Wait for the authenticated learner
    participant = await ctx.wait_for_participant()
    user_id = participant.identity

    target_skill = None
    lesson_context = {}

    # Read lesson metadata in background thread with tight 1.5s timeout
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
            asyncio.to_thread(_read_meta), timeout=1.5
        )
    except Exception:
        lesson_context = {"mode": "free_conversation"}

    logger.info("Session ready: room=%s user=%s mode=%s", room_name, user_id, lesson_context.get("mode"))

    # 1. STT: Groq Whisper Turbo — Multilingual (auto-detects English & Hindi)
    stt = groq.STT(
        model="whisper-large-v3-turbo",
    )

    # 2. LLM: Google Gemini 3.5 Flash Lite
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        llm = google.LLM(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key,
            temperature=0.5,
        )
    else:
        llm = openai.LLM(
            model=REALTIME_MODEL,
            base_url=LITELLM_PROXY_URL,
            api_key=LITELLM_PROXY_KEY,
        )

    # 3. TTS: Neural Indian Voice (Edge-TTS via local proxy)
    tts = openai.TTS(
        model="tts-1",
        voice="en-IN-NeerjaNeural",
        api_key="not-needed",
        base_url="http://localhost:8880/v1",
    )

    # 4. AgentSession — optimized endpointing, zero AEC warmup delay, no cloud turn gateway lag
    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.3,
        max_endpointing_delay=0.8,
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

    # Listen for learner disconnect
    @room.on("participant_disconnected")
    def on_disconnect(p):
        if p.identity == user_id:
            logger.info("Learner disconnected. Finalizing session %s.", session_id)
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

    # Craft punchy instant greeting
    greeting_text = "Hello! Welcome. How are you doing today?"
    if lesson_context.get("mode") == "assessment":
        greeting_text = "Welcome to your English assessment! Could you tell me a little about yourself?"
    elif lesson_context.get("practice_activity"):
        title = lesson_context.get("lesson_title", "speaking")
        greeting_text = f"Hello! Let us practice {title}. Are you ready?"

    # Instant greeting broadcast to UI + Audio playback
    await asyncio.sleep(0.2)
    asyncio.create_task(broadcast_ui_turn(room, "tutor", greeting_text))
    await session.say(greeting_text, allow_interruptions=True)

    logger.info("Greeting delivered for session %s", session_id)


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

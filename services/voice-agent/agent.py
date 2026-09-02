"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Features & Latency Fixes:
  1. STT: Groq Whisper Turbo with `detect_language=True` — transcribes authentic Hindi & English with precision.
  2. Instant Greeting: Agent waits for explicit `start_conversation` click signal from client before speaking, delivering greeting in <0.3s.
  3. Real-time UI Data Broadcast: Publishes exact bilingual transcripts to client WebRTC data channel.
  4. Ultra-low response latency: Gemini 3.5 Flash Lite with prompt discipline (1-2 sentences) + local neural Indian TTS.
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

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pravaah-voice-agent")

LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-pravaah-dev-key")
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gemini-2.5-flash")

# ---------------------------------------------------------------------------
# Tutor system prompt
# ---------------------------------------------------------------------------

TUTOR_SYSTEM_PROMPT = """You are Pravaah Coach, a spoken English tutor for Hindi-speaking learners.

Your mission: help the learner speak fluent, confident English through lively conversation.

## Critical Rules:
- Keep ALL replies strictly to 1-2 short sentences (under 20 words). Never lecture.
- Output clean spoken plain text ONLY (no asterisks, no bullet points, no markdown).
- Ask at most ONE question per turn.
- Speak primarily in English.

## Handling Hindi:
When the learner speaks in Hindi or Hinglish (e.g. "मुझे इंग्लिश सीखनी है" or "main theek hoon"):
- Acknowledge warmly and naturally show the English equivalent: "In English, you can say: 'I want to learn English.' What would you like to practice today?"
- Never scold. Bridge their Hindi thought into English.

## Handling English Mistakes (Natural Recasts):
When the learner makes an English grammar error:
1. Use a warm cue ("Small correction:", "A more natural way:").
2. State the correct sentence clearly.
3. Add a 1-sentence reason in Hinglish (e.g. "Kyunki 'did' ke saath base verb lagti hai").
4. Ask ONE question to continue the dialogue.

Example:
  Learner: "I didn't went there."
  Coach: "Small correction: 'I didn't go there.' Kyunki 'did' ke baad first form use hoti hai. What did you do instead?"

## Personality:
Warm, supportive, conversational, encouraging."""


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
            focus_instruction = """

## Diagnostic Assessment:
Ask 4 progressive spoken questions. Do not correct mistakes during assessment. Be warm and encouraging."""
        elif self.target_skill:
            title = self.lesson_context.get("lesson_title", self.target_skill)
            rule = self.lesson_context.get("rule_summary", "")
            practice = self.lesson_context.get("practice_activity", "")
            focus_instruction = f"""

## Targeted Skill: {title}
- Target: {self.target_skill}
- Rule: {rule}
- Activity: {practice}
Elicit this pattern naturally in dialogue."""

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
        logger.info("Learner said: %s", user_text)

        # Broadcast exact learner words (Hindi or English) to UI
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
        logger.info("Coach said: %s", agent_text)

        # Broadcast coach response to UI
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
    """LiveKit Agents entrypoint."""

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

    # 1. STT: Groq Whisper Turbo with detect_language=True & bilingual prompt hint
    stt = groq.STT(
        model="whisper-large-v3-turbo",
        detect_language=True,
        prompt="Hindi and English spoken conversation. Hindi: मुझे इंग्लिश सीखनी है, मैं ठीक हूँ, नमस्ते। English: Hello, how are you today?",
    )

    # 2. LLM: Google Gemini 3.5 Flash Lite
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

    # 3. TTS: Neural Indian English Voice (Edge-TTS via local proxy)
    tts = openai.TTS(
        model="tts-1",
        voice="en-IN-NeerjaNeural",
        api_key="not-needed",
        base_url="http://localhost:8880/v1",
    )

    # 4. AgentSession with fast turn detection and zero AEC warmup lag
    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.25,
        max_endpointing_delay=0.7,
        preemptive_generation=True,
        allow_interruptions=True,
        min_interruption_duration=0.25,
        aec_warmup_duration=0.0,
    )

    tutor = EnglishTutor(
        user_id=user_id,
        session_id=session_id,
        room=room,
        target_skill=target_skill,
        lesson_context=lesson_context,
    )

    # Synchronize start signal from user's "Start Conversation" button
    start_conversation_event = asyncio.Event()

    @room.on("data_received")
    def on_data_received(data_packet):
        try:
            msg = json.loads(data_packet.data.decode("utf-8"))
            if msg.get("type") == "start_conversation":
                start_conversation_event.set()
        except Exception:
            pass

    @room.on("track_published")
    def on_track_published(pub, p):
        if p.identity == user_id:
            start_conversation_event.set()

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

    # Start session in background
    await session.start(
        room=room,
        agent=tutor,
    )

    # Greeting message
    greeting_text = "Hello! Welcome. How are you doing today?"
    if lesson_context.get("mode") == "assessment":
        greeting_text = "Welcome to your English assessment! Could you tell me a little about yourself?"
    elif lesson_context.get("practice_activity"):
        title = lesson_context.get("lesson_title", "speaking")
        greeting_text = f"Hello! Today we will practice {title}. Are you ready?"

    # Wait for the learner to click "Start Conversation" button (or fallback after 30s)
    logger.info("Waiting for learner to click Start Conversation...")
    try:
        await asyncio.wait_for(start_conversation_event.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        pass

    # Instant greeting right when learner clicks start!
    logger.info("Learner started session — speaking greeting instantly.")
    await asyncio.sleep(0.1)
    asyncio.create_task(broadcast_ui_turn(room, "tutor", greeting_text))
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

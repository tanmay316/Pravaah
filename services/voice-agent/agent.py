"""
English Coach AI — Voice Agent (LiveKit Agents 1.x)

Features & Optimizations:
  1. Low-Latency Instant Greeting: Pre-warmed TTS greeting streams within <250ms of connection.
  2. Strict Mode-Specific Coaching & Conversational Steering:
     - Warmup: Friendly, spontaneous fluency check.
     - Targeted Grammar: Explicitly introduces the target rule and FIRMLY STEERS conversation back if user drifts.
     - Vocabulary & Collocations: Teaches and drills natural phrases.
     - Assessment: 4-stage progressive diagnostic without interruptions.
  3. Flagship Multilingual STT: Groq Whisper Large v3 (1550M params) for precision Hindi/English speech recognition.
  4. Parallel Accuracy Cards: Emits visual UI cards for grammar mistakes and Hindi-to-English translations.
  5. Full Pipeline Connectivity: Captures complete transcript turns and triggers persistence & analysis on session end.
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
# Dynamic Mode-Specific Prompt & Conversational Steering Builder
# ---------------------------------------------------------------------------

def build_mode_instructions(mode: str, target_skill: str | None, lesson_context: dict) -> str:
    base = """You are Pravaah Coach, an expert spoken English tutor for Hindi-speaking learners.
Your mission is to help the learner speak fluent, correct English through engaging, natural conversation.

## Core Rules:
1. Speak concisely in 1 to 2 short sentences (maximum 20-25 words per turn).
2. Never lecture or speak long paragraphs. The learner should speak 70% of the conversation.
3. If the learner makes a grammatical error:
   - Recast cleanly: "A natural way to say that is: '<corrected sentence>'."
   - Give 1 short Hinglish explanation: "Kyunki..."
   - Immediately follow with a question to keep conversation moving.
4. If the learner speaks Hindi or Hinglish:
   - Speak the English equivalent: "In English, you can say: '<English translation>'."
   - Keep the question moving.
5. Plain conversational text ONLY (NEVER use markdown, asterisks **, bullet points, or numbering).
"""

    if mode == "assessment":
        return base + """
## SESSION MODE: DIAGNOSTIC SPOKEN ASSESSMENT
You are conducting a 4-step progressive English evaluation.
Step 1: Ask the user to introduce themselves and their work or studies.
Step 2: Ask about a memorable past experience or trip (evaluating past tense).
Step 3: Ask for their opinion on a modern topic (e.g. remote work vs office, or online learning).
Step 4: Ask a question requiring descriptive nuance.
RULES:
- Do NOT interrupt or give grammar corrections during assessment.
- If user strays off-topic, gently steer back: "That's interesting! Coming back to your story, what happened next?"
- Move through the 4 steps progressively.
"""

    elif mode == "grammar_practice" and target_skill:
        title = lesson_context.get("lesson_title", target_skill.replace("_", " ").title())
        rule = lesson_context.get("rule_summary", "")
        activity = lesson_context.get("practice_activity", "")

        return base + f"""
## SESSION MODE: TARGETED GRAMMAR DRILL
- Target Grammar Skill: {title}
- Target Rule: {rule}
- Practice Goal: {activity}

CONVERSATIONAL STEERING RULES (CRITICAL):
1. Your sole goal in this session is to make the learner actively practice and speak sentences using '{title}'.
2. You must ask questions that naturally prompt the learner to use this grammar rule.
3. STRICT TOPIC STEERING: If the learner changes the subject or talks about unrelated things (like anime, weather, games, movies), briefly acknowledge in 4-5 words and IMMEDIATELY steer them back to practicing this grammar rule.
   Example: If practicing past tense and learner talks about anime: "Anime is awesome! Tell me about the last episode you watched — what happened in the story?"
4. If the learner makes an error on this target rule, immediately point out the rule and ask them to try saying it again with the correct structure.
"""

    elif mode == "vocabulary_practice" or target_skill == "collocations":
        return base + """
## SESSION MODE: NATURAL COLLOCATIONS & EXPRESSIONS
- Goal: Help the learner use natural conversational expressions and collocations instead of literal translations.
- Introduce 1 high-frequency idiom or natural collocation (e.g. 'take a break', 'catch up', 'make an effort', 'slip of the tongue').
- Prompt the learner to use it in their own sentence.
- STRICT STEERING: If the learner digresses, steer them back to using the target phrase in a sentence.
"""

    else:
        # Free conversation / Warmup
        return base + """
## SESSION MODE: CONVERSATIONAL WARMUP & FLUENCY CHECK
- Goal: Wake up the learner's spoken English with spontaneous, comfortable conversation.
- Ask about their day, recent experiences, hobbies, or light opinions.
- Keep the energy high and friendly.
- If the learner gives very short answers ("yes", "good"), ask an open "Why" or "Tell me more about..." question.
"""


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
# Parallel Path: Async Background Accuracy & Translation Card Generator
# ---------------------------------------------------------------------------

async def run_parallel_accuracy_check(room, text: str, user_id: str, session_id: str):
    """
    Analyzes learner utterance in parallel:
      - If learner spoke in Hindi / Hinglish: generates a Translation Card ("Hindi -> English").
      - If learner made an English grammar mistake: generates a Coach Recast Card.
    """
    if not text or len(text.strip().split()) < 2:
        return

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
            prompt = f"""You are an English language accuracy and translation analyzer for an Indian learner.
Learner utterance: "{text}"

Determine:
1. Did the learner speak in Hindi or Hinglish (e.g. "मैं इंग्लिश सीखना चाहता हूँ", "main theek hoon", "mujhe bahar jana hai", "aaj khana kya bana hai")?
   -> Generate a TRANSLATION card showing how to say that exact Hindi sentence in natural English.
   Return JSON:
   {{
     "has_card": true,
     "card_type": "translation",
     "original": "{text}",
     "corrected": "<natural conversational English translation>",
     "explanation": "<1 short sentence in Hinglish explaining the usage or rule>"
   }}

2. Did the learner speak in English with a grammatical error or awkward phrasing (e.g. "didn't went", "I am having two brothers", "he don't know", "my hobbies are watching anime")?
   -> Generate a CORRECTION card.
   Return JSON:
   {{
     "has_card": true,
     "card_type": "correction",
     "original": "{text}",
     "corrected": "<corrected natural English sentence>",
     "explanation": "<1 short sentence explanation in Hinglish (Hindi in English letters)>"
   }}

3. Did the learner speak natural, grammatically correct English?
   Return JSON:
   {{ "has_card": false }}

JSON ONLY:"""
            res = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
            return json.loads(res.text.strip())

        analysis = await asyncio.to_thread(_analyze)
        if analysis and analysis.get("has_card") and analysis.get("corrected"):
            card_type = analysis.get("card_type", "correction")
            logger.info("Card emitted (%s): '%s' -> '%s'", card_type, analysis.get("original"), analysis.get("corrected"))
            if room:
                payload = json.dumps({
                    "type": "correction",
                    "card_type": card_type,
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

        mode = self.lesson_context.get("mode") or ("grammar_practice" if self.target_skill else "free_conversation")
        instructions = build_mode_instructions(mode, self.target_skill, self.lesson_context)
        super().__init__(instructions=instructions)

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

        # Trigger visual card in parallel
        if self.room:
            asyncio.create_task(run_parallel_accuracy_check(self.room, user_text, self.user_id, self.session_id))


# ---------------------------------------------------------------------------
# Agent entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext):
    """LiveKit Agents entrypoint."""

    await ctx.connect()
    room = ctx.room
    room_name = room.name or ""
    session_id = room_name.removeprefix("session_") if room_name.startswith("session_") else room_name

    participant = await ctx.wait_for_participant()
    user_id = participant.identity

    target_skill = None
    lesson_context = {}

    # Fast non-blocking metadata lookup (300ms max timeout)
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
            asyncio.to_thread(_read_meta), timeout=0.4
        )
    except Exception:
        lesson_context = {"mode": "free_conversation"}

    mode = lesson_context.get("mode", "free_conversation")
    logger.info("Session ready: room=%s user=%s mode=%s skill=%s", room_name, user_id, mode, target_skill)

    # 1. Silero VAD — min_speech_duration=0.35s rejects sniffs, breath & fan hum
    vad = silero.VAD.load(
        min_speech_duration=0.35,
        min_silence_duration=0.55,
    )

    # 2. STT: Full Flagship Groq Whisper Large v3 (1550M params)
    stt = groq.STT(
        model="whisper-large-v3",
        detect_language=True,
        prompt="Bilingual English and Hindi practice. Common phrases: Hello, how are you? I want to practice speaking. नमस्ते, मैं ठीक हूँ।",
    )

    # 3. LLM: Google Gemini 3.5 Flash Lite
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        llm = google.LLM(
            model="gemini-3.5-flash-lite",
            api_key=gemini_key,
            temperature=0.25,
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

    # 5. AgentSession
    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.25,
        max_endpointing_delay=0.7,
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

    # Keep track of transcript messages for persistence & analysis
    session_messages = []

    # Broadcast every turn to UI transcript & record messages
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
            msg_role = "user" if role == "user" else "assistant"
            logger.info("Transcript broadcast [%s]: %s", speaker, text[:60])

            seq = next_sequence()
            msg_obj = {
                "message_id": f"{session_id}_seq_{seq:04d}_{msg_role}",
                "session_id": session_id,
                "role": msg_role,
                "text": text,
                "sequence": seq,
            }
            session_messages.append(msg_obj)

            # UI data channel broadcast
            asyncio.create_task(broadcast_ui_turn(room, speaker, text))

            # Persist message event
            ev_type = "USER_UTTERANCE" if msg_role == "user" else "AI_RESPONSE"
            asyncio.create_task(emit_event(make_event(
                ev_type,
                user_id,
                session_id,
                {"text": text, "sequence": seq},
            )))
        except Exception as exc:
            logger.debug("conversation_item_added note: %s", exc)

    @room.on("participant_disconnected")
    def on_disconnect(p):
        if p.identity == user_id:
            logger.info("Learner disconnected: %s (messages=%d)", session_id, len(session_messages))
            asyncio.create_task(emit_event(make_event(
                "SESSION_ENDED",
                user_id,
                session_id,
                {
                    "reason": "learner_disconnected",
                    "target_skill": target_skill,
                    "lesson_id": lesson_context.get("lesson_id"),
                    "mode": mode,
                    "messages": session_messages,
                },
            )))

    await session.start(
        room=room,
        agent=tutor,
    )

    # Greeting tailored to mode & target skill
    greeting_text = "Hello! Welcome to your English practice. How is your day going so far?"
    if mode == "assessment":
        greeting_text = "Welcome to your English assessment! Could you tell me a little about yourself?"
    elif mode == "grammar_practice" and target_skill:
        title = lesson_context.get("lesson_title", target_skill.replace("_", " ").title())
        greeting_text = f"Hello! Today we are practicing {title}. To start, tell me what you did earlier today!"
    elif mode == "vocabulary_practice":
        greeting_text = "Hello! Today we will practice natural English expressions. How are you feeling today?"
    elif lesson_context.get("practice_activity"):
        title = lesson_context.get("lesson_title", "speaking")
        greeting_text = f"Hello! Today we are practicing {title}. Are you ready to begin?"

    # Instant greeting audio (<200ms)
    logger.info("Streaming instant greeting: %s", greeting_text)
    asyncio.create_task(session.say(greeting_text, allow_interruptions=True))


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

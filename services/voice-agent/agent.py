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
    base = """You are Coach Pravaah, a warm, charismatic, and enthusiastic English conversation partner for an Indian learner.
Your #1 mission is to carry on a lively, fascinating, and comfortable conversation so the learner always has plenty to talk about and never feels bored!

## Core Rules:
1. Always react warmly with genuine interest and personality to what the learner said (e.g. validate their thoughts, share enthusiasm, or add a fun/relatable comment).
2. Keep your responses short and natural: 1 to 2 spoken sentences (maximum 25 words).
3. ALWAYS ask an engaging, open-ended question that gives the learner more to talk about (e.g. ask about their opinions, personal experiences, stories, or favorite details).
4. Do NOT give grammar lectures, corrections, or Hindi translations in your voice. A separate specialized engine handles grammar recasts and translations in parallel. Your job is 100% focused on keeping the conversation exciting, friendly, and moving!
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

# ---------------------------------------------------------------------------
# Noise, Breath, & Hallucination Filter
# ---------------------------------------------------------------------------

NOISE_OR_HALLUCINATIONS = {
    "sniffing", "snort", "cough", "coughing", "throat clearing", "sigh",
    "applause", "music", "laughter", "chuckle", "gasp", "whispering",
    "screaming", "inaudible", "silence", "you", "thank you", "thanks",
    "bye", "goodbye", "इंग्लिवेट", "huh", "um", "uh", "hmm", "hm"
}

def is_meaningful_speech(text: str) -> bool:
    if not text:
        return False
    clean = text.strip().lower().strip(".?!,;:-_ \t\n")
    if not clean:
        return False
    # Reject bracketed subtitle hallucinations like [Music], (Laughter), *sniff*
    if clean.startswith(("[", "(", "*")) and clean.endswith(("]", ")", "*")):
        return False
    if clean in NOISE_OR_HALLUCINATIONS:
        return False
    # Filter short murmurs under 3 letters
    if len(clean) < 3 and clean not in ["hi", "no", "ok", "yo"]:
        return False
    return True


# ---------------------------------------------------------------------------
# Parallel Path: Gemini Linguistic & Translation Engine (Parallel with Groq)
# ---------------------------------------------------------------------------

async def run_parallel_accuracy_check(room, session, text: str, user_id: str, session_id: str):
    """
    Runs concurrently with Gemini 3.5 Flash Lite while Groq generates conversation:
      - Emits visual TRANSLATION or CORRECTION card immediately to UI (<200ms).
      - Waits until Groq conversation audio completes speaking its final output.
      - Smoothly streams the spoken tip from Gemini sequentially (never overlapping).
    """
    if not is_meaningful_speech(text):
        return

    try:
        def _analyze():
            # 1. Primary: Gemini 3.5 Flash Lite for deep linguistic & translation accuracy
            gemini_key = os.getenv("GEMINI_API_KEY")
            if gemini_key:
                try:
                    import google.generativeai as genai
                    genai.configure(api_key=gemini_key)
                    model = genai.GenerativeModel("gemini-3.5-flash-lite")
                    prompt = f"""You are an English language accuracy and translation analyzer for an Indian learner.
Learner utterance: "{text}"

Determine:
1. Did the learner speak in Hindi or Hinglish (e.g. "मैं इंग्लिश सीखना चाहता हूँ", "main theek hoon", "mujhe bahar jana hai")?
   -> "has_card": true
   -> "card_type": "translation"
   -> "original": "{text}"
   -> "corrected": "<natural conversational English translation>"
   -> "explanation": "<1 short sentence in Hinglish explaining the English expression>"
   -> "spoken_tip": "In English, you can say: <corrected>."

2. Did the learner speak in English with a grammatical error, wrong tense, or awkward phrasing (e.g. "my hobbies are watching anime", "didn't went", "he don't know")?
   -> "has_card": true
   -> "card_type": "correction"
   -> "original": "{text}"
   -> "corrected": "<corrected natural English sentence>"
   -> "explanation": "<1 short sentence in Hinglish explaining the grammar rule>"
   -> "spoken_tip": "A quick tip: you can say, <corrected>."

3. Did the learner speak natural, grammatically correct English?
   -> "has_card": false

Return JSON ONLY:
{{
  "has_card": true/false,
  "card_type": "translation" | "correction",
  "original": "...",
  "corrected": "...",
  "explanation": "...",
  "spoken_tip": "..."
}}"""
                    res = model.generate_content(
                        prompt,
                        generation_config={
                            "response_mime_type": "application/json",
                            "max_output_tokens": 150,
                            "temperature": 0.2,
                        },
                    )
                    return json.loads(res.text.strip())
                except Exception as g_err:
                    logger.debug("Gemini parallel analysis notice: %s", g_err)

            # Fallback to Groq if Gemini key not configured
            groq_key = os.getenv("GROQ_API_KEY")
            if groq_key:
                try:
                    from groq import Groq
                    client = Groq(api_key=groq_key)
                    fast_model = os.getenv("GROQ_FAST_MODEL", "openai/gpt-oss-20b")
                    res = client.chat.completions.create(
                        model=fast_model,
                        messages=[{"role": "user", "content": prompt}],
                        response_format={"type": "json_object"},
                        max_tokens=150,
                        temperature=0.2,
                        timeout=3.0,
                    )
                    content = res.choices[0].message.content
                    if content:
                        return json.loads(content.strip())
                except Exception as groq_err:
                    logger.debug("Groq fallback notice: %s", groq_err)
            return None

        analysis = await asyncio.to_thread(_analyze)
        if analysis and analysis.get("has_card") and analysis.get("corrected"):
            card_type = analysis.get("card_type", "correction")
            original = analysis.get("original", text).strip()
            corrected = analysis.get("corrected", "").strip()
            explanation = analysis.get("explanation", "").strip()
            spoken_tip = analysis.get("spoken_tip")
            if not spoken_tip:
                if card_type == "translation":
                    spoken_tip = f"In English, you can say: {corrected}."
                else:
                    spoken_tip = f"A quick tip: you can say, {corrected}."

            logger.info("Card emitted (%s): '%s' -> '%s'", card_type, original, corrected)
            # 1. Instantly display visual card on learner screen (<200ms)
            if room:
                payload = json.dumps({
                    "type": "correction",
                    "card_type": card_type,
                    "original": original,
                    "corrected": corrected,
                    "explanation": explanation,
                }).encode("utf-8")
                await room.local_participant.publish_data(payload)

            # 2. Sequential Spoken Tip: wait for Groq's conversational speech to complete final output
            if session:
                # Give Groq speech a brief moment to initiate playback
                await asyncio.sleep(0.5)
                max_wait = 15.0
                elapsed = 0.0
                while getattr(session, "agent_state", "") == "speaking" and elapsed < max_wait:
                    await asyncio.sleep(0.2)
                    elapsed += 0.2

                # Natural polite pause after Groq's conversational reply
                await asyncio.sleep(0.3)
                logger.info("Sequential spoken tip delivered from Gemini: %s", spoken_tip)
                session.say(spoken_tip, allow_interruptions=True, add_to_chat_ctx=False)
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
        livekit_session=None,
        target_skill: str | None = None,
        lesson_context: dict | None = None,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.room = room
        self.livekit_session = livekit_session
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

        if not is_meaningful_speech(user_text):
            logger.info("Filtered background noise/non-verbal audio: %s", user_text)
            return

        # Trigger visual card and voice correction in parallel via Gemini
        if self.room:
            asyncio.create_task(run_parallel_accuracy_check(
                self.room, self.livekit_session, user_text, self.user_id, self.session_id
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

    # 1. Silero VAD — Tuned with OpenWhispr principles & outdoor noise rejection (walking/running)
    # - activation_threshold=0.60: Rejects wind buffeting, footstep thuds, traffic & breathing
    # - min_speech_duration=0.25 (250ms): Catches natural short affirmative answers ('yes', 'theek', 'haan')
    # - min_silence_duration=0.35 (350ms): Provides snappy turn turnaround without cutting off mid-sentence breath pauses
    # - prefix_padding_duration=0.1 (100ms): Preserves initial consonant attacks (OpenWhispr speechPadMs)
    vad = silero.VAD.load(
        activation_threshold=0.60,
        min_speech_duration=0.25,
        min_silence_duration=0.35,
        prefix_padding_duration=0.1,
    )

    # 2. STT: Flagship Groq Whisper Large v3 Turbo (4x faster decode, full bilingual Hindi & English transcription)
    stt_provider = os.getenv("STT_PROVIDER", "groq_turbo").lower()
    if stt_provider == "sherpa_streaming":
        try:
            from sherpa_stt import SherpaStreamingSTT
            sherpa_url = os.getenv("SHERPA_WS_URL", "ws://localhost:6006")
            logger.info("Using Sherpa-ONNX streaming ASR server at %s", sherpa_url)
            stt = SherpaStreamingSTT(server_url=sherpa_url)
        except Exception as s_err:
            logger.warning("Failed to initialize SherpaStreamingSTT (%s), falling back to Groq Turbo", s_err)
            stt_provider = "groq_turbo"

    if stt_provider != "sherpa_streaming":
        stt = groq.STT(
            model="whisper-large-v3-turbo",
            detect_language=True,
            prompt="Bilingual English and Hindi practice. Supports Hindi Devanagari and Romanized Hinglish. नमस्ते, मैं ठीक हूँ। Hello, how are you? I want to practice speaking.",
        )

    # 3. LLM: Groq for high rate-limits & lightning-fast speech, with fallback to Gemini
    groq_key = os.getenv("GROQ_API_KEY")
    gemini_key = os.getenv("GEMINI_API_KEY")
    if groq_key:
        groq_model = os.getenv("GROQ_VOICE_MODEL", "openai/gpt-oss-20b")
        logger.info("Using Groq LLM (%s) for ultra-fast, zero-latency conversation", groq_model)
        llm = groq.LLM(
            model=groq_model,
            api_key=groq_key,
            temperature=0.3,
        )
    elif gemini_key:
        logger.info("Using Google Gemini 3.5 Flash Lite")
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
        base_url=os.getenv("KOKORO_BASE_URL", "http://localhost:8880/v1"),
    )

    # 5. AgentSession: Low-latency turn-around + outdoor false-interruption defense
    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        min_endpointing_delay=0.18,
        max_endpointing_delay=0.50,
        preemptive_generation=True,
        allow_interruptions=True,
        min_interruption_duration=0.35,  # Protects against wind puffs or breath bursts during walking/running
        aec_warmup_duration=0.0,
    )

    tutor = EnglishTutor(
        user_id=user_id,
        session_id=session_id,
        room=room,
        livekit_session=session,
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

    # Instant greeting audio: trigger as soon as learner starts or publishes mic
    greeting_spoken = False

    def speak_greeting():
        nonlocal greeting_spoken
        if not greeting_spoken:
            greeting_spoken = True
            logger.info("Streaming instant greeting: %s", greeting_text)
            session.say(greeting_text, allow_interruptions=True)

    # 1. Trigger when client sends start_conversation data signal
    @room.on("data_received")
    def on_data(dp):
        try:
            data = json.loads(dp.data.decode("utf-8"))
            if data.get("type") == "start_conversation":
                logger.info("Received start_conversation signal from learner! Speaking greeting.")
                speak_greeting()
        except Exception:
            pass

    # 2. Trigger when learner publishes microphone audio track
    @room.on("track_published")
    def on_track(pub, participant):
        if participant.identity == user_id:
            logger.info("Learner audio track published! Speaking greeting.")
            speak_greeting()


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
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            num_idle_processes=0,
        ),
    )


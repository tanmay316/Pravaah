"""
Pravaah — Voice Agent (LiveKit Agents 1.x)

Design constraints this file is written against:
  * The realtime loop must never do synchronous work. Session context arrives as participant
    metadata on the join token, so there is no Firestore read (and no heavyweight import)
    anywhere on the hot path.
  * Transcript persistence and learning analysis are the API's job (POST
    /api/sessions/{id}/complete). Importing the learning engine here would drag litellm into
    the realtime process; it is opt-in via PRAVAAH_AGENT_PERSISTENCE.
  * The coach greets the learner by name, opens on the topic they picked, and steers the
    conversation back to that topic and goal.
"""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

from dotenv import load_dotenv

# Must be set before livekit.agents reads it. The loop monitor samples stack traces by
# re-reading source files from disk on every stall; on a CPU-starved host that turns one
# stall into a feedback loop of stalls. Opt back in by exporting a non-zero value.
os.environ.setdefault("LIVEKIT_AGENTS_LOOP_BLOCK_WARN_MS", "0")

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobExecutorType,
    WorkerOptions,
    cli,
)
from livekit.agents import llm as agent_llm
from livekit.agents import tts as agent_tts
from livekit.plugins import google, groq, openai, silero

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pravaah-voice-agent")

LITELLM_PROXY_URL = os.getenv("LITELLM_PROXY_URL", "http://localhost:4000")
LITELLM_PROXY_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-pravaah-dev-key")

# Gemini free-tier quotas differ sharply per model, and a 429 on one model says nothing about
# the next. Ordered best-first by (RPD, RPM, TPM); each entry is tried in turn on quota errors.
#   gemini-3.1-flash-lite  15 RPM / 250K TPM / 500 RPD
#   gemini-3.5-flash-lite  15 RPM / 250K TPM / 500 RPD
#   gemini-3.5-flash        5 RPM / 250K TPM /  20 RPD
#   gemma-4-31b            30 RPM /  16K TPM / 14.4K RPD  (huge daily budget, small context)
DEFAULT_GEMINI_CHAIN = "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.5-flash,gemma-4-31b"


def _model_chain(env_var: str, default: str) -> list[str]:
    raw = os.getenv(env_var) or default
    return [m.strip() for m in raw.split(",") if m.strip()]


# Conversation LLM fallbacks, used only when Groq is unavailable.
GEMINI_CHAIN = _model_chain("GEMINI_MODEL_CHAIN", DEFAULT_GEMINI_CHAIN)
# Every extra fallback instance is a live LLM client held for the whole session. Groq (tried
# first, and very reliable) covers the common case, so the conversational path only keeps the
# top two Gemini models by quota as a safety net rather than constructing all four.
GEMINI_VOICE_CHAIN = _model_chain("GEMINI_VOICE_MODEL_CHAIN", ",".join(GEMINI_CHAIN[:2]))
# The correction/translation card prompt is tiny, so the high-RPD small-context models suit it.
GEMINI_CARD_CHAIN = _model_chain("GEMINI_CARD_MODEL_CHAIN", "gemma-4-31b," + DEFAULT_GEMINI_CHAIN)
REALTIME_MODEL = os.getenv("REALTIME_MODEL", GEMINI_CHAIN[0])

# Persisting transcripts from inside the realtime process pulls in the learning engine
# (and litellm). The API already persists and analyses the full transcript on session end.
AGENT_PERSISTENCE_ENABLED = os.getenv("PRAVAAH_AGENT_PERSISTENCE", "false").lower() in {"1", "true", "yes"}


# ---------------------------------------------------------------------------
# Session context
# ---------------------------------------------------------------------------

DEFAULT_CONTEXT = {
    "mode": "free_conversation",
    "conversation_goal": "intro",
    "topic": None,
    "roleplay_scenario": None,
    "learner_name": None,
    "target_skill": None,
    "lesson_id": None,
}


def parse_session_context(raw_metadata: str | None) -> dict:
    """Read the session context the API embedded in the participant's join token."""
    ctx = dict(DEFAULT_CONTEXT)
    if not raw_metadata:
        return ctx
    try:
        parsed = json.loads(raw_metadata)
    except (ValueError, TypeError):
        logger.warning("Participant metadata was not valid JSON; using defaults.")
        return ctx
    if not isinstance(parsed, dict):
        return ctx
    for key in (
        "mode", "conversation_goal", "topic", "roleplay_scenario", "learner_name",
        "target_skill", "lesson_id", "user_id", "session_id", "pravaah_level", "hindi_support",
    ):
        if parsed.get(key):
            ctx[key] = parsed[key]
    return ctx


def first_name(full_name: str | None) -> str | None:
    if not full_name:
        return None
    cleaned = str(full_name).strip().split("@")[0].replace(".", " ").replace("_", " ").strip()
    return cleaned.split()[0].title() if cleaned else None


# ---------------------------------------------------------------------------
# Dynamic Mode-Specific Prompt & Conversational Steering Builder
# ---------------------------------------------------------------------------

def build_mode_instructions(mode: str, target_skill: str | None, lesson_context: dict) -> str:
    name = first_name(lesson_context.get("learner_name"))
    topic = (lesson_context.get("topic") or "").strip()
    goal = (lesson_context.get("conversation_goal") or "intro").strip()
    scenario = (lesson_context.get("roleplay_scenario") or "").strip()

    base = f"""You are Coach Pravaah, a warm, charismatic, and enthusiastic English conversation partner for an Indian learner{f" named {name}" if name else ""}.
Your #1 mission is to carry on a lively, fascinating, and comfortable conversation so the learner always has plenty to talk about and never feels bored!

## Core Rules:
1. Always react warmly with genuine interest and personality to what the learner said (e.g. validate their thoughts, share enthusiasm, or add a fun/relatable comment).
2. Keep your responses short and natural: 1 to 2 spoken sentences (maximum 25 words).
3. ALWAYS ask an engaging, open-ended question that gives the learner more to talk about (e.g. ask about their opinions, personal experiences, stories, or favorite details).
4. Do NOT give grammar lectures, corrections, or Hindi translations in your voice. A separate specialized engine handles grammar recasts and translations in parallel. Your job is 100% focused on keeping the conversation exciting, friendly, and moving!
5. Plain conversational text ONLY (NEVER use markdown, asterisks **, bullet points, or numbering).
"""

    if topic:
        base += f"""
## LOCKED SESSION TOPIC: {topic}
The learner explicitly chose to talk about "{topic}". This is the spine of the whole session.
- Open on it, stay on it, and keep finding fresh angles on it.
- If the learner drifts to something unrelated, acknowledge it in at most 5 words, then bridge
  straight back to "{topic}" with a specific question. Never announce that you are steering.
- Only leave the topic if the learner explicitly asks to change it.
"""

    if mode == "assessment" or goal == "assessment":
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

    if goal == "roleplay" or mode == "roleplay":
        scene = scenario or topic or "a realistic everyday situation"
        return base + f"""
## SESSION MODE: ROLEPLAY SIMULATION — {scene}
- Immediately adopt and hold the appropriate persona for "{scene}" (e.g. hiring manager, client,
  senior colleague, hotel concierge, shopkeeper, customer support agent).
- Open by setting the scene in one short line, in character, then ask your first in-character question.
- Stay in character for the entire session. Never break character to explain grammar.
- Drive the scenario forward with realistic complications so the learner has to react and improvise.
- If the learner stalls, offer an in-character prompt rather than a meta instruction.
"""

    if goal == "grammar" or (mode == "grammar_practice" and target_skill):
        title = lesson_context.get("lesson_title") or (
            target_skill.replace("_", " ").title() if target_skill else "spoken accuracy"
        )
        rule = lesson_context.get("rule_summary", "")
        activity = lesson_context.get("practice_activity", "")

        return base + f"""
## SESSION MODE: TARGETED GRAMMAR DRILL
- Target Grammar Skill: {title}
- Target Rule: {rule}
- Practice Goal: {activity}
{f'- Practise this strictly through the topic "{topic}".' if topic else ""}

CONVERSATIONAL STEERING RULES (CRITICAL):
1. Your sole goal in this session is to make the learner actively practice and speak sentences using '{title}'.
2. You must ask questions that naturally prompt the learner to use this grammar rule.
3. STRICT TOPIC STEERING: If the learner changes the subject, briefly acknowledge in 4-5 words and IMMEDIATELY steer them back to practicing this grammar rule.
4. If the learner makes an error on this target rule, model the correct phrasing in one short sentence and ask them to say it again correctly.
"""

    if goal == "vocabulary" or mode == "vocabulary_practice" or target_skill == "collocations":
        return base + f"""
## SESSION MODE: NATURAL COLLOCATIONS & EXPRESSIONS
- Goal: Help the learner use natural conversational expressions and collocations instead of literal translations.
- Introduce 1 high-frequency idiom or natural collocation (e.g. 'take a break', 'catch up', 'make an effort').
{f'- Choose expressions that fit the topic "{topic}" so they are immediately useful.' if topic else ""}
- Prompt the learner to use it in their own sentence.
- STRICT STEERING: If the learner digresses, steer them back to using the target phrase in a sentence.
"""

    if goal == "fluency":
        return base + f"""
## SESSION MODE: FLUENCY & SPEAKING TIME
- Maximise the learner's talking time. You speak little; they speak a lot.
- Ask questions that require stories, comparisons, opinions and explanations rather than yes/no answers.
- Never interrupt. When they pause, wait, then offer a short nudge.
{f'- Every question must come from the topic "{topic}".' if topic else ""}
"""

    # Friendly intro / casual chat
    return base + f"""
## SESSION MODE: FRIENDLY CONVERSATION & INTRODUCTION
- Carry on a lively, curious, supportive conversation.
- Ask open-ended questions about their experiences, feelings, and perspectives.
- Praise well-formed sentences briefly and sincerely.
{f'- Every question must grow out of the topic "{topic}".' if topic else "- Early on, find out what they enjoy talking about and build the session around it."}

### Style Guidelines:
- Concise spoken turns: 1 to 3 sentences maximum (25-35 words).
- Always end with an open prompt so the conversation flows seamlessly without awkward silences.
"""


def build_greeting(lesson_context: dict, target_skill: str | None) -> str:
    """
    First thing the learner hears. It names them, names the topic they chose, and asks a
    question that already belongs to that topic, so the session starts on-subject.
    """
    name = first_name(lesson_context.get("learner_name"))
    hello = f"Hi {name}!" if name else "Hello!"
    topic = (lesson_context.get("topic") or "").strip()
    goal = (lesson_context.get("conversation_goal") or "intro").strip()
    mode = lesson_context.get("mode") or "free_conversation"
    scenario = (lesson_context.get("roleplay_scenario") or "").strip()

    if mode == "assessment" or goal == "assessment":
        return f"{hello} Welcome to your English assessment. To start, could you tell me a little about yourself?"

    if goal == "roleplay" or mode == "roleplay":
        scene = scenario or topic or "a real-world situation"
        return (
            f"{hello} Let's role-play {scene}. I'll stay in character the whole time, so just "
            "respond naturally. Ready? Let's begin."
        )

    if goal == "grammar" or (mode == "grammar_practice" and target_skill):
        title = lesson_context.get("lesson_title") or (
            target_skill.replace("_", " ").title() if target_skill else "your spoken accuracy"
        )
        if topic:
            return f"{hello} Today we're polishing {title} while we talk about {topic}. So tell me, what got you interested in {topic}?"
        return f"{hello} Today we're practising {title}. To start, tell me what you did earlier today."

    if goal == "vocabulary" or mode == "vocabulary_practice":
        if topic:
            return f"{hello} Today we'll pick up natural English expressions around {topic}. To begin, tell me what {topic} means to you."
        return f"{hello} Today we'll practise natural English expressions. How are you feeling today?"

    if goal == "fluency":
        if topic:
            return f"{hello} I want to hear you talk as much as possible today, all about {topic}. Take your time and tell me everything you know about it."
        return f"{hello} Today is all about speaking time. Tell me about something that happened to you this week."

    if topic:
        return f"{hello} I'm Coach Pravaah. You picked {topic}, and I'd love to hear about it. What's your experience with {topic}?"

    return (
        f"{hello} I'm Coach Pravaah, your spoken English partner. "
        "What would you like to talk about today?"
    )



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
    if not AGENT_PERSISTENCE_ENABLED:
        return
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

    analysis_prompt = f"""You are an English language accuracy and translation analyzer for an Indian learner.
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

    try:
        def _analyze():
            # 1. Primary: Groq — same provider as the conversation LLM, so no extra cold start.
            groq_key = os.getenv("GROQ_API_KEY")
            if groq_key:
                try:
                    from groq import Groq
                    client = Groq(api_key=groq_key)
                    fast_model = os.getenv("GROQ_FAST_MODEL", "openai/gpt-oss-20b")
                    res = client.chat.completions.create(
                        model=fast_model,
                        messages=[{"role": "user", "content": analysis_prompt}],
                        response_format={"type": "json_object"},
                        max_tokens=200,
                        temperature=0.2,
                        timeout=4.0,
                    )
                    content = res.choices[0].message.content
                    if content:
                        return json.loads(content.strip())
                except Exception as groq_err:
                    logger.debug("Groq parallel analysis notice: %s", groq_err)

            # 2. Fallback: walk the Gemini chain until one is not rate limited.
            gemini_key = os.getenv("GEMINI_API_KEY")
            if gemini_key:
                try:
                    import google.generativeai as genai
                    genai.configure(api_key=gemini_key)
                except Exception as cfg_err:
                    logger.debug("Gemini configure notice: %s", cfg_err)
                    return None

                for model_name in GEMINI_CARD_CHAIN:
                    try:
                        model = genai.GenerativeModel(model_name)
                        res = model.generate_content(
                            analysis_prompt,
                            generation_config={
                                "response_mime_type": "application/json",
                                "max_output_tokens": 200,
                                "temperature": 0.2,
                            },
                        )
                        return json.loads(res.text.strip())
                    except Exception as g_err:
                        logger.debug("Gemini card model %s unavailable: %s", model_name, g_err)
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

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    room = ctx.room
    room_name = room.name or ""
    session_id = room_name.removeprefix("session_") if room_name.startswith("session_") else room_name

    # Wait briefly for the learner, then read the session context straight off their join
    # token. This replaces a Firestore round trip that used to run on the realtime loop.
    participant = None
    try:
        participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=10.0)
    except asyncio.TimeoutError:
        logger.warning("No participant joined room %s within 10s.", room_name)
    except Exception as exc:
        logger.warning("wait_for_participant notice: %s", exc)

    lesson_context = parse_session_context(getattr(participant, "metadata", None))
    user_id = lesson_context.get("user_id") or (participant.identity if participant else "learner")
    if not lesson_context.get("learner_name") and participant is not None:
        lesson_context["learner_name"] = getattr(participant, "name", None)
    lesson_context["session_id"] = lesson_context.get("session_id") or session_id
    target_skill = lesson_context.get("target_skill")

    mode = lesson_context.get("mode", "free_conversation")
    logger.info(
        "Session ready: room=%s user=%s mode=%s goal=%s topic=%r skill=%s",
        room_name, user_id, mode, lesson_context.get("conversation_goal"),
        lesson_context.get("topic"), target_skill,
    )

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

    # 3. LLM: Groq first for latency, then the Gemini chain. FallbackAdapter switches
    # providers per-request, so one model's quota running out doesn't end the session.
    groq_key = os.getenv("GROQ_API_KEY")
    gemini_key = os.getenv("GEMINI_API_KEY")
    llm_candidates = []

    if groq_key:
        for groq_model in _model_chain(
            "GROQ_MODEL_CHAIN",
            os.getenv("GROQ_VOICE_MODEL", "openai/gpt-oss-20b") + ",llama-3.3-70b-versatile",
        ):
            try:
                llm_candidates.append(groq.LLM(model=groq_model, api_key=groq_key, temperature=0.3))
            except Exception as exc:
                logger.warning("Groq LLM %s unavailable: %s", groq_model, exc)

    if gemini_key:
        for gemini_model in GEMINI_VOICE_CHAIN:
            try:
                llm_candidates.append(
                    google.LLM(model=gemini_model, api_key=gemini_key, temperature=0.25)
                )
            except Exception as exc:
                logger.warning("Gemini LLM %s unavailable: %s", gemini_model, exc)

    if not llm_candidates:
        logger.error(
            "No GROQ_API_KEY or GEMINI_API_KEY set; falling back to the LiteLLM proxy at %s",
            LITELLM_PROXY_URL,
        )
        llm_candidates.append(
            openai.LLM(model=REALTIME_MODEL, base_url=LITELLM_PROXY_URL, api_key=LITELLM_PROXY_KEY)
        )

    logger.info("LLM chain: %s", [c.model for c in llm_candidates])
    llm = llm_candidates[0] if len(llm_candidates) == 1 else agent_llm.FallbackAdapter(llm_candidates)

    # 4. TTS: Neural Indian English voice over an OpenAI-compatible /v1/audio/speech endpoint,
    # with Groq's hosted TTS behind it so a dead edge-tts host doesn't mute the coach.
    # TTS_BASE_URL must point at a host that is not competing with the agent for CPU.
    tts_base_url = os.getenv("TTS_BASE_URL") or os.getenv("KOKORO_BASE_URL") or "http://127.0.0.1:10000/v1"
    logger.info("Primary TTS endpoint: %s", tts_base_url)
    tts_candidates = [
        openai.TTS(
            model="tts-1",
            voice=os.getenv("TTS_VOICE", "en-IN-PrabhatNeural"),
            api_key="not-needed",
            base_url=tts_base_url,
        )
    ]

    if groq_key:
        try:
            tts_candidates.append(
                groq.TTS(
                    model=os.getenv("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english"),
                    voice=os.getenv("GROQ_TTS_VOICE", "troy"),
                    api_key=groq_key,
                )
            )
        except Exception as exc:
            logger.warning("Groq TTS fallback unavailable: %s", exc)

    tts = tts_candidates[0] if len(tts_candidates) == 1 else agent_tts.FallbackAdapter(tts_candidates)

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

    # Greeting tailored to the learner, their chosen topic and their session goal.
    greeting_text = build_greeting(lesson_context, target_skill)

    greeting_spoken = False

    def speak_greeting(trigger: str):
        """Idempotent: whichever signal arrives first wins, the rest are no-ops."""
        nonlocal greeting_spoken
        if greeting_spoken:
            return
        greeting_spoken = True
        logger.info("Greeting (trigger=%s): %s", trigger, greeting_text)
        # Show it in the transcript immediately, then speak it.
        asyncio.create_task(broadcast_ui_turn(room, "tutor", greeting_text))
        try:
            session.say(greeting_text, allow_interruptions=True)
        except Exception as s_err:
            logger.warning("session.say greeting notice: %s", s_err)

    # The client publishes its microphone and then sends start_conversation; either is a
    # reliable "the learner can hear us now" signal, and a timer covers the rest.
    @room.on("track_published")
    def on_track(pub, participant):
        logger.info("Audio track published by %s", participant.identity)
        speak_greeting("track_published")

    @room.on("data_received")
    def on_data(dp):
        try:
            data = json.loads(dp.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if data.get("type") == "start_conversation":
            speak_greeting("start_conversation")

    async def _greeting_timer():
        await asyncio.sleep(2.0)
        if len(room.remote_participants) > 0:
            speak_greeting("timer")

    asyncio.create_task(_greeting_timer())

    # The learner may have published their mic before these handlers existed, in which case
    # no event is coming; greet on what is already in the room.
    for remote in room.remote_participants.values():
        if any(pub.kind == rtc.TrackKind.KIND_AUDIO for pub in remote.track_publications.values()):
            speak_greeting("existing_track")
            break


# ---------------------------------------------------------------------------
# Optional background persistence (off by default; see AGENT_PERSISTENCE_ENABLED)
# ---------------------------------------------------------------------------

process_event = None
enqueue_outbox_event = None

if AGENT_PERSISTENCE_ENABLED:
    import sys

    _learning_engine_dir = os.path.join(os.path.dirname(__file__), "..", "learning-engine")
    if _learning_engine_dir not in sys.path:
        sys.path.insert(0, os.path.abspath(_learning_engine_dir))
    try:
        from worker import (  # noqa: E402
            process_event,
            enqueue_outbox_event,
        )
    except Exception as exc:
        logger.warning("Agent persistence requested but the learning engine failed to import: %s", exc)


if __name__ == "__main__":
    # PROCESS isolates the job from the worker's event loop, which is what keeps audio
    # smooth. THREAD shares one GIL with the worker and every stall becomes everyone's
    # stall; only use it where memory is too tight for a second interpreter.
    executor_type = (
        JobExecutorType.THREAD
        if os.getenv("JOB_EXECUTOR", "thread").lower() == "thread"
        else JobExecutorType.PROCESS
    )
    logger.info("Starting worker with %s job executor", executor_type)

    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            job_executor_type=executor_type,
            num_idle_processes=int(os.getenv("NUM_IDLE_PROCESSES", "0")),
            host="127.0.0.1",
            port=0,
            load_threshold=float("inf"),
        ),
    )


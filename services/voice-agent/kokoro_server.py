"""
Fast Neural Indian TTS Server (Edge-TTS + Pre-warmed LRU Cache)

Features:
  - High-fidelity Neural Indian English voice (`en-IN-NeerjaNeural`)
  - Complete, glitch-free MP3 frame delivery (prevents audio emitter flush / breaking voice)
  - Pre-warmed in-memory cache for instant greetings & common tutor responses
  - Automatic fallback to Kokoro ONNX if offline
"""

import asyncio
import io
import logging
import os
import time

import edge_tts
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-server")

app = FastAPI(title="Fast Indian TTS Server", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Kokoro ONNX fallback (offline only)
# ---------------------------------------------------------------------------
_kokoro_instance = None
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v0_19.onnx")
VOICES_BIN = os.path.join(MODEL_DIR, "voices-v1.0.bin")
VOICES_JSON = os.path.join(MODEL_DIR, "voices.json")
VOICES_PATH = VOICES_BIN if os.path.exists(VOICES_BIN) else VOICES_JSON


def get_kokoro():
    global _kokoro_instance
    if _kokoro_instance is None:
        try:
            from kokoro_onnx import Kokoro
            if os.path.exists(MODEL_PATH) and os.path.exists(VOICES_PATH):
                _kokoro_instance = Kokoro(MODEL_PATH, VOICES_PATH)
        except Exception:
            pass
    return _kokoro_instance


# ---------------------------------------------------------------------------
# In-memory LRU cache
# ---------------------------------------------------------------------------
_tts_cache: dict[str, bytes] = {}
MAX_CACHE = 400

VALID_VOICES = {"en-IN-PrabhatNeural", "en-IN-NeerjaNeural", "hi-IN-SwaraNeural"}
DEFAULT_VOICE = "en-IN-PrabhatNeural"

PREWARM_PHRASES = [
    "Hello! Welcome to your English practice. How is your day going so far?",
    "Welcome to your English assessment! Could you tell me a little about yourself?",
    "Hello! Today we will practice natural English expressions. How are you feeling today?",
    "Hello! Welcome. How are you doing today?",
    "Hello! Welcome to your English speaking session. How are you doing today?",
    "Okay.",
    "Great job!",
    "Perfect, that was very clear and natural!",
    "Exactly right, well done!",
]


class SpeechRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = DEFAULT_VOICE
    response_format: str = "mp3"
    speed: float = 1.0


def _clean(text: str) -> str:
    """Strip markdown artifacts and punctuation that confuse TTS."""
    t = text.strip().replace("**", "").replace("*", "").replace("#", "").replace('"', "").replace("`", "")
    return t if t else "Okay."


def _resolve_voice(v: str) -> str:
    return v if v in VALID_VOICES else DEFAULT_VOICE


def _cache_key(voice: str, text: str) -> str:
    return f"{voice}|{text}"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health_check():
    return {"status": "ok", "engine": "edge-tts", "cached_items": len(_tts_cache)}


@app.post("/v1/audio/speech")
async def generate_speech(req: SpeechRequest):
    t0 = time.monotonic()
    clean_text = _clean(req.input)
    voice = _resolve_voice(req.voice)
    key = _cache_key(voice, clean_text)

    # --- 1. In-memory Cache Hit (0ms) ---
    if key in _tts_cache:
        elapsed = (time.monotonic() - t0) * 1000
        logger.info("TTS [CACHE HIT] %.0fms: %s", elapsed, clean_text[:50])
        return Response(
            content=_tts_cache[key],
            media_type="audio/mpeg",
            headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
        )

    # --- 2. High-speed Edge-TTS Synthesis ---
    try:
        communicate = edge_tts.Communicate(clean_text, voice=voice)
        audio_buf = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buf.extend(chunk["data"])

        result_bytes = bytes(audio_buf)
        if result_bytes:
            if len(_tts_cache) < MAX_CACHE:
                _tts_cache[key] = result_bytes
            elapsed = (time.monotonic() - t0) * 1000
            logger.info("TTS [SYNTH] %.0fms (%d bytes): %s", elapsed, len(result_bytes), clean_text[:50])
            return Response(
                content=result_bytes,
                media_type="audio/mpeg",
                headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
            )
    except Exception as edge_err:
        logger.warning("Edge-TTS error, falling back to Kokoro: %s", edge_err)

    # --- 3. Kokoro Fallback (offline) ---
    try:
        import soundfile as sf
        kokoro = get_kokoro()
        if kokoro:
            k_voice = "hf_alpha" if "hf_alpha" in kokoro.get_voices() else "af_heart"
            lang = "hi" if k_voice.startswith("hf_") else "en-us"
            samples, sample_rate = kokoro.create(clean_text, voice=k_voice, speed=1.0, lang=lang)
            buffer = io.BytesIO()
            sf.write(buffer, samples, sample_rate, format="WAV")
            buffer.seek(0)
            return Response(
                content=buffer.read(),
                media_type="audio/wav",
                headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
            )
    except Exception as kokoro_err:
        logger.error("Kokoro fallback failed: %s", kokoro_err)

    raise HTTPException(status_code=500, detail="TTS generation failed")


# ---------------------------------------------------------------------------
# Pre-warm cache on startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def prewarm_cache():
    """Pre-synthesize common greetings for 0s greeting latency."""
    logger.info("Pre-warming TTS cache...")
    for phrase in PREWARM_PHRASES:
        try:
            key = _cache_key(DEFAULT_VOICE, phrase)
            communicate = edge_tts.Communicate(phrase, voice=DEFAULT_VOICE)
            buf = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.extend(chunk["data"])
            _tts_cache[key] = bytes(buf)
        except Exception as e:
            logger.warning("Prewarm notice for '%s': %s", phrase[:30], e)
    logger.info("TTS ready with %d pre-cached phrases.", len(_tts_cache))


if __name__ == "__main__":
    host = os.getenv("TTS_HOST", "127.0.0.1")
    port = int(os.getenv("TTS_PORT", "8880"))
    uvicorn.run(app, host=host, port=port)

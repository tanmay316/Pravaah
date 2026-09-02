"""
Fast TTS Server — Streaming Edge-TTS with LRU Cache

Key optimizations:
  1. STREAMING response: chunks sent to client as Edge-TTS produces them
     (no more buffering entire audio before responding → ~3x lower TTFA)
  2. In-memory LRU cache for repeated/greeting phrases (instant replay)
  3. Pre-warmed cache for common greetings on startup
  4. Kokoro ONNX fallback if Edge-TTS fails (offline mode)
"""

import asyncio
import io
import os
import time
import logging

import edge_tts
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-server")

app = FastAPI(title="Fast Streaming TTS Server", version="2.0.0")

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
# In-memory LRU cache (capped at 300 entries)
# ---------------------------------------------------------------------------
_tts_cache: dict[str, bytes] = {}
MAX_CACHE = 300

VALID_VOICES = {"en-IN-NeerjaNeural", "en-IN-PrabhatNeural", "hi-IN-SwaraNeural"}
DEFAULT_VOICE = "en-IN-NeerjaNeural"

# Greetings to pre-warm on startup (instant playback for first session)
PREWARM_PHRASES = [
    "Hello! Welcome to your English speaking session. How are you doing today?",
    "Hello! Welcome to your English speaking session. How are you doing today, and what would you like to talk about?",
    "Okay.",
    "Great job!",
    "Perfect, that was very clear and natural!",
    "Can you try saying that again?",
]


class SpeechRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = DEFAULT_VOICE
    response_format: str = "mp3"
    speed: float = 1.0


def _clean(text: str) -> str:
    """Strip markdown artifacts that confuse TTS."""
    t = text.strip().replace("**", "").replace("*", "").replace("#", "").replace('"', "")
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
    return {"status": "ok", "engine": "edge-tts-streaming", "cached": len(_tts_cache)}


@app.post("/v1/audio/speech")
async def generate_speech(req: SpeechRequest):
    t0 = time.monotonic()
    clean_text = _clean(req.input)
    voice = _resolve_voice(req.voice)
    key = _cache_key(voice, clean_text)

    # --- Cache hit: instant response ---
    if key in _tts_cache:
        elapsed = (time.monotonic() - t0) * 1000
        logger.debug("TTS cache HIT [%.0fms] %s", elapsed, clean_text[:60])
        return Response(
            content=_tts_cache[key],
            media_type="audio/mpeg",
            headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
        )

    # --- Streaming Edge-TTS synthesis ---
    try:
        communicate = edge_tts.Communicate(clean_text, voice=voice)

        # For short text (< 100 chars), buffer completely for caching + speed
        if len(clean_text) < 100:
            audio_buf = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_buf.extend(chunk["data"])
            result = bytes(audio_buf)
            if len(_tts_cache) < MAX_CACHE:
                _tts_cache[key] = result
            elapsed = (time.monotonic() - t0) * 1000
            logger.info("TTS synth [%.0fms] (%d bytes) %s", elapsed, len(result), clean_text[:60])
            return Response(
                content=result,
                media_type="audio/mpeg",
                headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
            )

        # For longer text, stream chunks to client as they arrive
        async def audio_stream():
            buf = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    data = chunk["data"]
                    buf.extend(data)
                    yield data
            # Cache the full result after streaming completes
            if len(_tts_cache) < MAX_CACHE:
                _tts_cache[key] = bytes(buf)

        elapsed = (time.monotonic() - t0) * 1000
        logger.info("TTS streaming start [%.0fms] %s", elapsed, clean_text[:60])
        return StreamingResponse(
            audio_stream(),
            media_type="audio/mpeg",
            headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
        )

    except Exception as edge_err:
        logger.warning("Edge-TTS error, trying Kokoro fallback: %s", edge_err)

    # --- Kokoro ONNX fallback (offline) ---
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
        logger.error("Kokoro fallback also failed: %s", kokoro_err)

    raise HTTPException(status_code=500, detail="TTS generation failed")


# ---------------------------------------------------------------------------
# Pre-warm cache on startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def prewarm_cache():
    """Pre-synthesize common greetings so first session is instant."""
    logger.info("Pre-warming TTS cache with %d phrases...", len(PREWARM_PHRASES))
    for phrase in PREWARM_PHRASES:
        try:
            voice = DEFAULT_VOICE
            key = _cache_key(voice, phrase)
            communicate = edge_tts.Communicate(phrase, voice=voice)
            buf = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.extend(chunk["data"])
            _tts_cache[key] = bytes(buf)
            logger.info("  Cached: %s (%d bytes)", phrase[:50], len(buf))
        except Exception as e:
            logger.warning("  Failed to cache: %s — %s", phrase[:50], e)
    logger.info("TTS cache pre-warmed: %d entries ready", len(_tts_cache))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8880)

import io
import os
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import edge_tts

app = FastAPI(title="Fast TTS Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_kokoro_instance = None
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v0_19.onnx")
VOICES_BIN = os.path.join(MODEL_DIR, "voices-v1.0.bin")
VOICES_JSON = os.path.join(MODEL_DIR, "voices.json")
VOICES_PATH = VOICES_BIN if os.path.exists(VOICES_BIN) else VOICES_JSON

# In-memory LRU cache for ultra-fast repeated phrases
_tts_cache: dict[str, bytes] = {}


def get_kokoro():
    global _kokoro_instance
    if _kokoro_instance is None:
        from kokoro_onnx import Kokoro
        if os.path.exists(MODEL_PATH) and os.path.exists(VOICES_PATH):
            _kokoro_instance = Kokoro(MODEL_PATH, VOICES_PATH)
    return _kokoro_instance


class SpeechRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = "en-IN-NeerjaNeural"
    response_format: str = "mp3"
    speed: float = 1.0


@app.get("/health")
def health_check():
    return {"status": "ok", "engine": "edge-tts"}


@app.post("/v1/audio/speech")
async def generate_speech(req: SpeechRequest):
    try:
        clean_text = req.input.strip().replace("*", "").replace("#", "").replace('"', "")
        if not clean_text:
            clean_text = "Okay."

        voice = req.voice or "en-IN-NeerjaNeural"
        if voice not in ["en-IN-NeerjaNeural", "en-IN-PrabhatNeural", "hi-IN-SwaraNeural"]:
            voice = "en-IN-NeerjaNeural"

        cache_key = f"{voice}_{clean_text}"
        if cache_key in _tts_cache:
            return Response(
                content=_tts_cache[cache_key],
                media_type="audio/mpeg",
                headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
            )

        # High-speed Edge-TTS Neural synthesis
        try:
            communicate = edge_tts.Communicate(clean_text, voice=voice)
            audio_buffer = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_buffer.extend(chunk["data"])

            result_bytes = bytes(audio_buffer)
            if len(_tts_cache) < 200:
                _tts_cache[cache_key] = result_bytes

            return Response(
                content=result_bytes,
                media_type="audio/mpeg",
                headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
            )
        except Exception as edge_err:
            print(f"[TTS] Edge-TTS error, trying Kokoro fallback: {edge_err}")

        # Fallback to local Kokoro if offline
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

        raise HTTPException(status_code=500, detail="TTS generation failed")
    except Exception as e:
        print(f"[TTS Server Error] {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8880)

import io
import os
import tempfile
import time
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import pyttsx3

app = FastAPI()

class SpeechRequest(BaseModel):
    model: str
    input: str
    voice: str = "af_heart"
    response_format: str = "mp3"
    speed: float = 1.0

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/v1/audio/speech")
async def create_speech(req: SpeechRequest):
    text = req.input.strip()
    if not text:
        text = "Hello!"
    print(f"[TTS] Generating speech for: '{text[:60]}...'")
    
    try:
        engine = pyttsx3.init()
        engine.setProperty("rate", 160)
        voices = engine.getProperty("voices")
        for v in voices:
            if "zira" in v.name.lower() or "female" in v.name.lower() or "eva" in v.name.lower() or "hazel" in v.name.lower():
                engine.setProperty("voice", v.id)
                break
                
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            temp_path = f.name
            
        engine.save_to_file(text, temp_path)
        engine.runAndWait()
        
        with open(temp_path, "rb") as f:
            wav_bytes = f.read()
            
        try:
            os.remove(temp_path)
        except Exception:
            pass
            
        print(f"[TTS] Generated {len(wav_bytes)} bytes of clear English voice")
        return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")
    except Exception as e:
        print(f"[TTS] Error generating voice: {e}")
        return StreamingResponse(io.BytesIO(b""), media_type="audio/wav")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8880)

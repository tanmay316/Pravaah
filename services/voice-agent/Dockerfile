FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY services/voice-agent/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/voice-agent/ /app/

# Downloads the Silero VAD weights at build time so the first job does not stall on them.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()" || true

# TTS_BASE_URL must point at an OpenAI-compatible /v1/audio/speech endpoint that is not
# competing with this process for CPU (the Pravaah API serves one at /v1).
ENV TTS_BASE_URL=""

CMD ["python", "agent.py", "start"]

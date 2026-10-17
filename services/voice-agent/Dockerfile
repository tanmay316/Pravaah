# Build context is this directory: `lk agent deploy` (run from services/voice-agent) and
# docker-compose both build from here, so the agent never gets confused with the API image.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    JOB_EXECUTOR=process \
    STT_PROVIDER=groq_turbo \
    VAD_MIN_SILENCE=0.38 \
    MIN_ENDPOINTING_DELAY=0.22 \
    MAX_ENDPOINTING_DELAY=0.85 \
    GROQ_VOICE_MODEL=qwen/qwen3.8-27b \
    GROQ_FAST_MODEL=qwen/qwen3.8-27b

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/

# Downloads the Silero VAD weights at build time so the first job does not stall on them.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()" || true

CMD ["python", "agent.py", "start"]

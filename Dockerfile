# Pravaah REST API + embedded neural TTS, and optionally the realtime voice agent.
#
# RUN_VOICE_AGENT=true co-hosts the LiveKit agent in this container. That is the simplest
# single-service deployment, but the agent competes with HTTP traffic for CPU; on a 0.1-vCPU
# instance expect "job executor is unresponsive" in the logs. For anything beyond testing,
# deploy services/voice-agent separately (see docs/DEPLOYMENT.md).
FROM python:3.11-slim

WORKDIR /app

# ffmpeg/libsndfile are needed by edge-tts output handling; curl for health probes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY services/api/requirements.txt /app/req-api.txt
COPY services/learning-engine/requirements.txt /app/req-le.txt
COPY services/voice-agent/requirements.txt /app/req-voice.txt

RUN pip install --no-cache-dir -r /app/req-api.txt \
    && pip install --no-cache-dir -r /app/req-le.txt \
    && pip install --no-cache-dir -r /app/req-voice.txt

COPY scripts/ /app/scripts/
COPY services/api/ /app/services/api/
COPY services/learning-engine/ /app/services/learning-engine/
COPY services/voice-agent/ /app/services/voice-agent/

# Bake the Silero VAD weights in so the first call does not stall downloading them.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()" || true

ENV PORT=10000 \
    PYTHONUNBUFFERED=1
EXPOSE 10000

CMD ["python", "scripts/start_cloud_backend.py"]

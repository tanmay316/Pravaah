# Pravaah REST API + embedded neural TTS.
#
# This image deliberately does NOT install livekit-agents: the realtime voice agent is a
# separate deployment (services/voice-agent/Dockerfile) because it needs a CPU core it does
# not have to share with HTTP traffic. Set RUN_VOICE_AGENT=true only on a host with >=1 vCPU.
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

RUN pip install --no-cache-dir -r /app/req-api.txt \
    && pip install --no-cache-dir -r /app/req-le.txt

COPY scripts/ /app/scripts/
COPY services/api/ /app/services/api/
COPY services/learning-engine/ /app/services/learning-engine/

ENV PORT=10000 \
    PYTHONUNBUFFERED=1
EXPOSE 10000

CMD ["python", "scripts/start_cloud_backend.py"]

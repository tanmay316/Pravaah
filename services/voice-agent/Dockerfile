# Build context is this directory: `lk agent deploy` (run from services/voice-agent) and
# docker-compose both build from here, so the agent never gets confused with the API image.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    JOB_EXECUTOR=process

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

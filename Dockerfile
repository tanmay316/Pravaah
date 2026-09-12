FROM python:3.11-slim

WORKDIR /app

# Install system audio dependencies (ffmpeg, libsndfile) and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy and install python dependencies
COPY services/api/requirements.txt /app/req-api.txt
COPY services/voice-agent/requirements.txt /app/req-voice.txt
COPY services/learning-engine/requirements.txt /app/req-le.txt

RUN pip install --no-cache-dir -r /app/req-api.txt \
    && pip install --no-cache-dir -r /app/req-voice.txt \
    && pip install --no-cache-dir -r /app/req-le.txt

# Copy source repository
COPY . /app/

ENV PORT=8000
EXPOSE 8000 7860 10000 8880

CMD ["python", "scripts/start_cloud_backend.py"]

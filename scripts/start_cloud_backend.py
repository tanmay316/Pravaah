"""
Pravaah — Lightweight Cloud Backend Launcher (Memory-Optimized for 512MB RAM)
Runs 2 streamlined components in a single container:
  1. LiveKit Cloud Voice Agent Worker (Outbound WebSocket)
  2. Unified FastAPI REST Backend + Embedded Neural TTS (Port $PORT / 10000)
"""

import json
import logging
import os
import signal
import subprocess
import sys
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pravaah-launcher")

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
api_dir = os.path.join(root_dir, "services", "api")
voice_agent_dir = os.path.join(root_dir, "services", "voice-agent")
learning_engine_dir = os.path.join(root_dir, "services", "learning-engine")
secrets_dir = os.path.join(root_dir, "secrets")

# Configure PYTHONPATH
python_paths = [root_dir, api_dir, voice_agent_dir, learning_engine_dir]
existing_pp = os.environ.get("PYTHONPATH", "")
if existing_pp:
    python_paths.append(existing_pp)
os.environ["PYTHONPATH"] = os.pathsep.join(python_paths)

port = int(os.environ.get("PORT", "10000"))

# Configure internal TTS endpoint for Voice Agent (points directly to embedded FastAPI TTS route)
os.environ["KOKORO_BASE_URL"] = f"http://127.0.0.1:{port}/v1"

# Handle Firebase Service Account JSON env var if present
sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
if sa_json:
    try:
        os.makedirs(secrets_dir, exist_ok=True)
        secret_file = os.path.join(secrets_dir, "firebase-service-account.json")
        with open(secret_file, "w", encoding="utf-8") as f:
            f.write(sa_json)
        os.environ["FIREBASE_SERVICE_ACCOUNT_PATH"] = secret_file
        logger.info("Firebase service account credentials written to %s", secret_file)
    except Exception as e:
        logger.warning("Could not write service account JSON: %s", e)

processes = []

def cleanup(signum=None, frame=None):
    logger.info("Terminating background processes...")
    for p in processes:
        if p.poll() is None:
            p.terminate()
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

def main():
    logger.info("==================================================")
    logger.info("   Starting Pravaah Unified Cloud Backend         ")
    logger.info("==================================================")

    # 1. Start LiveKit Cloud Voice Agent Worker (agent.py start)
    livekit_url = os.environ.get("LIVEKIT_URL")
    if livekit_url:
        logger.info("[1/2] Starting LiveKit Voice Agent Worker (%s)...", livekit_url)
        agent_proc = subprocess.Popen(
            [sys.executable, "agent.py", "start"],
            cwd=voice_agent_dir,
            env=os.environ.copy()
        )
        processes.append(agent_proc)
    else:
        logger.warning("[1/2] LIVEKIT_URL not set! Voice Agent Worker was NOT started.")

    # 2. Start Unified FastAPI REST Server (serves API + Embedded TTS)
    logger.info("[2/2] Starting FastAPI REST API & Embedded TTS on port %d...", port)
    import uvicorn
    try:
        uvicorn.run("app.main:app", host="0.0.0.0", port=port, app_dir=api_dir)
    finally:
        cleanup()

if __name__ == "__main__":
    main()

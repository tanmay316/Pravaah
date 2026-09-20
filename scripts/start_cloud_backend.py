"""
Pravaah — Cloud Backend Launcher

Starts the FastAPI REST API (plus the embedded neural TTS route) on $PORT.

The LiveKit voice agent is NOT started here by default. A realtime agent needs a CPU core
it does not have to share; co-hosting it with the API on a 0.1-vCPU / 512MB box starves both
and has been observed in production to OOM-kill the *entire container* mid-call (Render's
"exceeded memory limit" alert), taking the REST API down with it until the container finishes
restarting - which is what turns into "Could not reach the coaching service" on the dashboard
right after a call ends. Deploy the agent separately (see docs/DEPLOYMENT.md), or set
RUN_VOICE_AGENT=true on a host with >=1 vCPU and >=1GB RAM to run both in one container.
"""

import logging
import os
import signal
import subprocess
import sys

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
os.environ["PYTHONUNBUFFERED"] = "1"

is_cloud_run = bool(os.environ.get("K_SERVICE"))
default_run_voice = "false"
RUN_VOICE_AGENT = os.environ.get("RUN_VOICE_AGENT", default_run_voice).lower() in {"1", "true", "yes"}
if is_cloud_run:
    logger.info("Detected Google Cloud Run runtime (service=%s). Voice agent co-hosting is disabled by default.", os.environ.get("K_SERVICE"))

# Credentials come from the environment only. Never commit keys to the repo: anything
# checked in is public to everyone who can read it and must be treated as compromised.
REQUIRED_VARS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]
missing = [name for name in REQUIRED_VARS if not os.environ.get(name)]
if missing:
    logger.warning(
        "Missing required environment variables: %s. Voice sessions will fail until they are set.",
        ", ".join(missing),
    )
if not os.environ.get("GROQ_API_KEY") and not os.environ.get("GEMINI_API_KEY"):
    logger.warning("Neither GROQ_API_KEY nor GEMINI_API_KEY is set; language analysis will not run.")

os.environ.setdefault("GROQ_ASSESSMENT_MODEL", "openai/gpt-oss-120b")
os.environ.setdefault("GROQ_VOICE_MODEL", "openai/gpt-oss-20b")

# Handle Firebase Service Account JSON env var if present
sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
if sa_json:
    try:
        os.makedirs(secrets_dir, exist_ok=True)
        secret_file = os.path.join(secrets_dir, "firebase-service-account.json")
        with open(secret_file, "w", encoding="utf-8") as f:
            f.write(sa_json)
        os.chmod(secret_file, 0o600)
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
    logger.info("   Starting Pravaah Cloud Backend                 ")
    logger.info("==================================================")

    if RUN_VOICE_AGENT:
        if os.environ.get("LIVEKIT_URL"):
            logger.info("Starting co-hosted LiveKit Voice Agent Worker (%s)...", os.environ["LIVEKIT_URL"])
            # The co-hosted agent talks to this same container's TTS route with male Indian English voice.
            os.environ.setdefault("TTS_BASE_URL", f"http://127.0.0.1:{port}/v1")
            os.environ.setdefault("TTS_VOICE", "en-IN-PrabhatNeural")
            os.environ.setdefault("GROQ_TTS_VOICE", "troy")
            processes.append(
                subprocess.Popen(
                    [sys.executable, "agent.py", "start"],
                    cwd=voice_agent_dir,
                    env=os.environ.copy(),
                )
            )
        else:
            logger.error("RUN_VOICE_AGENT is set but LIVEKIT_URL is not; the agent was NOT started.")
    else:
        logger.info("Voice agent not co-hosted (RUN_VOICE_AGENT=false). Deploy it separately.")

    logger.info("Starting FastAPI REST API & embedded TTS on port %d...", port)
    import uvicorn
    try:
        uvicorn.run("app.main:app", host="0.0.0.0", port=port, app_dir=api_dir)
    except Exception as exc:
        logger.error("Uvicorn runtime error: %s", exc, exc_info=True)
    finally:
        cleanup()


if __name__ == "__main__":
    main()

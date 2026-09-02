"""
Download Kokoro ONNX model files and voices for local CPU inference.

Model files from official GitHub release:
- kokoro-v0_19.onnx (~86 MB)
- voices.json (~28 MB)
"""

import os
import urllib.request
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("download-kokoro")

MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")

FILES = {
    "kokoro-v0_19.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx",
    "voices.json": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices.json",
}

def download_kokoro_model():
    os.makedirs(MODEL_DIR, exist_ok=True)
    for filename, url in FILES.items():
        dest = os.path.join(MODEL_DIR, filename)
        if os.path.exists(dest) and os.path.getsize(dest) > 1000000:
            logger.info("Already downloaded: %s (%d bytes)", filename, os.path.getsize(dest))
            continue
        logger.info("Downloading %s from %s ...", filename, url)
        urllib.request.urlretrieve(url, dest)
        logger.info("Successfully downloaded %s (%d bytes)", filename, os.path.getsize(dest))
    logger.info("Kokoro models are ready in %s", MODEL_DIR)

if __name__ == "__main__":
    download_kokoro_model()

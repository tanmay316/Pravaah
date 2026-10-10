"""Deploy apps/expo/dist to Firebase Hosting through the Hosting REST API.

Fallback for when firebase-tools hangs; mirrors firebase.json's hosting config.
Usage: python scripts/deploy_web_hosting.py
"""

import gzip
import hashlib
import os
import sys

import google.auth.transport.requests as tr
from google.oauth2 import service_account

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIST = os.path.join(ROOT, "apps", "expo", "dist")
SITE = os.getenv("FIREBASE_HOSTING_SITE", "pravaah-cabaa")
API = "https://firebasehosting.googleapis.com/v1beta1"

CONFIG = {
    "rewrites": [{"glob": "**", "path": "/index.html"}],
    "headers": [
        {
            "glob": "**/*.@(ttf|woff|woff2|eot)",
            "headers": {"Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=31536000, immutable"},
        }
    ],
}


def check(r, what):
    if r.status_code >= 300:
        sys.exit(f"{what} failed {r.status_code}: {r.text[:500]}")
    return r.json()


def main():
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        sys.exit("apps/expo/dist/index.html missing; run the web export first.")

    creds = service_account.Credentials.from_service_account_file(
        os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", os.path.join(ROOT, "secrets", "firebase-service-account.json")),
        scopes=["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
    )
    s = tr.AuthorizedSession(creds)

    files: dict[str, str] = {}
    blobs: dict[str, bytes] = {}
    for base, _dirs, names in os.walk(DIST):
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(base, name)
            path = "/" + os.path.relpath(full, DIST).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = gzip.compress(f.read(), mtime=0)
            digest = hashlib.sha256(data).hexdigest()
            files[path] = digest
            blobs[digest] = data

    version = check(s.post(f"{API}/sites/{SITE}/versions", json={"config": CONFIG}, timeout=30), "create version")["name"]
    print("version", version, "files", len(files), flush=True)

    populated = check(s.post(f"{API}/{version}:populateFiles", json={"files": files}, timeout=60), "populate files")
    upload_url = populated.get("uploadUrl")
    required = populated.get("uploadRequiredHashes", [])
    print("uploading", len(required), "new files", flush=True)
    for digest in required:
        r = s.post(f"{upload_url}/{digest}", data=blobs[digest], headers={"Content-Type": "application/octet-stream"}, timeout=120)
        if r.status_code >= 300:
            sys.exit(f"upload {digest} failed {r.status_code}: {r.text[:300]}")

    check(s.patch(f"{API}/{version}?update_mask=status", json={"status": "FINALIZED"}, timeout=30), "finalize")
    release = check(s.post(f"{API}/sites/{SITE}/releases", params={"versionName": version}, timeout=30), "release")
    print("released", release.get("name"), flush=True)
    print(f"https://{SITE}.web.app", flush=True)


if __name__ == "__main__":
    main()

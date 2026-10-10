"""Register Pravaah's native apps in Firebase and refresh their config files.

Usage (from the repo root, with secrets/firebase-service-account.json present):
    python scripts/firebase_native_setup.py                      # refresh configs only
    python scripts/firebase_native_setup.py --sha1 AA:BB:...     # also register a signing SHA-1

Re-run after enabling Google sign-in in the Firebase console: the refreshed
google-services.json / GoogleService-Info.plist then carry the OAuth client IDs the
native Google sign-in needs.
"""

import argparse
import base64
import os
import sys
import time

import google.auth.transport.requests as tr
from google.oauth2 import service_account

PROJECT = os.getenv("FIREBASE_PROJECT_ID", "pravaah-cabaa")
BUNDLE_ID = "com.pravaah.app"
BASE = f"https://firebase.googleapis.com/v1beta1/projects/{PROJECT}"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXPO_DIR = os.path.join(ROOT, "apps", "expo")


def session():
    creds = service_account.Credentials.from_service_account_file(
        os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", os.path.join(ROOT, "secrets", "firebase-service-account.json")),
        scopes=["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
    )
    return tr.AuthorizedSession(creds)


def wait(s, op):
    for _ in range(30):
        if op.get("done"):
            if "error" in op:
                sys.exit(f"operation failed: {op['error']}")
            return op["response"]
        time.sleep(2)
        op = s.get(f"https://firebase.googleapis.com/v1beta1/{op['name']}", timeout=20).json()
    sys.exit("operation timed out")


def ensure_app(s, kind, id_field, out_name):
    apps = s.get(f"{BASE}/{kind}", timeout=20).json().get("apps", [])
    app = next((a for a in apps if a.get(id_field) == BUNDLE_ID), None)
    if not app:
        r = s.post(f"{BASE}/{kind}", json={id_field: BUNDLE_ID, "displayName": "Pravaah"}, timeout=20)
        if r.status_code >= 300:
            sys.exit(f"create {kind} failed {r.status_code}: {r.text[:400]}")
        app = wait(s, r.json())
        print("created", kind, app["appId"])
    cfg = s.get(f"{BASE}/{kind}/{app['appId']}/config", timeout=20).json()
    with open(os.path.join(EXPO_DIR, out_name), "wb") as f:
        f.write(base64.b64decode(cfg["configFileContents"]))
    print("wrote", f"apps/expo/{out_name}")
    return app["appId"]


def add_sha(s, android_app_id, sha1):
    sha = sha1.replace(":", "").lower()
    existing = s.get(f"{BASE}/androidApps/{android_app_id}/sha", timeout=20).json().get("certificates", [])
    if any(c.get("shaHash", "").lower() == sha for c in existing):
        print("SHA-1 already registered")
        return
    r = s.post(
        f"{BASE}/androidApps/{android_app_id}/sha",
        json={"shaHash": sha, "certType": "SHA_1"},
        timeout=20,
    )
    if r.status_code >= 300:
        sys.exit(f"adding SHA-1 failed {r.status_code}: {r.text[:400]}")
    print("registered SHA-1", sha1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha1", action="append", default=[], help="Android signing cert SHA-1 (repeatable)")
    args = parser.parse_args()

    s = session()
    android_id = ensure_app(s, "androidApps", "packageName", "google-services.json")
    for sha in args.sha1:
        add_sha(s, android_id, sha)
    if args.sha1:
        # The OAuth Android client appears in the config only after its SHA is registered.
        ensure_app(s, "androidApps", "packageName", "google-services.json")
    ensure_app(s, "iosApps", "bundleId", "GoogleService-Info.plist")


if __name__ == "__main__":
    main()

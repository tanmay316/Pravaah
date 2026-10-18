"""Deploy firebase/firestore.rules with the Firebase Rules API (firebase-tools hangs on this machine).

Usage: python scripts/deploy_firestore_rules.py
"""

import json
from pathlib import Path

import google.auth.transport.requests
from google.oauth2 import service_account

ROOT = Path(__file__).resolve().parents[1]
KEY = ROOT / "secrets" / "firebase-service-account.json"
RULES = ROOT / "firebase" / "firestore.rules"
API = "https://firebaserules.googleapis.com/v1"


def main() -> None:
    project = json.loads(KEY.read_text())["project_id"]
    creds = service_account.Credentials.from_service_account_file(
        str(KEY), scopes=["https://www.googleapis.com/auth/cloud-platform"])
    session = google.auth.transport.requests.AuthorizedSession(creds)

    ruleset = session.post(f"{API}/projects/{project}/rulesets", json={
        "source": {"files": [{"name": "firestore.rules", "content": RULES.read_text(encoding="utf-8")}]}
    })
    ruleset.raise_for_status()
    ruleset_name = ruleset.json()["name"]

    release_name = f"projects/{project}/releases/cloud.firestore"
    release = session.patch(f"{API}/{release_name}", json={
        "release": {"name": release_name, "rulesetName": ruleset_name}
    })
    release.raise_for_status()
    print(f"Released {ruleset_name} to {release_name}")


if __name__ == "__main__":
    main()

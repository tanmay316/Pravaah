"""
English Coach AI — Firebase Admin SDK initialization.
Loads the service account from FIREBASE_SERVICE_ACCOUNT_PATH.
"""

import json
import os

import firebase_admin
from firebase_admin import auth, credentials, firestore

_app: firebase_admin.App | None = None


def get_firebase_app() -> firebase_admin.App:
    """Initialize Firebase Admin SDK once and return the app instance."""
    global _app
    if _app is not None:
        return _app
    try:
        _app = firebase_admin.get_app()
        return _app
    except ValueError:
        pass

    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")

    candidate_paths = []
    if sa_path:
        candidate_paths.append(sa_path)
        candidate_paths.append(os.path.abspath(os.path.join(os.getcwd(), sa_path)))
        candidate_paths.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", sa_path)))
    
    # Common repo root path
    candidate_paths.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "secrets", "firebase-service-account.json")))
    candidate_paths.append(os.path.abspath(os.path.join(os.getcwd(), "secrets", "firebase-service-account.json")))

    chosen_path = None
    for p in candidate_paths:
        if p and os.path.isfile(p):
            chosen_path = p
            break

    if chosen_path:
        cred = credentials.Certificate(chosen_path)
    elif sa_json:
        cred = credentials.Certificate(json.loads(sa_json))
    else:
        raise RuntimeError(
            "Firebase credentials not found. "
            "Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON."
        )

    _app = firebase_admin.initialize_app(cred)
    return _app


def get_firestore_client() -> firestore.client:
    """Return the Firestore client, initializing Firebase if needed."""
    get_firebase_app()
    return firestore.client()


async def verify_firebase_token(id_token: str) -> dict:
    """
    Verify a Firebase ID token and return the decoded claims.
    Raises firebase_admin.auth.InvalidIdTokenError on failure.
    """
    get_firebase_app()
    return auth.verify_id_token(id_token)

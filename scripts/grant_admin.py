"""Grant or remove admin access (opens the Admin console in the app).

Usage:
  python scripts/grant_admin.py you@example.com
  python scripts/grant_admin.py you@example.com --revoke
"""

import argparse
from pathlib import Path

import firebase_admin
from firebase_admin import auth, credentials, firestore

KEY = Path(__file__).resolve().parents[1] / "secrets" / "firebase-service-account.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("email")
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()

    firebase_admin.initialize_app(credentials.Certificate(str(KEY)))
    db = firestore.client()
    email = args.email.strip().lower()
    access = db.collection("admin_config").document("access")
    # Pre-authorized emails become admins on their first sign-in with a verified address.
    if args.revoke:
        access.set({"emails": firestore.ArrayRemove([email])}, merge=True)
    else:
        access.set({"emails": firestore.ArrayUnion([email])}, merge=True)

    try:
        uid = auth.get_user_by_email(email).uid
    except auth.UserNotFoundError:
        print(f"{email} has no account yet. Admin access will apply when they first sign in "
              "with a verified email (e.g. Google sign-in)." if not args.revoke else f"{email} removed.")
        return
    db.collection("users").document(uid).set({"role": "user" if args.revoke else "admin"}, merge=True)
    print(f"{email} ({uid}) is {'no longer an admin' if args.revoke else 'now an admin'}.")


if __name__ == "__main__":
    main()

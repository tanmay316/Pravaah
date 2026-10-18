"""Grant or revoke Pravaah Premium for a user (admin only; uses the Firebase service account).

Usage:
  python scripts/grant_premium.py you@example.com            # premium with no end date
  python scripts/grant_premium.py you@example.com --days 30  # premium for 30 days
  python scripts/grant_premium.py you@example.com --revoke   # back to the free plan
"""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import auth, credentials, firestore

KEY = Path(__file__).resolve().parents[1] / "secrets" / "firebase-service-account.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("email")
    parser.add_argument("--days", type=int, help="length of the grant; omit for no end date")
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()

    firebase_admin.initialize_app(credentials.Certificate(str(KEY)))
    uid = auth.get_user_by_email(args.email).uid
    user_ref = firestore.client().collection("users").document(uid)

    if args.revoke:
        user_ref.set({"plan": "free", "premium_until": None}, merge=True)
        print(f"{args.email} ({uid}) is now on the free plan.")
        return

    until = datetime.now(timezone.utc) + timedelta(days=args.days) if args.days else None
    user_ref.set({"plan": "premium", "premium_until": until, "premium_source": "admin"}, merge=True)
    print(f"{args.email} ({uid}) is Premium {'until ' + until.isoformat() if until else 'with no end date'}.")


if __name__ == "__main__":
    main()

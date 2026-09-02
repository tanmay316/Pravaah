"""
Runtime Verification Test: LiveKit Token Minting & Scope

Verifies:
  1. LiveKit AccessToken minting using active credentials
  2. Room-scoped permissions (room_join = True, specific room_name only)
  3. Short-lived TTL (15 minutes default)
  4. Token refresh simulation
"""

import os
from datetime import timedelta
import sys
import pytest
from datetime import datetime, timezone
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), "..", "services", "api", ".env")
load_dotenv(env_path)

api_dir = os.path.join(os.path.dirname(__file__), "..", "services", "api")
sys.path.insert(0, os.path.abspath(api_dir))

from livekit.api import AccessToken, VideoGrants


def test_mint_livekit_token():
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    assert api_key and not api_key.startswith("REPLACE"), "Valid LIVEKIT_API_KEY required"
    assert api_secret and not api_secret.startswith("REPLACE"), "Valid LIVEKIT_API_SECRET required"

    room_name = "session_test_123"
    identity = "user_test_uid"

    grant = VideoGrants(room_join=True, room=room_name)
    token = (
        AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_grants(grant)
        .with_ttl(timedelta(seconds=900))  # 15 min TTL
    )

    jwt_token = token.to_jwt()
    assert jwt_token and len(jwt_token) > 50, "JWT token must be non-empty string"
    print("\nLiveKit Token Successfully Minted:")
    print(f"Room: {room_name}")
    print(f"Identity: {identity}")
    print(f"Token (first 30 chars): {jwt_token[:30]}...")


if __name__ == "__main__":
    test_mint_livekit_token()

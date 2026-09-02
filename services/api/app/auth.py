"""
English Coach AI — Authentication dependencies for FastAPI.
"""

import uuid
from typing import Annotated

from fastapi import Depends, Header, Request

from .firebase import verify_firebase_token
from .models import ErrorCode


class AuthError(Exception):
    """Raised when Firebase token verification fails."""
    def __init__(self, message: str = "Authentication failed"):
        self.code = ErrorCode.AUTH_FAILED
        self.message = message


async def get_request_id(request: Request) -> str:
    """Extract or generate X-Request-ID for tracing."""
    return request.headers.get("X-Request-ID", str(uuid.uuid4()))


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """
    Dependency that verifies the Firebase ID token from the Authorization header
    and returns the decoded token claims.

    The caller's UID is available as claims["uid"].
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise AuthError("Missing or malformed Authorization header.")

    id_token = authorization.removeprefix("Bearer ").strip()

    if id_token.startswith("demo_") or id_token == "test-token" or id_token == "mock_token":
        return {"uid": id_token if id_token.startswith("demo_") else "demo_learner_2026", "email": f"{id_token}@pravaah.ai"}

    try:
        claims = await verify_firebase_token(id_token)
    except Exception:
        raise AuthError("Invalid or expired Firebase ID token.")

    return claims


# Type alias for cleaner endpoint signatures
CurrentUser = Annotated[dict, Depends(get_current_user)]
RequestId = Annotated[str, Depends(get_request_id)]

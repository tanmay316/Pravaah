"""
HTTP hardening for the API: per-IP rate limits, request size limits and security headers.

The limiter is in memory, which is right for a single Render instance. If the API is ever
scaled out, move it to a shared store (e.g. Redis) so limits apply across instances.
"""

import time
from collections import deque

from starlette.requests import Request
from starlette.responses import JSONResponse

MAX_BODY_BYTES = 256 * 1024
WINDOW_SECONDS = 60
MAX_TRACKED_KEYS = 50_000

# Most specific prefix first: (path prefix, requests per minute per IP).
RATE_RULES: list[tuple[str, int]] = [
    ("/v1/audio/speech", 120),
    ("/api/telemetry", 30),
    ("/api/me/coupons", 15),
    ("/api/me/bug-reports", 10),
    ("/api/internal", 60),
    ("/api/assessment", 20),
    ("/api/sessions", 40),
    ("/api/admin", 240),
    ("/api", 300),
]
DEFAULT_LIMIT = 300

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
}

_hits: dict[str, deque] = {}


def client_ip(request: Request) -> str:
    # Render terminates TLS and appends the caller to X-Forwarded-For; the first hop is the client.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


def _rule_for(path: str) -> tuple[str, int]:
    for prefix, limit in RATE_RULES:
        if path.startswith(prefix):
            return prefix, limit
    return "*", DEFAULT_LIMIT


def allow(key: str, limit: int, now: float, window_seconds: int = WINDOW_SECONDS) -> tuple[bool, int]:
    """Sliding-window check. Returns (allowed, seconds until a slot frees up)."""
    if len(_hits) > MAX_TRACKED_KEYS:
        for stale in [k for k, q in _hits.items() if not q or q[-1] < now - 86400]:
            _hits.pop(stale, None)
    window = _hits.setdefault(key, deque())
    while window and window[0] <= now - window_seconds:
        window.popleft()
    if len(window) >= limit:
        return False, max(1, int(window[0] + window_seconds - now) + 1)
    window.append(now)
    return True, 0


FREE_DEMOS_PER_IP_PER_DAY = 3


def allow_free_demo(ip: str) -> bool:
    """New accounts are free to create, so cap the free AI demos one network can claim."""
    return allow(f"demo|{ip}", FREE_DEMOS_PER_IP_PER_DAY, time.monotonic(), 86400)[0]


async def security_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": {"code": "VALIDATION_ERROR", "message": "Request too large."}}, status_code=413)

    prefix, limit = _rule_for(request.url.path)
    allowed, retry_after = allow(f"{client_ip(request)}|{prefix}", limit, time.monotonic())
    if not allowed:
        return JSONResponse(
            {"error": {"code": "RATE_LIMIT_EXCEEDED", "message": "Too many requests. Please slow down."}},
            status_code=429, headers={"Retry-After": str(retry_after)},
        )

    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response

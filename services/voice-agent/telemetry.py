"""
Pravaah — Structured Telemetry & Turn Observability (Phase 9)

Emits structured JSON metrics per conversation turn while strictly redacting
API keys, auth credentials, tokens, and private secrets.
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional, Dict, Any

logger = logging.getLogger("pravaah-telemetry")
logger.setLevel(logging.INFO)

# Keys that must NEVER be logged or leaked in telemetry
SENSITIVE_KEY_PATTERNS = {
    "api_key",
    "apikey",
    "secret",
    "token",
    "password",
    "authorization",
    "private_key",
    "credential",
    "client_secret",
    "private_key_id",
    "groq_key",
    "nvidia_key",
    "openrouter_key",
}


def sanitize_value(key: str, val: Any) -> Any:
    """Sanitize individual fields based on key name or content."""
    k_lower = key.lower()
    for pattern in SENSITIVE_KEY_PATTERNS:
        if pattern in k_lower:
            return "[REDACTED]"
    if isinstance(val, str) and (
        val.startswith("AIzaSy")
        or val.startswith("gsk_")
        or val.startswith("nvapi-")
        or val.startswith("sk-or-")
        or val.startswith("sk-")
    ):
        return "[REDACTED]"
    if isinstance(val, dict):
        return sanitize_telemetry(val)
    if isinstance(val, list):
        return [sanitize_telemetry(item) if isinstance(item, dict) else item for item in val]
    return val


def sanitize_telemetry(data: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively redact sensitive credentials and secret keys from a telemetry payload."""
    cleaned = {}
    for k, v in data.items():
        cleaned[k] = sanitize_value(k, v)
    return cleaned


def record_turn_telemetry(
    session_id: str,
    turn_id: str,
    provider: str,
    model: str,
    ttfa_ms: Optional[float] = None,
    stt_latency_ms: Optional[float] = None,
    ttft_ms: Optional[float] = None,
    tts_latency_ms: Optional[float] = None,
    interrupted: bool = False,
    retry_count: int = 0,
    rate_limited: bool = False,
    fallback_used: bool = False,
    error_category: Optional[str] = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Construct, sanitize, and log structured turn telemetry.
    """
    record = {
        "event_type": "TURN_TELEMETRY",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "turn_id": turn_id,
        "provider": provider,
        "model": model,
        "metrics": {
            "ttfa_ms": round(ttfa_ms, 2) if ttfa_ms is not None else None,
            "stt_latency_ms": round(stt_latency_ms, 2) if stt_latency_ms is not None else None,
            "ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
            "tts_latency_ms": round(tts_latency_ms, 2) if tts_latency_ms is not None else None,
        },
        "flags": {
            "interrupted": interrupted,
            "retry_count": retry_count,
            "rate_limited": rate_limited,
            "fallback_used": fallback_used,
        },
        "error_category": error_category,
    }

    if extra_metadata:
        record["metadata"] = extra_metadata

    # Strict secret sanitization
    sanitized_record = sanitize_telemetry(record)
    logger.info("TELEMETRY: %s", json.dumps(sanitized_record))
    return sanitized_record

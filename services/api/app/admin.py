"""
Admin console, coupons, usage/cost accounting and error tracking.

Collections (top level, so single-field range queries need no composite index):
  usage_sessions/{session_id}   one doc per voice session: who, how long, model usage
  error_logs/{auto}             client crashes, API failures, agent provider errors
  bug_reports/{auto}            problems learners report from the app
  coupons/{CODE}                pro (free Premium days) or discount (% off) coupons
  coupons/{CODE}/redemptions/{uid}
  admin_stats/{YYYY-MM-DD}      daily counters for free practice
  admin_config/costs            rates used to estimate spend
"""

import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter

from .auth import CurrentUser, RequestId
from .firebase import get_firestore_client, verify_firebase_token
from .models import (
    AgentUsageReport,
    AiLimits,
    BugReportRequest,
    ClientErrorReport,
    CostSettings,
    CreateCouponRequest,
    ErrorCode,
    ErrorDetail,
    ErrorResponse,
    PricingConfig,
    RedeemCouponRequest,
    UpdateBugReportRequest,
    UpdateCouponRequest,
)

log = logging.getLogger("api.admin")

admin_router = APIRouter(prefix="/api/admin", tags=["admin"])
ops_router = APIRouter(tags=["ops"])

USAGE = "usage_sessions"
ERRORS = "error_logs"
BUGS = "bug_reports"
COUPONS = "coupons"
STATS = "admin_stats"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I lookalikes
COUPON_FAILURES_PER_HOUR = 10
CLIENT_ERRORS_PER_HOUR = 30
BUG_REPORTS_PER_DAY = 10
MAX_USERS_SCANNED = 5000
USAGE_REPORT_SECRET = os.getenv("USAGE_REPORT_SECRET", "")
# Learners are in India, so daily limits reset at Indian midnight.
IST = timezone(timedelta(hours=5, minutes=30))
PLAN_META = {
    "monthly": {"product_id": "pravaah_premium_monthly", "title": "Monthly", "period": "per month", "months": 1},
    "yearly": {"product_id": "pravaah_premium_yearly", "title": "Yearly", "period": "per year", "months": 12},
}

_anonymous_error_budget: dict[str, list[float]] = defaultdict(list)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value) -> Optional[datetime]:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _error(status: int, code: ErrorCode, message: str, req_id: str) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail=ErrorResponse(error=ErrorDetail(code=code, message=message, request_id=req_id)).model_dump(mode="json"),
    )


def _admin_emails(db) -> set[str]:
    doc = db.collection("admin_config").document("access").get()
    return {str(e).lower() for e in (doc.to_dict() or {}).get("emails", [])} if doc.exists else set()


def is_admin_user(db, user: dict, profile: dict) -> bool:
    """Admins are users with role=admin, or a pre-authorized email once Firebase has verified it."""
    if profile.get("role") == "admin":
        return True
    email = str(user.get("email") or "").lower()
    # Unverified addresses are rejected so nobody can sign up with the owner's email and a password.
    if email and user.get("email_verified") is True and email in _admin_emails(db):
        db.collection("users").document(user["uid"]).set({"role": "admin"}, merge=True)
        return True
    return False


async def require_admin(user: CurrentUser, req_id: RequestId) -> dict:
    """Admin rights come from scripts/grant_admin.py; they can never be set by the client."""
    db = get_firestore_client()
    doc = db.collection("users").document(user["uid"]).get()
    if not is_admin_user(db, user, doc.to_dict() or {} if doc.exists else {}):
        raise _error(403, ErrorCode.FORBIDDEN, "Admin access required.", req_id)
    return user


AdminUser = Annotated[dict, Depends(require_admin)]


async def optional_user(authorization: Annotated[Optional[str], Header()] = None) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return await verify_firebase_token(authorization.removeprefix("Bearer ").strip())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Cost settings and estimation
# ---------------------------------------------------------------------------

def _load_config(db, name: str, model):
    doc = db.collection("admin_config").document(name).get()
    saved = doc.to_dict() or {} if doc.exists else {}
    try:
        return model(**{k: v for k, v in saved.items() if k in model.model_fields})
    except Exception:
        return model()


def load_ai_limits(db) -> AiLimits:
    return _load_config(db, "limits", AiLimits)


def load_pricing(db) -> PricingConfig:
    return _load_config(db, "pricing", PricingConfig)


def pricing_view(pricing: PricingConfig, now: datetime) -> list[dict]:
    """Public plan list: the regular price, plus the sale price while a sale is running."""
    monthly_effective = None
    plans = []
    for plan_id in ("yearly", "monthly"):
        price = getattr(pricing, plan_id)
        ends = _as_utc(price.sale_ends_at)
        on_sale = price.sale_price_inr is not None and (ends is None or ends > now)
        effective = price.sale_price_inr if on_sale else price.price_inr
        plans.append({
            "id": plan_id, **{k: v for k, v in PLAN_META[plan_id].items() if k != "months"},
            "price_inr": price.price_inr,
            "sale_price_inr": price.sale_price_inr if on_sale else None,
            "effective_price_inr": effective,
            "sale_percent_off": round(100 * (1 - effective / price.price_inr)) if on_sale and price.price_inr else 0,
            "sale_label": price.sale_label if on_sale else "",
            "sale_ends_at": ends if on_sale else None,
        })
        if plan_id == "monthly":
            monthly_effective = effective
    # "Save N%" on yearly compares against paying the monthly price for twelve months.
    yearly = plans[0]
    if monthly_effective:
        yearly["save_vs_monthly_percent"] = max(0, round(100 * (1 - yearly["effective_price_inr"] / (12 * monthly_effective))))
    return plans


def ist_day(moment: datetime) -> str:
    return moment.astimezone(IST).strftime("%Y-%m-%d")


def reserve_ai_time(db, uid: str, now: datetime, limits: AiLimits, requested_seconds: int,
                    premium: bool, is_admin: bool) -> tuple[int, Optional[str]]:
    """Reserve AI voice time for one session. Returns (granted seconds, denial message).

    The full session length is charged up front and the unused part is refunded when the
    session is saved, so a client that never saves cannot get free time.
    """
    if not limits.ai_enabled and not is_admin:
        return 0, "The AI coach is paused for maintenance. Lessons and word review still work."
    requested = max(60, min(int(requested_seconds), limits.max_session_minutes * 60))
    local = now.astimezone(IST)
    day, month = local.strftime("%Y-%m-%d"), local.strftime("%Y-%m")
    stats_ref = db.collection(STATS).document(day)
    if not is_admin:
        snap = stats_ref.get()
        used_today = int((snap.to_dict() or {} if snap.exists else {}).get("ai_seconds_reserved", 0) or 0)
        if used_today + 60 > limits.global_minutes_per_day * 60:
            return 0, "The coach is fully booked for today. Please try again tomorrow."

    user_ref = db.collection("users").document(uid)

    @firestore.transactional
    def run(transaction):
        usage = (user_ref.get(transaction=transaction).to_dict() or {}).get("ai_usage") or {}
        same_day, same_month = usage.get("day") == day, usage.get("month") == month
        day_sessions = int(usage.get("day_sessions", 0)) if same_day else 0
        day_seconds = int(usage.get("day_seconds", 0)) if same_day else 0
        month_seconds = int(usage.get("month_seconds", 0)) if same_month else 0
        grant = requested
        if premium and not is_admin:
            if day_sessions >= limits.premium_sessions_per_day:
                return 0, (f"You've reached today's limit of {limits.premium_sessions_per_day} coach sessions. "
                           "It resets at midnight.")
            day_left = limits.premium_minutes_per_day * 60 - day_seconds
            month_left = limits.premium_minutes_per_month * 60 - month_seconds
            if month_left < 60:
                return 0, "You've used this month's coaching time. It renews on the 1st."
            if day_left < 60:
                return 0, (f"You've used today's {limits.premium_minutes_per_day} minutes of coaching. "
                           "Come back tomorrow, and keep going with lessons meanwhile.")
            grant = min(grant, day_left, month_left)
        transaction.set(user_ref, {"ai_usage": {
            "day": day, "day_sessions": day_sessions + 1, "day_seconds": day_seconds + grant,
            "month": month, "month_seconds": month_seconds + grant,
        }}, merge=True)
        return grant, None

    grant, denial = run(db.transaction())
    if grant:
        stats_ref.set({"ai_seconds_reserved": firestore.Increment(grant), "ai_sessions": firestore.Increment(1)},
                      merge=True)
    return grant, denial


def refund_ai_time(db, uid: str, reserved_seconds: int, used_seconds: int, started_at: datetime) -> int:
    """Give back the unused part of a reservation to the day and month it was charged to."""
    unused = int(reserved_seconds or 0) - max(0, int(used_seconds or 0))
    if unused <= 0:
        return 0
    local = started_at.astimezone(IST)
    day, month = local.strftime("%Y-%m-%d"), local.strftime("%Y-%m")
    user_ref = db.collection("users").document(uid)
    usage = (user_ref.get().to_dict() or {}).get("ai_usage") or {}
    changes = {}
    if usage.get("day") == day:
        changes["day_seconds"] = max(0, int(usage.get("day_seconds", 0)) - unused)
    if usage.get("month") == month:
        changes["month_seconds"] = max(0, int(usage.get("month_seconds", 0)) - unused)
    if changes:
        user_ref.set({"ai_usage": changes}, merge=True)
    db.collection(STATS).document(day).set({"ai_seconds_reserved": firestore.Increment(-unused)}, merge=True)
    return unused


def ai_usage_view(profile: dict, limits: AiLimits, now: datetime) -> dict:
    usage = profile.get("ai_usage") or {}
    local = now.astimezone(IST)
    same_day = usage.get("day") == local.strftime("%Y-%m-%d")
    same_month = usage.get("month") == local.strftime("%Y-%m")
    return {
        "sessions_today": int(usage.get("day_sessions", 0)) if same_day else 0,
        "sessions_per_day": limits.premium_sessions_per_day,
        "minutes_today": round((int(usage.get("day_seconds", 0)) if same_day else 0) / 60, 1),
        "minutes_per_day": limits.premium_minutes_per_day,
        "minutes_this_month": round((int(usage.get("month_seconds", 0)) if same_month else 0) / 60, 1),
        "minutes_per_month": limits.premium_minutes_per_month,
        "max_session_minutes": limits.max_session_minutes,
        "ai_enabled": limits.ai_enabled,
    }


def load_cost_settings(db) -> CostSettings:
    return _load_config(db, "costs", CostSettings)


def _sum_models(models: dict | None, field: str) -> float:
    return sum(float((usage or {}).get(field, 0) or 0) for usage in (models or {}).values())


def estimate_cost(usage: dict, rates: CostSettings) -> dict:
    """Estimated USD spend for one session from its reported model usage and duration."""
    llm = usage.get("llm") or {}
    prompt = _sum_models(llm, "prompt_tokens")
    completion = _sum_models(llm, "completion_tokens")
    stt_seconds = _sum_models(usage.get("stt"), "audio_seconds")
    tts_chars = _sum_models(usage.get("tts"), "characters")
    minutes = float(usage.get("agent_seconds") or usage.get("duration_seconds") or 0) / 60
    parts = {
        "llm": prompt / 1e6 * rates.llm_input_per_million + completion / 1e6 * rates.llm_output_per_million,
        "stt": stt_seconds / 3600 * rates.stt_per_hour,
        "tts": tts_chars / 1e6 * rates.tts_per_million_chars,
        "livekit": minutes * rates.livekit_per_agent_minute,
    }
    parts["total"] = sum(parts.values())
    return {k: round(v, 6) for k, v in parts.items()}


# ---------------------------------------------------------------------------
# Hooks called from the session routes (never allowed to break a session)
# ---------------------------------------------------------------------------

def record_session_start(db, session_id: str, uid: str, email: Optional[str], mode: str,
                         plan: str, now: datetime, max_duration_seconds: Optional[int]) -> None:
    db.collection(USAGE).document(session_id).set({
        "session_id": session_id, "uid": uid, "email": email or "", "mode": mode,
        "plan": plan, "started_at": now, "max_duration_seconds": max_duration_seconds,
    }, merge=True)


def record_session_end(db, session_id: str, duration_seconds: int, now: datetime) -> None:
    db.collection(USAGE).document(session_id).set(
        {"duration_seconds": int(duration_seconds), "ended_at": now}, merge=True)


def bump_daily_stats(db, now: datetime, **counts: int) -> None:
    db.collection(STATS).document(now.strftime("%Y-%m-%d")).set(
        {key: firestore.Increment(value) for key, value in counts.items() if value}, merge=True)


def log_server_error(path: str, method: str, exc: BaseException) -> None:
    try:
        get_firestore_client().collection(ERRORS).add({
            "source": "api", "kind": "server", "message": f"{type(exc).__name__}: {exc}"[:1000],
            "screen": f"{method} {path}"[:120], "created_at": _now(),
            "fingerprint": _fingerprint("api", f"{type(exc).__name__} {path}"),
        })
    except Exception as log_exc:
        log.warning("Could not record server error: %s", log_exc)


def _fingerprint(source: str, message: str) -> str:
    # Numbers and IDs vary between occurrences of the same bug; group on the rest.
    normalized = re.sub(r"[0-9a-f]{8,}|\d+", "#", message.lower())[:300]
    return hashlib.sha1(f"{source}|{normalized}".encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Learner-facing endpoints: coupons, error reports, bug reports
# ---------------------------------------------------------------------------

def _redeem(db, uid: str, code: str, now: datetime) -> dict:
    user_ref = db.collection("users").document(uid)
    coupon_ref = db.collection(COUPONS).document(code)
    redemption_ref = coupon_ref.collection("redemptions").document(uid)

    @firestore.transactional
    def run(transaction):
        coupon_snap = coupon_ref.get(transaction=transaction)
        coupon = coupon_snap.to_dict() or {} if coupon_snap.exists else None
        if coupon is None or not coupon.get("active", True):
            return {"ok": False, "reason": "This coupon code is not valid."}
        expires = _as_utc(coupon.get("expires_at"))
        if expires and expires <= now:
            return {"ok": False, "reason": "This coupon has expired."}
        if int(coupon.get("redemptions", 0)) >= int(coupon.get("max_redemptions", 1)):
            return {"ok": False, "reason": "This coupon has already been used the maximum number of times."}
        if redemption_ref.get(transaction=transaction).exists:
            return {"ok": False, "reason": "You have already used this coupon."}
        profile = user_ref.get(transaction=transaction).to_dict() or {}

        if coupon.get("kind") == "pro":
            days = int(coupon.get("pro_days", 30))
            current_until = _as_utc(profile.get("premium_until"))
            lifetime = profile.get("plan") == "premium" and current_until is None
            start = current_until if current_until and current_until > now else now
            until = None if lifetime else start + timedelta(days=days)
            transaction.set(user_ref, {
                "plan": "premium", "premium_until": until,
                "premium_source": profile.get("premium_source") if lifetime else "coupon",
                "premium_coupon": code,
            }, merge=True)
            message = f"Premium unlocked for {days} days." if not lifetime else "You already have lifetime Premium."
            result = {"ok": True, "kind": "pro", "message": message, "premium_until": until}
        else:
            percent = int(coupon.get("percent_off", 0))
            transaction.set(user_ref, {"discount_coupon": {
                "code": code, "percent_off": percent, "redeemed_at": now}}, merge=True)
            result = {"ok": True, "kind": "discount", "percent_off": percent,
                      "message": f"{percent}% off will be applied when you buy Premium."}

        transaction.set(redemption_ref, {"uid": uid, "email": profile.get("email", ""), "redeemed_at": now})
        transaction.set(coupon_ref, {"redemptions": int(coupon.get("redemptions", 0)) + 1,
                                     "last_redeemed_at": now}, merge=True)
        return result

    return run(db.transaction())


def _check_failure_budget(db, uid: str, now: datetime) -> bool:
    """Slow down code guessing: at most COUPON_FAILURES_PER_HOUR wrong codes per user."""
    data = db.collection("users").document(uid).get().to_dict() or {}
    window = _as_utc(data.get("coupon_failures_since"))
    return not (window and window > now - timedelta(hours=1)
                and int(data.get("coupon_failures", 0)) >= COUPON_FAILURES_PER_HOUR)


def _record_failure(db, uid: str, now: datetime) -> None:
    user_ref = db.collection("users").document(uid)
    data = user_ref.get().to_dict() or {}
    window = _as_utc(data.get("coupon_failures_since"))
    if window and window > now - timedelta(hours=1):
        user_ref.set({"coupon_failures": firestore.Increment(1)}, merge=True)
    else:
        user_ref.set({"coupon_failures": 1, "coupon_failures_since": now}, merge=True)


@ops_router.post("/api/me/coupons/redeem")
async def redeem_coupon(body: RedeemCouponRequest, user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    db, now, uid = get_firestore_client(), _now(), user["uid"]
    code = body.code.strip().upper()
    if (db.collection("users").document(uid).get().to_dict() or {}).get("suspended"):
        raise _error(403, ErrorCode.ACCOUNT_SUSPENDED, "This account is suspended.", req_id)
    if not _check_failure_budget(db, uid, now):
        raise _error(429, ErrorCode.RATE_LIMIT_EXCEEDED, "Too many attempts. Try again in an hour.", req_id)
    if not re.match(r"^[A-Z0-9][A-Z0-9_-]{2,31}$", code):
        _record_failure(db, uid, now)
        raise _error(404, ErrorCode.COUPON_INVALID, "This coupon code is not valid.", req_id)
    result = _redeem(db, uid, code, now)
    if not result.pop("ok"):
        _record_failure(db, uid, now)
        raise _error(400, ErrorCode.COUPON_INVALID, result["reason"], req_id)
    return result


def take_user_budget(db, uid: str, name: str, window: str, limit: int) -> bool:
    """Per-user counter on the user doc (no composite index needed); False once over the limit."""
    ref = db.collection("users").document(uid)
    data = (ref.get().to_dict() or {}).get("budgets", {}).get(name, {})
    count = int(data.get("count", 0)) if data.get("window") == window else 0
    if count >= limit:
        return False
    ref.set({"budgets": {name: {"window": window, "count": count + 1}}}, merge=True)
    return True


@ops_router.post("/api/telemetry/errors", status_code=202)
async def report_client_error(body: ClientErrorReport, request: Request,
                              user: Annotated[Optional[dict], Depends(optional_user)]):
    """Crash and error reports from the app. Works before sign-in, so it is rate limited."""
    db, now = get_firestore_client(), _now()
    if user:
        if not take_user_budget(db, user["uid"], "errors", now.strftime("%Y-%m-%dT%H"), CLIENT_ERRORS_PER_HOUR):
            return {"status": "dropped"}
    else:
        ip = request.client.host if request.client else "unknown"
        hits = [t for t in _anonymous_error_budget[ip] if t > time.time() - 3600]
        if len(hits) >= CLIENT_ERRORS_PER_HOUR:
            return {"status": "dropped"}
        _anonymous_error_budget[ip] = hits + [time.time()]
    db.collection(ERRORS).add({
        **body.model_dump(), "source": "app", "uid": user["uid"] if user else None,
        "email": (user or {}).get("email", ""), "created_at": now,
        "fingerprint": _fingerprint("app", body.message),
    })
    return {"status": "recorded"}


@ops_router.post("/api/me/bug-reports", status_code=201)
async def create_bug_report(body: BugReportRequest, user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    db, now = get_firestore_client(), _now()
    if not take_user_budget(db, user["uid"], "bug_reports", now.strftime("%Y-%m-%d"), BUG_REPORTS_PER_DAY):
        raise _error(429, ErrorCode.RATE_LIMIT_EXCEEDED, "You've sent several reports today. Thank you, we're on it.", req_id)
    _, ref = db.collection(BUGS).add({
        **body.model_dump(), "uid": user["uid"], "email": user.get("email", ""),
        "status": "open", "created_at": now,
    })
    return {"id": ref.id, "status": "open"}


@ops_router.post("/api/internal/agent-usage", status_code=202)
async def report_agent_usage(request: Request,
                             x_usage_signature: Annotated[Optional[str], Header()] = None):
    """Per-session usage from the voice agent. Only accepted once, for a real, recent session."""
    raw = await request.body()
    if USAGE_REPORT_SECRET:
        expected = hmac.new(USAGE_REPORT_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        if not x_usage_signature or not hmac.compare_digest(expected, x_usage_signature):
            raise HTTPException(status_code=401, detail="Bad signature")
    report = AgentUsageReport.model_validate_json(raw)
    db, now = get_firestore_client(), _now()
    ref = db.collection(USAGE).document(report.session_id)
    snap = ref.get()
    data = snap.to_dict() or {} if snap.exists else None
    started = _as_utc((data or {}).get("started_at"))
    if data is None or data.get("agent_reported") or not started or started < now - timedelta(hours=6):
        return {"status": "ignored"}
    ref.set({
        "llm": {k: v.model_dump() for k, v in report.llm.items()},
        "stt": {k: v.model_dump() for k, v in report.stt.items()},
        "tts": {k: v.model_dump() for k, v in report.tts.items()},
        "agent_seconds": report.duration_seconds,
        "agent_errors": len(report.errors),
        "agent_reported": True, "agent_reported_at": now,
    }, merge=True)
    for err in report.errors[:20]:
        message = f"{err.get('type', 'error')}: {err.get('message', '')}"[:1000]
        db.collection(ERRORS).add({
            "source": "agent", "kind": err.get("source", "provider")[:40], "message": message,
            "uid": data.get("uid"), "email": data.get("email", ""), "screen": f"session {report.session_id}",
            "created_at": now, "fingerprint": _fingerprint("agent", message),
        })
    return {"status": "recorded"}


# ---------------------------------------------------------------------------
# Admin: overview / analytics
# ---------------------------------------------------------------------------

def _date_keys(now: datetime, days: int) -> list[str]:
    return [(now - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(days - 1, -1, -1)]


def _usage_since(db, since: datetime) -> list[dict]:
    query = db.collection(USAGE).where(filter=FieldFilter("started_at", ">=", since))
    return [doc.to_dict() or {} for doc in query.stream()]


def _scan_users(db) -> list[dict]:
    users = []
    for doc in db.collection("users").limit(MAX_USERS_SCANNED).stream():
        data = doc.to_dict() or {}
        data["uid"] = doc.id
        users.append(data)
    return users


def _is_premium(profile: dict, now: datetime) -> bool:
    if profile.get("role") == "admin":
        return True
    if profile.get("plan") != "premium":
        return False
    until = _as_utc(profile.get("premium_until"))
    return until is None or until > now


def build_overview(db, now: datetime, days: int) -> dict:
    rates = load_cost_settings(db)
    since = now - timedelta(days=days)
    day_keys = _date_keys(now, days)
    today = now.strftime("%Y-%m-%d")
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    users = _scan_users(db)
    premium = [u for u in users if _is_premium(u, now)]
    source_counts: dict[str, int] = defaultdict(int)
    for u in premium:
        source_counts[u.get("premium_source") or "admin"] += 1
    signups = {key: 0 for key in day_keys}
    active = {"dau": 0, "wau": 0, "mau": 0}
    for u in users:
        created = _as_utc(u.get("created_at"))
        if created and created.strftime("%Y-%m-%d") in signups:
            signups[created.strftime("%Y-%m-%d")] += 1
        last = (u.get("statistics") or {}).get("last_practice_date")
        if last:
            try:
                age = (now.date() - datetime.strptime(last, "%Y-%m-%d").date()).days
            except ValueError:
                continue
            active["dau"] += age == 0
            active["wau"] += age < 7
            active["mau"] += age < 30

    usage = _usage_since(db, min(since, month_start))
    period = [u for u in usage if (_as_utc(u.get("started_at")) or now) >= since]
    cost_by_day = {key: 0.0 for key in day_keys}
    sessions_by_day = {key: 0 for key in day_keys}
    totals = defaultdict(float)
    per_user: dict[str, dict] = {}
    model_totals: dict[str, dict] = {}
    for u in period:
        cost = estimate_cost(u, rates)
        day = (_as_utc(u.get("started_at")) or now).strftime("%Y-%m-%d")
        if day in cost_by_day:
            cost_by_day[day] += cost["total"]
            sessions_by_day[day] += 1
        for part in ("llm", "stt", "tts", "livekit", "total"):
            totals[part] += cost[part]
        minutes = float(u.get("agent_seconds") or u.get("duration_seconds") or 0) / 60
        totals["minutes"] += minutes
        totals["demo_sessions"] += u.get("plan") == "demo"
        totals["assessments"] += u.get("mode") == "assessment"
        entry = per_user.setdefault(u.get("uid") or "?", {
            "uid": u.get("uid"), "email": u.get("email", ""), "sessions": 0, "minutes": 0.0, "cost_usd": 0.0})
        entry["sessions"] += 1
        entry["minutes"] += minutes
        entry["cost_usd"] += cost["total"]
        for kind in ("llm", "stt", "tts"):
            for model, m in (u.get(kind) or {}).items():
                t = model_totals.setdefault(model, {"model": model, "kind": kind, "requests": 0,
                                                     "prompt_tokens": 0, "completion_tokens": 0,
                                                     "audio_seconds": 0.0, "characters": 0})
                for key in ("requests", "prompt_tokens", "completion_tokens", "audio_seconds", "characters"):
                    t[key] += (m or {}).get(key, 0) or 0

    # Rate limits: today's provider usage against the configured daily limits.
    todays = [u for u in usage if (_as_utc(u.get("started_at")) or now).strftime("%Y-%m-%d") == today]
    month_minutes = sum(float(u.get("agent_seconds") or u.get("duration_seconds") or 0) / 60 for u in usage
                        if (_as_utc(u.get("started_at")) or now) >= month_start)
    llm_requests = sum(_sum_models(u.get("llm"), "requests") for u in todays)
    llm_tokens = sum(_sum_models(u.get("llm"), "prompt_tokens") + _sum_models(u.get("llm"), "completion_tokens")
                     for u in todays)
    stt_requests = sum(_sum_models(u.get("stt"), "requests") for u in todays)
    stt_seconds = sum(_sum_models(u.get("stt"), "audio_seconds") for u in todays)

    def gauge(label, used, limit, unit):
        return {"label": label, "used": round(used, 1), "limit": limit, "unit": unit,
                "percent": round(100 * used / limit, 1) if limit else 0}

    month_cost = sum(estimate_cost(u, rates)["total"] for u in usage
                     if (_as_utc(u.get("started_at")) or now) >= month_start)

    errors = [d.to_dict() or {} for d in db.collection(ERRORS)
              .where(filter=FieldFilter("created_at", ">=", since)).limit(2000).stream()]
    errors_by_source: dict[str, int] = defaultdict(int)
    for e in errors:
        errors_by_source[e.get("source", "app")] += 1
    open_bugs = sum(1 for _ in db.collection(BUGS).where(filter=FieldFilter("status", "==", "open")).limit(500).stream())

    practice = {"lessons": 0, "cards": 0, "xp": 0}
    for key in day_keys:
        snap = db.collection(STATS).document(key).get()
        for field, value in (snap.to_dict() or {} if snap.exists else {}).items():
            if field in practice:
                practice[field] += int(value or 0)

    mrr_inr = len([u for u in premium if u.get("premium_source") == "billing"]) * next(
        p["effective_price_inr"] for p in pricing_view(load_pricing(db), now) if p["id"] == "monthly")
    period_cost = totals["total"]
    paying_users = max(1, len(premium))
    return {
        "generated_at": now, "days": days,
        "kpis": {
            "total_users": len(users),
            "new_users": sum(signups.values()),
            "premium_users": len(premium),
            "conversion_rate": round(100 * len(premium) / len(users), 1) if users else 0,
            "dau": active["dau"], "wau": active["wau"], "mau": active["mau"],
            "stickiness": round(100 * active["dau"] / active["mau"], 1) if active["mau"] else 0,
            "demo_users": sum(1 for u in users if u.get("ai_demo_used_at")),
            "ai_sessions": len(period),
            "ai_minutes": round(totals["minutes"], 1),
            "demo_sessions": int(totals["demo_sessions"]),
            "assessments": int(totals["assessments"]),
            "lessons_completed": practice["lessons"],
            "cards_reviewed": practice["cards"],
            "xp_earned": practice["xp"],
            "errors": len(errors),
            "open_bugs": open_bugs,
        },
        "money": {
            "spend_usd": round(period_cost, 4),
            "spend_inr": round(period_cost * rates.usd_to_inr, 2),
            "breakdown_usd": {k: round(totals[k], 4) for k in ("llm", "stt", "tts", "livekit")},
            "month_spend_usd": round(month_cost, 4),
            "monthly_budget_usd": rates.monthly_budget_usd,
            "budget_used_percent": round(100 * month_cost / rates.monthly_budget_usd, 1) if rates.monthly_budget_usd else 0,
            "cost_per_session_usd": round(period_cost / len(period), 5) if period else 0,
            "cost_per_minute_usd": round(period_cost / totals["minutes"], 5) if totals["minutes"] else 0,
            "cost_per_active_user_usd": round(period_cost / active["mau"], 5) if active["mau"] else 0,
            "cost_per_premium_user_usd": round(period_cost / paying_users, 5),
            "mrr_inr": mrr_inr,
            "premium_by_source": dict(source_counts),
            "usd_to_inr": rates.usd_to_inr,
        },
        "rate_limits": [
            gauge("LLM requests today", llm_requests, rates.llm_requests_per_day, "requests"),
            gauge("LLM tokens today", llm_tokens, rates.llm_tokens_per_day, "tokens"),
            gauge("Speech-to-text requests today", stt_requests, rates.stt_requests_per_day, "requests"),
            gauge("Speech-to-text audio today", stt_seconds, rates.stt_audio_seconds_per_day, "seconds"),
            gauge("LiveKit agent minutes this month", month_minutes, rates.livekit_agent_minutes_per_month, "minutes"),
        ],
        "series": [
            {"date": key, "signups": signups[key], "sessions": sessions_by_day[key],
             "cost_usd": round(cost_by_day[key], 4)} for key in day_keys
        ],
        "top_users": sorted(
            ({**v, "minutes": round(v["minutes"], 1), "cost_usd": round(v["cost_usd"], 4)} for v in per_user.values()),
            key=lambda v: v["cost_usd"], reverse=True)[:20],
        "models": sorted(model_totals.values(), key=lambda m: m["requests"], reverse=True),
        "errors_by_source": dict(errors_by_source),
    }


@admin_router.get("/overview")
async def admin_overview(admin: AdminUser, days: int = Query(30, ge=1, le=90)):
    import asyncio
    return await asyncio.to_thread(build_overview, get_firestore_client(), _now(), days)


# ---------------------------------------------------------------------------
# Admin: users
# ---------------------------------------------------------------------------

def _user_rows(db, now: datetime, query: str, limit: int) -> list[dict]:
    rates = load_cost_settings(db)
    usage = _usage_since(db, now - timedelta(days=90))
    cost: dict[str, dict] = defaultdict(lambda: {"sessions": 0, "minutes": 0.0, "cost_usd": 0.0})
    for u in usage:
        c = cost[u.get("uid") or "?"]
        c["sessions"] += 1
        c["minutes"] += float(u.get("agent_seconds") or u.get("duration_seconds") or 0) / 60
        c["cost_usd"] += estimate_cost(u, rates)["total"]
    needle = query.strip().lower()
    rows = []
    for u in _scan_users(db):
        if needle and needle not in f"{u.get('email', '')} {u.get('display_name', '')} {u['uid']}".lower():
            continue
        stats = u.get("statistics") or {}
        c = cost.get(u["uid"], {"sessions": 0, "minutes": 0.0, "cost_usd": 0.0})
        rows.append({
            "uid": u["uid"], "email": u.get("email", ""), "name": u.get("display_name", ""),
            "role": u.get("role", "user"), "plan": "premium" if _is_premium(u, now) else "free",
            "premium_until": _as_utc(u.get("premium_until")), "premium_source": u.get("premium_source"),
            "created_at": _as_utc(u.get("created_at")), "last_practice_date": stats.get("last_practice_date"),
            "streak_days": int(stats.get("streak_days", 0) or 0), "level": u.get("pravaah_level", "unassessed"),
            "demo_used": bool(u.get("ai_demo_used_at")), "suspended": bool(u.get("suspended")),
            "ai_sessions_90d": c["sessions"],
            "ai_minutes_90d": round(c["minutes"], 1), "cost_usd_90d": round(c["cost_usd"], 4),
        })
    rows.sort(key=lambda r: (r["cost_usd_90d"], r["created_at"] or datetime.min.replace(tzinfo=timezone.utc)),
              reverse=True)
    return rows[:limit]


@admin_router.get("/users")
async def admin_users(admin: AdminUser, q: str = "", limit: int = Query(100, ge=1, le=500)):
    import asyncio
    return await asyncio.to_thread(_user_rows, get_firestore_client(), _now(), q, limit)


@admin_router.post("/users/{uid}/premium")
async def admin_set_premium(uid: str, admin: AdminUser, req_id: RequestId,
                            days: Optional[int] = Query(None, ge=1, le=3650), revoke: bool = False):
    db = get_firestore_client()
    ref = db.collection("users").document(uid)
    if not ref.get().exists:
        raise _error(404, ErrorCode.SESSION_NOT_FOUND, "User not found.", req_id)
    if revoke:
        ref.set({"plan": "free", "premium_until": None}, merge=True)
        return {"uid": uid, "plan": "free"}
    until = _now() + timedelta(days=days) if days else None
    ref.set({"plan": "premium", "premium_until": until, "premium_source": "admin"}, merge=True)
    return {"uid": uid, "plan": "premium", "premium_until": until}


@admin_router.post("/users/{uid}/reset-demo")
async def admin_reset_demo(uid: str, admin: AdminUser):
    get_firestore_client().collection("users").document(uid).set(
        {"ai_demo_used_at": None, "free_assessment_at": None}, merge=True)
    return {"uid": uid, "demo_available": True}


@admin_router.post("/users/{uid}/suspend")
async def admin_suspend_user(uid: str, admin: AdminUser, req_id: RequestId, restore: bool = False):
    """Block an abusive account: no sign-in, no AI. Restore undoes it."""
    if uid == admin["uid"]:
        raise _error(400, ErrorCode.VALIDATION_ERROR, "You cannot suspend your own account.", req_id)
    from firebase_admin import auth as firebase_auth
    db = get_firestore_client()
    db.collection("users").document(uid).set(
        {"suspended": not restore, "suspended_at": None if restore else _now(),
         "suspended_by": None if restore else admin.get("email", "")}, merge=True)
    try:
        firebase_auth.update_user(uid, disabled=not restore)
        if not restore:
            firebase_auth.revoke_refresh_tokens(uid)
    except Exception as exc:
        log.warning("Could not update Firebase auth state for %s: %s", uid, exc)
    return {"uid": uid, "suspended": not restore}


# ---------------------------------------------------------------------------
# Admin: errors and bug reports
# ---------------------------------------------------------------------------

@admin_router.get("/errors")
async def admin_errors(admin: AdminUser, days: int = Query(7, ge=1, le=90), limit: int = Query(300, ge=1, le=1000)):
    since = _now() - timedelta(days=days)
    docs = (get_firestore_client().collection(ERRORS).where(filter=FieldFilter("created_at", ">=", since))
            .order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit).stream())
    events, groups = [], {}
    for doc in docs:
        e = {**(doc.to_dict() or {}), "id": doc.id}
        events.append(e)
        g = groups.setdefault(e.get("fingerprint") or doc.id, {
            "fingerprint": e.get("fingerprint") or doc.id, "message": e.get("message", ""),
            "source": e.get("source", "app"), "count": 0, "users": set(), "last_seen": e.get("created_at"),
            "screen": e.get("screen", ""), "platform": e.get("platform", ""),
        })
        g["count"] += 1
        if e.get("uid"):
            g["users"].add(e["uid"])
    grouped = [{**g, "users": len(g["users"])} for g in groups.values()]
    grouped.sort(key=lambda g: g["count"], reverse=True)
    return {"groups": grouped, "events": events[:100]}


@admin_router.get("/bugs")
async def admin_bugs(admin: AdminUser, status: str = "all", limit: int = Query(200, ge=1, le=1000)):
    query = get_firestore_client().collection(BUGS)
    if status in {"open", "in_progress", "resolved"}:
        query = query.where(filter=FieldFilter("status", "==", status))
    docs = [{**(d.to_dict() or {}), "id": d.id} for d in query.limit(limit).stream()]
    docs.sort(key=lambda d: _as_utc(d.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return docs


@admin_router.patch("/bugs/{bug_id}")
async def admin_update_bug(bug_id: str, body: UpdateBugReportRequest, admin: AdminUser, req_id: RequestId):
    ref = get_firestore_client().collection(BUGS).document(bug_id)
    if not ref.get().exists:
        raise _error(404, ErrorCode.SESSION_NOT_FOUND, "Report not found.", req_id)
    ref.set({"status": body.status, "updated_at": _now(), "updated_by": admin.get("email", "")}, merge=True)
    return {"id": bug_id, "status": body.status}


# ---------------------------------------------------------------------------
# Admin: coupons
# ---------------------------------------------------------------------------

def _random_code(prefix: str) -> str:
    body = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{prefix}-{body[:4]}-{body[4:]}" if prefix else f"{body[:4]}-{body[4:]}"


def _coupon_view(doc_id: str, data: dict) -> dict:
    return {
        "code": doc_id, "kind": data.get("kind"), "pro_days": data.get("pro_days"),
        "percent_off": data.get("percent_off"), "max_redemptions": int(data.get("max_redemptions", 1)),
        "redemptions": int(data.get("redemptions", 0)), "active": bool(data.get("active", True)),
        "expires_at": _as_utc(data.get("expires_at")), "note": data.get("note", ""),
        "batch_id": data.get("batch_id"), "created_at": _as_utc(data.get("created_at")),
        "created_by": data.get("created_by", ""),
    }


@admin_router.get("/coupons")
async def admin_list_coupons(admin: AdminUser, limit: int = Query(500, ge=1, le=2000)):
    docs = get_firestore_client().collection(COUPONS).limit(limit).stream()
    rows = [_coupon_view(d.id, d.to_dict() or {}) for d in docs]
    rows.sort(key=lambda r: r["created_at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return rows


@admin_router.post("/coupons", status_code=201)
async def admin_create_coupons(body: CreateCouponRequest, admin: AdminUser, req_id: RequestId):
    db, now = get_firestore_client(), _now()
    base = {
        "kind": body.kind, "pro_days": body.pro_days if body.kind == "pro" else None,
        "percent_off": body.percent_off if body.kind == "discount" else None,
        "max_redemptions": body.max_redemptions, "redemptions": 0, "active": True,
        "expires_at": body.expires_at, "note": body.note, "created_at": now,
        "created_by": admin.get("email", ""),
    }
    if body.code:
        try:
            db.collection(COUPONS).document(body.code).create(base)
        except AlreadyExists:
            raise _error(409, ErrorCode.VALIDATION_ERROR, f"A coupon named {body.code} already exists.", req_id)
        return [_coupon_view(body.code, base)]

    batch_id = secrets.token_hex(4)
    created = []
    for _ in range(body.count):
        for _attempt in range(5):
            code = _random_code(body.prefix)
            try:
                db.collection(COUPONS).document(code).create({**base, "batch_id": batch_id})
                created.append(_coupon_view(code, {**base, "batch_id": batch_id}))
                break
            except AlreadyExists:
                continue
    return created


@admin_router.patch("/coupons/{code}")
async def admin_update_coupon(code: str, body: UpdateCouponRequest, admin: AdminUser, req_id: RequestId):
    ref = get_firestore_client().collection(COUPONS).document(code.upper())
    snap = ref.get()
    if not snap.exists:
        raise _error(404, ErrorCode.COUPON_INVALID, "Coupon not found.", req_id)
    changes = body.model_dump(exclude_unset=True)
    if changes:
        ref.set(changes, merge=True)
    return _coupon_view(ref.id, {**(snap.to_dict() or {}), **changes})


@admin_router.get("/coupons/{code}/redemptions")
async def admin_coupon_redemptions(code: str, admin: AdminUser):
    docs = get_firestore_client().collection(COUPONS).document(code.upper()).collection("redemptions").stream()
    rows = [{**(d.to_dict() or {}), "uid": d.id} for d in docs]
    rows.sort(key=lambda r: _as_utc(r.get("redeemed_at")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return rows


# ---------------------------------------------------------------------------
# Admin: cost settings
# ---------------------------------------------------------------------------

@admin_router.get("/settings/costs", response_model=CostSettings)
async def admin_get_costs(admin: AdminUser):
    return load_cost_settings(get_firestore_client())


@admin_router.put("/settings/costs", response_model=CostSettings)
async def admin_put_costs(body: CostSettings, admin: AdminUser):
    get_firestore_client().collection("admin_config").document("costs").set(
        {**body.model_dump(), "updated_at": _now(), "updated_by": admin.get("email", "")})
    return body


@admin_router.get("/settings/limits", response_model=AiLimits)
async def admin_get_limits(admin: AdminUser):
    return load_ai_limits(get_firestore_client())


@admin_router.put("/settings/limits", response_model=AiLimits)
async def admin_put_limits(body: AiLimits, admin: AdminUser):
    get_firestore_client().collection("admin_config").document("limits").set(
        {**body.model_dump(), "updated_at": _now(), "updated_by": admin.get("email", "")})
    return body


@admin_router.get("/pricing", response_model=PricingConfig)
async def admin_get_pricing(admin: AdminUser):
    return load_pricing(get_firestore_client())


@admin_router.put("/pricing", response_model=PricingConfig)
async def admin_put_pricing(body: PricingConfig, admin: AdminUser):
    get_firestore_client().collection("admin_config").document("pricing").set(
        {**body.model_dump(), "updated_at": _now(), "updated_by": admin.get("email", "")})
    return body


@ops_router.get("/api/pricing")
async def public_pricing():
    """Current Premium prices for the paywall, including any running sale."""
    return {"currency": "INR", "plans": pricing_view(load_pricing(get_firestore_client()), _now())}


@ops_router.get("/api/me/ai-usage")
async def my_ai_usage(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    db = get_firestore_client()
    doc = db.collection("users").document(user["uid"]).get()
    return ai_usage_view(doc.to_dict() or {} if doc.exists else {}, load_ai_limits(db), _now())

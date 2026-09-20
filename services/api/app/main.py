"""
English Coach AI — FastAPI application entry point.

Endpoints:
  GET  /api/me/profile
  GET  /api/me/sessions
  GET  /api/me/progress
  GET  /api/me/mistakes
  GET  /api/me/vocabulary
  DELETE /api/me
  POST /api/sessions
  POST /api/sessions/{session_id}/token/refresh
  GET  /api/sessions/{session_id}
"""

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
import logging

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from livekit.api import AccessToken, VideoGrants
from pydantic import BaseModel

import sys

from .auth import AuthError, CurrentUser, RequestId
from .firebase import get_firebase_app, get_firestore_client
from firebase_admin import firestore
from .models import (
    CreateSessionRequest,
    CreateSessionResponse,
    ErrorCode,
    ErrorDetail,
    ErrorResponse,
    LearnerProfile,
    LessonRecord,
    PersonalizedLesson,
    Mistake,
    AssessmentObservationInput,
    ProficiencyAssessmentRecord,
    DailyPlanActivityModel,
    DailyLearningPlanModel,
    CompleteActivityRequest,
    CompleteSessionRequest,
    UpdateGoalRequest,
    UpdateProfileRequest,
    ProgressSummary,
    RefreshTokenResponse,
    SessionSummary,
    VocabularyEntry,
)

# Import learning engine functions
base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
le_path = os.path.join(base_dir, "services", "learning-engine")
if le_path not in sys.path:
    sys.path.insert(0, le_path)

try:
    from worker import (
        apply_proficiency_assessment,
        get_or_create_daily_plan,
        complete_daily_plan_activity,
        compute_focus_ranking,
        process_event,
        analyze_session_messages,
    )
    from curriculum import evaluate_assessment_rubric, generate_daily_plan
except ImportError as _le_import_error:
    # Swallowing this silently used to turn every learning-engine endpoint into an
    # opaque 500 (NameError) at request time, so make the cause obvious at boot.
    logging.getLogger("api").error(
        "Learning engine import failed (%s). Daily plans, assessment and session analysis "
        "endpoints will be unavailable. Expected package at %s",
        _le_import_error,
        le_path,
    )

PRAVAAH_CEFR_REFERENCE = {
    "E": "A1", "D": "A1–A2", "C": "A2", "B": "B1", "A": "B2–C1", "S": "C1–C2+",
}

load_dotenv()

# ---------------------------------------------------------------------------
# LiveKit token helpers
# ---------------------------------------------------------------------------

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
LIVEKIT_TOKEN_TTL_SECONDS = 15 * 60  # 15 minutes, renewable


def _mint_livekit_token(
    room_name: str,
    participant_identity: str,
    participant_name: str | None = None,
    metadata: dict | None = None,
) -> tuple[str, datetime]:
    """
    Mint a short-lived, room-scoped LiveKit access token.

    Session context (mode, topic, goal, skill) is embedded as participant metadata so the
    voice agent can read it straight off the participant instead of doing a blocking
    Firestore lookup on its realtime event loop.
    """
    grant = VideoGrants(room_join=True, room=room_name, can_publish=True, can_subscribe=True)
    token = (
        AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(participant_identity)
        .with_grants(grant)
        .with_ttl(timedelta(seconds=LIVEKIT_TOKEN_TTL_SECONDS))
    )
    if participant_name:
        token = token.with_name(participant_name)
    if metadata:
        token = token.with_metadata(json.dumps(metadata))
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=LIVEKIT_TOKEN_TTL_SECONDS)
    return token.to_jwt(), expires_at


def _compute_streak_days(last_practice_date: str | None, current_streak: int) -> int:
    """A streak only survives if the last practice was today or yesterday."""
    if not last_practice_date or not current_streak:
        return 0
    try:
        last = datetime.strptime(last_practice_date, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return 0
    delta = (datetime.now(timezone.utc).date() - last).days
    return int(current_streak) if delta <= 1 else 0


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

async def _warmup_tts():
    try:
        await asyncio.sleep(2)
        greetings = [
            "Hi! I'm Coach Pravaah, your spoken English partner. What would you like to talk about today?",
            "Hi Tanmay! I'm Coach Pravaah, your spoken English partner. What would you like to talk about today?",
            "Hello! I'm Coach Pravaah, your spoken English partner. What would you like to talk about today?",
            "I'm ready whenever you are. Just say hello to get started!",
        ]
        for g in greetings:
            clean = g.strip()
            key = f"en-IN-PrabhatNeural|{clean}"
            if key not in _tts_cache:
                try:
                    data = await _synthesize_edge(clean, "en-IN-PrabhatNeural")
                    if data:
                        _tts_cache[key] = data
                        logging.getLogger("api").info("Pre-warmed TTS greeting: %s", clean[:35])
                except Exception as e:
                    logging.getLogger("api").debug("TTS warmup notice: %s", e)
    except Exception as exc:
        logging.getLogger("api").debug("TTS warmup task notice: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Firebase and warmup TTS cache on startup."""
    get_firebase_app()
    asyncio.create_task(_warmup_tts())
    yield


app = FastAPI(
    title="English Coach AI — API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

@app.exception_handler(AuthError)
async def auth_error_handler(request, exc: AuthError):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    return Response(
        status_code=401,
        content=ErrorResponse(
            error=ErrorDetail(code=exc.code, message=exc.message, request_id=request_id)
        ).model_dump_json(),
        media_type="application/json",
        headers={"X-Request-ID": request_id},
    )


# ---------------------------------------------------------------------------
# Health & Root Status (supports GET & HEAD for Render health checker)
# ---------------------------------------------------------------------------

@app.api_route("/", methods=["GET", "HEAD"])
async def root():
    return {
        "status": "healthy",
        "service": "Pravaah Backend API",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.api_route("/health", methods=["GET", "HEAD"])
@app.api_route("/api/health", methods=["GET", "HEAD"])
async def health():
    return {"status": "ok", "service": "api"}


# ---------------------------------------------------------------------------
# Embedded Neural TTS Endpoint (/v1/audio/speech) — Male voice default
# ---------------------------------------------------------------------------

class SpeechRequest(BaseModel):
    model: str = "tts-1"
    input: str
    voice: str = "en-IN-PrabhatNeural"
    response_format: str = "mp3"
    speed: float = 1.0


_tts_cache: dict[str, bytes] = {}


async def _synthesize_edge(clean_text: str, voice: str) -> bytes:
    import edge_tts
    communicate = edge_tts.Communicate(clean_text, voice=voice)
    audio_buf = bytearray()

    async def _stream():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buf.extend(chunk["data"])

    await asyncio.wait_for(_stream(), timeout=7.0)
    return bytes(audio_buf)


@app.post("/v1/audio/speech")
async def generate_speech(req: SpeechRequest):
    clean_text = req.input.strip().replace("**", "").replace("*", "").replace("#", "").replace('"', "").replace("`", "") or "Okay."
    voice = req.voice if req.voice in {"en-IN-PrabhatNeural", "en-IN-NeerjaNeural", "hi-IN-SwaraNeural"} else "en-IN-PrabhatNeural"
    key = f"{voice}|{clean_text}"

    if key in _tts_cache:
        return Response(
            content=_tts_cache[key],
            media_type="audio/mpeg",
            headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
        )

    try:
        result_bytes = await _synthesize_edge(clean_text, voice)
        if result_bytes:
            if len(_tts_cache) < 200:
                _tts_cache[key] = result_bytes
            return Response(
                content=result_bytes,
                media_type="audio/mpeg",
                headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
            )
    except Exception as exc:
        logging.getLogger("api").warning("TTS synthesis attempt 1 error (%s), retrying...", exc)
        try:
            result_bytes = await _synthesize_edge(clean_text, voice)
            if result_bytes:
                if len(_tts_cache) < 200:
                    _tts_cache[key] = result_bytes
                return Response(
                    content=result_bytes,
                    media_type="audio/mpeg",
                    headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
                )
        except Exception as retry_exc:
            raise HTTPException(status_code=500, detail=f"TTS synthesis error: {retry_exc}")

    raise HTTPException(status_code=500, detail="TTS generation failed")


# ---------------------------------------------------------------------------
# Learner profile — /api/me
# ---------------------------------------------------------------------------

@app.get("/api/me/profile", response_model=LearnerProfile)
async def get_my_profile(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    user_ref = db.collection("users").document(uid)
    doc = user_ref.get()

    # Identity claims from the verified Firebase token are the source of truth for
    # the learner's name, so the UI never has to guess or show a placeholder.
    claim_name = user.get("name") or user.get("display_name")
    claim_email = user.get("email")
    claim_photo = user.get("picture") or user.get("photo_url")

    if not doc.exists:
        # Auto-create default profile on first access
        profile = LearnerProfile(
            uid=uid,
            display_name=claim_name or (claim_email.split("@")[0] if claim_email else None),
            email=claim_email,
            photo_url=claim_photo,
        )
        profile_data = profile.model_dump()
        profile_data["created_at"] = datetime.now(timezone.utc)
        user_ref.set(profile_data)
        return profile.model_copy(update={"created_at": profile_data["created_at"]})

    data = doc.to_dict() or {}
    data["uid"] = uid

    identity_updates = {}
    if claim_email and data.get("email") != claim_email:
        identity_updates["email"] = claim_email
    if claim_photo and data.get("photo_url") != claim_photo:
        identity_updates["photo_url"] = claim_photo
    # Never overwrite a name the learner set themselves via PATCH.
    if claim_name and not data.get("display_name"):
        identity_updates["display_name"] = claim_name
    if identity_updates:
        data.update(identity_updates)
        user_ref.set(identity_updates, merge=True)

    if not data.get("display_name") and claim_email:
        data["display_name"] = claim_email.split("@")[0]

    # Flatten the nested statistics map so the client gets a flat, typed profile.
    stats = data.get("statistics") or {}
    data["total_sessions"] = int(stats.get("total_sessions", 0) or 0)
    data["total_practice_minutes"] = int(stats.get("total_practice_minutes", stats.get("practice_minutes", 0)) or 0)
    data["last_practice_date"] = stats.get("last_practice_date")
    data["streak_days"] = _compute_streak_days(stats.get("last_practice_date"), stats.get("streak_days", 0))

    # Self-healing: if pravaah_level is missing or unassessed, check proficiency_assessments subcollection
    if not data.get("pravaah_level") or data.get("pravaah_level") == "unassessed":
        try:
            latest_assess_stream = list(
                user_ref.collection("proficiency_assessments")
                .order_by("assessed_at", direction=firestore.Query.DESCENDING)
                .limit(1)
                .stream()
            )
            if latest_assess_stream:
                assess_data = latest_assess_stream[0].to_dict()
                assessed_level = assess_data.get("pravaah_level")
                if assessed_level and assessed_level in {"E", "D", "C", "B", "A", "S"}:
                    cefr_ref = assess_data.get("cefr_reference") or PRAVAAH_CEFR_REFERENCE.get(assessed_level, "A2")
                    data["pravaah_level"] = assessed_level
                    data["cefr_reference"] = cefr_ref
                    data["cefr_level"] = cefr_ref
                    if assess_data.get("strengths"):
                        data["strengths"] = assess_data.get("strengths")
                    if assess_data.get("weaknesses"):
                        data["weaknesses"] = assess_data.get("weaknesses")
                    if assess_data.get("initial_focus"):
                        data["current_focus"] = assess_data.get("initial_focus")

                    user_ref.set({
                        "pravaah_level": assessed_level,
                        "cefr_reference": cefr_ref,
                        "cefr_level": cefr_ref,
                        "last_assessed_at": assess_data.get("assessed_at"),
                        "updated_at": firestore.SERVER_TIMESTAMP,
                    }, merge=True)
                    logging.getLogger("api").info("Self-healed profile for user %s: set level to %s (%s)", uid, assessed_level, cefr_ref)
        except Exception as e:
            logging.getLogger("api").warning("Profile self-healing check notice: %s", e)

    return LearnerProfile(**data)


@app.patch("/api/me/profile", response_model=LearnerProfile)
async def update_my_profile(
    body: UpdateProfileRequest, user: CurrentUser, req_id: RequestId, response: Response
):
    """Update learner settings (e.g. display name, daily goal minutes, Hindi support)."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    user_ref = db.collection("users").document(uid)

    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc)
        user_ref.set(update_data, merge=True)

        # If daily goal minutes was updated, sync or regenerate today's daily plan
        if "daily_goal_minutes" in update_data:
            try:
                get_or_create_daily_plan(user_id=uid, goal_minutes=update_data["daily_goal_minutes"])
            except Exception as exc:
                logging.getLogger("api").warning("Daily plan sync after goal update failed: %s", exc)

    return await get_my_profile(user=user, req_id=req_id, response=response)




@app.get("/api/me/progress", response_model=ProgressSummary)
async def get_my_progress(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    doc = db.collection("users").document(uid).get()
    
    total_sessions = 0
    total_minutes = 0.0
    
    if doc.exists:
        data = doc.to_dict() or {}
        stats = data.get("statistics", {})
        total_sessions = stats.get("total_sessions", 0)
        total_minutes = float(stats.get("total_practice_minutes", stats.get("practice_minutes", 0.0)))

    if total_sessions == 0:
        sessions = list(db.collection("users").document(uid).collection("sessions").stream())
        total_sessions = len(sessions)
        for s in sessions:
            s_data = s.to_dict() or {}
            dur = s_data.get("duration_seconds") or 0
            total_minutes += dur / 60.0

    return ProgressSummary(
        total_sessions=total_sessions,
        total_practice_minutes=total_minutes,
    )


@app.get("/api/me/sessions", response_model=list[SessionSummary])
async def get_my_sessions(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    sessions_ref = db.collection("users").document(uid).collection("sessions").limit(50)
    results = []
    for doc in sessions_ref.stream():
        data = doc.to_dict() or {}
        data["session_id"] = doc.id
        results.append(SessionSummary(**data))
    return results


@app.get("/api/me/mistakes")
async def get_my_mistakes(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    base_ref = db.collection("users").document(uid).collection("mistakes")
    try:
        docs = base_ref.order_by("created_at", direction=firestore.Query.DESCENDING).limit(300).stream()
    except Exception:
        docs = base_ref.limit(300).stream()

    results = []
    for doc in docs:
        data = doc.to_dict() or {}
        data["mistake_id"] = doc.id
        if "short_explanation" in data and "explanation" not in data:
            data["explanation"] = data["short_explanation"]
        # The client groups by skill and then by day, so both must always be present.
        if not data.get("curriculum_skill_id"):
            data["curriculum_skill_id"] = data.get("category") or "sentence_structure"
        created = data.get("created_at")
        if hasattr(created, "isoformat"):
            data["created_at"] = created.isoformat()
        elif created is not None:
            data["created_at"] = str(created)
        data.pop("updated_at", None)
        results.append(data)
    return results


@app.get("/api/me/vocabulary")
async def get_my_vocabulary(user: CurrentUser, req_id: RequestId, response: Response):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    results = []
    try:
        vocab_ref = db.collection("users").document(uid).collection("vocabulary").order_by("created_at", direction=firestore.Query.DESCENDING).limit(50)
        for doc in vocab_ref.stream():
            data = doc.to_dict() or {}
            data["vocabulary_id"] = doc.id
            if "term" not in data:
                data["term"] = data.get("suggested_alternative") or data.get("original_usage") or "Expression"
            if "context" not in data:
                data["context"] = data.get("original_usage") or ""
            if "natural_usage_tip" not in data:
                data["natural_usage_tip"] = data.get("explanation") or ""
            results.append(data)
    except Exception:
        vocab_ref = db.collection("users").document(uid).collection("vocabulary").limit(50)
        for doc in vocab_ref.stream():
            data = doc.to_dict() or {}
            data["vocabulary_id"] = doc.id
            if "term" not in data:
                data["term"] = data.get("suggested_alternative") or data.get("original_usage") or "Expression"
            if "context" not in data:
                data["context"] = data.get("original_usage") or ""
            if "natural_usage_tip" not in data:
                data["natural_usage_tip"] = data.get("explanation") or ""
            results.append(data)
    return results


@app.delete("/api/me", status_code=200)
@app.delete("/api/me/account", status_code=200)
async def delete_my_account(user: CurrentUser, req_id: RequestId, response: Response):
    """Delete the authenticated user's Firebase Auth account and all Firestore data."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()

    # Delete subcollections
    user_ref = db.collection("users").document(uid)
    for subcollection_name in ["sessions", "mistakes", "vocabulary", "dailyStats", "proficiency_assessments", "daily_plans"]:
        subcol_ref = user_ref.collection(subcollection_name)
        for doc in subcol_ref.stream():
            if subcollection_name == "sessions":
                messages_ref = doc.reference.collection("messages")
                for msg in messages_ref.stream():
                    msg.reference.delete()
            doc.reference.delete()

    # Delete user document
    user_ref.delete()

    # Delete Firebase Auth account
    from firebase_admin import auth
    try:
        auth.delete_user(uid)
    except Exception:
        pass

    return {"message": "Account deleted.", "deleted": True, "request_id": req_id}


@app.post("/api/sessions", response_model=CreateSessionResponse)
async def create_session(
    body: CreateSessionRequest,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    session_id = str(uuid.uuid4())
    room_name = f"session_{session_id}"
    now = datetime.now(timezone.utc)

    # Determine lesson ID if targeted skill practice
    lesson_id = body.lesson_id
    if not lesson_id and body.target_skill:
        lesson_id = f"lsn_{body.target_skill}_{uuid.uuid4().hex[:6]}"

    db = get_firestore_client()

    # Resolve the learner's display name so the coach can greet them personally.
    learner_name = user.get("name") or user.get("display_name")
    profile_snapshot = db.collection("users").document(uid).get()
    profile_data = profile_snapshot.to_dict() or {} if profile_snapshot.exists else {}
    learner_name = profile_data.get("display_name") or learner_name
    if not learner_name and user.get("email"):
        learner_name = user["email"].split("@")[0]

    conversation_goal = body.conversation_goal.value if body.conversation_goal else None
    if conversation_goal is None:
        conversation_goal = {
            "grammar_practice": "grammar",
            "vocabulary_practice": "vocabulary",
            "roleplay": "roleplay",
        }.get(body.mode.value, "intro")

    topic = (body.topic or "").strip() or None
    roleplay_scenario = (body.roleplay_scenario or "").strip() or None

    session_data = {
        "session_id": session_id,
        "user_id": uid,
        "mode": body.mode.value,
        "start_time": now,
        "end_time": None,
        "summary": None,
        "metrics": {},
        "state": "CREATED",
        "target_skill": body.target_skill,
        "lesson_id": lesson_id,
        "topic": topic,
        "conversation_goal": conversation_goal,
        "roleplay_scenario": roleplay_scenario,
    }
    db.collection("users").document(uid).collection("sessions").document(session_id).set(session_data)
    try:
        db.collection("sessions").document(session_id).set({
            "session_id": session_id,
            "user_id": uid,
            "mode": body.mode.value,
            "target_skill": body.target_skill,
            "lesson_id": lesson_id,
            "topic": topic,
            "conversation_goal": conversation_goal,
            "roleplay_scenario": roleplay_scenario,
            "created_at": now,
        })
    except Exception as exc:
        logging.getLogger("api").warning("Top-level session mirror failed for %s: %s", session_id, exc)

    # If launching a targeted lesson, transition lesson to in_progress state
    if lesson_id and body.target_skill:
        db.collection("users").document(uid).collection("lessons").document(lesson_id).set({
            "lesson_id": lesson_id,
            "source_skill_id": body.target_skill,
            "session_id": session_id,
            "start_time": now,
            "completion_status": "in_progress",
            "status": "in_progress",
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

    # Mint LiveKit token carrying the full session context as participant metadata.
    token, _ = _mint_livekit_token(
        room_name,
        participant_identity=uid,
        participant_name=learner_name,
        metadata={
            "session_id": session_id,
            "user_id": uid,
            "learner_name": learner_name,
            "mode": body.mode.value,
            "target_skill": body.target_skill,
            "lesson_id": lesson_id,
            "topic": topic,
            "conversation_goal": conversation_goal,
            "roleplay_scenario": roleplay_scenario,
            "pravaah_level": profile_data.get("pravaah_level", "unassessed"),
            "hindi_support": profile_data.get("hindi_support", "high"),
        },
    )

    return CreateSessionResponse(
        session_id=session_id,
        livekit_token=token,
        room_name=room_name,
    )


@app.get("/api/me/lessons", response_model=list[LessonRecord])
async def get_my_lessons(user: CurrentUser, req_id: RequestId, response: Response):
    """Retrieve history of recommended and completed lessons."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    lessons_ref = (
        db.collection("users").document(uid).collection("lessons")
        .order_by("updated_at", direction="DESCENDING")
        .limit(20)
    )
    results = []
    for doc in lessons_ref.stream():
        data = doc.to_dict()
        data["lesson_id"] = doc.id
        results.append(LessonRecord(**data))
    return results


@app.get("/api/me/lessons/{lesson_id}", response_model=LessonRecord)
async def get_lesson_by_id(lesson_id: str, user: CurrentUser, req_id: RequestId, response: Response):
    """Retrieve a specific lesson record by ID."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    doc = db.collection("users").document(uid).collection("lessons").document(lesson_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=404,
            detail=ErrorResponse(
                error=ErrorDetail(
                    code=ErrorCode.VALIDATION_ERROR,
                    message="Lesson not found.",
                    request_id=req_id,
                )
            ).model_dump(),
        )
    data = doc.to_dict()
    data["lesson_id"] = doc.id
    return LessonRecord(**data)


@app.post("/api/sessions/{session_id}/token/refresh", response_model=RefreshTokenResponse)
async def refresh_session_token(
    session_id: str,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Issue a new short-lived LiveKit token for an active session."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]

    # Verify session ownership
    db = get_firestore_client()
    session_ref = db.collection("users").document(uid).collection("sessions").document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists:
        raise HTTPException(
            status_code=404,
            detail=ErrorResponse(
                error=ErrorDetail(
                    code=ErrorCode.SESSION_NOT_FOUND,
                    message="Session not found.",
                    request_id=req_id,
                )
            ).model_dump(),
        )

    session_data = session_doc.to_dict()
    if session_data.get("end_time") is not None:
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(
                error=ErrorDetail(
                    code=ErrorCode.SESSION_EXPIRED,
                    message="Session has already ended.",
                    request_id=req_id,
                )
            ).model_dump(),
        )

    room_name = f"session_{session_id}"
    token, expires_at = _mint_livekit_token(room_name, participant_identity=uid)

    # Update heartbeat for usage accounting
    session_ref.update({"last_heartbeat": datetime.now(timezone.utc)})

    return RefreshTokenResponse(livekit_token=token, expires_at=expires_at)


@app.get("/api/sessions/{session_id}", response_model=SessionSummary)
async def get_session(
    session_id: str,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    doc = db.collection("users").document(uid).collection("sessions").document(session_id).get()
    if not doc.exists:
        raise HTTPException(
            status_code=404,
            detail=ErrorResponse(
                error=ErrorDetail(
                    code=ErrorCode.SESSION_NOT_FOUND,
                    message="Session not found.",
                    request_id=req_id,
                )
            ).model_dump(),
        )
    data = doc.to_dict()
    data["session_id"] = doc.id
    return SessionSummary(**data)


@app.post("/api/sessions/{session_id}/complete", status_code=200)
async def complete_session(
    session_id: str,
    body: CompleteSessionRequest,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """
    Explicitly finalize a voice session, record duration & stats,
    mark daily plan activity completed, and trigger session analysis.
    """
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    now = datetime.now(timezone.utc)
    duration_seconds = max(0, body.duration_seconds)
    duration_minutes = max(1, duration_seconds // 60) if duration_seconds >= 30 else 1

    session_ref = db.collection("users").document(uid).collection("sessions").document(session_id)
    session_ref.set({
        "state": "COMPLETED",
        "end_time": now,
        "duration_seconds": duration_seconds,
        "completion_reason": "user_ended",
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    # Increment user profile statistics and roll the practice streak forward
    user_doc_ref = db.collection("users").document(uid)
    today_str = now.strftime("%Y-%m-%d")
    existing_stats = {}
    snapshot = user_doc_ref.get()
    if snapshot.exists:
        existing_stats = (snapshot.to_dict() or {}).get("statistics") or {}

    last_practice_date = existing_stats.get("last_practice_date")
    prior_streak = int(existing_stats.get("streak_days", 0) or 0)
    if last_practice_date == today_str:
        streak_days = max(prior_streak, 1)
    else:
        yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        streak_days = prior_streak + 1 if last_practice_date == yesterday else 1

    user_doc_ref.set({
        "statistics": {
            "total_sessions": firestore.Increment(1),
            "total_practice_minutes": firestore.Increment(duration_minutes),
            "last_practice_date": today_str,
            "streak_days": streak_days,
        },
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    # Complete daily plan activity if lesson_id passed
    if body.lesson_id:
        try:
            complete_daily_plan_activity(
                user_id=uid,
                activity_id=body.lesson_id,
                session_id=session_id,
                duration_minutes=duration_minutes,
            )
        except Exception as exc:
            logging.getLogger("api").warning("Daily plan activity completion failed for %s: %s", body.lesson_id, exc)

    # Process session analysis for mistakes & vocabulary
    event_payload = {
        "duration_seconds": duration_seconds,
        "lesson_id": body.lesson_id,
        "target_skill": body.target_skill,
        "messages": body.messages or [],
    }
    event = {
        "event_id": str(uuid.uuid4()),
        "event_type": "SESSION_ENDED",
        "user_id": uid,
        "session_id": session_id,
        "sequence": 9999,
        "timestamp": now.isoformat(),
        "payload": event_payload,
    }

    try:
        if "process_event" in globals():
            await process_event(event)
    except Exception as exc:
        logging.getLogger("api").warning("Session analysis failed for %s: %s", session_id, exc)

    return {
        "status": "completed",
        "session_id": session_id,
        "duration_seconds": duration_seconds,
        "duration_minutes": duration_minutes,
    }


# ---------------------------------------------------------------------------
# Phase 6: Initial Assessment & Daily Learning Plan Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/assessment", status_code=200)
async def submit_proficiency_assessment(
    body: AssessmentObservationInput,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """
    Submits a spoken English diagnostic assessment. Accepts task-aware speech evidence
    and telemetry from the LiveKit session, executes structured LLM evaluation,
    maps to the Pravaah rubric (E/D/C/B/A/S), persists history, and initializes the daily plan.
    """
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]

    result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input=body.model_dump(),
    )
    return {
        "status": "success",
        "request_id": req_id,
        "assessment": result,
    }


@app.get("/api/assessment/history", response_model=list[ProficiencyAssessmentRecord])
async def get_assessment_history(
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Retrieve history of all qualitative proficiency assessments for this user."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    db = get_firestore_client()
    assess_ref = (
        db.collection("users").document(uid).collection("proficiency_assessments")
        .order_by("assessed_at", direction="DESCENDING")
        .limit(20)
    )
    results = []
    for doc in assess_ref.stream():
        data = doc.to_dict()
        data["assessment_id"] = doc.id
        results.append(ProficiencyAssessmentRecord(**data))
    return results


@app.get("/api/me/daily-plan", response_model=DailyLearningPlanModel)
async def get_today_daily_plan(
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Retrieve or automatically generate today's structured daily practice plan."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    plan = get_or_create_daily_plan(user_id=uid)
    return DailyLearningPlanModel(**plan)


@app.post("/api/me/daily-plan/activity/{activity_id}/complete", response_model=DailyLearningPlanModel)
@app.post("/api/me/daily-plan/activities/{activity_id}/complete", response_model=DailyLearningPlanModel)
async def complete_activity_in_daily_plan(
    activity_id: str,
    body: CompleteActivityRequest,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Mark an activity in today's daily plan as completed and advance progress."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    plan = complete_daily_plan_activity(
        user_id=uid,
        date_str=today_str,
        activity_id=activity_id,
        session_id=body.session_id,
        duration_minutes=body.duration_minutes,
        learner_speaking_time_seconds=body.learner_speaking_time_seconds,
        idle_time_seconds=body.idle_time_seconds,
    )
    return DailyLearningPlanModel(**plan)


@app.get("/api/me/focus")
async def get_focus_ranking(
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """
    The learner's skills ordered by how urgently they need work, derived from the mistakes
    actually recorded in their sessions rather than from the one-off assessment. Drives the
    Lessons page and the ordering of today's plan.
    """
    response.headers["X-Request-ID"] = req_id
    try:
        ranking = compute_focus_ranking(user["uid"])
    except Exception as exc:
        logging.getLogger("api").error("Focus ranking failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=503, detail="Focus ranking is temporarily unavailable.")
    return {"skills": ranking}


@app.post("/api/me/daily-plan/refresh", response_model=DailyLearningPlanModel)
async def refresh_daily_plan(
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Rebuild today's plan against the latest mistake evidence."""
    response.headers["X-Request-ID"] = req_id
    plan = get_or_create_daily_plan(user_id=user["uid"], force_regenerate=True)
    return DailyLearningPlanModel(**plan)


@app.post("/api/me/goal", status_code=200)
@app.post("/api/me/daily-plan/goal", status_code=200)
async def update_daily_goal(
    body: UpdateGoalRequest,
    user: CurrentUser,
    req_id: RequestId,
    response: Response,
):
    """Update user daily goal minutes (15, 30, 60, 90) and regenerate today's daily plan."""
    response.headers["X-Request-ID"] = req_id
    uid = user["uid"]
    plan = get_or_create_daily_plan(user_id=uid, goal_minutes=body.goal_minutes)
    return {
        "status": "success",
        "daily_goal_minutes": body.goal_minutes,
        "daily_plan": plan,
    }


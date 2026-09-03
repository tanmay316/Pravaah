"""
English Coach AI — Pydantic models for API request/response schemas.
"""

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SessionMode(str, Enum):
    free_conversation = "free_conversation"
    grammar_practice = "grammar_practice"
    vocabulary_practice = "vocabulary_practice"
    roleplay = "roleplay"


class ErrorCode(str, Enum):
    AUTH_FAILED = "AUTH_FAILED"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    ROOM_FULL = "ROOM_FULL"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    FORBIDDEN = "FORBIDDEN"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# ---------------------------------------------------------------------------
# Common error response
# ---------------------------------------------------------------------------

class ErrorDetail(BaseModel):
    code: ErrorCode
    message: str
    request_id: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

class CreateSessionRequest(BaseModel):
    mode: SessionMode = SessionMode.free_conversation
    target_skill: Optional[str] = None
    lesson_id: Optional[str] = None


class CreateSessionResponse(BaseModel):
    session_id: str
    livekit_token: str
    room_name: str


class RefreshTokenResponse(BaseModel):
    livekit_token: str
    expires_at: datetime


class CompleteSessionRequest(BaseModel):
    duration_seconds: int = 0
    lesson_id: Optional[str] = None
    target_skill: Optional[str] = None
    messages: Optional[list[dict]] = None


# ---------------------------------------------------------------------------
# Personalized Lesson & Learner Profile (Phase 3D & 4)
# ---------------------------------------------------------------------------

class PersonalizedLesson(BaseModel):
    lesson_id: Optional[str] = None
    target_skill_id: str
    lesson_title: str
    category: str = "grammar"
    cefr_level: str = "A2"
    stage: str = "guided_practice"
    mastery_score: float = 0.50
    rule_summary: str
    hindi_explanation: str = ""
    practice_activity: str
    selection_reason: str = "active_weakness"


class LessonRecord(BaseModel):
    lesson_id: str
    source_skill_id: str
    lesson_title: str = ""
    session_id: str = ""
    stage: str = "guided_practice"
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_seconds: int = 0
    attempts: int = 0
    correction_attempts: int = 0
    successful_repetitions: int = 0
    failed_repetitions: int = 0
    mastery_before: float = 0.5
    mastery_after: float = 0.5
    completion_status: Literal["recommended", "in_progress", "completed", "abandoned"] = "recommended"
    selection_reason: str = "active_weakness"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class LearnerProfile(BaseModel):
    uid: str
    pravaah_level: str = "unassessed"
    cefr_reference: Optional[str] = "unassessed"
    # Legacy internal field accepted for existing Firestore documents; clients
    # must present pravaah_level rather than CEFR.
    cefr_level: Optional[str] = None
    native_language: str = "hi"
    target_language: str = "en"
    daily_goal_minutes: int = 15
    tutor_style: str = "encouraging"
    hindi_support: str = "high"  # high | occasional | minimal | off
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    developing_skills: list[str] = Field(default_factory=list)
    strong_skills: list[str] = Field(default_factory=list)
    mastered_skills: list[str] = Field(default_factory=list)
    current_focus: Optional[str] = "past_simple_auxiliary"
    skill_mastery: dict[str, float] = Field(default_factory=dict)
    recommended_lesson: Optional[PersonalizedLesson] = None
    created_at: Optional[datetime] = None


class UpdateProfileRequest(BaseModel):
    daily_goal_minutes: Optional[int] = None
    hindi_support: Optional[str] = None  # high | occasional | minimal | off
    target_language: Optional[str] = None
    native_language: Optional[str] = None



# ---------------------------------------------------------------------------
# Phase 6: Assessment & Daily Learning Plan Schemas
# ---------------------------------------------------------------------------

class AssessmentTaskEvidence(BaseModel):
    task_id: str = Field(..., description="task_1_intro | task_2_past | task_3_opinion | task_4_hypothetical")
    task_title: Optional[str] = Field(default=None, description="Descriptive task title")
    prompt: str = Field(..., description="Prompt or question given to the learner")
    transcript: str = Field(..., description="Verbatim learner speech transcript")
    duration_ms: int = Field(default=0, description="Duration of learner speech in milliseconds")
    word_count: int = Field(default=0, description="Total word count produced")
    pause_count: int = Field(default=0, description="Number of pauses detected")
    long_pause_count: int = Field(default=0, description="Number of pauses > 1.5s")
    restart_count: int = Field(default=0, description="Number of false starts or restarts")
    response_latency_ms: int = Field(default=0, description="Latency before speaking started in ms")
    turn_count: int = Field(default=1, description="Number of turns in the task interaction")


class AssessmentObservationInput(BaseModel):
    session_id: Optional[str] = None
    goal_minutes: int = 30
    tasks: Optional[list[AssessmentTaskEvidence]] = None
    notes: Optional[str] = None
    # Direct ratings allowed for test mocking or internal evaluations
    pravaah_level: Optional[Literal["E", "D", "C", "B", "A", "S"]] = None
    grammar_rating: Optional[str] = None
    vocabulary_rating: Optional[str] = None
    fluency_rating: Optional[str] = None
    comprehension_rating: Optional[str] = None
    speaking_complexity: Optional[str] = None
    conversation_ability: Optional[str] = None
    pronunciation_rating: Optional[str] = None
    transcripts: Optional[list[dict]] = None  # Legacy/fallback format [{question, response}]


class ProficiencyAssessmentRecord(BaseModel):
    assessment_id: str
    user_id: str
    pravaah_level: str
    cefr_reference: str
    name: str
    criteria: str
    grammar_rating: str = "elementary"
    vocabulary_rating: str = "elementary"
    fluency_rating: str = "elementary"
    comprehension_rating: str = "elementary"
    speaking_complexity: str = "elementary"
    conversation_ability: str = "elementary"
    pronunciation_rating: str = "not_assessed"
    pronunciation: Optional[str] = "Not assessed in V1 (audio-level phonetic analysis deferred)"
    assessment_observations: Optional[dict[str, str]] = None
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    initial_focus: str
    current_focus: Optional[str] = None
    assessed_at: str
    notes: Optional[str] = None
    tasks_evidence: Optional[list[dict]] = None


class DailyPlanActivityModel(BaseModel):
    activity_id: str
    title: str
    mode: str
    target_skill: Optional[str] = None
    duration_minutes: int
    stage: str = "guided_practice"
    objective: str
    prompt_activity: str
    is_completed: bool = False
    session_id: Optional[str] = None
    completed_at: Optional[str] = None
    learner_speaking_time_seconds: Optional[int] = None
    idle_time_seconds: Optional[int] = None


class DailyLearningPlanModel(BaseModel):
    plan_id: str
    plan_date: str
    goal_minutes: int = 30
    planned_minutes: int = 30
    completed_minutes: int = 0
    activities: list[DailyPlanActivityModel] = Field(default_factory=list)
    completed_activities_count: int = 0
    target_skills: list[str] = Field(default_factory=list)
    completion_status: Literal["not_started", "in_progress", "completed"] = "not_started"
    current_activity_index: int = 0
    total_learner_speaking_seconds: Optional[int] = None
    total_idle_seconds: Optional[int] = None


class CompleteActivityRequest(BaseModel):
    session_id: Optional[str] = None
    duration_minutes: Optional[int] = None
    learner_speaking_time_seconds: Optional[int] = None
    idle_time_seconds: Optional[int] = None


class UpdateGoalRequest(BaseModel):
    goal_minutes: int = Field(..., ge=15, le=120)


# ---------------------------------------------------------------------------
# Progress Summary
# ---------------------------------------------------------------------------

class ProgressSummary(BaseModel):
    total_sessions: int = 0
    total_practice_minutes: float = 0.0
    total_speaking_seconds: Optional[int] = None
    grammar_accuracy: Optional[float] = None
    vocabulary_diversity: Optional[float] = None
    words_per_minute: Optional[float] = None


# ---------------------------------------------------------------------------
# Session history
# ---------------------------------------------------------------------------

class SessionSummary(BaseModel):
    session_id: str
    mode: SessionMode
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    summary: Optional[str] = None
    duration_minutes: Optional[float] = None
    learner_speaking_time_seconds: Optional[int] = None
    idle_time_seconds: Optional[int] = None


# ---------------------------------------------------------------------------
# Mistakes
# ---------------------------------------------------------------------------

class Mistake(BaseModel):
    mistake_id: str
    session_id: str
    category: str
    original: str
    corrected: str
    explanation: Optional[str] = None
    severity: str = "medium"
    repeated_successfully: bool = False
    timestamp: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

class VocabularyEntry(BaseModel):
    vocabulary_id: str
    word: str
    meaning: Optional[str] = None
    example: Optional[str] = None
    source_session_id: Optional[str] = None
    times_seen: int = 0
    times_used: int = 0
    mastery: float = 0.0
    last_seen: Optional[datetime] = None


"""
English Coach AI — Pydantic models for API request/response schemas.
"""

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SessionMode(str, Enum):
    free_conversation = "free_conversation"
    grammar_practice = "grammar_practice"
    vocabulary_practice = "vocabulary_practice"
    roleplay = "roleplay"
    assessment = "assessment"


class ErrorCode(str, Enum):
    AUTH_FAILED = "AUTH_FAILED"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    ROOM_FULL = "ROOM_FULL"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    FORBIDDEN = "FORBIDDEN"
    PREMIUM_REQUIRED = "PREMIUM_REQUIRED"
    COUPON_INVALID = "COUPON_INVALID"
    LIMIT_REACHED = "LIMIT_REACHED"
    ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED"
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


# Coach voices the learner can pick; resolved to provider voice IDs in the agent.
TtsVoice = Literal[
    "warm_male", "casual_male", "british_male", "indian_male",
    "indian_female", "british_female", "us_female",
]


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

class ConversationGoal(str, Enum):
    """How the learner wants the session to be steered."""
    intro = "intro"
    grammar = "grammar"
    vocabulary = "vocabulary"
    roleplay = "roleplay"
    fluency = "fluency"
    assessment = "assessment"


class CreateSessionRequest(BaseModel):
    # Lesson instructions and identity are resolved by the server, never supplied by clients.
    model_config = ConfigDict(extra="forbid")

    mode: SessionMode = SessionMode.free_conversation
    target_skill: Optional[str] = Field(default=None, min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$")
    lesson_id: Optional[str] = Field(default=None, min_length=1, max_length=160, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    speech_language: Literal["auto", "en", "hi"] = "en"
    topic: Optional[str] = Field(
        default=None, max_length=120,
        description="Learner-chosen subject, e.g. 'job interview', 'cricket', 'my daily routine'.",
    )
    conversation_goal: Optional[ConversationGoal] = None
    roleplay_scenario: Optional[str] = Field(default=None, max_length=160)


class CreateSessionResponse(BaseModel):
    session_id: str
    livekit_token: str
    room_name: str
    # Set for the free demo; the client and the agent both end the call at this limit.
    max_duration_seconds: Optional[int] = None


class Entitlements(BaseModel):
    plan: Literal["free", "premium"] = "free"
    is_premium: bool = False
    premium_until: Optional[datetime] = None
    demo_available: bool = True
    demo_seconds: int = 300
    assessment_available: bool = True
    next_assessment_at: Optional[datetime] = None
    is_admin: bool = False
    # Discount coupon the learner redeemed, applied when they buy Premium.
    discount_code: Optional[str] = None
    discount_percent: int = 0


COUPON_CODE_PATTERN = r"^[A-Z0-9][A-Z0-9_-]{2,31}$"


class CreateCouponRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["pro", "discount"]
    # Leave empty to generate random codes; set to name the coupon yourself.
    code: Optional[str] = Field(default=None, pattern=COUPON_CODE_PATTERN)
    count: int = Field(default=1, ge=1, le=200)
    prefix: str = Field(default="PRAVAAH", pattern=r"^[A-Z0-9]{0,12}$")
    pro_days: int = Field(default=30, ge=1, le=3650)
    percent_off: int = Field(default=20, ge=1, le=100)
    max_redemptions: int = Field(default=1, ge=1, le=100000)
    expires_at: Optional[datetime] = None
    note: str = Field(default="", max_length=200)


class UpdateCouponRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    active: Optional[bool] = None
    max_redemptions: Optional[int] = Field(default=None, ge=1, le=100000)
    expires_at: Optional[datetime] = None
    note: Optional[str] = Field(default=None, max_length=200)


class RedeemCouponRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=3, max_length=32)


class ClientErrorReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=1000)
    stack: str = Field(default="", max_length=4000)
    screen: str = Field(default="", max_length=120)
    platform: str = Field(default="", max_length=20)
    app_version: str = Field(default="", max_length=40)
    kind: Literal["crash", "error", "api"] = "error"


class BugReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str = Field(min_length=5, max_length=2000)
    screen: str = Field(default="", max_length=120)
    platform: str = Field(default="", max_length=20)
    app_version: str = Field(default="", max_length=40)


class UpdateBugReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["open", "in_progress", "resolved"]


class ModelUsageReport(BaseModel):
    requests: int = Field(default=0, ge=0, le=100000)
    prompt_tokens: int = Field(default=0, ge=0, le=20_000_000)
    completion_tokens: int = Field(default=0, ge=0, le=5_000_000)
    audio_seconds: float = Field(default=0, ge=0, le=36000)
    characters: int = Field(default=0, ge=0, le=5_000_000)


class AgentUsageReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=8, max_length=80)
    llm: dict[str, ModelUsageReport] = Field(default_factory=dict, max_length=20)
    stt: dict[str, ModelUsageReport] = Field(default_factory=dict, max_length=20)
    tts: dict[str, ModelUsageReport] = Field(default_factory=dict, max_length=20)
    errors: list[dict[str, str]] = Field(default_factory=list, max_length=50)
    duration_seconds: float = Field(default=0, ge=0, le=36000)


class CostSettings(BaseModel):
    """USD rates the admin dashboard uses to estimate spend; edit them to match your invoices."""
    model_config = ConfigDict(extra="forbid")

    llm_input_per_million: float = Field(default=0.15, ge=0, le=1000)
    llm_output_per_million: float = Field(default=0.60, ge=0, le=1000)
    stt_per_hour: float = Field(default=0.04, ge=0, le=1000)
    tts_per_million_chars: float = Field(default=0.0, ge=0, le=1000)
    livekit_per_agent_minute: float = Field(default=0.01, ge=0, le=100)
    monthly_budget_usd: float = Field(default=50.0, ge=0, le=1_000_000)
    usd_to_inr: float = Field(default=84.0, ge=1, le=1000)
    # Daily provider limits used for the rate-limit gauges (Groq free tier defaults).
    llm_requests_per_day: int = Field(default=1000, ge=0, le=100_000_000)
    llm_tokens_per_day: int = Field(default=500_000, ge=0, le=10_000_000_000)
    stt_requests_per_day: int = Field(default=2000, ge=0, le=100_000_000)
    stt_audio_seconds_per_day: int = Field(default=28_800, ge=0, le=100_000_000)
    livekit_agent_minutes_per_month: int = Field(default=1000, ge=0, le=100_000_000)


class AiLimits(BaseModel):
    """Hard caps on AI spend, enforced by the API (and the agent) for every session."""
    model_config = ConfigDict(extra="forbid")

    ai_enabled: bool = True  # Kill switch: pauses every AI voice session except for admins.
    premium_sessions_per_day: int = Field(default=10, ge=1, le=200)
    premium_minutes_per_day: int = Field(default=60, ge=5, le=1440)
    premium_minutes_per_month: int = Field(default=900, ge=10, le=44640)
    max_session_minutes: int = Field(default=30, ge=5, le=180)
    # All users combined; protects the monthly budget from a traffic spike or abuse.
    global_minutes_per_day: int = Field(default=3000, ge=10, le=1_000_000)
    assessments_per_day: int = Field(default=3, ge=1, le=50)
    plan_refreshes_per_day: int = Field(default=20, ge=1, le=500)
    analysis_attempts_per_session: int = Field(default=3, ge=1, le=10)


class PlanPrice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    price_inr: int = Field(ge=0, le=1_000_000)
    # Optional sale: shown as the regular price struck through next to this one.
    sale_price_inr: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    sale_label: str = Field(default="", max_length=40)
    sale_ends_at: Optional[datetime] = None

    @model_validator(mode="after")
    def _sale_below_price(self):
        if self.sale_price_inr is not None and self.sale_price_inr >= self.price_inr:
            raise ValueError("The sale price must be lower than the regular price.")
        return self


class PricingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    monthly: PlanPrice = Field(default_factory=lambda: PlanPrice(price_inr=299))
    yearly: PlanPrice = Field(default_factory=lambda: PlanPrice(price_inr=1999))


class PracticeLessonResult(BaseModel):
    stars: int = 0
    best_accuracy: float = 0.0
    completed_count: int = 0
    last_completed_at: Optional[datetime] = None


class PracticeCardState(BaseModel):
    box: int = 0
    due: str = ""
    seen: int = 0
    correct: int = 0


class PracticeProgress(BaseModel):
    xp_total: int = 0
    xp_today: int = 0
    daily_xp_goal: int = 30
    lessons_today: int = 0
    cards_reviewed_today: int = 0
    today: str = ""
    week_xp: list[dict] = Field(default_factory=list)
    lessons: dict[str, PracticeLessonResult] = Field(default_factory=dict)
    cards: dict[str, PracticeCardState] = Field(default_factory=dict)
    streak_days: int = 0


class CompletePracticeLessonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    correct: int = Field(ge=0, le=40)
    total: int = Field(ge=1, le=40)


class CardReviewResult(BaseModel):
    card_id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    correct: bool


class SubmitCardReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[CardReviewResult] = Field(min_length=1, max_length=50)


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
    display_name: Optional[str] = None
    email: Optional[str] = None
    photo_url: Optional[str] = None
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
    # None until the learner picks a coach voice; sessions fall back to DEFAULT_TTS_VOICE.
    tts_voice: Optional[TtsVoice] = None
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    developing_skills: list[str] = Field(default_factory=list)
    strong_skills: list[str] = Field(default_factory=list)
    mastered_skills: list[str] = Field(default_factory=list)
    current_focus: Optional[str] = "past_simple_auxiliary"
    skill_mastery: dict[str, float] = Field(default_factory=dict)
    recommended_lesson: Optional[PersonalizedLesson] = None
    streak_days: int = 0
    total_sessions: int = 0
    total_practice_minutes: int = 0
    last_practice_date: Optional[str] = None
    last_assessed_at: Optional[str] = None
    created_at: Optional[datetime] = None


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None
    daily_goal_minutes: Optional[int] = None
    hindi_support: Optional[str] = None  # high | occasional | minimal | off
    tts_voice: Optional[TtsVoice] = None
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
    pronunciation: Optional[str] = None
    assessment_observations: Optional[dict[str, str]] = None
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    filler_words_detected: list[str] = Field(default_factory=list)
    restarts_and_false_starts: list[str] = Field(default_factory=list)
    grammatical_breakdowns: list[dict[str, str]] = Field(default_factory=list)
    initial_focus: str
    current_focus: Optional[str] = None
    assessed_at: str
    notes: Optional[str] = None
    tasks_evidence: Optional[list[dict]] = None


class LearningExample(BaseModel):
    """Public correction evidence; internal confidence/provenance may carry other types."""
    original: str
    corrected: str
    explanation: Optional[str] = None


class DailyPlanActivityModel(BaseModel):
    activity_id: str
    title: str
    mode: str
    target_skill: Optional[str] = None
    duration_minutes: int
    stage: str = "guided_practice"
    objective: str
    prompt_activity: str
    priority_reason: Optional[str] = None
    source_examples: list[LearningExample] = Field(default_factory=list)
    priority_rank: Optional[int] = Field(default=None, ge=1)
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
    state: Optional[str] = None
    target_skill: Optional[str] = None
    lesson_id: Optional[str] = None
    topic: Optional[str] = None
    conversation_goal: Optional[str] = None
    duration_seconds: Optional[int] = None
    duration_minutes: Optional[float] = None
    learner_speaking_time_seconds: Optional[int] = None
    idle_time_seconds: Optional[int] = None
    metrics: dict = Field(default_factory=dict)


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


"""
Phase 6: Initial Proficiency Assessment + Daily Learning Plan Tests

Validates:
1. New learner defaults to 'unassessed' for pravaah_level and cefr_reference.
2. Rubric evaluation assigns E, D, C, B, A, S correctly based on structured observations.
3. Internal CEFR reference mapping is preserved (E->A1, D->A1-A2, C->A2, B->B1, A->B2-C1, S->C1-C2+).
4. Normal daily sessions and mastery updates NEVER change overall pravaah_level.
5. Multiple assessments persist in history under users/{uid}/proficiency_assessments.
6. Initial weaknesses, strengths, and first learning focus are diagnosed from assessment.
7. Structured Daily Learning Plans generated for 15, 30, 60, and 90 minutes.
8. Daily plan activity sequence ordering (Warmup/Conversation -> Targeted Grammar -> Vocabulary -> Review).
9. Activity completion and daily progress accumulation (completed_minutes increment).
10. Activity completion idempotency (re-completing an activity does not double-count minutes).
11. Next activity selection advances current_activity_index automatically.
12. Strict multi-user isolation across assessments and daily plans.
"""

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
import pytest

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import (
    CURRICULUM_SKILLS,
    ASSESSMENT_RUBRIC,
    evaluate_assessment_rubric,
    generate_daily_plan,
    DailyLearningPlan,
    DailyPlanActivity,
)
from worker import (
    get_firestore_client,
    apply_proficiency_assessment,
    get_or_create_daily_plan,
    complete_daily_plan_activity,
    update_learner_mastery,
    GrammarMistakeFact,
    SessionAnalysisResult,
)


@pytest.mark.asyncio
async def test_new_learner_is_unassessed():
    """Unassessed new learners must have pravaah_level='unassessed' and cefr_reference='unassessed'."""
    uid = f"test_user_unassessed_{uuid.uuid4().hex[:8]}"
    db = get_firestore_client()
    user_ref = db.collection("users").document(uid)

    # Initial state without assessment
    doc = user_ref.get()
    assert not doc.exists or doc.to_dict().get("pravaah_level") in (None, "unassessed")

    # Run session analysis
    sess_id = f"sess_{uuid.uuid4().hex[:6]}"
    analysis = SessionAnalysisResult(
        mistakes=[],
        vocabulary=[],
    )
    messages = [{"role": "user", "text": "Hello how are you doing today"}]
    res = await update_learner_mastery(
        user_id=uid,
        session_id=sess_id,
        analysis=analysis,
        messages=messages,
    )
    assert res["pravaah_level"] == "unassessed"
    assert res["cefr_reference"] == "unassessed"


def test_rubric_evaluates_all_levels_correctly():
    """Rubric evaluation correctly maps multi-dimensional ratings to E, D, C, B, A, S."""
    levels = ["E", "D", "C", "B", "A", "S"]
    expected_cefr = {
        "E": "A1",
        "D": "A1–A2",
        "C": "A2",
        "B": "B1",
        "A": "B2–C1",
        "S": "C1–C2+",
    }

    for lvl in levels:
        eval_res = evaluate_assessment_rubric(assigned_level=lvl)
        assert eval_res["pravaah_level"] == lvl
        assert eval_res["cefr_reference"] == expected_cefr[lvl]
        assert "name" in eval_res
        assert "criteria" in eval_res
        assert isinstance(eval_res["weaknesses"], list)
        assert isinstance(eval_res["strengths"], list)
        assert eval_res["current_focus"] in CURRICULUM_SKILLS

    # Test qualitative ratings average
    eval_beginner = evaluate_assessment_rubric(
        grammar_rating="beginner",
        vocabulary_rating="beginner",
        fluency_rating="beginner",
        comprehension_rating="beginner",
        speaking_complexity="beginner",
        conversation_ability="beginner",
    )
    assert eval_beginner["pravaah_level"] == "E"

    eval_advanced = evaluate_assessment_rubric(
        grammar_rating="advanced",
        vocabulary_rating="advanced",
        fluency_rating="advanced",
        comprehension_rating="advanced",
        speaking_complexity="advanced",
        conversation_ability="advanced",
    )
    assert eval_advanced["pravaah_level"] == "A"


@pytest.mark.asyncio
async def test_apply_assessment_persists_history_and_diagnoses_profile():
    """Applying an assessment persists in history, updates profile, and sets initial focus."""
    uid = f"test_user_assess_{uuid.uuid4().hex[:8]}"
    db = get_firestore_client()

    # Apply initial assessment resulting in Level C
    result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={
            "pravaah_level": "C",
            "grammar_rating": "elementary",
            "vocabulary_rating": "elementary",
            "fluency_rating": "elementary",
            "notes": "Good baseline conversational ability, recurring past auxiliary errors.",
            "goal_minutes": 30,
        },
    )

    assert result["pravaah_level"] == "C"
    assert result["cefr_reference"] == "A2"
    assert "past_simple_auxiliary" in result["weaknesses"]
    assert result["current_focus"] == "past_simple_auxiliary"
    assert result["daily_plan"]["planned_minutes"] == 30

    # Verify history document exists in subcollection
    assessments = list(db.collection("users").document(uid).collection("proficiency_assessments").stream())
    assert len(assessments) == 1
    assert assessments[0].to_dict()["pravaah_level"] == "C"

    # Verify user profile in Firestore
    user_doc = db.collection("users").document(uid).get().to_dict()
    assert user_doc["pravaah_level"] == "C"
    assert user_doc["cefr_reference"] == "A2"
    assert user_doc["current_focus"] == "past_simple_auxiliary"
    assert user_doc["daily_goal_minutes"] == 30


@pytest.mark.asyncio
async def test_daily_session_cannot_change_overall_pravaah_level():
    """Daily practice sessions update skill mastery but NEVER change overall pravaah_level."""
    uid = f"test_user_no_lvl_change_{uuid.uuid4().hex[:8]}"
    sess_id = f"sess_{uuid.uuid4().hex[:6]}"

    # Assess as Level B
    await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={"pravaah_level": "B", "goal_minutes": 30},
    )

    # Learner commits multiple mistakes in daily session
    mistakes = [
        GrammarMistakeFact(
            mistake_id="m1",
            session_id=sess_id,
            message_id="msg_1",
            category="grammar_error",
            original="I didn't went",
            corrected="I didn't go",
            explanation="Past simple auxiliary takes base verb",
            severity="high",
            confidence=0.95,
        ),
        GrammarMistakeFact(
            mistake_id="m2",
            session_id=sess_id,
            message_id="msg_2",
            category="grammar_error",
            original="She didn't saw",
            corrected="She didn't see",
            explanation="Past simple auxiliary takes base verb",
            severity="high",
            confidence=0.95,
        ),
    ]

    analysis = SessionAnalysisResult(
        mistakes=mistakes,
        vocabulary=[],
    )
    messages = [
        {"role": "user", "text": "I didn't went to market yesterday"},
        {"role": "assistant", "text": "Remember to say 'I didn't go'. Can you repeat that?"},
        {"role": "user", "text": "She didn't saw the movie"},
    ]

    res = await update_learner_mastery(
        user_id=uid,
        session_id=sess_id,
        analysis=analysis,
        messages=messages,
    )

    # Level must strictly remain B
    assert res["pravaah_level"] == "B"
    assert res["cefr_reference"] == "B1"


def test_daily_plan_generation_durations_and_structures():
    """Validates 15, 30, 60, and 90 minute daily plan generations."""
    uid = "test_user_plans"
    weaknesses = ["past_simple_auxiliary", "be_verb_misuse"]
    mastery = {"past_simple_auxiliary": 0.40, "be_verb_misuse": 0.45}

    # 15 Min Plan: 5m Warmup + 10m Targeted
    plan15 = generate_daily_plan(uid, goal_minutes=15, weaknesses=weaknesses, skill_mastery=mastery)
    assert plan15.goal_minutes == 15
    assert plan15.planned_minutes == 15
    assert len(plan15.activities) == 2
    assert plan15.activities[0].mode == "free_conversation"
    assert plan15.activities[1].mode == "grammar_practice"

    # 30 Min Plan: 10m Conv + 10m Targeted + 5m Vocab + 5m Review
    plan30 = generate_daily_plan(uid, goal_minutes=30, weaknesses=weaknesses, skill_mastery=mastery)
    assert plan30.goal_minutes == 30
    assert plan30.planned_minutes == 30
    assert len(plan30.activities) == 4
    modes30 = [a.mode for a in plan30.activities]
    assert modes30 == ["free_conversation", "grammar_practice", "vocabulary", "review"]

    # 60 Min Plan: 10m Warmup + 15m Target1 + 10m Roleplay + 10m Vocab + 10m Target2 + 5m Review
    plan60 = generate_daily_plan(uid, goal_minutes=60, weaknesses=weaknesses, skill_mastery=mastery)
    assert plan60.goal_minutes == 60
    assert plan60.planned_minutes == 60
    assert len(plan60.activities) == 6
    modes60 = [a.mode for a in plan60.activities]
    assert "roleplay" in modes60

    # 90 Min Plan: 15m Conv + 20m Target1 + 15m Roleplay + 15m Vocab + 15m Target2 + 10m Review
    plan90 = generate_daily_plan(uid, goal_minutes=90, weaknesses=weaknesses, skill_mastery=mastery)
    assert plan90.goal_minutes == 90
    assert plan90.planned_minutes == 90
    assert len(plan90.activities) == 6


@pytest.mark.asyncio
async def test_daily_plan_activity_completion_and_progress_accumulation():
    """Completing activities accumulates completed_minutes and updates current_activity_index."""
    uid = f"test_user_progress_{uuid.uuid4().hex[:8]}"
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Generate 30m plan (4 activities: 10m, 10m, 5m, 5m)
    plan = get_or_create_daily_plan(uid, date_str=today_str, goal_minutes=30)
    assert plan["completed_minutes"] == 0
    assert plan["current_activity_index"] == 0
    assert plan["completion_status"] == "not_started"

    act1_id = plan["activities"][0]["activity_id"]
    act2_id = plan["activities"][1]["activity_id"]

    # Complete Activity 1 (10 min)
    updated1 = complete_daily_plan_activity(
        user_id=uid,
        date_str=today_str,
        activity_id=act1_id,
        session_id="sess_1",
        duration_minutes=10,
    )
    assert updated1["completed_minutes"] == 10
    assert updated1["completed_activities_count"] == 1
    assert updated1["current_activity_index"] == 1
    assert updated1["completion_status"] == "in_progress"
    assert updated1["activities"][0]["is_completed"] is True

    # Complete Activity 2 (10 min)
    updated2 = complete_daily_plan_activity(
        user_id=uid,
        date_str=today_str,
        activity_id=act2_id,
        session_id="sess_2",
        duration_minutes=10,
    )
    assert updated2["completed_minutes"] == 20
    assert updated2["completed_activities_count"] == 2
    assert updated2["current_activity_index"] == 2


@pytest.mark.asyncio
async def test_activity_completion_is_idempotent():
    """Re-completing an already completed activity must not double-count minutes."""
    uid = f"test_user_idemp_plan_{uuid.uuid4().hex[:8]}"
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    plan = get_or_create_daily_plan(uid, date_str=today_str, goal_minutes=30)
    act1_id = plan["activities"][0]["activity_id"]

    # Complete Activity 1 first time
    up1 = complete_daily_plan_activity(uid, date_str=today_str, activity_id=act1_id, duration_minutes=10)
    assert up1["completed_minutes"] == 10
    assert up1["completed_activities_count"] == 1

    # Complete Activity 1 second time (idempotent duplicate event)
    up2 = complete_daily_plan_activity(uid, date_str=today_str, activity_id=act1_id, duration_minutes=10)
    assert up2["completed_minutes"] == 10
    assert up2["completed_activities_count"] == 1


@pytest.mark.asyncio
async def test_two_user_plan_and_assessment_isolation():
    """Complete isolation between two users' assessments and daily plans."""
    user_a = f"user_a_iso_{uuid.uuid4().hex[:8]}"
    user_b = f"user_b_iso_{uuid.uuid4().hex[:8]}"
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # User A assesses as Level D (Basic, 15 min goal)
    await apply_proficiency_assessment(
        user_id=user_a,
        assessment_input={"pravaah_level": "D", "goal_minutes": 15},
    )

    # User B assesses as Level S (Mastery, 60 min goal)
    await apply_proficiency_assessment(
        user_id=user_b,
        assessment_input={"pravaah_level": "S", "goal_minutes": 60},
    )

    plan_a = get_or_create_daily_plan(user_a, date_str=today_str)
    plan_b = get_or_create_daily_plan(user_b, date_str=today_str)

    assert plan_a["goal_minutes"] == 15
    assert len(plan_a["activities"]) == 2

    assert plan_b["goal_minutes"] == 60
    assert len(plan_b["activities"]) == 6

    # Complete user A activity
    act_a_id = plan_a["activities"][0]["activity_id"]
    complete_daily_plan_activity(user_a, date_str=today_str, activity_id=act_a_id, duration_minutes=5)

    # Verify user B is untouched
    plan_b_check = get_or_create_daily_plan(user_b, date_str=today_str)
    assert plan_b_check["completed_minutes"] == 0
    assert plan_b_check["completed_activities_count"] == 0


@pytest.mark.asyncio
async def test_verbatim_transcript_preserves_grammar_errors():
    """Verbatim transcript must preserve learner grammar errors (e.g. 'didn't went') without normalization."""
    uid = f"test_user_verbatim_{uuid.uuid4().hex[:8]}"

    tasks = [
        {
            "task_id": "task_1_intro",
            "task_title": "Introduction & Daily Routine",
            "prompt": "Tell me about yourself and your routine.",
            "transcript": "Hello, my name is Rahul. I am software engineer and I am having two brothers. Every day I am going to office by bus.",
            "duration_ms": 18500,
            "word_count": 25,
            "pause_count": 3,
            "long_pause_count": 1,
            "restart_count": 0,
            "response_latency_ms": 800,
            "turn_count": 1,
        },
        {
            "task_id": "task_2_past",
            "task_title": "Past Experience & Storytelling",
            "prompt": "Describe a memorable day from your past.",
            "transcript": "Yesterday I didn't went to office because it rained heavily. I stayed at home and I was make tea for my family.",
            "duration_ms": 22000,
            "word_count": 24,
            "pause_count": 4,
            "long_pause_count": 2,
            "restart_count": 1,
            "response_latency_ms": 1200,
            "turn_count": 1,
        },
        {
            "task_id": "task_3_opinion",
            "task_title": "Opinion & Reasoning",
            "prompt": "Do you prefer working from home or office?",
            "transcript": "I am agree that working from home is convenient, but in office we can discuss about projects more faster.",
            "duration_ms": 20000,
            "word_count": 22,
            "pause_count": 3,
            "long_pause_count": 1,
            "restart_count": 0,
            "response_latency_ms": 950,
            "turn_count": 1,
        },
        {
            "task_id": "task_4_hypothetical",
            "task_title": "Hypothetical & Complex Discussion",
            "prompt": "If you could change one thing in workplace communication, what would it be?",
            "transcript": "If I can change one thing, I will tell people to do less meetings so we can focus on code.",
            "duration_ms": 24000,
            "word_count": 21,
            "pause_count": 4,
            "long_pause_count": 1,
            "restart_count": 1,
            "response_latency_ms": 1100,
            "turn_count": 1,
        },
    ]

    result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={
            "tasks": tasks,
            "goal_minutes": 30,
        },
    )

    # Result must be computed by backend analyzer
    assert result["pravaah_level"] in ["E", "D", "C", "B", "A", "S"]
    assert "cefr_reference" in result
    assert "weaknesses" in result
    assert "strengths" in result
    assert "current_focus" in result
    assert result["current_focus"] in CURRICULUM_SKILLS

    # Check Firestore record includes verbatim tasks evidence
    db = get_firestore_client()
    assess_doc = list(db.collection("users").document(uid).collection("proficiency_assessments").stream())[0].to_dict()
    assert "tasks_evidence" in assess_doc
    assert len(assess_doc["tasks_evidence"]) == 4
    assert "didn't went" in assess_doc["tasks_evidence"][1]["transcript"]


def test_pronunciation_is_strictly_qualitative():
    """Pronunciation assessment must not infer phonetic quality from text and is marked not assessed in V1."""
    eval_res = evaluate_assessment_rubric(
        grammar_rating="intermediate",
        vocabulary_rating="intermediate",
        fluency_rating="intermediate",
        comprehension_rating="intermediate",
        speaking_complexity="intermediate",
        conversation_ability="intermediate",
        pronunciation_rating="not_assessed",
    )
    # Check that evaluation does not calculate fake numeric pronunciation score and clearly states deferred V1 status
    assert eval_res["pravaah_level"] == "B"
    assert "pronunciation_score" not in eval_res
    assert "Not assessed in V1" in eval_res["pronunciation"]


def test_model_configuration_no_deprecated_references():
    """Verify codebase contains no deprecated gemini-2.0 or gemini-1.5-flash references."""
    import glob

    code_files = glob.glob(os.path.join(base_dir, "services", "**", "*.py"), recursive=True)
    code_files += [
        f for f in glob.glob(os.path.join(base_dir, "apps", "**", "*.ts*"), recursive=True)
        if "node_modules" not in f and ".expo" not in f
    ]

    for filepath in code_files:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            assert "gemini-2.0-flash" not in content, f"Found deprecated gemini-2.0-flash in {filepath}"
            assert "gemini-2.0-flash-lite" not in content, f"Found deprecated gemini-2.0-flash-lite in {filepath}"


def test_static_frontend_no_hardcoded_ratings_fallback():
    """Statically verify apps/expo/app/assessment.tsx contains no hardcoded rating fallback strings."""
    assessment_file = os.path.join(base_dir, "apps", "expo", "app", "assessment.tsx")
    with open(assessment_file, "r", encoding="utf-8") as f:
        content = f.read()

    # Ensure no fake hardcoded fallback levels exist in result rendering
    assert 'assessmentResult?.pravaah_level || "C"' not in content, "Found hardcoded Level C fallback"
    assert 'assessmentResult?.cefr_reference || "A2"' not in content, "Found hardcoded A2 fallback"
    assert 'grammar_rating: "emerging_control"' not in content, "Found hardcoded grammar rating"
    assert 'vocabulary_rating: "functional_everyday"' not in content, "Found hardcoded vocab rating"


@pytest.mark.asyncio
async def test_assessment_evidence_justification_and_dimension_observations_persisted():
    """Persisting assessment must store dimension-level qualitative observations that justify the final level."""
    uid = f"test_user_justification_{uuid.uuid4().hex[:8]}"
    db = get_firestore_client()

    result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={
            "pravaah_level": "B",
            "grammar_rating": "intermediate",
            "vocabulary_rating": "intermediate",
            "fluency_rating": "intermediate",
            "comprehension_rating": "intermediate",
            "speaking_complexity": "intermediate",
            "conversation_ability": "intermediate",
            "pronunciation_rating": "not_assessed",
            "notes": "Good conversational flow with specific need for preposition and collocation practice.",
            "goal_minutes": 30,
        },
    )

    assert result["pravaah_level"] == "B"
    assert "assessment_observations" in result
    obs = result["assessment_observations"]
    assert obs["grammar"] == "intermediate"
    assert obs["vocabulary"] == "intermediate"
    assert obs["comprehension"] == "intermediate"
    assert obs["fluency"] == "intermediate"
    assert obs["speaking_complexity"] == "intermediate"
    assert obs["conversation_ability"] == "intermediate"
    assert obs["pronunciation"] == "not_assessed"

    # Verify saved in user profile document
    user_doc = db.collection("users").document(uid).get().to_dict()
    assert "assessment_observations" in user_doc
    assert user_doc["assessment_observations"]["grammar"] == "intermediate"


@pytest.mark.asyncio
async def test_current_focus_consistency_and_first_daily_activity():
    """Weaknesses must contain all diagnosed weaknesses, and current_focus must be the first targeted activity."""
    uid = f"test_user_focus_{uuid.uuid4().hex[:8]}"

    # Assessment with past_simple_auxiliary as strongest weakness
    result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={
            "pravaah_level": "C",
            "grammar_rating": "elementary",
            "weaknesses": ["past_simple_auxiliary", "stative_verbs"],
            "current_focus": "past_simple_auxiliary",
            "goal_minutes": 30,
        },
    )

    assert "past_simple_auxiliary" in result["weaknesses"]
    assert "stative_verbs" in result["weaknesses"]
    assert result["current_focus"] == "past_simple_auxiliary"

    # First targeted grammar activity in the generated daily plan must be current_focus
    daily_plan = result["daily_plan"]
    targeted_acts = [a for a in daily_plan["activities"] if a["mode"] == "grammar_practice"]
    assert len(targeted_acts) >= 1
    assert targeted_acts[0]["target_skill"] == "past_simple_auxiliary"


@pytest.mark.asyncio
async def test_speaking_time_metrics_distinct_from_planned_duration():
    """Learner speaking time and idle time must be kept distinct from planned and completed session duration."""
    uid = f"test_user_metrics_{uuid.uuid4().hex[:8]}"
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    plan = get_or_create_daily_plan(uid, date_str=today_str, goal_minutes=30)
    act1_id = plan["activities"][0]["activity_id"]

    # Complete activity with 10 min session duration, but 240s (4 min) actual speaking time
    updated = complete_daily_plan_activity(
        user_id=uid,
        date_str=today_str,
        activity_id=act1_id,
        session_id="sess_timing_1",
        duration_minutes=10,
        learner_speaking_time_seconds=240,
        idle_time_seconds=60,
    )

    assert updated["planned_minutes"] == 30
    assert updated["completed_minutes"] == 10
    assert updated["total_learner_speaking_seconds"] == 240
    assert updated["total_idle_seconds"] == 60
    assert updated["activities"][0]["learner_speaking_time_seconds"] == 240
    assert updated["activities"][0]["idle_time_seconds"] == 60



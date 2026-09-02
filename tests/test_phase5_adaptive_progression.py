"""
Phase 5 Test Suite: Adaptive Learning & Lesson Progression

Tests:
1. test_selecting_lowest_meaningful_weakness
2. test_avoiding_recently_completed_skill_when_other_skill_weaker
3. test_keeping_skill_active_when_mastery_remains_low
4. test_advancing_lesson_stage_after_successful_practice
5. test_varying_practice_prompts
6. test_mastered_skill_receiving_occasional_review
7. test_recurring_failure_causing_earlier_review
8. test_exact_mastery_threshold_behavior
9. test_no_automatic_overall_pravaah_level_change
10. test_two_user_adaptive_isolation
"""

import asyncio
import os
import sys
import uuid
import pytest
from datetime import datetime, timezone

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import (
    CURRICULUM_SKILLS,
    MASTERY_BANDS,
    LESSON_STAGES,
    determine_lesson_stage,
    get_varied_practice_activity,
    select_next_adaptive_skill,
    generate_personalized_lesson,
)
from worker import (
    get_firestore_client,
    update_learner_mastery,
    GrammarMistakeFact,
    SessionAnalysisResult,
)


@pytest.mark.asyncio
async def test_selecting_lowest_meaningful_weakness():
    """Selects the skill with the lowest mastery score and active error evidence."""
    skill_mastery = {
        "past_simple_auxiliary": 0.38,
        "stative_verbs": 0.72,
        "articles": 0.85,
    }
    skill_stats = {
        "past_simple_auxiliary": {"attempts": 2, "errors": 2, "failed_repetitions": 0, "last_session_index": 1},
        "stative_verbs": {"attempts": 3, "errors": 0, "failed_repetitions": 0, "last_session_index": 2},
        "articles": {"attempts": 4, "errors": 0, "failed_repetitions": 0, "last_session_index": 3},
    }

    selected_skill, stage, reason = select_next_adaptive_skill(
        skill_mastery,
        skill_stats=skill_stats,
        session_count=3,
    )

    assert selected_skill == "past_simple_auxiliary"
    assert stage == "guided_practice"
    assert reason == "active_weakness"


@pytest.mark.asyncio
async def test_avoiding_recently_completed_skill_when_other_skill_weaker():
    """If a skill was just practiced and improved, switches to another weak skill for variety."""
    skill_mastery = {
        "past_simple_auxiliary": 0.62,  # just practiced and improved
        "be_verb_misuse": 0.40,         # still weak
        "prepositions": 0.78,
    }
    skill_stats = {
        "past_simple_auxiliary": {"attempts": 4, "errors": 1, "failed_repetitions": 0, "last_session_index": 2},
        "be_verb_misuse": {"attempts": 2, "errors": 2, "failed_repetitions": 0, "last_session_index": 1},
        "prepositions": {"attempts": 3, "errors": 0, "failed_repetitions": 0, "last_session_index": 2},
    }

    selected_skill, stage, reason = select_next_adaptive_skill(
        skill_mastery,
        skill_stats=skill_stats,
        just_completed_skill="past_simple_auxiliary",
        session_count=2,
    )

    assert selected_skill == "be_verb_misuse"
    assert stage == "guided_practice"
    assert reason == "active_weakness"


@pytest.mark.asyncio
async def test_keeping_skill_active_when_mastery_remains_low():
    """If mastery remains low and it is still the primary weakness, continues the skill with varied prompt."""
    skill_mastery = {
        "past_simple_auxiliary": 0.35,
        "stative_verbs": 0.80,
    }
    skill_stats = {
        "past_simple_auxiliary": {"attempts": 2, "errors": 2, "failed_repetitions": 0, "last_session_index": 1},
        "stative_verbs": {"attempts": 3, "errors": 0, "failed_repetitions": 0, "last_session_index": 1},
    }

    selected_skill, stage, reason = select_next_adaptive_skill(
        skill_mastery,
        skill_stats=skill_stats,
        just_completed_skill="past_simple_auxiliary",
        session_count=1,
    )

    assert selected_skill == "past_simple_auxiliary"
    assert stage == "guided_practice"


@pytest.mark.asyncio
async def test_advancing_lesson_stage_after_successful_practice():
    """Stage advances logically from introduction to guided practice to conversational practice to review."""
    # 1. Introduction stage (< 0.35 or 0 attempts)
    assert determine_lesson_stage(0.25, attempts=0) == "introduction"
    assert determine_lesson_stage(0.30, attempts=1) == "introduction"

    # 2. Guided practice stage (0.35 - 0.60)
    assert determine_lesson_stage(0.42, attempts=2) == "guided_practice"
    assert determine_lesson_stage(0.58, attempts=3) == "guided_practice"

    # 3. Conversational practice stage (0.60 - 0.85)
    assert determine_lesson_stage(0.65, attempts=4) == "conversational_practice"
    assert determine_lesson_stage(0.80, attempts=5) == "conversational_practice"

    # 4. Review stage (>= 0.85)
    assert determine_lesson_stage(0.90, attempts=6) == "review"
    assert determine_lesson_stage(0.95, attempts=8) == "review"


@pytest.mark.asyncio
async def test_varying_practice_prompts():
    """Consecutive lessons for the same skill do not produce identical prompts."""
    skill_id = "past_simple_auxiliary"

    # Prompt 1
    prompt_1 = get_varied_practice_activity(skill_id, stage="guided_practice", attempt_count=0, previous_prompts=[])
    # Prompt 2 avoids prompt 1
    prompt_2 = get_varied_practice_activity(skill_id, stage="guided_practice", attempt_count=1, previous_prompts=[prompt_1])
    # Prompt 3 avoids prompt 1 and 2
    prompt_3 = get_varied_practice_activity(skill_id, stage="guided_practice", attempt_count=2, previous_prompts=[prompt_1, prompt_2])

    assert prompt_1 != prompt_2
    assert prompt_2 != prompt_3
    assert prompt_1 != prompt_3


@pytest.mark.asyncio
async def test_mastered_skill_receiving_occasional_review():
    """A mastered skill that hasn't been practiced for several sessions is scheduled for review."""
    skill_mastery = {
        "past_simple_auxiliary": 0.92,
        "past_simple": 0.88,
    }
    skill_stats = {
        "past_simple_auxiliary": {"attempts": 6, "errors": 0, "failed_repetitions": 0, "last_session_index": 1},
        "past_simple": {"attempts": 5, "errors": 0, "failed_repetitions": 0, "last_session_index": 5},
    }

    # User is currently on session 6 (past_simple_auxiliary not seen for 5 sessions)
    selected_skill, stage, reason = select_next_adaptive_skill(
        skill_mastery,
        skill_stats=skill_stats,
        session_count=6,
    )

    assert selected_skill == "past_simple_auxiliary"
    assert stage == "review"
    assert reason == "spaced_review_due"


@pytest.mark.asyncio
async def test_recurring_failure_causing_earlier_review():
    """Recurring repetition failures fast-track a skill back to immediate review/practice."""
    skill_mastery = {
        "past_simple_auxiliary": 0.88,
        "articles": 0.90,
    }
    skill_stats = {
        "past_simple_auxiliary": {"attempts": 5, "errors": 1, "failed_repetitions": 2, "last_session_index": 3},
        "articles": {"attempts": 6, "errors": 0, "failed_repetitions": 0, "last_session_index": 1},
    }

    selected_skill, stage, reason = select_next_adaptive_skill(
        skill_mastery,
        skill_stats=skill_stats,
        session_count=4,
    )

    assert selected_skill == "past_simple_auxiliary"
    assert stage == "review"
    assert reason == "recurring_failure_review"


@pytest.mark.asyncio
async def test_exact_mastery_threshold_behavior():
    """Validates the exact mastery thresholds for active weakness, developing, strong, and mastered."""
    assert MASTERY_BANDS["weakness"] == 0.60
    assert MASTERY_BANDS["developing"] == 0.75
    assert MASTERY_BANDS["strong"] == 0.90
    assert MASTERY_BANDS["mastered"] == 1.00


@pytest.mark.asyncio
async def test_no_automatic_overall_pravaah_level_change():
    """Daily adaptive practice does not alter the user's overall pravaah_level or cefr_reference."""
    db = get_firestore_client()
    uid = f"test_phase5_level_preserve_{uuid.uuid4().hex[:6]}"
    session_id = f"sess_p5_level_{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc)

    user_ref = db.collection("users").document(uid)
    user_ref.set({
        "uid": uid,
        "pravaah_level": "unassessed",
        "cefr_reference": "unassessed",
        "current_focus": "past_simple_auxiliary",
        "skill_mastery": {"past_simple_auxiliary": 0.42},
    })
    user_ref.collection("sessions").document(session_id).set({
        "session_id": session_id,
        "start_time": now,
        "duration_seconds": 60,
    })

    messages = [
        {"role": "user", "sequence": 1, "text": "Yesterday I didn't went.", "message_id": f"{session_id}_m1"},
        {"role": "assistant", "sequence": 2, "text": "Say 'I didn't go.'", "message_id": f"{session_id}_m2"},
        {"role": "user", "sequence": 3, "text": "I didn't go.", "message_id": f"{session_id}_m3"},
    ]
    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=session_id,
                message_id=f"{session_id}_m1",
            )
        ]
    )

    profile = await update_learner_mastery(uid, session_id, analysis, messages)

    assert profile["pravaah_level"] == "unassessed"
    assert profile["cefr_reference"] == "unassessed"
    # Skill mastery updated
    assert profile["skill_mastery"]["past_simple_auxiliary"] == 0.46
    # Adaptive recommended lesson created
    assert "recommended_lesson" in profile
    assert profile["recommended_lesson"]["target_skill_id"] == "past_simple_auxiliary"
    assert profile["recommended_lesson"]["stage"] == "guided_practice"


@pytest.mark.asyncio
async def test_two_user_adaptive_isolation():
    """Adaptive progression for user A never influences the recommendations or stages for user B."""
    db = get_firestore_client()
    uid_a = f"test_p5_user_a_{uuid.uuid4().hex[:6]}"
    uid_b = f"test_p5_user_b_{uuid.uuid4().hex[:6]}"
    sess_a = f"sess_a_{uuid.uuid4().hex[:6]}"
    sess_b = f"sess_b_{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc)

    # User A: weak on past_simple_auxiliary
    db.collection("users").document(uid_a).set({
        "uid": uid_a,
        "pravaah_level": "unassessed",
        "current_focus": "past_simple_auxiliary",
        "skill_mastery": {"past_simple_auxiliary": 0.35, "stative_verbs": 0.85},
    })
    db.collection("users").document(uid_a).collection("sessions").document(sess_a).set({
        "session_id": sess_a,
        "start_time": now,
        "duration_seconds": 60,
    })

    # User B: weak on stative_verbs
    db.collection("users").document(uid_b).set({
        "uid": uid_b,
        "pravaah_level": "unassessed",
        "current_focus": "stative_verbs",
        "skill_mastery": {"past_simple_auxiliary": 0.88, "stative_verbs": 0.38},
    })
    db.collection("users").document(uid_b).collection("sessions").document(sess_b).set({
        "session_id": sess_b,
        "start_time": now,
        "duration_seconds": 60,
    })

    prof_a = await update_learner_mastery(uid_a, sess_a, SessionAnalysisResult(mistakes=[]), [])
    prof_b = await update_learner_mastery(uid_b, sess_b, SessionAnalysisResult(mistakes=[]), [])

    assert prof_a["current_focus"] == "past_simple_auxiliary"
    assert prof_b["current_focus"] == "stative_verbs"
    assert prof_a["recommended_lesson"]["target_skill_id"] == "past_simple_auxiliary"
    assert prof_b["recommended_lesson"]["target_skill_id"] == "stative_verbs"

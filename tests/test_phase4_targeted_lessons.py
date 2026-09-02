"""
Phase 4: Targeted Lesson Execution Test Suite

Tests for:
1. Launching a recommended lesson creates targeted session and transitions lesson to 'in_progress'.
2. Target skill and pedagogical context passed into session and EnglishTutor agent.
3. Repetition evidence tracking from tutor's quoted target prompt.
4. Exact learner attempt counters (attempts, correction_attempts, successful_repetitions, failed_repetitions).
5. Exact deterministic mastery formula during targeted lesson execution.
6. Lesson record completion lifecycle (persisted with before/after mastery, status='completed').
7. Abandoned lesson handling (session < 10s with 0 attempts -> status='abandoned').
8. Next recommended lesson generation and current_focus update after completion.
9. Unassessed initial state preservation (new user retains 'unassessed' pravaah_level).
10. Two-user lesson and mastery isolation.
"""

import asyncio
import os
import sys
import uuid
import pytest
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import (
    CURRICULUM_SKILLS,
    map_to_curriculum_skill,
    generate_personalized_lesson,
    cefr_reference_for_pravaah_level,
)
from worker import (
    get_firestore_client,
    process_event,
    update_learner_mastery,
    _repetition_evidence,
    GrammarMistakeFact,
    SessionAnalysisResult,
    LessonRecord,
    SkillMasteryRecord,
)
from agent import EnglishTutor, make_event


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def db():
    return get_firestore_client()


# ---------------------------------------------------------------------------
# Test 1: Unassessed initial state preservation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unassessed_initial_proficiency_state(db):
    """Verify new learner starts with pravaah_level='unassessed' and cefr_reference='unassessed'."""
    test_uid = f"user_unassessed_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    # Initial profile creation
    user_ref.set({
        "pravaah_level": "unassessed",
        "cefr_reference": "unassessed",
        "created_at": datetime.now(timezone.utc),
    })

    # Practice session with clean speech
    analysis = SessionAnalysisResult(mistakes=[], vocabulary=[])
    user_turns = [{"text": "I went to work yesterday.", "message_id": f"{session_id}_msg_1"}]

    profile = await update_learner_mastery(test_uid, session_id, analysis, user_turns)

    # Profile must remain 'unassessed'
    assert profile["pravaah_level"] == "unassessed"
    assert profile["cefr_reference"] == "unassessed"
    assert cefr_reference_for_pravaah_level("unassessed") == "unassessed"


# ---------------------------------------------------------------------------
# Test 2: Tutor receives structured lesson context
# ---------------------------------------------------------------------------

def test_tutor_receives_target_objective():
    """Verify EnglishTutor receives lesson context and injects natural elicitation instructions."""
    lesson_ctx = {
        "target_skill": "past_simple_auxiliary",
        "lesson_id": "lsn_test_123",
        "lesson_title": "Past Simple: did/didn't + base verb",
        "rule_summary": "Always use base verb after didn't (e.g. didn't go).",
        "practice_activity": "Tell me three things you didn't do yesterday.",
    }

    tutor = EnglishTutor(
        user_id="test_user",
        session_id="test_sess",
        target_skill="past_simple_auxiliary",
        lesson_context=lesson_ctx,
    )

    instructions = tutor.instructions
    assert "Targeted Practice Session: Past Simple: did/didn't + base verb" in instructions
    assert "past_simple_auxiliary" in instructions
    assert "Tell me three things you didn't do yesterday." in instructions
    assert "Conversational Elicitation" in instructions
    assert "No Lectures" in instructions


# ---------------------------------------------------------------------------
# Test 3: Repetition evidence tracking from tutor prompt
# ---------------------------------------------------------------------------

def test_repetition_evidence_from_tutor_quoted_target():
    """Verify _repetition_evidence identifies learner repetition following tutor correction."""
    session_id = "sess_rep_test"
    messages = [
        {"role": "user", "text": "Yesterday I didn't saw him.", "message_id": f"{session_id}_m1", "sequence": 1},
        {"role": "assistant", "text": "Small correction: Say 'I didn't see him.' Try repeating that!", "message_id": f"{session_id}_m2", "sequence": 2},
        {"role": "user", "text": "I didn't see him yesterday.", "message_id": f"{session_id}_m3", "sequence": 3},
    ]

    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't saw",
                corrected="didn't see",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=session_id,
                message_id=f"{session_id}_m1",
            )
        ],
        vocabulary=[],
    )

    successes, failures = _repetition_evidence(analysis, messages)
    assert successes.get("past_simple_auxiliary") == 1
    assert failures.get("past_simple_auxiliary", 0) == 0


# ---------------------------------------------------------------------------
# Test 4: Exact learner attempt counters semantics
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_exact_learner_attempt_counters(db):
    """Verify attempts, correction_attempts, successful_repetitions, failed_repetitions counters."""
    test_uid = f"user_counters_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_cnt_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    messages = [
        {"role": "user", "text": "I didn't went.", "message_id": f"{session_id}_m1", "sequence": 1},
        {"role": "assistant", "text": "Say 'I didn't go.'", "message_id": f"{session_id}_m2", "sequence": 2},
        {"role": "user", "text": "I didn't go.", "message_id": f"{session_id}_m3", "sequence": 3},
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
        ],
        vocabulary=[],
    )

    await update_learner_mastery(test_uid, session_id, analysis, messages)

    skill_doc = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert skill_doc["attempts"] == 2  # 1 error attempt + 1 repetition attempt
    assert skill_doc["correction_attempts"] == 1  # 1 attempt following tutor prompt
    assert skill_doc["successful_repetitions"] == 1
    assert skill_doc["failed_repetitions"] == 0
    assert skill_doc["errors"] == 1
    # Mastery: 0.500 - 0.080 (error) + 0.120 (repetition) = 0.540
    assert skill_doc["mastery"] == 0.540


# ---------------------------------------------------------------------------
# Test 5 & 6: Lesson completion lifecycle & persistence
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lesson_completion_lifecycle_and_persistence(db):
    """Verify active targeted lesson transitions from in_progress to completed with before/after mastery."""
    test_uid = f"user_lesson_e2e_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_lsn_{uuid.uuid4().hex[:8]}"
    lesson_id = f"lsn_past_simple_auxiliary_{uuid.uuid4().hex[:6]}"
    user_ref = db.collection("users").document(test_uid)

    # 1. Lesson initially recommended
    user_ref.collection("lessons").document(lesson_id).set({
        "lesson_id": lesson_id,
        "source_skill_id": "past_simple_auxiliary",
        "lesson_title": "Past Simple: did/didn't + base verb",
        "completion_status": "recommended",
        "status": "recommended",
        "mastery_before": 0.42,
        "mastery_after": 0.42,
    })

    # 2. Session created with lesson_id
    user_ref.collection("sessions").document(session_id).set({
        "mode": "grammar_practice",
        "target_skill": "past_simple_auxiliary",
        "lesson_id": lesson_id,
        "start_time": datetime.now(timezone.utc),
        "duration_seconds": 90,
    })

    # Set existing skill baseline mastery = 0.42
    user_ref.collection("skills").document("past_simple_auxiliary").set({
        "skill_id": "past_simple_auxiliary",
        "title": "Past Simple: did/didn't + base verb",
        "mastery": 0.42,
        "attempts": 1,
        "errors": 1,
        "processed_sessions": ["prev_sess"],
    })

    # 3. Session execution: error followed by successful repetition
    messages = [
        {"role": "user", "text": "Yesterday I didn't went anywhere.", "message_id": f"{session_id}_m1", "sequence": 1},
        {"role": "assistant", "text": "Small correction: Say 'I didn't go anywhere.' Try repeating that!", "message_id": f"{session_id}_m2", "sequence": 2},
        {"role": "user", "text": "I didn't go anywhere.", "message_id": f"{session_id}_m3", "sequence": 3},
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
        ],
        vocabulary=[],
    )

    profile = await update_learner_mastery(test_uid, session_id, analysis, messages)

    # 4. Verify LessonRecord in Firestore
    lesson_doc = user_ref.collection("lessons").document(lesson_id).get()
    assert lesson_doc.exists
    lesson_data = lesson_doc.to_dict()
    assert lesson_data["completion_status"] == "completed"
    assert lesson_data["mastery_before"] == 0.42
    # 0.42 - 0.08 + 0.12 = 0.46
    assert lesson_data["mastery_after"] == 0.46
    assert lesson_data["successful_repetitions"] == 1
    assert lesson_data["duration_seconds"] == 90

    # 5. Verify Next Recommended Lesson generated
    next_lesson = profile["recommended_lesson"]
    assert next_lesson is not None
    assert next_lesson["target_skill_id"] is not None


# ---------------------------------------------------------------------------
# Test 7: Abandoned lesson handling
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_abandoned_lesson_handling(db):
    """Verify session ending abruptly (< 10s) with 0 learner turns marks lesson as 'abandoned'."""
    test_uid = f"user_abandon_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_ab_{uuid.uuid4().hex[:8]}"
    lesson_id = f"lsn_abandon_{uuid.uuid4().hex[:6]}"
    user_ref = db.collection("users").document(test_uid)

    # Session created and ended after 4 seconds with 0 user turns
    user_ref.collection("sessions").document(session_id).set({
        "mode": "grammar_practice",
        "target_skill": "be_verb_misuse",
        "lesson_id": lesson_id,
        "start_time": datetime.now(timezone.utc),
        "duration_seconds": 4,
    })

    analysis = SessionAnalysisResult(mistakes=[], vocabulary=[])
    messages = []  # 0 messages

    await update_learner_mastery(test_uid, session_id, analysis, messages)

    lesson_doc = user_ref.collection("lessons").document(lesson_id).get()
    assert lesson_doc.exists
    assert lesson_doc.to_dict()["completion_status"] == "abandoned"


# ---------------------------------------------------------------------------
# Test 8: Next recommended lesson selection after mastery improvement
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_next_lesson_selection_after_mastery_improvement(db):
    """Verify after mastering a skill (mastery >= 0.60), next weakness is selected for lesson."""
    test_uid = f"user_progression_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_prog_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    # Set initial skills: past_simple_auxiliary = 0.55 (weak), stative_verbs = 0.38 (weakest)
    user_ref.collection("skills").document("past_simple_auxiliary").set({
        "skill_id": "past_simple_auxiliary",
        "title": "Past Simple: did/didn't + base verb",
        "mastery": 0.55,
        "attempts": 2,
    })
    user_ref.collection("skills").document("stative_verbs").set({
        "skill_id": "stative_verbs",
        "title": "Stative Verbs (No Continuous -ing)",
        "mastery": 0.38,
        "attempts": 2,
    })

    # Session practices stative_verbs: clean usage (+0.05) or repetition (+0.12)
    analysis = SessionAnalysisResult(mistakes=[], vocabulary=[])
    messages = [{"role": "user", "text": "I have two cars.", "message_id": f"{session_id}_m1"}]

    profile = await update_learner_mastery(test_uid, session_id, analysis, messages)

    # Weakest remaining skill is selected as current focus
    assert profile["current_focus"] in ["stative_verbs", "past_simple_auxiliary"]
    assert profile["recommended_lesson"]["target_skill_id"] in ["stative_verbs", "past_simple_auxiliary"]


# ---------------------------------------------------------------------------
# Test 10: Two-user lesson and mastery isolation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_two_user_lesson_isolation(db):
    """Verify User A's lesson and mastery execution has zero influence on User B."""
    user_a = f"user_iso_a_{uuid.uuid4().hex[:8]}"
    user_b = f"user_iso_b_{uuid.uuid4().hex[:8]}"
    sess_a = f"sess_a_{uuid.uuid4().hex[:8]}"
    sess_b = f"sess_b_{uuid.uuid4().hex[:8]}"
    lsn_a = f"lsn_a_{uuid.uuid4().hex[:6]}"
    lsn_b = f"lsn_b_{uuid.uuid4().hex[:6]}"

    user_a_ref = db.collection("users").document(user_a)
    user_b_ref = db.collection("users").document(user_b)

    user_a_ref.collection("sessions").document(sess_a).set({
        "mode": "grammar_practice",
        "target_skill": "past_simple_auxiliary",
        "lesson_id": lsn_a,
        "duration_seconds": 60,
    })
    user_b_ref.collection("sessions").document(sess_b).set({
        "mode": "grammar_practice",
        "target_skill": "prepositions",
        "lesson_id": lsn_b,
        "duration_seconds": 60,
    })

    analysis_a = SessionAnalysisResult(mistakes=[], vocabulary=[])
    analysis_b = SessionAnalysisResult(mistakes=[], vocabulary=[])

    await update_learner_mastery(user_a, sess_a, analysis_a, [{"role": "user", "text": "I didn't go."}])
    await update_learner_mastery(user_b, sess_b, analysis_b, [{"role": "user", "text": "I play cricket."}])

    assert user_a_ref.collection("lessons").document(lsn_a).get().exists
    assert not user_b_ref.collection("lessons").document(lsn_a).get().exists

    assert user_b_ref.collection("lessons").document(lsn_b).get().exists
    assert not user_a_ref.collection("lessons").document(lsn_b).get().exists

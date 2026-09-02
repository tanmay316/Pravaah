"""
Phase 3C Mastery & Memory Test Suite (Updated with Clarifications & Real Event Integration)

Tests for:
1. First occurrence of a skill initializes baseline state.
2. Repeated error aggregation with exact formula (-0.08 per error).
3. Successful correction increasing mastery (+0.12 per successful repetition).
4. Exact deterministic mastery formula values (isolated vs combined).
5. Correct English not lowering mastery (+0.05 clean usage reward).
6. Natural alternative not counting as error (0 penalty).
7. Multiple distinct error examples mapping to one skill (didn't went, didn't saw, didn't bought).
8. Repeated session analysis idempotency (0 double-counting).
9. Two-user mastery isolation.
10. Curriculum mapping for Hindi-speaker patterns.
11. Personalized next lesson selection & current_focus tracking.
12. CEFR level preservation (A2 learner + mistakes remains A2).
13. Attempts semantics (learner attempts only).
14. Real event integration (tutor events -> learning engine -> mastery -> idempotency).
"""

import asyncio
import os
import sys
import uuid
import pytest

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import (
    CURRICULUM_SKILLS,
    map_to_curriculum_skill,
    generate_personalized_lesson,
)
from worker import (
    get_firestore_client,
    process_event,
    analyze_session_messages,
    update_learner_mastery,
    GrammarMistakeFact,
    VocabularyOpportunityFact,
    SessionAnalysisResult,
    ProficiencyAssessment,
    apply_proficiency_assessment,
)
from agent import make_event


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def db():
    return get_firestore_client()


# ---------------------------------------------------------------------------
# Test 10: Curriculum Mapping
# ---------------------------------------------------------------------------

def test_curriculum_mapping():
    """Verify standard Hindi-speaker error patterns map to the correct curriculum skills."""
    # 1. Past simple auxiliary
    assert map_to_curriculum_skill("past_tense", "I didn't went there.") == "past_simple_auxiliary"
    assert map_to_curriculum_skill("grammar", "I didn't saw him yesterday.") == "past_simple_auxiliary"
    assert map_to_curriculum_skill("grammar", "I didn't bought any milk.") == "past_simple_auxiliary"

    # 2. Be verb misuse
    assert map_to_curriculum_skill("verbs", "I am agree with you.") == "be_verb_misuse"

    # 3. Stative verbs
    assert map_to_curriculum_skill("stative_verbs", "I am having two cars.") == "stative_verbs"
    assert map_to_curriculum_skill("verbs", "She is knowing the answer.") == "stative_verbs"

    # 4. Subject-verb agreement
    assert map_to_curriculum_skill("agreement", "He don't like coffee.") == "subject_verb_agreement"

    # 5. Prepositions
    assert map_to_curriculum_skill("prepositions", "Let's discuss about this topic.") == "prepositions"
    assert map_to_curriculum_skill("prepositions", "I play with cricket.") == "prepositions"

    # 6. Collocations / Vocabulary error
    assert map_to_curriculum_skill("collocations", "I made a party yesterday.") == "collocations"
    assert map_to_curriculum_skill("vocabulary", "I have one doubt about this.") == "collocations"

    # 7. Past simple regular/irregular
    assert map_to_curriculum_skill("past_tense", "Yesterday I go to market.") == "past_simple"


# ---------------------------------------------------------------------------
# Test 7: Multiple distinct error examples map to one skill
# ---------------------------------------------------------------------------

def test_multiple_examples_mapping_to_one_skill():
    """Verify 'didn't went', 'didn't saw', 'didn't bought' all contribute to past_simple_auxiliary."""
    examples = [
        "I didn't went to school.",
        "I didn't saw the movie.",
        "I didn't bought the car.",
    ]
    for ex in examples:
        skill = map_to_curriculum_skill("grammar", ex)
        assert skill == "past_simple_auxiliary", f"Expected 'past_simple_auxiliary' for '{ex}', got '{skill}'"


# ---------------------------------------------------------------------------
# Test 1 & 2: First occurrence & Repeated error aggregation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_first_occurrence_and_repeated_error_aggregation(db):
    """Verify first error creates skill record with penalty (-0.08), and repeated errors aggregate."""
    test_uid = f"test_user_mastery_{uuid.uuid4().hex[:8]}"
    session_1 = f"sess_{uuid.uuid4().hex[:8]}"
    session_2 = f"sess_{uuid.uuid4().hex[:8]}"

    user_ref = db.collection("users").document(test_uid)

    # Session 1: 1 error on past_simple_auxiliary
    analysis_1 = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I didn't went",
                corrected="I didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=session_1,
                message_id=f"{session_1}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns_1 = [{"text": "I didn't went yesterday.", "message_id": f"{session_1}_seq_0001_user"}]

    await update_learner_mastery(test_uid, session_1, analysis_1, user_turns_1)

    # Check Firestore skill document
    skill_doc_1 = user_ref.collection("skills").document("past_simple_auxiliary").get()
    assert skill_doc_1.exists
    data_1 = skill_doc_1.to_dict()
    assert data_1["attempts"] == 1
    assert data_1["errors"] == 1
    assert data_1["mastery"] == 0.42  # 0.50 - 0.08 = 0.42
    assert "I didn't went" in data_1["examples"]

    # Session 2: Second error on past_simple_auxiliary ("I didn't saw")
    analysis_2 = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I didn't saw",
                corrected="I didn't see",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=session_2,
                message_id=f"{session_2}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns_2 = [{"text": "I didn't saw him.", "message_id": f"{session_2}_seq_0001_user"}]

    await update_learner_mastery(test_uid, session_2, analysis_2, user_turns_2)

    skill_doc_2 = user_ref.collection("skills").document("past_simple_auxiliary").get()
    data_2 = skill_doc_2.to_dict()
    assert data_2["attempts"] == 2
    assert data_2["errors"] == 2
    assert data_2["mastery"] == 0.34  # 0.42 - 0.08 = 0.34
    assert len(data_2["examples"]) == 2


# ---------------------------------------------------------------------------
# Test 4: Exact deterministic mastery formula values
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_mastery_formula_exact_deterministic_values(db):
    """Verify exact formula values: isolated error = -0.08, isolated correction = +0.12, combined = +0.04."""
    test_uid = f"test_user_formula_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    # 1. Baseline: starts at 0.500
    # 2. Session A: isolated error -> 0.500 - 0.080 = 0.420
    sess_a = f"sess_a_{uuid.uuid4().hex[:8]}"
    analysis_a = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=sess_a,
                message_id=f"{sess_a}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    await update_learner_mastery(test_uid, sess_a, analysis_a, [{"text": "I didn't went"}])
    skill_a = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert skill_a["mastery"] == 0.420

    # 3. Session B: combined error + successful repetition in same session
    # -0.080 (error) + 0.120 (repetition) = +0.040 -> 0.420 + 0.040 = 0.460
    sess_b = f"sess_b_{uuid.uuid4().hex[:8]}"
    analysis_b = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base verb with didn't",
                session_id=sess_b,
                message_id=f"{sess_b}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns_b = [
        {"role": "user", "sequence": 1, "text": "Yesterday I didn't went.", "message_id": f"{sess_b}_seq_0001_user"},
        {"role": "assistant", "sequence": 2, "text": "Small correction: say 'I didn't go.' Please repeat it.", "message_id": f"{sess_b}_seq_0002_assistant"},
        {"role": "user", "sequence": 3, "text": "I understand, I didn't go to school.", "message_id": f"{sess_b}_seq_0003_user"},
    ]
    await update_learner_mastery(test_uid, sess_b, analysis_b, user_turns_b)
    skill_b = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert skill_b["mastery"] == 0.460

    # 4. Session C: isolated successful repetition (no error) -> +0.120 -> 0.460 + 0.120 = 0.580
    sess_c = f"sess_c_{uuid.uuid4().hex[:8]}"
    # Mock analysis where no new error was committed, but learner repeated target correction
    analysis_c = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="was practicing didn't go",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="natural_alternative",  # 0 error penalty
                confidence=0.95,
                short_explanation="Target repetition",
                session_id=sess_c,
                message_id=f"{sess_c}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns_c = [
        {"role": "user", "sequence": 1, "text": "Today I am practicing.", "message_id": f"{sess_c}_seq_0001_user"},
        {"role": "assistant", "sequence": 2, "text": "Try saying 'I didn't go' once.", "message_id": f"{sess_c}_seq_0002_assistant"},
        {"role": "user", "sequence": 3, "text": "I didn't go anywhere today.", "message_id": f"{sess_c}_seq_0003_user"},
    ]
    await update_learner_mastery(test_uid, sess_c, analysis_c, user_turns_c)
    skill_c = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert skill_c["mastery"] == 0.580


# ---------------------------------------------------------------------------
# Test 5: Correct English not lowering mastery
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_correct_english_not_lowering_mastery(db):
    """Verify completely correct English does not decrease mastery, and gives clean usage credit (+0.05)."""
    test_uid = f"test_user_clean_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    analysis = SessionAnalysisResult(mistakes=[], vocabulary=[])
    user_turns = [
        {"text": "I went to the store and bought some coffee.", "message_id": f"{session_id}_seq_0001_user"},
        {"text": "It was a very productive morning.", "message_id": f"{session_id}_seq_0003_user"},
    ]

    await update_learner_mastery(test_uid, session_id, analysis, user_turns)

    skill_doc = user_ref.collection("skills").document("sentence_structure").get()
    data = skill_doc.to_dict()
    assert data["errors"] == 0
    assert data["mastery"] == 0.55  # 0.50 + 0.05 = 0.55


# ---------------------------------------------------------------------------
# Test 6: Natural Alternative does not count as error
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_natural_alternative_not_counting_as_error(db):
    """Verify optional natural alternatives (e.g. reading books -> immersed in books) do NOT reduce mastery or increase error count."""
    test_uid = f"test_user_sug_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="The movie was very good",
                corrected="I really enjoyed the movie",
                category="natural_alternative",
                curriculum_skill_id="sentence_structure",
                fact_type="natural_alternative",  # NOT an error
                confidence=0.85,
                short_explanation="Optional more expressive phrasing",
                session_id=session_id,
                message_id=f"{session_id}_seq_0001_user",
            )
        ],
        vocabulary=[
            VocabularyOpportunityFact(
                original_usage="reading books",
                suggested_alternative="immersed in reading",
                curriculum_skill_id="collocations",
                fact_type="natural_alternative",
                explanation="Expressive vocabulary alternative",
                confidence=0.85,
                session_id=session_id,
                message_id=f"{session_id}_seq_0001_user",
            )
        ],
    )
    user_turns = [{"text": "The movie was very good and I like reading books.", "message_id": f"{session_id}_seq_0001_user"}]

    await update_learner_mastery(test_uid, session_id, analysis, user_turns)

    # 1. Check mistakes subcollection: should be 0 genuine mistakes
    mistakes = list(user_ref.collection("mistakes").stream())
    assert len(mistakes) == 0

    # 2. Check skill mastery: should NOT have any error penalties
    skill_doc = user_ref.collection("skills").document("sentence_structure").get()
    if skill_doc.exists:
        data = skill_doc.to_dict()
        assert data["errors"] == 0
        assert data["mastery"] >= 0.50


# ---------------------------------------------------------------------------
# Test 8: Repeated session analysis idempotency
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_repeated_session_analysis_idempotency(db):
    """Verify running update_learner_mastery on the same session twice does NOT double-count."""
    test_uid = f"test_user_idemp_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I am agree",
                corrected="I agree",
                category="be_verb_misuse",
                curriculum_skill_id="be_verb_misuse",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Agree is a main verb",
                session_id=session_id,
                message_id=f"{session_id}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns = [{"text": "I am agree with you.", "message_id": f"{session_id}_seq_0001_user"}]

    # Run 1
    await update_learner_mastery(test_uid, session_id, analysis, user_turns)
    skill_1 = user_ref.collection("skills").document("be_verb_misuse").get().to_dict()
    assert skill_1["attempts"] == 1
    assert skill_1["errors"] == 1
    assert skill_1["mastery"] == 0.42

    # Run 2 (duplicate/re-run)
    await update_learner_mastery(test_uid, session_id, analysis, user_turns)
    skill_2 = user_ref.collection("skills").document("be_verb_misuse").get().to_dict()
    assert skill_2["attempts"] == 1, "Attempts must NOT double count on re-run"
    assert skill_2["errors"] == 1, "Errors must NOT double count on re-run"
    assert skill_2["mastery"] == 0.42, "Mastery must remain identical"


# ---------------------------------------------------------------------------
# Test 9: Two-User Isolation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_two_user_mastery_isolation(db):
    """Verify User A's mastery changes have zero effect on User B's profile."""
    user_a = f"test_user_iso_a_{uuid.uuid4().hex[:8]}"
    user_b = f"test_user_iso_b_{uuid.uuid4().hex[:8]}"
    sess_a = f"sess_a_{uuid.uuid4().hex[:8]}"
    sess_b = f"sess_b_{uuid.uuid4().hex[:8]}"

    analysis_a = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="He don't know",
                corrected="He doesn't know",
                category="subject_verb_agreement",
                curriculum_skill_id="subject_verb_agreement",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Third person takes doesn't",
                session_id=sess_a,
                message_id=f"{sess_a}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )

    analysis_b = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I am having a car",
                corrected="I have a car",
                category="stative_verbs",
                curriculum_skill_id="stative_verbs",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Have for possession is stative",
                session_id=sess_b,
                message_id=f"{sess_b}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )

    await update_learner_mastery(user_a, sess_a, analysis_a, [{"text": "He don't know"}])
    await update_learner_mastery(user_b, sess_b, analysis_b, [{"text": "I am having a car"}])

    user_a_ref = db.collection("users").document(user_a)
    user_b_ref = db.collection("users").document(user_b)

    skill_a = user_a_ref.collection("skills").document("subject_verb_agreement").get().to_dict()
    assert skill_a["mastery"] == 0.42

    skill_b = user_b_ref.collection("skills").document("stative_verbs").get().to_dict()
    assert skill_b["mastery"] == 0.42

    assert not user_a_ref.collection("skills").document("stative_verbs").get().exists


# ---------------------------------------------------------------------------
# Test 11: Personalized Next Lesson & Current Focus Selection
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_personalized_next_lesson_selection(db):
    """Verify that a learner with past_simple_auxiliary mastery=0.42 receives the structured curriculum lesson & current_focus."""
    test_uid = f"test_user_lesson_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I didn't went",
                corrected="I didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="In negative past simple, didn't requires the base verb.",
                session_id=session_id,
                message_id=f"{session_id}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns = [{"text": "I didn't went there yesterday.", "message_id": f"{session_id}_seq_0001_user"}]

    profile = await update_learner_mastery(test_uid, session_id, analysis, user_turns)

    assert "past_simple_auxiliary" in profile["weaknesses"]
    assert profile["current_focus"] == "past_simple_auxiliary"

    recommended = profile["recommended_lesson"]
    assert recommended["target_skill_id"] == "past_simple_auxiliary"
    assert "Past Simple: did/didn't + base verb" in recommended["lesson_title"]
    assert "didn't go" in recommended["rule_summary"]
    assert "Tell me three things you didn't do yesterday." in recommended["practice_activity"]


# ---------------------------------------------------------------------------
# Test 12: CEFR level is preserved and NOT downgraded after session mistakes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cefr_level_not_downgraded_after_mistakes(db):
    """Verify an A2 learner who makes multiple mistakes remains at level A2 unless explicit reassessment occurs."""
    test_uid = f"test_user_cefr_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    # User initially established at A2
    user_ref.set({"cefr_level": "A2", "level": "A2"})

    # Session with 3 grammar errors
    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="I didn't went",
                corrected="I didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Error 1",
                session_id=session_id,
                message_id=f"{session_id}_seq_0001_user",
            ),
            GrammarMistakeFact(
                original="I am agree",
                corrected="I agree",
                category="be_verb_misuse",
                curriculum_skill_id="be_verb_misuse",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Error 2",
                session_id=session_id,
                message_id=f"{session_id}_seq_0003_user",
            ),
            GrammarMistakeFact(
                original="He don't know",
                corrected="He doesn't know",
                category="subject_verb_agreement",
                curriculum_skill_id="subject_verb_agreement",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Error 3",
                session_id=session_id,
                message_id=f"{session_id}_seq_0005_user",
            ),
        ],
        vocabulary=[],
    )
    user_turns = [
        {"text": "I didn't went.", "message_id": f"{session_id}_seq_0001_user"},
        {"text": "I am agree.", "message_id": f"{session_id}_seq_0003_user"},
        {"text": "He don't know.", "message_id": f"{session_id}_seq_0005_user"},
    ]

    profile = await update_learner_mastery(test_uid, session_id, analysis, user_turns)

    # CEFR Level must remain A2!
    assert profile["cefr_level"] == "A2"
    doc_after = user_ref.get().to_dict()
    assert doc_after["cefr_level"] == "A2"
    assert doc_after["level"] == "A2"


# ---------------------------------------------------------------------------
# Test 13: learner-only attempt counters
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_attempts_count_only_learner_evidence(db):
    """Tutor explanation/prompt is never an attempt; two learner turns are."""
    uid, session_id = f"test_user_attempts_{uuid.uuid4().hex[:8]}", f"sess_{uuid.uuid4().hex[:8]}"
    analysis = SessionAnalysisResult(mistakes=[GrammarMistakeFact(
        original="I didn't went", corrected="I didn't go", category="past_simple_auxiliary",
        curriculum_skill_id="past_simple_auxiliary", fact_type="grammar_error", confidence=0.95,
        short_explanation="base verb", session_id=session_id, message_id=f"{session_id}_seq_1_user",
    )])
    messages = [
        {"role": "user", "sequence": 1, "message_id": f"{session_id}_seq_1_user", "text": "I didn't went."},
        {"role": "assistant", "sequence": 2, "message_id": f"{session_id}_seq_2_assistant", "text": "Use didn't go. Please repeat it."},
        {"role": "user", "sequence": 3, "message_id": f"{session_id}_seq_3_user", "text": "I didn't go."},
    ]
    await update_learner_mastery(uid, session_id, analysis, messages)
    data = db.collection("users").document(uid).collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert data["attempts"] == 2
    assert data["correction_attempts"] == 1
    assert data["successful_repetitions"] == 1
    assert data["mastery"] == 0.54


# ---------------------------------------------------------------------------
# Assessment-only Pravaah level progression
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pravaah_levels_change_only_via_multidimensional_assessment(db):
    """Every E→S transition carries all dimensions; no session can perform it."""
    uid = f"test_user_levels_{uuid.uuid4().hex[:8]}"
    dimensions = dict(grammar="observed", vocabulary="observed", comprehension="observed", fluency="observed", speaking_complexity="observed", pronunciation="not scored in V1", conversation_ability="observed")
    expected = {"E": "A1", "D": "A1–A2", "C": "A2", "B": "B1", "A": "B2–C1", "S": "C1–C2+"}
    for level, cefr_reference in expected.items():
        profile = await apply_proficiency_assessment(uid, ProficiencyAssessment(pravaah_level=level, **dimensions))
        assert profile["pravaah_level"] == level
        assert profile["cefr_reference"] == cefr_reference

    # Ordinary bad-session evidence changes a skill, not the assessed level.
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    bad = SessionAnalysisResult(mistakes=[GrammarMistakeFact(
        original="He don't know", corrected="He doesn't know", category="subject_verb_agreement",
        curriculum_skill_id="subject_verb_agreement", fact_type="grammar_error", confidence=0.95,
        short_explanation="agreement", session_id=session_id, message_id=f"{session_id}_user",
    )])
    profile = await update_learner_mastery(uid, session_id, bad, [{"role": "user", "message_id": f"{session_id}_user", "text": "He don't know."}])
    assert profile["pravaah_level"] == "S"
    assert profile["cefr_reference"] == "C1–C2+"


# ---------------------------------------------------------------------------
# Test 14: Real Event Integration Test
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_real_tutor_event_integration_and_idempotency(db):
    """
    End-to-end integration test:
    1. Real session produces SESSION_STARTED, USER_UTTERANCE (error), AI_RESPONSE (correction prompt),
       USER_UTTERANCE (successful repetition), SESSION_ENDED.
    2. Events are consumed via process_event().
    3. Messages are persisted in Firestore.
    4. Skill mastery is updated from learner behaviors.
    5. Replaying identical events is 100% idempotent.
    """
    test_uid = f"test_user_e2e_{uuid.uuid4().hex[:8]}"
    session_id = f"sess_e2e_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(test_uid)

    # 1. Event 1: SESSION_STARTED
    e1 = make_event("SESSION_STARTED", test_uid, session_id, {"mode": "free_conversation", "topic": "Weekend"})
    await process_event(e1)

    # 2. Event 2: USER_UTTERANCE (Learner makes past simple auxiliary mistake)
    e2 = make_event("USER_UTTERANCE", test_uid, session_id, {"text": "Yesterday I didn't went anywhere.", "duration_ms": 3200})
    await process_event(e2)

    # 3. Event 3: AI_RESPONSE (Tutor provides correction prompt)
    e3 = make_event("AI_RESPONSE", test_uid, session_id, {"text": "Small correction: Say 'I didn't go anywhere.' Try repeating that!", "duration_ms": 4000})
    await process_event(e3)

    # 4. Event 4: USER_UTTERANCE (Learner successfully repeats corrected phrase)
    e4 = make_event("USER_UTTERANCE", test_uid, session_id, {"text": "Ah, okay! I didn't go anywhere yesterday.", "duration_ms": 3500})
    await process_event(e4)

    # 5. Event 5: SESSION_ENDED
    e5 = make_event("SESSION_ENDED", test_uid, session_id, {"duration_seconds": 45, "reason": "user_left"})
    await process_event(e5)

    # Allow async analysis & Firestore updates to finish (Gemini call)
    await asyncio.sleep(8)

    # Verify Firestore Messages persisted
    messages = list(user_ref.collection("sessions").document(session_id).collection("messages").order_by("sequence").stream())
    assert len(messages) == 3  # e2 (user), e3 (ai), e4 (user)
    assert messages[0].to_dict()["text"] == "Yesterday I didn't went anywhere."
    assert messages[1].to_dict()["text"] == "Small correction: Say 'I didn't go anywhere.' Try repeating that!"
    assert messages[2].to_dict()["text"] == "Ah, okay! I didn't go anywhere yesterday."

    # Verify Skill Mastery Record in Firestore
    skill_doc = user_ref.collection("skills").document("past_simple_auxiliary").get()
    assert skill_doc.exists
    skill_data = skill_doc.to_dict()
    # 0.50 - 0.08 (error) + 0.12 (successful repetition) = 0.54
    assert skill_data["mastery"] == 0.54
    assert skill_data["errors"] >= 1
    assert skill_data["successful_repetitions"] >= 1

    # Verify Profile recommended lesson
    profile_doc = user_ref.get().to_dict()
    assert profile_doc["current_focus"] == "past_simple_auxiliary"
    assert profile_doc["recommended_lesson"]["target_skill_id"] == "past_simple_auxiliary"

    # 6. Replay Events (Idempotency verification)
    await process_event(e1)
    await process_event(e2)
    await process_event(e3)
    await process_event(e4)
    await process_event(e5)

    # Verify mastery and messages did not duplicate
    messages_after = list(user_ref.collection("sessions").document(session_id).collection("messages").stream())
    assert len(messages_after) == 3
    skill_data_after = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    assert skill_data_after["mastery"] == 0.54
    assert skill_data_after["attempts"] == skill_data["attempts"]

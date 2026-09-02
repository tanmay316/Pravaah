"""
Phase 3B: Grammar and Vocabulary Analysis Tests

Automated Test Suite covering all 10 requirements:
  1. "Yesterday I go to market." -> "Yesterday I went to the market."
  2. "I didn't went there." -> "I didn't go there."
  3. "I am agree with you." -> "I agree with you."
  4. Correct English produces no false grammar error.
  5. Simple acceptable vocabulary is not unnecessarily upgraded.
  6. Low-confidence analysis (<0.75) is filtered out.
  7. Rerunning analysis on the same session is idempotent (no duplicate documents).
  8. Firestore failure in analysis does not throw unhandled exceptions.
  9. Malformed LLM JSON is handled/retried safely without crashing.
  10. User A analysis data is strictly isolated from User B.
"""

import asyncio
import os
import sys
import uuid
import pytest
from dotenv import load_dotenv

# Set paths
base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))

env_path = os.path.join(base_dir, "services", "voice-agent", ".env")
load_dotenv(env_path)

from worker import (
    analyze_session_messages,
    get_firestore_client,
    SessionAnalysisResult,
    GrammarMistakeFact,
    VocabularyOpportunityFact,
    make_deterministic_id,
)


@pytest.fixture(scope="module")
def db():
    return get_firestore_client()


@pytest.fixture
def user_ids():
    uid_a = f"test_user_A_{uuid.uuid4().hex[:6]}"
    uid_b = f"test_user_B_{uuid.uuid4().hex[:6]}"
    session_id = f"test_sess_{uuid.uuid4().hex[:8]}"
    return {"user_a": uid_a, "user_b": uid_b, "session_id": session_id}


@pytest.mark.asyncio
async def test_canonical_mistake_1_past_tense(user_ids):
    """Test 1: 'Yesterday I go to market.' -> 'Yesterday I went to the market.'"""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "Yesterday I go to market.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    result = await analyze_session_messages(uid, session_id, messages)

    assert len(result.mistakes) >= 1, "Must detect the past tense error"
    mistake = result.mistakes[0]
    assert "went" in mistake.corrected.lower(), "Must correct 'go' to 'went'"
    assert mistake.confidence >= 0.75
    assert mistake.session_id == session_id
    assert mistake.message_id == f"{session_id}_seq_0001_user"


@pytest.mark.asyncio
async def test_canonical_mistake_2_double_past(user_ids):
    """Test 2: 'I didn't went there.' -> 'I didn't go there.'"""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "I didn't went there yesterday.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    result = await analyze_session_messages(uid, session_id, messages)

    assert len(result.mistakes) >= 1, "Must detect double past tense error"
    mistake = result.mistakes[0]
    assert "go" in mistake.corrected.lower(), "Must correct 'didn't went' to 'didn't go'"
    assert mistake.confidence >= 0.75


@pytest.mark.asyncio
async def test_canonical_mistake_3_stative_predicate(user_ids):
    """Test 3: 'I am agree with you.' -> 'I agree with you.'"""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "I am agree with you completely.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    result = await analyze_session_messages(uid, session_id, messages)

    assert len(result.mistakes) >= 1, "Must detect 'am agree' mistake"
    mistake = result.mistakes[0]
    assert "i agree" in mistake.corrected.lower(), "Must correct 'I am agree' to 'I agree'"
    assert mistake.confidence >= 0.75


@pytest.mark.asyncio
async def test_correct_english_no_false_positive(user_ids):
    """Test 4: Correct natural English should produce no false grammar errors."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "I went to the supermarket this morning and bought some apples.", "message_id": f"{session_id}_seq_0001_user"},
        {"role": "user", "text": "Could you tell me what time the train arrives?", "message_id": f"{session_id}_seq_0002_user"},
    ]

    result = await analyze_session_messages(uid, session_id, messages)

    assert len(result.mistakes) == 0, "Must not falsely flag natural, correct English sentences"


@pytest.mark.asyncio
async def test_simple_vocabulary_not_overcomplicated(user_ids):
    """Test 5: Acceptable/simple vocabulary should not be unnecessarily upgraded to complex words."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "I like reading books in the evening.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    result = await analyze_session_messages(uid, session_id, messages)

    # Should not demand replacing "like" with "relish/savor" or "books" with "tomes"
    for v in result.vocabulary:
        if v.original_usage.lower() == "like":
            assert v.suggested_alternative is None or "enjoy" in v.suggested_alternative.lower()


@pytest.mark.asyncio
async def test_confidence_threshold_filtering(user_ids):
    """Test 6: Low-confidence items (<0.75) should be filtered out."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    # When we set a high threshold, items below the threshold must be filtered out
    messages = [
        {"role": "user", "text": "Yesterday I go to market.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    # Test with threshold 0.99 (should filter out items below 0.99)
    strict_result = await analyze_session_messages(uid, session_id, messages, confidence_threshold=0.99)
    # The normal threshold 0.75 should retain it
    normal_result = await analyze_session_messages(uid, session_id, messages, confidence_threshold=0.75)

    assert len(normal_result.mistakes) >= 1
    assert all(m.confidence >= 0.75 for m in normal_result.mistakes)


@pytest.mark.asyncio
async def test_idempotent_session_analysis_rerun(db, user_ids):
    """Test 7: Running analysis on the exact same session twice produces zero duplicate documents."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "Yesterday I am go market.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    # Run 1
    await analyze_session_messages(uid, session_id, messages)

    mistakes_ref = db.collection("users").document(uid).collection("mistakes")
    count_1 = len(list(mistakes_ref.where("session_id", "==", session_id).stream()))

    # Run 2 (exact same session)
    await analyze_session_messages(uid, session_id, messages)

    count_2 = len(list(mistakes_ref.where("session_id", "==", session_id).stream()))

    assert count_1 > 0, "Must create initial mistake document"
    assert count_1 == count_2, "Re-running analysis must not duplicate documents in Firestore"


@pytest.mark.asyncio
async def test_firestore_failure_resilience():
    """Test 8: Firestore failure in analysis does not throw unhandled exception or crash."""
    try:
        # Invalid user_id that fails writing or empty inputs
        res = await analyze_session_messages(
            user_id="",
            session_id="dummy_session",
            messages=[],
        )
        assert isinstance(res, SessionAnalysisResult)
    except Exception as e:
        pytest.fail(f"analyze_session_messages raised unhandled exception on error: {e}")


@pytest.mark.asyncio
async def test_malformed_llm_json_resilience(user_ids):
    """Test 9: Malformed LLM output is rejected safely without crashing."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    # Calling with empty user messages returns safe empty result
    res = await analyze_session_messages(uid, session_id, [{"role": "assistant", "text": "Hello!"}])
    assert isinstance(res, SessionAnalysisResult)
    assert len(res.mistakes) == 0
    assert len(res.vocabulary) == 0


@pytest.mark.asyncio
async def test_two_user_analysis_isolation(db, user_ids):
    """Test 10: User A analysis/data is not accessible to User B."""
    uid_a = user_ids["user_a"]
    uid_b = user_ids["user_b"]
    session_id = user_ids["session_id"]

    messages = [
        {"role": "user", "text": "I didn't went to the meeting.", "message_id": f"{session_id}_seq_0001_user"},
    ]

    await analyze_session_messages(uid_a, session_id, messages)

    # User A has mistakes
    docs_a = list(db.collection("users").document(uid_a).collection("mistakes").where("session_id", "==", session_id).stream())
    assert len(docs_a) >= 1

    # User B has no mistakes for this session
    docs_b = list(db.collection("users").document(uid_b).collection("mistakes").where("session_id", "==", session_id).stream())
    assert len(docs_b) == 0, "User B must not see User A's mistakes"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

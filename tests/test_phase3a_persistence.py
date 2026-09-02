"""
Phase 3A: Session Data Persistence Tests

Automated Test Suite for:
  1. Session creation & metadata persistence
  2. Finalized message persistence (user utterance & AI response)
  3. Session completion & duration tracking
  4. Idempotent write & duplicate event handling
  5. Reconnect / duplicate delivery safety
  6. Strict two-user isolation
  7. Firestore failure resilience (non-blocking realtime guarantee)
"""

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
import pytest
from dotenv import load_dotenv

# Set paths
base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))

env_path = os.path.join(base_dir, "services", "voice-agent", ".env")
load_dotenv(env_path)

from agent import make_event
from worker import process_event, get_firestore_client, _processed_event_ids


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
async def test_session_creation_metadata(db, user_ids):
    """Test 1: Session creation and initial metadata in Firestore."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    event = make_event(
        "SESSION_STARTED",
        user_id=uid,
        session_id=session_id,
        payload={"mode": "free_conversation", "topic": "Daily Routine"},
    )

    await process_event(event)

    doc_ref = db.collection("users").document(uid).collection("sessions").document(session_id)
    doc = doc_ref.get()

    assert doc.exists, "Session document must exist in Firestore"
    data = doc.to_dict()
    assert data["sessionId"] == session_id
    assert data["mode"] == "free_conversation"
    assert data["topic"] == "Daily Routine"
    assert data["state"] == "IN_PROGRESS"
    assert "start_time" in data


@pytest.mark.asyncio
async def test_finalized_message_persistence(db, user_ids):
    """Test 2: Finalized user utterance and AI response message persistence."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    # 1. User Utterance Event
    user_event = make_event(
        "USER_UTTERANCE",
        user_id=uid,
        session_id=session_id,
        payload={"text": "Yesterday I am go market.", "duration_ms": 2300},
    )
    await process_event(user_event)

    # 2. AI Response Event
    ai_event = make_event(
        "AI_RESPONSE",
        user_id=uid,
        session_id=session_id,
        payload={
            "text": "A more natural way is: Yesterday I went to the market.",
            "duration_ms": 3100,
            "interrupted": False,
        },
    )
    await process_event(ai_event)

    # Verify messages subcollection
    messages_ref = db.collection("users").document(uid).collection("sessions").document(session_id).collection("messages")
    messages = list(messages_ref.stream())

    assert len(messages) == 2, "Must persist exactly 2 finalized messages"

    msg_map = {m.to_dict()["role"]: m.to_dict() for m in messages}
    assert "user" in msg_map
    assert msg_map["user"]["text"] == "Yesterday I am go market."
    assert msg_map["user"]["duration_ms"] == 2300

    assert "assistant" in msg_map
    assert "went to the market" in msg_map["assistant"]["text"]
    assert msg_map["assistant"]["interrupted"] is False


@pytest.mark.asyncio
async def test_session_completion(db, user_ids):
    """Test 3: Session completion, state transition, and duration calculation."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    end_event = make_event(
        "SESSION_ENDED",
        user_id=uid,
        session_id=session_id,
        payload={"duration_seconds": 185, "reason": "user_completed"},
    )
    await process_event(end_event)

    doc = db.collection("users").document(uid).collection("sessions").document(session_id).get()
    data = doc.to_dict()

    assert data["state"] == "COMPLETED"
    assert data["duration_seconds"] == 185
    assert data["completion_reason"] == "user_completed"
    assert "end_time" in data


@pytest.mark.asyncio
async def test_idempotent_duplicate_events(db, user_ids):
    """Test 4: Idempotent write & duplicate event handling."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    dup_event = make_event(
        "USER_UTTERANCE",
        user_id=uid,
        session_id=session_id,
        payload={"text": "This is a duplicate test utterance."},
    )

    # First delivery
    await process_event(dup_event)

    # Duplicate delivery (same event_id)
    await process_event(dup_event)

    messages_ref = db.collection("users").document(uid).collection("sessions").document(session_id).collection("messages")
    matching = [m for m in messages_ref.stream() if m.to_dict().get("text") == "This is a duplicate test utterance."]

    assert len(matching) == 1, "Duplicate event delivery must not duplicate records in Firestore"


@pytest.mark.asyncio
async def test_reconnect_duplicate_delivery(db, user_ids):
    """Test 5: Reconnect / retry scenario with cleared in-memory cache."""
    uid = user_ids["user_a"]
    session_id = user_ids["session_id"]

    reconnect_event = make_event(
        "AI_RESPONSE",
        user_id=uid,
        session_id=session_id,
        payload={"text": "Reconnect safety test response."},
    )
    reconnect_event["sequence"] = 99  # explicit sequence

    await process_event(reconnect_event)

    # Simulate process restart by clearing in-memory deduplication set
    _processed_event_ids.discard(reconnect_event["event_id"])

    # Re-delivery of the exact same event
    await process_event(reconnect_event)

    # Document ID format ensures idempotent overwrite
    expected_doc_id = f"{session_id}_seq_0099_assistant"
    doc = db.collection("users").document(uid).collection("sessions").document(session_id).collection("messages").document(expected_doc_id).get()

    assert doc.exists
    assert doc.to_dict()["text"] == "Reconnect safety test response."


@pytest.mark.asyncio
async def test_strict_user_isolation(db, user_ids):
    """Test 6: Strict 2-user isolation (User B cannot see User A's data)."""
    uid_a = user_ids["user_a"]
    uid_b = user_ids["user_b"]
    session_id = user_ids["session_id"]

    # Explicitly create User A's session
    start_event = make_event(
        "SESSION_STARTED",
        user_id=uid_a,
        session_id=session_id,
        payload={"mode": "free_conversation"},
    )
    await process_event(start_event)

    # Check User A's session exists
    doc_a = db.collection("users").document(uid_a).collection("sessions").document(session_id).get()
    assert doc_a.exists, "User A session must exist"
    assert doc_a.to_dict()["sessionId"] == session_id

    # Check User B's namespace has no access to User A's session
    doc_b = db.collection("users").document(uid_b).collection("sessions").document(session_id).get()
    assert not doc_b.exists, "User B must not see User A's session document"


@pytest.mark.asyncio
async def test_firestore_failure_resilience():
    """Test 7: Firestore failure does not throw unhandled exception or break agent."""
    corrupted_event = {
        "event_id": "malformed_event_123",
        "event_type": "USER_UTTERANCE",
        "user_id": None,  # Causes validation / error
        "session_id": None,
        "payload": {},
    }

    # Must catch and log error cleanly without raising exception
    try:
        await process_event(corrupted_event)
        resilience_passed = True
    except Exception:
        resilience_passed = False

    assert resilience_passed, "Process event must be resilient to errors without crashing"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

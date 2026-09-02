import asyncio
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from worker import get_firestore_client, process_event
from agent import make_event

async def backfill_user_live_session():
    uid = "qlkYmZ0kcsgQ1CEWLBIn8nzLWxh1"
    session_id = "66ceb4c5-2707-4b8d-807b-54c3492fcef5"

    print("=" * 80)
    print("BACKFILLING REAL USER CONVERSATION TO FIRESTORE")
    print("=" * 80)
    print(f"User UID: {uid}")
    print(f"Session ID: {session_id}\n")

    # 1. SESSION_STARTED
    await process_event(make_event(
        "SESSION_STARTED",
        user_id=uid,
        session_id=session_id,
        payload={"mode": "free_conversation", "topic": "General English Conversation"}
    ))

    # 2. USER_UTTERANCE 1
    await process_event(make_event(
        "USER_UTTERANCE",
        user_id=uid,
        session_id=session_id,
        payload={"text": "No, there is no topic particularly. I just... one, two, three, English I want to learn and improve English.", "duration_ms": 7200}
    ))

    # 3. AI_RESPONSE 1
    await process_event(make_event(
        "AI_RESPONSE",
        user_id=uid,
        session_id=session_id,
        payload={
            "text": "That's great! Let's start with something fun. What do you enjoy doing in your free time? Any hobbies or activities you're passionate about?",
            "duration_ms": 4500,
            "interrupted": False
        }
    ))

    # 4. USER_UTTERANCE 2
    await process_event(make_event(
        "USER_UTTERANCE",
        user_id=uid,
        session_id=session_id,
        payload={"text": "I like... anime and I play with cricket.", "duration_ms": 3800}
    ))

    # 5. AI_RESPONSE 2
    await process_event(make_event(
        "AI_RESPONSE",
        user_id=uid,
        session_id=session_id,
        payload={
            "text": "Small correction. You could say: 'I watch anime and I play cricket.' We don't say 'play with cricket' when talking about the sport. Can you try saying: 'I play cricket'?",
            "duration_ms": 5200,
            "interrupted": False
        }
    ))

    # 6. SESSION_ENDED
    await process_event(make_event(
        "SESSION_ENDED",
        user_id=uid,
        session_id=session_id,
        payload={"duration_seconds": 154, "reason": "learner_disconnected"}
    ))

    # Allow async analysis task to finish
    await asyncio.sleep(4)

    # Inspect Firestore to verify
    db = get_firestore_client()
    user_ref = db.collection("users").document(uid)

    sess_doc = user_ref.collection("sessions").document(session_id).get()
    print("=" * 80)
    print(f"FIRESTORE SESSION DOCUMENT: users/{uid}/sessions/{session_id}")
    print("=" * 80)
    sess_data = sess_doc.to_dict()
    for k, v in sess_data.items():
        if hasattr(v, "isoformat"):
            sess_data[k] = v.isoformat()
    print(json.dumps(sess_data, indent=2))

    messages = list(user_ref.collection("sessions").document(session_id).collection("messages").order_by("sequence").stream())
    print("\n" + "=" * 80)
    print(f"FIRESTORE MESSAGES SUBCOLLECTION: users/{uid}/sessions/{session_id}/messages/ ({len(messages)} messages)")
    print("=" * 80)
    for m in messages:
        m_data = m.to_dict()
        for k, v in m_data.items():
            if hasattr(v, "isoformat"):
                m_data[k] = v.isoformat()
        print(f"[{m.id}] ({m_data.get('role')}): {m_data.get('text')}")

    mistakes = list(user_ref.collection("mistakes").stream())
    print("\n" + "=" * 80)
    print(f"FIRESTORE MISTAKES SUBCOLLECTION: users/{uid}/mistakes/ ({len(mistakes)} mistakes)")
    print("=" * 80)
    for doc in mistakes:
        m_dict = doc.to_dict()
        for k, v in m_dict.items():
            if hasattr(v, "isoformat"):
                m_dict[k] = v.isoformat()
        print(f"\n[Mistake ID: {doc.id}]")
        print(json.dumps(m_dict, indent=2))

if __name__ == "__main__":
    asyncio.run(backfill_user_live_session())

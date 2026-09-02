import json
import sys
import os

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from worker import get_firestore_client, process_event
from agent import make_event
import asyncio

async def inspect():
    db = get_firestore_client()
    
    # Create a demo realistic completed session to inspect exact final state
    demo_uid = "demo_learner_auth_verified"
    demo_session_id = "session_phase3a_demo"
    
    # 1. SESSION_STARTED
    await process_event(make_event(
        "SESSION_STARTED",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={"mode": "free_conversation", "topic": "Daily Routine Practice"}
    ))
    
    # 2. USER_UTTERANCE
    await process_event(make_event(
        "USER_UTTERANCE",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={"text": "Yesterday I am go market and buy one shirt.", "duration_ms": 2850}
    ))
    
    # 3. AI_RESPONSE
    await process_event(make_event(
        "AI_RESPONSE",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={
            "text": "Almost! A more natural way to say that is: 'Yesterday I went to the market and bought a shirt.' We use past tense 'went' and 'bought' for yesterday. Can you repeat that?",
            "duration_ms": 4200,
            "interrupted": False
        }
    ))
    
    # 4. USER_UTTERANCE (Repetition)
    await process_event(make_event(
        "USER_UTTERANCE",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={"text": "Yesterday I went to the market and bought a shirt.", "duration_ms": 2600}
    ))
    
    # 5. AI_RESPONSE (Reinforcement)
    await process_event(make_event(
        "AI_RESPONSE",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={
            "text": "Perfect! Much better. What color was the shirt?",
            "duration_ms": 2100,
            "interrupted": False
        }
    ))
    
    # 6. SESSION_ENDED
    await process_event(make_event(
        "SESSION_ENDED",
        user_id=demo_uid,
        session_id=demo_session_id,
        payload={"duration_seconds": 124, "reason": "user_completed"}
    ))
    
    # Fetch and print
    sess_doc = db.collection("users").document(demo_uid).collection("sessions").document(demo_session_id).get()
    sess_data = sess_doc.to_dict()
    for k, v in sess_data.items():
        if hasattr(v, "isoformat"):
            sess_data[k] = v.isoformat()
            
    print("=" * 80)
    print(f"DOCUMENT: users/{demo_uid}/sessions/{demo_session_id}")
    print("=" * 80)
    print(json.dumps(sess_data, indent=2))
    
    messages = list(db.collection("users").document(demo_uid).collection("sessions").document(demo_session_id).collection("messages").order_by("sequence").stream())
    print("\n" + "=" * 80)
    print(f"SUBCOLLECTION: users/{demo_uid}/sessions/{demo_session_id}/messages ({len(messages)} messages)")
    print("=" * 80)
    for m in messages:
        m_data = m.to_dict()
        for k, v in m_data.items():
            if hasattr(v, "isoformat"):
                m_data[k] = v.isoformat()
        print(f"\nMessage [{m.id}]:")
        print(json.dumps(m_data, indent=2))

if __name__ == "__main__":
    asyncio.run(inspect())

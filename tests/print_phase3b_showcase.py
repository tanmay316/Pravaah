import asyncio
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from worker import get_firestore_client, analyze_session_messages, process_event
from agent import make_event

async def demonstrate_phase3b_analysis():
    uid = "demo_learner_phase3b_showcase"
    session_id = "session_3b_grammar_vocab_demo"

    # Simulate realistic user messages from a spoken session
    user_messages = [
        {
            "role": "user",
            "sequence": 2,
            "message_id": f"{session_id}_seq_0002_user",
            "text": "Yesterday I go to market and buy one shirt, but I didn't went inside the big mall because I am agree that it is very expensive.",
            "duration_ms": 4800,
        },
        {
            "role": "user",
            "sequence": 4,
            "message_id": f"{session_id}_seq_0004_user",
            "text": "I like reading books in the evening at home.",
            "duration_ms": 2500,
        }
    ]

    print("=" * 80)
    print("PHASE 3B — STRUCTURED GRAMMAR & VOCABULARY ANALYSIS EXECUTION")
    print("=" * 80)
    print(f"Target User: {uid}")
    print(f"Session ID: {session_id}")
    print(f"Total User Utterances Analyzed: {len(user_messages)}\n")

    # Run analysis
    result = await analyze_session_messages(uid, session_id, user_messages)

    print("-" * 80)
    print("PYDANTIC STRUCTURED ANALYSIS RESULT (IN-MEMORY MODEL OUTPUT)")
    print("-" * 80)
    print(result.model_dump_json(indent=2))

    # Fetch real documents directly from Firestore to prove persistence & exact schema
    db = get_firestore_client()
    user_ref = db.collection("users").document(uid)

    mistakes = list(user_ref.collection("mistakes").where("session_id", "==", session_id).stream())
    print("\n" + "=" * 80)
    print(f"ACTUAL FIRESTORE MISTAKES DOCUMENTS: users/{uid}/mistakes/ ({len(mistakes)} records)")
    print("=" * 80)
    for doc in mistakes:
        data = doc.to_dict()
        for k, v in data.items():
            if hasattr(v, "isoformat"):
                data[k] = v.isoformat()
        print(f"\n[Document ID: {doc.id}]")
        print(json.dumps(data, indent=2))

    vocab_docs = list(user_ref.collection("vocabulary").where("session_id", "==", session_id).stream())
    print("\n" + "=" * 80)
    print(f"ACTUAL FIRESTORE VOCABULARY DOCUMENTS: users/{uid}/vocabulary/ ({len(vocab_docs)} records)")
    print("=" * 80)
    for doc in vocab_docs:
        data = doc.to_dict()
        for k, v in data.items():
            if hasattr(v, "isoformat"):
                data[k] = v.isoformat()
        print(f"\n[Document ID: {doc.id}]")
        print(json.dumps(data, indent=2))

if __name__ == "__main__":
    asyncio.run(demonstrate_phase3b_analysis())

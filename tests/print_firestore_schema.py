import json
import sys
import os

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))

from worker import get_firestore_client

db = get_firestore_client()

# Query users
users = list(db.collection("users").stream())

print("=" * 80)
print(f"EXACT FIRESTORE DOCUMENT STRUCTURE VERIFICATION (Total Users: {len(users)})")
print("=" * 80)

for u in users:
    uid = u.id
    sessions = list(db.collection("users").document(uid).collection("sessions").stream())
    if sessions:
        for sess in sessions:
            sess_data = sess.to_dict()
            for k, v in sess_data.items():
                if hasattr(v, "isoformat"):
                    sess_data[k] = v.isoformat()
            
            print(f"\n[SESSION DOCUMENT] Path: users/{uid}/sessions/{sess.id}")
            print("Session Data:")
            print(json.dumps(sess_data, indent=2))
            
            # Subcollection
            messages = list(db.collection("users").document(uid).collection("sessions").document(sess.id).collection("messages").stream())
            print(f"\n[MESSAGES SUBCOLLECTION] Path: users/{uid}/sessions/{sess.id}/messages (Count: {len(messages)})")
            for m in messages:
                m_data = m.to_dict()
                for k, v in m_data.items():
                    if hasattr(v, "isoformat"):
                        m_data[k] = v.isoformat()
                print(f"  [Message: {m.id}]")
                print("  " + json.dumps(m_data, indent=4).replace("\n", "\n  "))
            break
        break

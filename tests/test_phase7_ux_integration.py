"""
Phase 7 UX & API Integration Test Suite
Verifies all learner-facing endpoints supporting the complete Expo product experience:
1. Profile retrieval and live setting updates (daily_goal_minutes, hindi_support)
2. Mistakes list retrieval
3. Vocabulary notebook retrieval
4. Progress summary calculation
5. Full account deletion with complete user isolation
"""

import os
import sys
import pytest
from datetime import datetime, timezone
from dotenv import load_dotenv

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "api"))

env_path = os.path.join(base_dir, "services", "voice-agent", ".env")
load_dotenv(env_path)

from httpx import AsyncClient, ASGITransport
from services.api.app.main import app
from services.api.app.firebase import get_firestore_client
from services.api.app.auth import get_current_user

@pytest.fixture
def test_db():
    return get_firestore_client()

@pytest.mark.asyncio
async def test_profile_update_and_daily_plan_realignment(test_db):
    uid = "test_p7_user_profile"
    app.dependency_overrides[get_current_user] = lambda: {"uid": uid}
    
    # 1. Initialize user doc
    test_db.collection("users").document(uid).set({
        "pravaah_level": "C",
        "cefr_reference": "A2",
        "current_focus": "past_simple_auxiliary",
        "daily_goal_minutes": 30,
        "hindi_support": "high",
        "weaknesses": ["past_simple_auxiliary"],
    })
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        headers = {"Authorization": "Bearer test_token"}
        
        # 2. GET profile
        res = await ac.get("/api/me/profile", headers=headers)
        assert res.status_code == 200
        p = res.json()
        assert p["pravaah_level"] == "C"
        assert p["daily_goal_minutes"] == 30
        assert p["hindi_support"] == "high"
        
        # 3. PATCH profile with new goal (60m) and hindi_support (minimal)
        patch_res = await ac.patch("/api/me/profile", json={
            "daily_goal_minutes": 60,
            "hindi_support": "minimal"
        }, headers=headers)
        assert patch_res.status_code == 200
        updated_p = patch_res.json()
        assert updated_p["daily_goal_minutes"] == 60
        assert updated_p["hindi_support"] == "minimal"
        
        # 4. Check that daily plan now reflects 60m
        plan_res = await ac.get("/api/me/daily-plan", headers=headers)
        assert plan_res.status_code == 200
        plan = plan_res.json()
        assert plan["goal_minutes"] == 60
        assert plan["planned_minutes"] == 60

@pytest.mark.asyncio
async def test_mistakes_and_vocabulary_notebook_endpoints(test_db):
    uid = "test_p7_user_notebook"
    app.dependency_overrides[get_current_user] = lambda: {"uid": uid}
    
    # Pre-populate some mistakes and vocabulary
    now_iso = datetime.now(timezone.utc).isoformat()
    test_db.collection(f"users/{uid}/mistakes").document("mstk_1").set({
        "session_id": "sess_1",
        "turn_id": "turn_1",
        "category": "past_simple_auxiliary",
        "original": "Yesterday I didn't went",
        "corrected": "Yesterday I didn't go",
        "explanation": "Use didn't + base verb",
        "severity": "high",
        "created_at": now_iso
    })
    
    test_db.collection(f"users/{uid}/vocabulary").document("voc_1").set({
        "term": "have a party",
        "context": "We decided to have a party last Friday.",
        "natural_usage_tip": "Use 'have a party' instead of 'make a party'.",
        "created_at": now_iso
    })
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        headers = {"Authorization": "Bearer test_token"}
        
        # Mistakes
        mistakes_res = await ac.get("/api/me/mistakes", headers=headers)
        assert mistakes_res.status_code == 200
        mistakes = mistakes_res.json()
        assert len(mistakes) >= 1
        assert mistakes[0]["mistake_id"] == "mstk_1"
        assert mistakes[0]["original"] == "Yesterday I didn't went"
        assert mistakes[0]["corrected"] == "Yesterday I didn't go"
        
        # Vocabulary
        vocab_res = await ac.get("/api/me/vocabulary", headers=headers)
        assert vocab_res.status_code == 200
        vocab = vocab_res.json()
        assert len(vocab) >= 1
        assert vocab[0]["vocabulary_id"] == "voc_1"
        assert vocab[0]["term"] == "have a party"

@pytest.mark.asyncio
async def test_progress_summary_and_account_deletion(test_db):
    uid = "test_p7_user_deletion"
    app.dependency_overrides[get_current_user] = lambda: {"uid": uid}
    
    # 1. Create user and a completed session
    now_iso = datetime.now(timezone.utc).isoformat()
    test_db.collection("users").document(uid).set({
        "pravaah_level": "B",
        "cefr_reference": "B1",
        "daily_goal_minutes": 15,
    })
    test_db.collection(f"users/{uid}/sessions").document("sess_del_1").set({
        "status": "completed",
        "mode": "grammar_practice",
        "target_skill": "past_simple_auxiliary",
        "duration_seconds": 600,
        "created_at": now_iso,
        "ended_at": now_iso,
    })
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        headers = {"Authorization": "Bearer test_token"}
        
        # 2. Progress summary
        prog_res = await ac.get("/api/me/progress", headers=headers)
        assert prog_res.status_code == 200
        prog = prog_res.json()
        assert prog["total_sessions"] >= 1
        assert prog["total_practice_minutes"] >= 10.0
        
        # 3. Account deletion
        del_res = await ac.delete("/api/me/account", headers=headers)
        assert del_res.status_code == 200
        assert del_res.json()["deleted"] is True
        
        # 4. Confirm doc is deleted
        doc = test_db.collection("users").document(uid).get()
        assert not doc.exists

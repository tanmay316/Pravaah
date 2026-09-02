"""
Phase 4: Targeted Lesson Execution Showcase

Demonstrates:
1. Initial unassessed learner profile (pravaah_level="unassessed", cefr_reference="unassessed").
2. Recommended focus lesson for `past_simple_auxiliary` (mastery baseline = 0.42).
3. Learner launches targeted practice session -> Lesson transitions to 'in_progress'.
4. Tutor agent receives structured objective & formulates natural conversational elicitation.
5. Learner speaks: error committed -> tutor correction prompt -> learner successful repetition.
6. Learning worker processes session evidence:
   - attempts: 2 (total learner attempts)
   - correction_attempts: 1 (prompted)
   - successful_repetitions: 1
   - failed_repetitions: 0
   - mastery: 0.420 - 0.080 + 0.120 = 0.460
7. Lesson document persisted under users/{uid}/lessons/{lesson_id} (status="completed").
8. Next recommended lesson generated and persisted.
9. Full Firestore document state printed before & after.
"""

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import CURRICULUM_SKILLS, generate_personalized_lesson
from worker import (
    get_firestore_client,
    update_learner_mastery,
    GrammarMistakeFact,
    SessionAnalysisResult,
)
from agent import EnglishTutor


async def run_showcase():
    print("=" * 80)
    print("  PRAVAAH PHASE 4: TARGETED LESSON EXECUTION LIVE SHOWCASE")
    print("=" * 80)
    db = get_firestore_client()
    uid = f"showcase_user_{uuid.uuid4().hex[:6]}"
    session_id = f"sess_tgt_{uuid.uuid4().hex[:6]}"
    lesson_id = f"lsn_past_simple_auxiliary_{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc)

    user_ref = db.collection("users").document(uid)

    print(f"\n[STEP 1] INITIAL LEARNER PROFILE CREATION (Unassessed State)")
    print("-" * 80)
    initial_profile = {
        "uid": uid,
        "pravaah_level": "unassessed",
        "cefr_reference": "unassessed",
        "native_language": "Hindi",
        "target_language": "English",
        "daily_goal_minutes": 15,
        "current_focus": "past_simple_auxiliary",
        "skill_mastery": {"past_simple_auxiliary": 0.42},
        "weaknesses": ["past_simple_auxiliary"],
        "created_at": now,
    }
    user_ref.set(initial_profile)
    user_ref.collection("skills").document("past_simple_auxiliary").set({
        "skill_id": "past_simple_auxiliary",
        "title": "Past Simple: did/didn't + base verb",
        "mastery": 0.42,
        "attempts": 1,
        "errors": 1,
        "correction_attempts": 0,
        "successful_repetitions": 0,
        "failed_repetitions": 0,
    })

    # Recommended initial lesson
    init_lesson = generate_personalized_lesson("past_simple_auxiliary", 0.42, lesson_id=lesson_id)
    user_ref.collection("lessons").document(lesson_id).set({
        "lesson_id": lesson_id,
        "source_skill_id": "past_simple_auxiliary",
        "lesson_title": init_lesson.lesson_title,
        "completion_status": "recommended",
        "status": "recommended",
        "mastery_before": 0.42,
        "mastery_after": 0.42,
        **init_lesson.model_dump(),
        "created_at": now,
    })

    print(f"  • User ID: {uid}")
    print(f"  • Pravaah Level: {initial_profile['pravaah_level']} (Assessed Level unchanged)")
    print(f"  • CEFR Reference: {initial_profile['cefr_reference']}")
    print(f"  • Current Focus Skill: past_simple_auxiliary (Mastery: 0.42 / 42%)")
    print(f"  • Recommended Lesson ID: {lesson_id}")
    print(f"    - Title: {init_lesson.lesson_title}")
    print(f"    - Rule: {init_lesson.rule_summary}")
    print(f"    - Practice Prompt: '{init_lesson.practice_activity}'")

    print(f"\n[STEP 2] LEARNER LAUNCHES TARGETED PRACTICE SESSION")
    print("-" * 80)
    # API creates session with target_skill and lesson_id
    user_ref.collection("sessions").document(session_id).set({
        "session_id": session_id,
        "mode": "grammar_practice",
        "target_skill": "past_simple_auxiliary",
        "lesson_id": lesson_id,
        "start_time": now,
        "duration_seconds": 90,
        "state": "CREATED",
    })
    # Lesson document transitions to in_progress
    user_ref.collection("lessons").document(lesson_id).set({
        "completion_status": "in_progress",
        "status": "in_progress",
        "session_id": session_id,
    }, merge=True)
    print(f"  • Created Session: {session_id} (mode='grammar_practice', target='past_simple_auxiliary')")
    print(f"  • Lesson Status: 'in_progress'")

    print(f"\n[STEP 3] TUTOR AGENT CONVERSATIONAL TARGETED PRACTICE CONTEXT")
    print("-" * 80)
    lesson_ctx = {
        "target_skill": "past_simple_auxiliary",
        "lesson_id": lesson_id,
        "lesson_title": init_lesson.lesson_title,
        "rule_summary": init_lesson.rule_summary,
        "practice_activity": init_lesson.practice_activity,
    }
    tutor = EnglishTutor(
        user_id=uid,
        session_id=session_id,
        target_skill="past_simple_auxiliary",
        lesson_context=lesson_ctx,
    )
    print("  • Tutor System Instructions (snippet):")
    print("    \"" + tutor.instructions[:250].replace("\n", " ") + "...\"")
    print(f"  • Tutor Natural Elicitation Greeting:")
    print(f"    \"Hi there! Today let's practice using 'didn't' with base verbs. {init_lesson.practice_activity}\"")

    print(f"\n[STEP 4] REALTIME CONVERSATION TURNS & LEARNER PERFORMANCE")
    print("-" * 80)
    messages = [
        {"role": "assistant", "sequence": 1, "text": "Hi there! Tell me three things you didn't do yesterday.", "message_id": f"{session_id}_m1"},
        {"role": "user", "sequence": 2, "text": "Yesterday I didn't went to market and I didn't watched TV.", "message_id": f"{session_id}_m2"},
        {"role": "assistant", "sequence": 3, "text": "Good start! Small correction: Say 'I didn't go to market and I didn't watch TV.' Try repeating that!", "message_id": f"{session_id}_m3"},
        {"role": "user", "sequence": 4, "text": "I didn't go to market and I didn't watch TV.", "message_id": f"{session_id}_m4"},
        {"role": "assistant", "sequence": 5, "text": "Perfect! That was very clear. What else did you do?", "message_id": f"{session_id}_m5"},
    ]
    for msg in messages:
        role_label = "Learner" if msg["role"] == "user" else "AI Tutor"
        print(f"  [{role_label}]: {msg['text']}")

    print(f"\n[STEP 5] SERVER-SIDE LEARNING ENGINE PERSISTENCE & MASTERY UPDATE")
    print("-" * 80)
    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.96,
                short_explanation="Use base verb with didn't (didn't go).",
                session_id=session_id,
                message_id=f"{session_id}_m2",
            )
        ],
        vocabulary=[],
    )

    profile_after = await update_learner_mastery(uid, session_id, analysis, messages)

    print(f"\n[STEP 6] POST-LESSON FIRESTORE STATE")
    print("-" * 80)
    skill_doc = user_ref.collection("skills").document("past_simple_auxiliary").get().to_dict()
    lesson_doc = user_ref.collection("lessons").document(lesson_id).get().to_dict()
    user_doc = user_ref.get().to_dict()

    print("  1. SKILL RECORD (users/{uid}/skills/past_simple_auxiliary):")
    print(f"     • skill_id: {skill_doc.get('skill_id')}")
    print(f"     • mastery: {skill_doc.get('mastery')} (0.420 - 0.080 + 0.120 = 0.460)")
    print(f"     • attempts (total learner turns): {skill_doc.get('attempts')}")
    print(f"     • correction_attempts (prompted): {skill_doc.get('correction_attempts')}")
    print(f"     • successful_repetitions: {skill_doc.get('successful_repetitions')}")
    print(f"     • failed_repetitions: {skill_doc.get('failed_repetitions')}")
    print(f"     • errors: {skill_doc.get('errors')}")

    print("\n  2. COMPLETED LESSON RECORD (users/{uid}/lessons/{lesson_id}):")
    print(f"     • lesson_id: {lesson_doc.get('lesson_id')}")
    print(f"     • source_skill_id: {lesson_doc.get('source_skill_id')}")
    print(f"     • completion_status: '{lesson_doc.get('completion_status')}'")
    print(f"     • mastery_before: {lesson_doc.get('mastery_before')}")
    print(f"     • mastery_after: {lesson_doc.get('mastery_after')}")
    print(f"     • duration_seconds: {lesson_doc.get('duration_seconds')}s")
    print(f"     • successful_repetitions: {lesson_doc.get('successful_repetitions')}")

    print("\n  3. LEARNER PROFILE & NEXT RECOMMENDED LESSON (users/{uid}):")
    print(f"     • pravaah_level: '{user_doc.get('pravaah_level')}' (Preserved, no auto-downgrade)")
    print(f"     • cefr_reference: '{user_doc.get('cefr_reference')}'")
    print(f"     • current_focus: '{user_doc.get('current_focus')}'")
    next_rec = user_doc.get("recommended_lesson", {})
    print(f"     • Next Recommended Lesson ID: {next_rec.get('lesson_id')}")
    print(f"       - Title: {next_rec.get('lesson_title')}")
    print(f"       - Target Skill: {next_rec.get('target_skill_id')}")
    print(f"       - Practice Prompt: '{next_rec.get('practice_activity')}'")

    print("\n" + "=" * 80)
    print("  PHASE 4 TARGETED LESSON EXECUTION SHOWCASE: COMPLETED SUCCESSFULLY")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(run_showcase())

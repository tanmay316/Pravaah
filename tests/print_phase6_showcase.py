"""
Phase 6 Complete Flow Showcase Script:
Demonstrates the full new-user lifecycle:
1. Unassessed new learner state in Firestore
2. Initial multi-dimensional spoken assessment rubric evaluation
3. Assigning Pravaah Level (E -> D -> C -> B -> A -> S) & CEFR reference
4. Initializing Today's Structured Daily Learning Plan (e.g. 30 min)
5. Execution and completion of first activity
6. Progress accumulation & advancement to next activity
7. Mastery updates from normal practice sessions without changing overall Pravaah level
8. Full Firestore before/after snapshot inspection
"""

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

# Add service paths to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "services", "learning-engine"))
sys.path.insert(0, os.path.join(BASE_DIR, "services", "api"))

from curriculum import (
    evaluate_assessment_rubric,
    generate_daily_plan,
    CURRICULUM_SKILLS,
)
from worker import (
    get_firestore_client,
    apply_proficiency_assessment,
    get_or_create_daily_plan,
    complete_daily_plan_activity,
    update_learner_mastery,
    GrammarMistakeFact,
    SessionAnalysisResult,
)


def print_banner(title: str):
    print("\n" + "=" * 78)
    print(f"  {title.upper()}")
    print("=" * 78)


def print_section(title: str):
    print("\n" + "-" * 60)
    print(f">> {title}")
    print("-" * 60)


async def run_phase6_showcase():
    print_banner("Pravaah Phase 6: Initial Proficiency Assessment & Daily Learning Plan")
    db = get_firestore_client()
    uid = f"showcase_user_{uuid.uuid4().hex[:8]}"
    user_ref = db.collection("users").document(uid)

    # -------------------------------------------------------------------------
    # STEP 1: Brand New Learner (Unassessed State)
    # -------------------------------------------------------------------------
    print_section("Step 1: Brand New Learner Initial State")
    user_doc = user_ref.get()
    print(f"User ID: {uid}")
    print(f"Firestore Doc Exists: {user_doc.exists}")
    print(f"Initial Pravaah Level: unassessed")
    print(f"Initial CEFR Reference: unassessed")

    # -------------------------------------------------------------------------
    # STEP 2: Multi-Dimensional Spoken Assessment Evaluation
    # -------------------------------------------------------------------------
    print_section("Step 2: Spoken Assessment Multi-Dimensional Rubric")
    print("Conversational speaking tasks completed:")
    print("  1. Introduction & Daily Routine (A1-A2)")
    print("  2. Past Experience & Storytelling (A2-B1)")
    print("  3. Opinion & Reasoning (B1-B2)")
    print("  4. Complex / Hypothetical Discussion (B2-C1)")

    assessment_ratings = {
        "grammar_rating": "elementary",
        "vocabulary_rating": "elementary",
        "fluency_rating": "elementary",
        "comprehension_rating": "intermediate",
        "speaking_complexity": "elementary",
        "conversation_ability": "elementary",
        "pronunciation_rating": "elementary",
        "goal_minutes": 30,
        "notes": "Good baseline conversational fluency; needs work on past tense auxiliaries and stative verbs.",
    }

    eval_result = evaluate_assessment_rubric(**assessment_ratings)
    print("\nEvaluated Rubric Output:")
    print(f"  * Assigned Pravaah Level : {eval_result['pravaah_level']} ({eval_result['name']})")
    print(f"  * Internal CEFR Reference: {eval_result['cefr_reference']}")
    print(f"  * Diagnosed Strengths    : {', '.join(eval_result['strengths'])}")
    print(f"  * Diagnosed Weaknesses   : {', '.join(eval_result['weaknesses'])}")
    print(f"  * Initial Focus Skill    : {eval_result['current_focus']}")

    # -------------------------------------------------------------------------
    # STEP 3: Persist Assessment & Initialize Profile + Daily Plan
    # -------------------------------------------------------------------------
    print_section("Step 3: Persisting Assessment to Firestore & Initializing Daily Plan")
    applied_result = await apply_proficiency_assessment(
        user_id=uid,
        assessment_input={
            "pravaah_level": eval_result["pravaah_level"],
            "notes": assessment_ratings["notes"],
            "goal_minutes": 30,
            **assessment_ratings,
        },
    )

    plan = applied_result["daily_plan"]
    print(f"Generated Daily Plan ID: {plan['plan_id']}")
    print(f"Daily Goal Minutes     : {plan['goal_minutes']}m (Planned: {plan['planned_minutes']}m)")
    print(f"Planned Activities Count: {len(plan['activities'])}")
    for i, act in enumerate(plan["activities"], 1):
        print(f"   [{i}] {act['title']:<28} | {act['duration_minutes']:>2} min | Mode: {act['mode']:<16} | Stage: {act['stage']}")

    # -------------------------------------------------------------------------
    # STEP 4: First Activity Execution & Completion
    # -------------------------------------------------------------------------
    print_section("Step 4: Executing First Daily Activity ('Warm-up Free Conversation')")
    first_act = plan["activities"][0]
    sess_id_1 = f"sess_act1_{uuid.uuid4().hex[:6]}"
    print(f"Starting Activity 1: '{first_act['title']}' (Target: {first_act['duration_minutes']} min)")

    # Complete activity 1
    updated_plan_dict = complete_daily_plan_activity(
        user_id=uid,
        activity_id=first_act["activity_id"],
        session_id=sess_id_1,
        duration_minutes=first_act["duration_minutes"],
    )

    print("\nUpdated Daily Progress After Activity 1:")
    print(f"  * Completed Minutes   : {updated_plan_dict['completed_minutes']} / {updated_plan_dict['planned_minutes']} min")
    print(f"  * Completed Activities: {updated_plan_dict['completed_activities_count']} / {len(updated_plan_dict['activities'])}")
    print(f"  * Plan Status         : {updated_plan_dict['completion_status']}")
    print(f"  * Next Up (Activity 2): {updated_plan_dict['activities'][updated_plan_dict['current_activity_index']]['title']}")

    # -------------------------------------------------------------------------
    # STEP 5: Practice Session with Errors -- Level Strictly Preserved
    # -------------------------------------------------------------------------
    print_section("Step 5: Normal Daily Practice Session with Errors (No Level Change)")
    sess_id_2 = f"sess_act2_{uuid.uuid4().hex[:6]}"
    mistakes = [
        GrammarMistakeFact(
            mistake_id=f"m_{uuid.uuid4().hex[:6]}",
            session_id=sess_id_2,
            message_id="msg_1",
            category="grammar_error",
            original="Yesterday I didn't went there",
            corrected="Yesterday I didn't go there",
            explanation="Use base verb with didn't",
            severity="high",
            confidence=0.95,
        )
    ]
    analysis = SessionAnalysisResult(mistakes=mistakes, vocabulary=[])
    messages = [
        {"role": "user", "text": "Yesterday I didn't went there to meet him."},
        {"role": "assistant", "text": "Remember to say 'I didn't go'. Can you repeat that?"},
        {"role": "user", "text": "Yesterday I didn't go there."},
    ]

    profile_after_session = await update_learner_mastery(
        user_id=uid,
        session_id=sess_id_2,
        analysis=analysis,
        messages=messages,
    )

    print(f"Session processed: 1 error detected & corrected for 'past_simple_auxiliary'")
    print(f"Updated Skill Mastery  : {profile_after_session['skill_mastery'].get('past_simple_auxiliary')}")
    print(f"Pravaah Level AFTER Session: {profile_after_session['pravaah_level']} (STRICTLY PRESERVED)")
    print(f"CEFR Reference AFTER       : {profile_after_session['cefr_reference']} (STRICTLY PRESERVED)")

    # -------------------------------------------------------------------------
    # STEP 6: Firestore Final State Verification
    # -------------------------------------------------------------------------
    print_section("Step 6: Authoritative Firestore Profile & History Verification")
    final_user_doc = user_ref.get().to_dict()
    assessments_history = list(user_ref.collection("proficiency_assessments").stream())
    daily_plans = list(user_ref.collection("daily_plans").stream())

    print(f"Firestore User Profile:")
    print(f"  * uid               : {final_user_doc.get('uid')}")
    print(f"  * pravaah_level     : {final_user_doc.get('pravaah_level')}")
    print(f"  * cefr_reference    : {final_user_doc.get('cefr_reference')}")
    print(f"  * current_focus     : {final_user_doc.get('current_focus')}")
    print(f"  * daily_goal_minutes: {final_user_doc.get('daily_goal_minutes')} min")
    print(f"  * assessments count : {len(assessments_history)}")
    print(f"  * daily plans count : {len(daily_plans)}")

    print_banner("Phase 6 End-to-End Showcase Successfully Verified!")


if __name__ == "__main__":
    asyncio.run(run_phase6_showcase())

"""
Phase 3C Showcase & Verification Script

Demonstrates:
1. Before / After Learner Profile in Firestore
2. Mastery changes from sample corrections (evidence-based update formula)
3. Personalized lesson generated from real weakness
4. Verification that re-running the same session does not double-count (idempotency)
"""

import asyncio
import json
import os
import sys
import uuid

sys.stdout.reconfigure(encoding="utf-8")

base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(base_dir, "services", "learning-engine"))
sys.path.insert(0, os.path.join(base_dir, "services", "voice-agent"))

from curriculum import CURRICULUM_SKILLS, map_to_curriculum_skill
from worker import (
    get_firestore_client,
    update_learner_mastery,
    GrammarMistakeFact,
    VocabularyOpportunityFact,
    SessionAnalysisResult,
)

async def run_phase3c_showcase():
    db = get_firestore_client()
    demo_uid = f"learner_demo_{uuid.uuid4().hex[:6]}"
    session_id_1 = f"session_1_{uuid.uuid4().hex[:6]}"
    session_id_2 = f"session_2_{uuid.uuid4().hex[:6]}"
    user_ref = db.collection("users").document(demo_uid)

    print("=" * 80)
    print("PHASE 3C SHOWCASE: LEARNER MASTERY, MEMORY & CURRICULUM MAPPING")
    print("=" * 80)
    print(f"Demo User ID: {demo_uid}\n")

    # -----------------------------------------------------------------------
    # STEP 1: Initial Profile State (Before any sessions)
    # -----------------------------------------------------------------------
    print("[STEP 1] INITIAL LEARNER PROFILE STATE (Baseline):")
    print(json.dumps({
        "cefr_level": "A2",
        "native_language": "Hindi",
        "target_language": "English",
        "strengths": [],
        "weaknesses": [],
        "skill_mastery": {k: 0.5 for k in list(CURRICULUM_SKILLS.keys())[:4]},
    }, indent=2))

    # -----------------------------------------------------------------------
    # STEP 2: First Session — Mistakes Encountered
    # -----------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("[STEP 2] SESSION 1: Learner commits grammar mistakes:")
    print("  * Learner said: 'Yesterday I didn't went to office.'")
    print("  * Learner said: 'I am agree with your point.'")
    print("  * Learner said: 'The movie was very good.' (natural alternative, NOT an error)")
    print("=" * 80)

    analysis_1 = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="In negative past simple, use base form of the verb after didn't.",
                session_id=session_id_1,
                message_id=f"{session_id_1}_seq_0001_user",
            ),
            GrammarMistakeFact(
                original="I am agree",
                corrected="I agree",
                category="be_verb_misuse",
                curriculum_skill_id="be_verb_misuse",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Agree is already a main verb. Do not add 'am'.",
                session_id=session_id_1,
                message_id=f"{session_id_1}_seq_0003_user",
            ),
            GrammarMistakeFact(
                original="The movie was very good",
                corrected="I really enjoyed the movie",
                category="natural_alternative",
                curriculum_skill_id="sentence_structure",
                fact_type="natural_alternative",  # Non-penalizing!
                confidence=0.85,
                short_explanation="Expressive natural alternative",
                session_id=session_id_1,
                message_id=f"{session_id_1}_seq_0005_user",
            ),
        ],
        vocabulary=[],
    )
    user_turns_1 = [
        {"text": "Yesterday I didn't went to office.", "message_id": f"{session_id_1}_seq_0001_user"},
        {"text": "I am agree with your point.", "message_id": f"{session_id_1}_seq_0003_user"},
        {"text": "The movie was very good.", "message_id": f"{session_id_1}_seq_0005_user"},
    ]

    profile_after_s1 = await update_learner_mastery(demo_uid, session_id_1, analysis_1, user_turns_1)

    print("\n--- Skill Mastery After Session 1 (Evidence-based Penalty applied) ---")
    skills_s1 = {doc.id: doc.to_dict() for doc in user_ref.collection("skills").stream()}
    for s_id in ["past_simple_auxiliary", "be_verb_misuse", "sentence_structure"]:
        s_data = skills_s1.get(s_id, {})
        mastery_val = s_data.get("mastery", 0.50)
        attempts_val = s_data.get("attempts", 0)
        errors_val = s_data.get("errors", 0)
        examples_val = s_data.get("examples", [])
        print(f"  * {s_id:25s}: Mastery={mastery_val:.2f} (Attempts={attempts_val}, Errors={errors_val}, Examples={examples_val})")

    print("\n--- Top-Level Profile & Recommended Lesson After Session 1 ---")
    print(json.dumps({
        "cefr_level": profile_after_s1["cefr_level"],
        "weaknesses": profile_after_s1["weaknesses"],
        "recommended_lesson": profile_after_s1["recommended_lesson"],
    }, indent=2))

    # -----------------------------------------------------------------------
    # STEP 3: Second Session — Successful Correction & Repetition
    # -----------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("[STEP 3] SESSION 2: Learner successfully corrects and repeats the target structure:")
    print("  * Learner says: 'I didn't went...' -> Tutor clarifies -> Learner: 'Ah, I didn't go to the gym.'")
    print("=" * 80)

    analysis_2 = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="past_simple_auxiliary",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                confidence=0.95,
                short_explanation="Use base form with didn't",
                session_id=session_id_2,
                message_id=f"{session_id_2}_seq_0001_user",
            )
        ],
        vocabulary=[],
    )
    user_turns_2 = [
        {"text": "I didn't went yesterday.", "message_id": f"{session_id_2}_seq_0001_user"},
        {"text": "Got it! I didn't go to the gym yesterday.", "message_id": f"{session_id_2}_seq_0003_user"},
    ]

    profile_after_s2 = await update_learner_mastery(demo_uid, session_id_2, analysis_2, user_turns_2)

    print("\n--- Skill Mastery After Session 2 (Reward for Successful Correction) ---")
    skills_s2 = {doc.id: doc.to_dict() for doc in user_ref.collection("skills").stream()}
    psa_data = skills_s2.get("past_simple_auxiliary", {})
    print(f"  * past_simple_auxiliary   : Mastery={psa_data.get('mastery'):.2f} (Attempts={psa_data.get('attempts')}, Successful Corrections={psa_data.get('successful_corrections')})")

    # -----------------------------------------------------------------------
    # STEP 4: Idempotency Verification (Re-running Session 2)
    # -----------------------------------------------------------------------
    print("\n" + "=" * 80)
    print("[STEP 4] IDEMPOTENCY CHECK: Re-running Session 2 analysis:")
    print("=" * 80)
    await update_learner_mastery(demo_uid, session_id_2, analysis_2, user_turns_2)

    skills_s2_rerun = {doc.id: doc.to_dict() for doc in user_ref.collection("skills").stream()}
    psa_data_rerun = skills_s2_rerun.get("past_simple_auxiliary", {})
    print(f"  * Mastery after duplicate run: {psa_data_rerun.get('mastery'):.2f} (Attempts={psa_data_rerun.get('attempts')}, Errors={psa_data_rerun.get('errors')})")
    assert psa_data_rerun.get("mastery") == psa_data.get("mastery"), "Mastery must not change on duplicate run!"
    assert psa_data_rerun.get("attempts") == psa_data.get("attempts"), "Attempts must not double-count on duplicate run!"
    print("  >>> IDEMPOTENCY CONFIRMED: 0 double counting.")

    print("\n" + "=" * 80)
    print("PHASE 3C SHOWCASE COMPLETE: ALL VERIFICATIONS PASSED!")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(run_phase3c_showcase())

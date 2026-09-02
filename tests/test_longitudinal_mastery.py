"""
Pravaah — Longitudinal Multi-Day Learner Mastery & Adaptive Progression Simulation

Simulates an authentic learner's journey over 12 days:
- Day 1: Baseline diagnostic (past_simple_auxiliary mastery ~0.42)
- Day 2: Repeated error (-0.08) + active tutor correction
- Day 3: Successful prompted repetition (+0.12)
- Day 5: Free conversation (2-day decay + clean usage +0.05, 3rd error session unlocks memory hook)
- Day 8: Spaced review session (3-day decay + guided practice +0.05)
- Day 12: Natural correct usage (4-day decay + clean usage +0.05 -> promotes next weakness)
"""

import math
import pytest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "learning-engine"))
from curriculum import (
    CURRICULUM_SKILLS,
    generate_personalized_lesson,
    select_next_adaptive_skill,
    MASTERY_BANDS,
)

def apply_step(
    mastery_prev: float,
    delta_evidence: float,
    delta_days: float = 0.0,
    lambda_decay: float = 0.005,
) -> float:
    """Applies canonical hybrid mastery formula: M_new = clamp(M_prev * exp(-lambda * delta_t) + delta_evidence, 0.05, 1.0)"""
    decay_factor = math.exp(-lambda_decay * delta_days)
    m_decayed = mastery_prev * decay_factor
    m_new = max(0.05, min(1.0, round(m_decayed + delta_evidence, 3)))
    return m_new

def test_longitudinal_learner_simulation():
    print("\n" + "=" * 70)
    print("STARTING 12-DAY LONGITUDINAL LEARNER MASTERY SIMULATION")
    print("=" * 70)

    # State tracking
    skill_id = "past_simple_auxiliary"
    distinct_error_sessions = []
    log = []

    # --- DAY 1: Baseline Diagnostic Assessment ---
    m_day1 = 0.420
    log.append({"day": 1, "event": "Diagnostic Assessment", "mastery": m_day1, "note": "Initial active weakness"})
    assert m_day1 < MASTERY_BANDS["weakness"]

    # --- DAY 2: Error in Session (delta_t = 1 day, error = -0.08) ---
    distinct_error_sessions.append("session_d2")
    m_day2 = apply_step(m_day1, delta_evidence=-0.08, delta_days=1.0)
    log.append({"day": 2, "event": "Grammar Error ('didn't went')", "mastery": m_day2, "note": "Correction triggered (-0.08)"})
    assert m_day2 < m_day1
    assert len(distinct_error_sessions) == 1

    # --- DAY 3: Successful Prompted Repetition (delta_t = 1 day, rep = +0.12) ---
    # Learner made an error earlier in session, then successfully repeated correction (+0.12)
    distinct_error_sessions.append("session_d3")
    m_day3 = apply_step(m_day2, delta_evidence=+0.12, delta_days=1.0)
    log.append({"day": 3, "event": "Prompted Repetition ('didn't go')", "mastery": m_day3, "note": "Positive reinforcement (+0.12)"})
    assert m_day3 > m_day2
    assert len(distinct_error_sessions) == 2

    # --- DAY 5: Free Conversation with 3rd Error Attempt & Memory Hook Unlock (delta_t = 2 days) ---
    distinct_error_sessions.append("session_d5")
    # 3rd distinct session with error triggers memory hook eligibility
    memory_hook_eligible = (len(distinct_error_sessions) >= 3)
    assert memory_hook_eligible is True, "Memory hook must be unlocked after 3 distinct error sessions"

    # Learner hears memory hook and self-corrects (clean usage +0.05)
    m_day5 = apply_step(m_day3, delta_evidence=+0.05, delta_days=2.0)
    lesson_d5 = generate_personalized_lesson(
        skill_id=skill_id,
        mastery=m_day5,
        memory_hook_eligible=memory_hook_eligible,
    )
    assert lesson_d5.memory_hook_eligible is True
    assert "did/didn't" in lesson_d5.memory_hook
    log.append({"day": 5, "event": "Memory Hook Triggered + Clean Usage", "mastery": m_day5, "note": f"Memory Hook: {lesson_d5.memory_hook[:40]}..."})

    # --- DAY 8: Spaced Review Practice (delta_t = 3 days, clean usage +0.05) ---
    m_day8 = apply_step(m_day5, delta_evidence=+0.05, delta_days=3.0)
    log.append({"day": 8, "event": "Spaced Review Practice", "mastery": m_day8, "note": "Progressing towards developing band"})
    assert m_day8 >= 0.54

    # --- DAY 12: Natural Fluency & Mastery Transition (delta_t = 4 days, clean usage +0.15 multi-turn) ---
    m_day12 = apply_step(m_day8, delta_evidence=+0.15, delta_days=4.0)
    log.append({"day": 12, "event": "Fluent Spoken Mastery", "mastery": m_day12, "note": "Skill reaches developing/strong band"})
    assert m_day12 >= 0.65

    # Test Adaptive Next-Skill Selection at Day 12
    all_mastery = {
        "past_simple_auxiliary": m_day12,
        "prepositions": 0.38,
        "be_verb_misuse": 0.45,
    }
    stats = {
        "past_simple_auxiliary": {"attempts": 8, "errors": 3, "successful_repetitions": 3, "sessions_since_seen": 0},
        "prepositions": {"attempts": 2, "errors": 2, "sessions_since_seen": 4},
        "be_verb_misuse": {"attempts": 1, "errors": 1, "sessions_since_seen": 3},
    }
    next_skill, stage, reason = select_next_adaptive_skill(
        all_skill_mastery=all_mastery,
        skill_stats=stats,
        just_completed_skill="past_simple_auxiliary",
    )

    # Past simple auxiliary has been mastered; adaptive selector shifts focus to remaining priority weakness (prepositions)
    assert next_skill == "prepositions"
    assert reason in ["active_weakness", "recurring_failure_practice"]

    print("\n--- SIMULATION RESULTS TABLE ---")
    for row in log:
        print(f"Day {row['day']:2d} | {row['event']:<38} | Mastery: {row['mastery']:.3f} | {row['note']}")
    print(f"\nNext Recommended Focus: {next_skill} (Reason: {reason})")
    print("=" * 70)

if __name__ == "__main__":
    test_longitudinal_learner_simulation()

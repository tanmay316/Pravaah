# Pravaah — Real Learner Multi-Day Testing Protocol (Phase 9)

> [!IMPORTANT]
> **Simulation vs Empirical Evidence Disclaimer**:
> Software simulations (e.g. 12-day Markov simulations) validate the mathematical correctness and stability of the learning engine's state transitions, mastery decay functions, and lesson progression.
> **They do NOT constitute empirical scientific proof of human language acquisition.**
> Efficacy claims must be grounded in the multi-day empirical trial protocol detailed below.

---

## 1. Study Overview & Cohort Design

- **Cohort Size**: 15–30 Hindi-speaking English learners.
- **Initial Proficiency Target**: Pravaah Levels E, D, C (CEFR A1–B1 equivalents).
- **Trial Schedule**: 14 Days (Testing Milestones at Day 1, Day 3, Day 7, Day 14).
- **Session Cadence**: Daily 10–15 minute spoken conversational session.

---

## 2. Milestone Evaluation Matrix

| Milestone | Activity Type | Measured Quantitative Indicators | Measured Qualitative Indicators |
| :--- | :--- | :--- | :--- |
| **Day 1** (Baseline) | 4-Question Diagnostic Assessment + 10-min Free Speech | Baseline level (E/D/C/B/A/S), initial error counts per curriculum skill, silence ratio | Initial learner anxiety, self-reported confidence (1–5 scale) |
| **Day 3** (Early Retention) | Target Lesson (Weakness 1) + Conversation | Unprompted clean usage vs recurrence of targeted error, prompted repetition success rate | Frustration with interruptions or explanations |
| **Day 7** (Mid-Point Check) | Review Lesson (Weakness 1) + Target Lesson (Weakness 2) | Mastery decay resistance, memory hook recall, multi-turn dialogue length | Perceived naturalness, helpfulness of Hindi memory hooks |
| **Day 14** (Post-Trial Test) | Comprehensive Diagnostic Re-Assessment + Free Roleplay | CEFR/Pravaah Level delta, net mastery change, recurring mistake reduction rate | Perceived fluency improvement, overall satisfaction, Willingness to Recommend (NPS) |

---

## 3. Data Collection Protocol

### Quantitative Metrics:
1. **Target-Skill Error Rate**: Total occurrences of target error per 100 spoken words.
2. **Prompted Repetition Accuracy**: Percentage of tutor corrections correctly repeated on the first prompt.
3. **Unprompted Clean Usage**: Spontaneous grammatically correct usage of previously failed structures.
4. **Calculated Skill Mastery ($M_t$)**: Deterministic mastery score tracking under the hybrid decay formula.
5. **System Latency Metrics**: Perceived response delay vs measured TTFA (P50/P95).

### Qualitative / Experiential Metrics (Post-Session Survey):
1. **Helpfulness Score (1–5)**: *"Did the tutor's correction help you understand the rule?"*
2. **Conversation Flow (1–5)**: *"Did the conversation feel natural or robotic?"*
3. **Frustration Index (1–5)**: *"Did you feel interrupted or overwhelmed by corrections?"*
4. **Hindi Hook Utility (1–5)**: *"Was the Hindi memory explanation easy to remember?"*

---

## 4. Acceptance Criteria for Production Efficacy

1. **Repetition Success Rate**: $\ge 80\%$ of prompted corrections successfully repeated accurately.
2. **Target Error Reduction**: $\ge 35\%$ decrease in recurring target errors by Day 14 across active learners.
3. **Positive Experiential Rating**: $\ge 4.2 / 5.0$ average rating for tutor patience, clarity, and naturalness.
4. **Low Frustration**: $\le 1.5 / 5.0$ average frustration score regarding tutor turn pacing and single-question rule.

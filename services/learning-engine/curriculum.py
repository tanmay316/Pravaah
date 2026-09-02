"""
English Coach AI — Curriculum & Skill Matrix (Phase 5 Adaptive Progression)

Structured pedagogical definitions mapping learner weaknesses to curriculum skills,
adaptive mastery bands, 4-stage lesson progression, prompt variety, and review scheduling.
"""

import os
import math
import uuid
from typing import Optional, Literal
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Canonical Pravaah V1 Hybrid Mastery Formula & Parameters
# ---------------------------------------------------------------------------
# Initial tunable V1 parameter (default 0.005, configurable via env var)
MASTERY_DECAY_LAMBDA = float(os.getenv("MASTERY_DECAY_LAMBDA", "0.005"))

EVIDENCE_DELTAS = {
    "genuine_error": -0.08,
    "successful_prompted_repetition": 0.12,
    "clean_target_skill_usage": 0.05,
    "natural_alternative": 0.0,
}

def calculate_mastery_update(
    previous_mastery: float,
    evidence_delta: float,
    days_since_last_meaningful_evidence: float = 0.0,
    decay_lambda: float = MASTERY_DECAY_LAMBDA,
) -> tuple[float, float]:
    """
    Canonical Pravaah V1 Hybrid Mastery Formula:
      M_decay = M_previous * exp(-lambda * days_since_last_meaningful_evidence)
      M_new = clamp(M_decay + evidence_delta, 0.05, 1.0)
    
    Deterministic IEEE 754 precision rounded to 4 decimals internally.
    Returns:
      (m_decay, m_new_clamped)
    """
    days = max(0.0, float(days_since_last_meaningful_evidence))
    m_decay = float(previous_mastery) * math.exp(-float(decay_lambda) * days)
    m_decay = round(m_decay, 4)
    
    m_new = m_decay + float(evidence_delta)
    m_new_clamped = max(0.05, min(1.0, round(m_new, 4)))
    return m_decay, m_new_clamped

# ---------------------------------------------------------------------------
# Adaptive Mastery Bands & Lesson Stages (Configuration-driven)
# ---------------------------------------------------------------------------

MASTERY_BANDS = {
    "weakness": 0.60,      # < 0.60: active weakness / prioritize practice
    "developing": 0.75,    # 0.60 - 0.75: developing / continue with lower frequency
    "strong": 0.90,        # 0.75 - 0.90: strong / mix into conversation review
    "mastered": 1.00,      # >= 0.90: mastered / stop prioritizing unless review due
}

LESSON_STAGES = {
    "introduction": "introduction",
    "guided_practice": "guided_practice",
    "conversational_practice": "conversational_practice",
    "review": "review",
}

# ---------------------------------------------------------------------------
# Curriculum Skills Matrix with Varied Practice Activities
# ---------------------------------------------------------------------------

CURRICULUM_SKILLS = {
    "past_simple_auxiliary": {
        "title": "Past Simple: did/didn't + base verb",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "In negative past simple sentences or questions, 'did' or 'didn't' already carries the past tense. Always follow it with the base form of the verb (e.g., 'didn't go', NOT 'didn't went').",
        "memory_hook": "Remember: did/didn't ke saath hamesha verb ki base form lagti hai — say 'didn't go', not 'didn't went'.",
        "practice_activity": "Tell me three things you didn't do yesterday.",
        "activities": [
            "Tell me three things you didn't do yesterday.",
            "Think about a movie or show you watched. What didn't you like about it?",
            "Tell me about a trip or weekend where something didn't go according to plan.",
            "Ask me two questions about what I did or didn't do last weekend.",
        ],
        "keywords": ["didn't", "did not", "did you", "did went", "did came", "did saw", "didn't went", "didn't saw", "didn't bought"],
    },
    "past_simple": {
        "title": "Past Simple: Regular & Irregular Verbs",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "When talking about completed actions in the past (yesterday, last week, ago), use the past simple form of the verb (e.g., 'went', 'bought', 'saw').",
        "memory_hook": "Remember: past events (yesterday, last week) ke liye verb ki 2nd form lagti hai (went, saw, played).",
        "practice_activity": "Describe two things you bought or places you visited last weekend.",
        "activities": [
            "Describe two things you bought or places you visited last weekend.",
            "Tell me about your favorite childhood memory and what happened.",
            "Describe your first day at your current school, college, or job.",
            "Tell me about a delicious meal you ate recently and who cooked it.",
        ],
        "keywords": ["yesterday", "last year", "last week", "ago", "went", "bought", "go to market"],
    },
    "stative_verbs": {
        "title": "Stative Verbs (No Continuous -ing)",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "Verbs expressing states, possession, emotions, or thoughts (have, know, like, love, understand) are usually not used in continuous '-ing' form (e.g., 'I have two brothers', NOT 'I am having').",
        "memory_hook": "Remember: feelings ya possession wale verbs mein '-ing' nahi lagta — say 'I know', not 'I am knowing'.",
        "practice_activity": "Tell me about your family or what you know about your favorite city.",
        "activities": [
            "Tell me about your family or what you know about your favorite city.",
            "Describe three things you own or carry with you every day using 'I have...'",
            "Tell me about a subject or skill you understand really well.",
            "Describe your favorite food and explain why you like it.",
        ],
        "keywords": ["am having", "is having", "are having", "is knowing", "am knowing", "are knowing", "is understanding"],
    },
    "subject_verb_agreement": {
        "title": "Subject-Verb Agreement (He/She/It + Verbs with -s)",
        "category": "grammar",
        "cefr_level": "A1",
        "rule_summary": "Third-person singular subjects (he, she, it, singular nouns) take verbs ending in '-s' or '-es' (e.g., 'He doesn't know', 'She works here').",
        "memory_hook": "Remember: he/she/it ke saath verb mein '-s' ya '-es' lagta hai — say 'he knows', not 'he know'.",
        "practice_activity": "Describe your best friend's daily routine using three sentences.",
        "activities": [
            "Describe your best friend's daily routine using three sentences.",
            "Tell me about a colleague or family member and what they do for work.",
            "Describe a famous person and what they do in their free time.",
            "Tell me what your pet or a neighbor's pet does every morning.",
        ],
        "keywords": ["he don't", "she don't", "it don't", "he go", "she want", "he like"],
    },
    "be_verb_misuse": {
        "title": "Be Verbs vs. Main Verbs (I agree vs. I am agree)",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "'Agree' is already a main verb. Do not add 'am/is/are' before main verbs in simple present (say 'I agree', NOT 'I am agree').",
        "memory_hook": "Remember: 'agree' khud main verb hai — say 'I agree', not 'I am agree'.",
        "practice_activity": "Give your opinion on remote work: start with 'I agree that...' or 'I disagree that...'",
        "activities": [
            "Give your opinion on remote work: start with 'I agree that...' or 'I disagree that...'",
            "Do you agree or disagree that artificial intelligence will replace jobs? Give two reasons.",
            "Tell me your opinion on public transport vs. driving private cars using 'I agree/disagree'.",
            "Share your perspective on living in big cities vs. peaceful towns.",
        ],
        "keywords": ["am agree", "is agree", "are agree", "am disagree"],
    },
    "prepositions": {
        "title": "Prepositions with Verbs & Sports",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "Some English verbs take direct objects without prepositions (e.g., 'discuss this', NOT 'discuss about this'; 'play cricket', NOT 'play with cricket').",
        "memory_hook": "Remember: 'discuss' ya 'play' ke baad extra preposition nahi lagta — say 'discuss this', not 'discuss about this'.",
        "practice_activity": "Tell me what topic you want to discuss, and what sports or games you play.",
        "activities": [
            "Tell me what topic you want to discuss, and what sports or games you play.",
            "Tell me about an important project or idea you discussed with someone recently.",
            "What sports or outdoor games do you or your friends play on weekends?",
            "Describe when you usually reach your office or home in the evening.",
        ],
        "keywords": ["discuss about", "play with cricket", "play with football", "reach to", "order for"],
    },
    "articles": {
        "title": "Definite & Indefinite Articles (a/an/the)",
        "category": "grammar",
        "cefr_level": "A1",
        "rule_summary": "Use 'a'/'an' for singular countable nouns mentioned for the first time, and 'the' for specific or previously mentioned things (e.g., 'went to the market and bought a shirt').",
        "memory_hook": "Remember: singular countable cheezon ke sath 'a'/'an' aur specific cheezon ke liye 'the' use karein.",
        "practice_activity": "Name three items in your room using 'a', 'an', or 'the'.",
        "activities": [
            "Name three items in your room using 'a', 'an', or 'the'.",
            "Describe what you bought during your last shopping trip using 'a', 'an', and 'the'.",
            "Describe a delicious fruit, an interesting book, and the best cafe in your city.",
            "Tell me about a vehicle you want to buy and the road you would drive it on.",
        ],
        "keywords": ["go to market", "buy one shirt", "missing article", "wrong article"],
    },
    "collocations": {
        "title": "Natural Word Pairings & Collocations",
        "category": "vocabulary",
        "cefr_level": "A2",
        "rule_summary": "Certain words naturally go together in English (e.g., 'have a party' NOT 'make a party'; 'have a question' NOT 'have one doubt').",
        "memory_hook": "Remember: 'make a party' nahi 'have a party', aur 'take a decision' ki jagah 'make a decision' bolte hain.",
        "practice_activity": "Tell me about a party or event you had recently.",
        "activities": [
            "Tell me about a party or event you had recently.",
            "Tell me about an important decision you made recently and what happened.",
            "If you have a question or doubt during meetings, how do you ask for clarification?",
            "Describe a small mistake you made while cooking or working and how you fixed it.",
        ],
        "keywords": ["made a party", "have one doubt", "make a party", "take a decision", "do a mistake"],
    },
    "sentence_structure": {
        "title": "English Word Order & Structure (SVO)",
        "category": "grammar",
        "cefr_level": "A2",
        "rule_summary": "Standard English follows Subject + Verb + Object word order (e.g., 'I want to learn English', NOT 'English I want to learn').",
        "memory_hook": "Remember: English ka basic sentence order hai Subject + Verb + Object (jaise 'I like coffee').",
        "practice_activity": "Tell me what you want to achieve this year.",
        "activities": [
            "Tell me what you want to achieve this year.",
            "Describe your daily schedule from morning to evening in 3 clear sentences.",
            "Tell me why you are learning English and what your main goal is.",
            "Describe what you enjoy doing on a rainy day.",
        ],
        "keywords": ["word order", "inverted order", "sentence structure"],
    },
}

# Product-facing proficiency levels (unchanged by daily practice)
PRAVAAH_LEVELS = {
    "E": {"name": "Beginner", "cefr_reference": "A1", "description": "Can understand and produce very basic English."},
    "D": {"name": "Basic", "cefr_reference": "A1–A2", "description": "Can communicate simple everyday information with significant help."},
    "C": {"name": "Elementary", "cefr_reference": "A2", "description": "Can handle familiar conversations but makes frequent grammar/vocabulary mistakes."},
    "B": {"name": "Intermediate", "cefr_reference": "B1", "description": "Can hold everyday conversations, explain experiences and give opinions."},
    "A": {"name": "Advanced", "cefr_reference": "B2–C1", "description": "Can speak naturally and confidently about complex topics with relatively few errors."},
    "S": {"name": "Mastery", "cefr_reference": "C1–C2+", "description": "Can communicate fluently, precisely and naturally across everyday, academic and professional situations."},
}


def cefr_reference_for_pravaah_level(pravaah_level: str) -> str:
    """Return the internal curriculum reference for a product proficiency level."""
    if not pravaah_level or str(pravaah_level).lower() == "unassessed":
        return "unassessed"
    return PRAVAAH_LEVELS.get(pravaah_level, {}).get("cefr_reference", "unassessed")


# ---------------------------------------------------------------------------
# Adaptive Stage & Activity Selection Helpers (Phase 5)
# ---------------------------------------------------------------------------

def determine_lesson_stage(mastery: float, attempts: int = 0, successful_repetitions: int = 0) -> str:
    """
    Determines pedagogical stage based on mastery and learner evidence.
    Stages:
    - introduction: mastery < 0.35 or 0 attempts
    - guided_practice: 0.35 <= mastery < 0.60 (focus on elicitation + repetition)
    - conversational_practice: 0.60 <= mastery < 0.85 (open-ended conversational usage)
    - review: mastery >= 0.85 (occasional check-in)
    """
    if mastery < 0.35 or attempts == 0:
        return "introduction"
    elif mastery < 0.60:
        return "guided_practice"
    elif mastery < 0.85:
        return "conversational_practice"
    else:
        return "review"


def get_varied_practice_activity(
    skill_id: str,
    stage: str = "guided_practice",
    attempt_count: int = 0,
    previous_prompts: Optional[list[str]] = None,
) -> str:
    """
    Selects a varied conversational practice prompt so learners never receive the exact same prompt indefinitely.
    """
    skill_meta = CURRICULUM_SKILLS.get(skill_id, CURRICULUM_SKILLS["past_simple_auxiliary"])
    activities = skill_meta.get("activities", [skill_meta.get("practice_activity")])
    if not activities:
        return skill_meta.get("practice_activity", "Let's practice speaking in English.")

    prev = previous_prompts or []
    # Find first activity not in recent previous prompts
    for act in activities:
        if act not in prev:
            return act

    # Fallback to rotating by attempt count if all have been seen
    index = attempt_count % len(activities)
    return activities[index]


def select_next_adaptive_skill(
    all_skill_mastery: dict[str, float],
    skill_stats: Optional[dict[str, dict]] = None,
    just_completed_skill: Optional[str] = None,
    session_count: int = 0,
) -> tuple[str, str, str]:
    """
    Adaptive deterministic skill selection algorithm:
    - Returns (selected_skill_id, stage, selection_reason)
    - Considers mastery, error frequency, recency, repetitions, and review intervals.
    - Avoids repeating just-completed skill if another weak skill exists.
    - Keeps skill active if mastery remains low.
    - Schedules mastered skills for conversational review.
    - Fast-tracks failed review repetitions back to guided practice.
    """
    stats = skill_stats or {}

    # Identify active diagnosed weaknesses (where learner has evidence or low baseline)
    active_diagnosed_weaknesses = [
        s for s, m in all_skill_mastery.items()
        if (m < MASTERY_BANDS["weakness"]) and (stats.get(s, {}).get("attempts", 0) > 0 or stats.get(s, {}).get("errors", 0) > 0 or m < 0.50)
    ]

    scored_candidates = []

    for skill_id, mastery in all_skill_mastery.items():
        s_data = stats.get(skill_id, {})
        errors = s_data.get("errors", 0)
        attempts = s_data.get("attempts", 0)
        failed_reps = s_data.get("failed_repetitions", 0)
        last_sess_idx = s_data.get("last_session_index", 0)
        sessions_since_seen = session_count - last_sess_idx if session_count >= last_sess_idx else 0

        # Base weakness priority: lower mastery -> higher priority
        priority = (1.0 - mastery) * 100.0

        # Unattempted default skills have lower priority than active diagnosed weaknesses
        if attempts == 0 and errors == 0 and mastery == 0.50:
            priority = 30.0

        # Error frequency weight
        priority += 15.0 * min(errors, 4)

        # Recurring failure penalty weight (fast-track attention)
        priority += 25.0 * min(failed_reps, 3)

        # Recency adjustment for just-completed skill:
        if skill_id == just_completed_skill:
            other_active = [s for s in active_diagnosed_weaknesses if s != skill_id]
            if mastery >= MASTERY_BANDS["weakness"]:
                priority -= 35.0  # Graduated to developing, encourage other skills
            elif other_active:
                priority -= 25.0  # Other diagnosed weaknesses exist, cycle to them
            # If this is the only active weakness and still < 0.60, keep priority high!

        # Mastered review scheduling:
        # If skill is mastered (>= 0.85) and has not been reviewed in >= 3 sessions, give it a review bonus
        if mastery >= 0.85:
            if failed_reps > 0:
                # Immediate review due to failure
                priority = 85.0 + (failed_reps * 15.0)
                reason = "recurring_failure_review"
            elif sessions_since_seen >= 3:
                priority = 50.0 + (sessions_since_seen * 5.0)
                reason = "spaced_review_due"
            else:
                priority = -10.0  # Mastered and recently reviewed
                reason = "mastered"
        elif failed_reps > 0:
            reason = "recurring_failure_practice"
        elif mastery < MASTERY_BANDS["weakness"]:
            reason = "active_weakness"
        elif mastery < MASTERY_BANDS["developing"]:
            reason = "developing_skill"
        else:
            reason = "strong_skill"

        stage = determine_lesson_stage(mastery, attempts=attempts)
        if reason in ["spaced_review_due", "recurring_failure_review"]:
            stage = "review"
        elif reason == "recurring_failure_practice":
            stage = "guided_practice"

        scored_candidates.append({
            "skill_id": skill_id,
            "mastery": mastery,
            "priority": priority,
            "stage": stage,
            "reason": reason,
        })

    # Sort descending by priority
    scored_candidates.sort(key=lambda x: x["priority"], reverse=True)

    if scored_candidates:
        top = scored_candidates[0]
        return top["skill_id"], top["stage"], top["reason"]

    # Default fallback
    return "past_simple_auxiliary", "guided_practice", "default_focus"


# ---------------------------------------------------------------------------
# Personalized Lesson Model (Phase 5)
# ---------------------------------------------------------------------------

class PersonalizedLesson(BaseModel):
    lesson_id: str = Field(default_factory=lambda: f"lsn_{uuid.uuid4().hex[:8]}", description="Unique lesson identifier")
    target_skill_id: str = Field(..., description="Curriculum skill ID")
    lesson_title: str = Field(..., description="Human readable lesson title")
    category: str = Field(default="grammar", description="grammar | vocabulary")
    cefr_level: str = Field(default="A2", description="Target CEFR level")
    stage: str = Field(default="guided_practice", description="introduction | guided_practice | conversational_practice | review")
    rule_summary: str = Field(..., description="Concise rule explanation")
    practice_activity: str = Field(..., description="Targeted speaking prompt")
    mastery_score: float = Field(default=0.5, description="Learner's current mastery in this skill")
    selection_reason: str = Field(default="active_weakness", description="active_weakness | developing_skill | review")
    memory_hook: Optional[str] = Field(default=None, description="Optional 1-sentence Hindi/Hinglish memory hook for recurring errors")
    memory_hook_eligible: bool = Field(default=False, description="True if error occurred across >=3 distinct sessions")


def map_to_curriculum_skill(category: str, original_text: str = "", explanation: str = "") -> str:
    """
    Deterministically maps an error or category into a standard curriculum skill ID.
    """
    cat_lower = str(category).lower().strip()
    text_lower = str(original_text).lower().strip()
    expl_lower = str(explanation).lower().strip()

    # 1. Past simple auxiliary (didn't went, didn't saw, did you went)
    if "didn't" in text_lower or "did not" in text_lower or "did you" in text_lower or "auxiliary" in cat_lower or "auxiliary" in expl_lower:
        return "past_simple_auxiliary"

    # 2. Be verb misuse (I am agree)
    if "am agree" in text_lower or "is agree" in text_lower or "agree" in text_lower and "am" in text_lower or "be_verb" in cat_lower:
        return "be_verb_misuse"

    # 3. Stative verbs (I am having, knowing)
    if "stative" in cat_lower or "am having" in text_lower or "is having" in text_lower or "is knowing" in text_lower or "am knowing" in text_lower:
        return "stative_verbs"

    # 4. Subject-verb agreement (he don't, she want)
    if "agreement" in cat_lower or "subject_verb" in cat_lower or "don't" in text_lower and ("he" in text_lower or "she" in text_lower or "it" in text_lower):
        return "subject_verb_agreement"

    # 5. Prepositions (play with cricket, discuss about)
    if "preposition" in cat_lower or "discuss about" in text_lower or "play with" in text_lower:
        return "prepositions"

    # 6. Collocations & vocabulary errors (made a party, have a doubt)
    if "collocation" in cat_lower or "vocabulary" in cat_lower or "made a party" in text_lower or "one doubt" in text_lower or "do a mistake" in text_lower:
        return "collocations"

    # 7. Articles (missing a/an/the)
    if "article" in cat_lower or "a/an" in expl_lower or "the" in cat_lower:
        return "articles"

    # 8. Past simple regular/irregular (yesterday I go)
    if "past" in cat_lower or "yesterday" in text_lower or "past_tense" in cat_lower:
        return "past_simple"

    # 9. Word order / sentence structure
    if "order" in cat_lower or "structure" in cat_lower:
        return "sentence_structure"

    # Check direct match with curriculum skill IDs
    for skill_id in CURRICULUM_SKILLS:
        if skill_id in cat_lower:
            return skill_id

    return "sentence_structure"


def generate_personalized_lesson(
    skill_id: str,
    mastery: float = 0.5,
    stage: Optional[str] = None,
    attempt_count: int = 0,
    previous_prompts: Optional[list[str]] = None,
    selection_reason: str = "active_weakness",
    lesson_id: Optional[str] = None,
    memory_hook_eligible: bool = False,
) -> PersonalizedLesson:
    """
    Generates a structured, curriculum-backed personalized lesson with adaptive stage and prompt variety.
    """
    skill_info = CURRICULUM_SKILLS.get(skill_id, CURRICULUM_SKILLS["past_simple_auxiliary"])
    actual_lesson_id = lesson_id or f"lsn_{skill_id}_{uuid.uuid4().hex[:6]}"
    actual_stage = stage or determine_lesson_stage(mastery, attempts=attempt_count)
    prompt = get_varied_practice_activity(skill_id, stage=actual_stage, attempt_count=attempt_count, previous_prompts=previous_prompts)
    hook = skill_info.get("memory_hook") if memory_hook_eligible else None

    return PersonalizedLesson(
        lesson_id=actual_lesson_id,
        target_skill_id=skill_id,
        lesson_title=skill_info["title"],
        category=skill_info.get("category", "grammar"),
        cefr_level=skill_info["cefr_level"],
        stage=actual_stage,
        rule_summary=skill_info["rule_summary"],
        practice_activity=prompt,
        mastery_score=round(mastery, 3),
        selection_reason=selection_reason,
        memory_hook=hook,
        memory_hook_eligible=memory_hook_eligible,
    )


# ---------------------------------------------------------------------------
# Initial Proficiency Assessment Rubric (Phase 6)
# ---------------------------------------------------------------------------

ASSESSMENT_RUBRIC = {
    "E": {
        "name": "Beginner",
        "cefr_reference": "A1",
        "criteria": "Produces isolated words, fragmented phrases, frequent basic errors in subject-verb agreement or articles.",
        "weaknesses": ["subject_verb_agreement", "articles"],
        "strengths": [],
        "initial_focus": "subject_verb_agreement",
    },
    "D": {
        "name": "Basic",
        "cefr_reference": "A1–A2",
        "criteria": "Communicates basic everyday ideas with effort; common errors in past tense auxiliaries and be-verb misuse.",
        "weaknesses": ["past_simple_auxiliary", "be_verb_misuse"],
        "strengths": ["articles"],
        "initial_focus": "past_simple_auxiliary",
    },
    "C": {
        "name": "Elementary",
        "cefr_reference": "A2",
        "criteria": "Handles familiar everyday conversation but makes frequent grammatical errors in past tense or stative verbs.",
        "weaknesses": ["past_simple_auxiliary", "stative_verbs"],
        "strengths": ["subject_verb_agreement", "articles"],
        "initial_focus": "past_simple_auxiliary",
    },
    "B": {
        "name": "Intermediate",
        "cefr_reference": "B1",
        "criteria": "Speaks comfortably on familiar topics; main opportunities in prepositions and natural collocations.",
        "weaknesses": ["prepositions", "collocations"],
        "strengths": ["past_simple_auxiliary", "past_simple", "be_verb_misuse"],
        "initial_focus": "prepositions",
    },
    "A": {
        "name": "Advanced",
        "cefr_reference": "B2–C1",
        "criteria": "Speaks fluently and naturally about complex subjects; minor refinements in complex collocations or nuance.",
        "weaknesses": ["collocations", "sentence_structure"],
        "strengths": ["past_simple_auxiliary", "stative_verbs", "prepositions", "subject_verb_agreement"],
        "initial_focus": "collocations",
    },
    "S": {
        "name": "Mastery",
        "cefr_reference": "C1–C2+",
        "criteria": "Near-native precision, effortless fluency, broad range of vocabulary and idioms.",
        "weaknesses": [],
        "strengths": ["past_simple_auxiliary", "past_simple", "stative_verbs", "prepositions", "subject_verb_agreement", "articles", "collocations", "sentence_structure"],
        "initial_focus": "collocations",
    },
}


def evaluate_assessment_rubric(
    grammar_rating: str = "elementary",
    vocabulary_rating: str = "elementary",
    fluency_rating: str = "elementary",
    comprehension_rating: str = "elementary",
    speaking_complexity: str = "elementary",
    conversation_ability: str = "elementary",
    pronunciation_rating: str = "not_assessed",
    assigned_level: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Evaluates multi-dimensional assessor observations against the structured Pravaah rubric.
    Assigns product proficiency grade E, D, C, B, A, or S and returns initial diagnostic profile.
    Pronunciation is explicitly marked as not assessed in V1 (acoustic analysis deferred).
    """
    if assigned_level and assigned_level.upper() in ASSESSMENT_RUBRIC:
        level = assigned_level.upper()
    else:
        # Score mapping for qualitative ratings
        rating_scores = {
            "beginner": 1, "basic": 2, "elementary": 3, "intermediate": 4, "advanced": 5, "mastery": 6,
            "e": 1, "d": 2, "c": 3, "b": 4, "a": 5, "s": 6,
            "low": 1, "moderate": 3, "good": 4, "high": 5, "excellent": 6,
        }
        all_ratings = [
            str(grammar_rating).lower(),
            str(vocabulary_rating).lower(),
            str(fluency_rating).lower(),
            str(comprehension_rating).lower(),
            str(speaking_complexity).lower(),
            str(conversation_ability).lower(),
        ]
        avg_score = sum(rating_scores.get(r, 3) for r in all_ratings) / len(all_ratings)

        if avg_score < 1.8:
            level = "E"
        elif avg_score < 2.6:
            level = "D"
        elif avg_score < 3.6:
            level = "C"
        elif avg_score < 4.6:
            level = "B"
        elif avg_score < 5.6:
            level = "A"
        else:
            level = "S"

    rubric_entry = ASSESSMENT_RUBRIC[level]
    weaknesses = list(kwargs.get("weaknesses") or rubric_entry["weaknesses"])
    strengths = list(kwargs.get("strengths") or rubric_entry["strengths"])

    # Priority ordering for selecting immediate current_focus among diagnosed weaknesses
    focus_priority = [
        "past_simple_auxiliary",
        "past_simple",
        "be_verb_misuse",
        "subject_verb_agreement",
        "articles",
        "stative_verbs",
        "prepositions",
        "collocations",
        "sentence_structure",
    ]
    selected_focus = None
    if kwargs.get("current_focus"):
        selected_focus = kwargs["current_focus"]
    elif kwargs.get("initial_focus"):
        selected_focus = kwargs["initial_focus"]
    elif weaknesses:
        for p_skill in focus_priority:
            if p_skill in weaknesses:
                selected_focus = p_skill
                break
        if not selected_focus:
            selected_focus = weaknesses[0]
    else:
        selected_focus = rubric_entry["initial_focus"]

    current_focus = selected_focus

    return {
        "pravaah_level": level,
        "cefr_reference": rubric_entry["cefr_reference"],
        "name": rubric_entry["name"],
        "criteria": rubric_entry["criteria"],
        "grammar_rating": str(grammar_rating).lower(),
        "vocabulary_rating": str(vocabulary_rating).lower(),
        "fluency_rating": str(fluency_rating).lower(),
        "comprehension_rating": str(comprehension_rating).lower(),
        "speaking_complexity": str(speaking_complexity).lower(),
        "conversation_ability": str(conversation_ability).lower(),
        "pronunciation_rating": "not_assessed",
        "weaknesses": weaknesses,
        "strengths": strengths,
        "current_focus": current_focus,
        "pronunciation": "Not assessed in V1 (audio-level phonetic analysis deferred)",
    }


# ---------------------------------------------------------------------------
# Daily Learning Plan Models & Generator (Phase 6)
# ---------------------------------------------------------------------------

class DailyPlanActivity(BaseModel):
    activity_id: str = Field(..., description="Unique activity ID within daily plan")
    title: str = Field(..., description="User-facing activity title")
    mode: str = Field(..., description="free_conversation | grammar_practice | vocabulary | review | roleplay")
    target_skill: Optional[str] = Field(default=None, description="Target curriculum skill ID if applicable")
    duration_minutes: int = Field(..., description="Planned duration in minutes")
    stage: str = Field(default="guided_practice", description="Pedagogical stage")
    objective: str = Field(..., description="Specific practice goal for this activity")
    prompt_activity: str = Field(..., description="Conversational prompt used by tutor agent")
    is_completed: bool = Field(default=False, description="Whether activity has been completed today")
    session_id: Optional[str] = Field(default=None, description="Completed session ID")
    completed_at: Optional[str] = Field(default=None, description="ISO timestamp of completion")
    learner_speaking_time_seconds: Optional[int] = Field(default=None, description="Actual learner speaking audio duration")
    idle_time_seconds: Optional[int] = Field(default=None, description="Measured silence or idle time")


class DailyLearningPlan(BaseModel):
    plan_id: str = Field(..., description="Unique daily plan ID (e.g. plan_2026-08-30)")
    plan_date: str = Field(..., description="Plan date (YYYY-MM-DD)")
    goal_minutes: int = Field(default=30, description="Daily goal chosen by learner (15, 30, 60, 90)")
    planned_minutes: int = Field(default=30, description="Sum of activity durations")
    completed_minutes: int = Field(default=0, description="Sum of completed activity durations")
    activities: list[DailyPlanActivity] = Field(default_factory=list, description="Ordered activity sequence")
    completed_activities_count: int = Field(default=0, description="Number of completed activities")
    target_skills: list[str] = Field(default_factory=list, description="List of skills practiced today")
    completion_status: Literal["not_started", "in_progress", "completed"] = "not_started"
    current_activity_index: int = Field(default=0, description="Index of the next uncompleted activity")
    total_learner_speaking_seconds: Optional[int] = Field(default=None, description="Cumulative actual speaking time across sessions")
    total_idle_seconds: Optional[int] = Field(default=None, description="Cumulative idle duration across sessions")


def generate_daily_plan(
    user_id: str,
    goal_minutes: int = 30,
    weaknesses: Optional[list[str]] = None,
    current_focus: Optional[str] = None,
    skill_mastery: Optional[dict[str, float]] = None,
    date_str: Optional[str] = None,
) -> DailyLearningPlan:
    """
    Generates a structured, pedagogical Daily Practice Plan tailored to the learner's goal minutes (15, 30, 60, 90).
    Sequences varied speaking activities (Warmup -> Targeted Weakness -> Roleplay -> Vocabulary -> Spaced Review).
    Ensures the first targeted activity strictly focuses on current_focus.
    """
    from datetime import datetime, timezone
    today = date_str or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    plan_id = f"plan_{today}_{uuid.uuid4().hex[:6]}"

    user_weaknesses = list(weaknesses or ["past_simple_auxiliary", "be_verb_misuse"])
    mastery_dict = skill_mastery or {}

    primary_skill = current_focus or (user_weaknesses[0] if user_weaknesses else "past_simple_auxiliary")
    if primary_skill not in user_weaknesses:
        user_weaknesses.insert(0, primary_skill)

    secondary_skill = next((w for w in user_weaknesses if w != primary_skill), "be_verb_misuse")
    vocab_skill = "collocations"

    primary_meta = CURRICULUM_SKILLS.get(primary_skill, CURRICULUM_SKILLS["past_simple_auxiliary"])
    secondary_meta = CURRICULUM_SKILLS.get(secondary_skill, CURRICULUM_SKILLS["be_verb_misuse"])
    vocab_meta = CURRICULUM_SKILLS.get(vocab_skill, CURRICULUM_SKILLS["collocations"])

    primary_stage = determine_lesson_stage(mastery_dict.get(primary_skill, 0.42))
    secondary_stage = determine_lesson_stage(mastery_dict.get(secondary_skill, 0.45))

    activities: list[DailyPlanActivity] = []

    if goal_minutes <= 15:
        # 15 min plan: 5 min Warmup Conversation + 10 min Targeted Practice
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_1_warmup",
            title="Warm-up Conversation",
            mode="free_conversation",
            duration_minutes=5,
            stage="conversational_practice",
            objective="Get comfortable speaking English fluently about your day.",
            prompt_activity="Tell me how your day is going so far and what's on your mind!",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_2_target",
            title=f"Targeted Focus: {primary_meta['title']}",
            mode="grammar_practice",
            target_skill=primary_skill,
            duration_minutes=10,
            stage=primary_stage,
            objective=f"Practice {primary_meta['title']} in active speaking.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage=primary_stage, attempt_count=0),
        ))

    elif goal_minutes <= 30:
        # 30 min plan: 10m Free Conversation + 10m Targeted Grammar + 5m Vocabulary Boost + 5m Spaced Review
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_1_conv",
            title="Free Speaking Conversation",
            mode="free_conversation",
            duration_minutes=10,
            stage="conversational_practice",
            objective="Build natural speaking confidence through everyday open dialogue.",
            prompt_activity="Let's talk about your favorite hobbies and weekend activities!",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_2_target",
            title=f"Targeted Focus: {primary_meta['title']}",
            mode="grammar_practice",
            target_skill=primary_skill,
            duration_minutes=10,
            stage=primary_stage,
            objective=f"Master {primary_meta['title']} with active repetition.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage=primary_stage, attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_3_vocab",
            title="Natural Vocabulary & Collocations",
            mode="vocabulary",
            target_skill=vocab_skill,
            duration_minutes=5,
            stage="guided_practice",
            objective="Upgrade everyday phrasing to natural native collocations.",
            prompt_activity=get_varied_practice_activity(vocab_skill, stage="guided_practice", attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_4_review",
            title="Spaced Review & Wrap-up",
            mode="review",
            target_skill=secondary_skill,
            duration_minutes=5,
            stage="review",
            objective=f"Review retention of {secondary_meta['title']} in casual speaking.",
            prompt_activity=get_varied_practice_activity(secondary_skill, stage="review", attempt_count=1),
        ))

    elif goal_minutes <= 60:
        # 60 min plan: 10m Warmup + 15m Targeted Grammar 1 + 10m Roleplay + 10m Vocabulary + 10m Targeted Grammar 2 + 5m Spaced Review
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_1_warmup",
            title="Warm-up Speaking Dialogue",
            mode="free_conversation",
            duration_minutes=10,
            stage="conversational_practice",
            objective="Fluency warm-up and active listening.",
            prompt_activity="Tell me about an exciting goal or project you're working on!",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_2_target1",
            title=f"Targeted Practice: {primary_meta['title']}",
            mode="grammar_practice",
            target_skill=primary_skill,
            duration_minutes=15,
            stage=primary_stage,
            objective=f"Intensive speaking practice for {primary_meta['title']}.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage=primary_stage, attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_3_roleplay",
            title="Real-World Roleplay Scenario",
            mode="roleplay",
            duration_minutes=10,
            stage="conversational_practice",
            objective="Simulate a real-life conversation in a restaurant or workplace.",
            prompt_activity="Let's roleplay ordering food and making special requests at a restaurant!",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_4_vocab",
            title="Vocabulary & Expression Boost",
            mode="vocabulary",
            target_skill=vocab_skill,
            duration_minutes=10,
            stage="guided_practice",
            objective="Learn and produce natural English idioms and expressions.",
            prompt_activity=get_varied_practice_activity(vocab_skill, stage="guided_practice", attempt_count=1),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_5_target2",
            title=f"Secondary Skill: {secondary_meta['title']}",
            mode="grammar_practice",
            target_skill=secondary_skill,
            duration_minutes=10,
            stage=secondary_stage,
            objective=f"Strengthen accuracy for {secondary_meta['title']}.",
            prompt_activity=get_varied_practice_activity(secondary_skill, stage=secondary_stage, attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_6_review",
            title="Day's Summary & Spaced Review",
            mode="review",
            target_skill=primary_skill,
            duration_minutes=5,
            stage="review",
            objective="Consolidate today's learning gains into natural conversation.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage="review", attempt_count=2),
        ))

    else:
        # 90 min plan: 15m Free Conv + 20m Target 1 + 15m Roleplay + 15m Vocab + 15m Target 2 + 10m Spaced Review
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_1_conv",
            title="Deep Conversational Immersion",
            mode="free_conversation",
            duration_minutes=15,
            stage="conversational_practice",
            objective="Extended speaking fluency on personal and professional topics.",
            prompt_activity="Share your thoughts on living abroad vs living in your hometown!",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_2_target1",
            title=f"Core Mastery Focus: {primary_meta['title']}",
            mode="grammar_practice",
            target_skill=primary_skill,
            duration_minutes=20,
            stage=primary_stage,
            objective=f"Deep practice and guided repetition for {primary_meta['title']}.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage=primary_stage, attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_3_roleplay",
            title="Workplace & Professional Roleplay",
            mode="roleplay",
            duration_minutes=15,
            stage="conversational_practice",
            objective="Handle challenging conversational workplace scenarios.",
            prompt_activity="Roleplay a meeting where you pitch a new idea to your manager.",
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_4_vocab",
            title="Advanced Vocabulary & Idioms",
            mode="vocabulary",
            target_skill=vocab_skill,
            duration_minutes=15,
            stage="guided_practice",
            objective="Expand expressive range with natural native collocations.",
            prompt_activity=get_varied_practice_activity(vocab_skill, stage="guided_practice", attempt_count=1),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_5_target2",
            title=f"Secondary Skill: {secondary_meta['title']}",
            mode="grammar_practice",
            target_skill=secondary_skill,
            duration_minutes=15,
            stage=secondary_stage,
            objective=f"Reinforce accuracy for {secondary_meta['title']}.",
            prompt_activity=get_varied_practice_activity(secondary_skill, stage=secondary_stage, attempt_count=0),
        ))
        activities.append(DailyPlanActivity(
            activity_id=f"{plan_id}_act_6_review",
            title="Comprehensive Spaced Review",
            mode="review",
            target_skill=primary_skill,
            duration_minutes=10,
            stage="review",
            objective="Review all target structures covered throughout the 90-minute session.",
            prompt_activity=get_varied_practice_activity(primary_skill, stage="review", attempt_count=2),
        ))

    total_planned = sum(a.duration_minutes for a in activities)
    target_skills_list = list({a.target_skill for a in activities if a.target_skill})

    return DailyLearningPlan(
        plan_id=plan_id,
        plan_date=today,
        goal_minutes=goal_minutes,
        planned_minutes=total_planned,
        completed_minutes=0,
        activities=activities,
        completed_activities_count=0,
        target_skills=target_skills_list,
        completion_status="not_started",
        current_activity_index=0,
    )


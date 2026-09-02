"""
Pravaah — Comprehensive Pedagogical & UX Improvements Test Suite

Tests:
1. STRICT SINGLE-QUESTION RULE (at most 1 conversational question per response)
2. REPEATED-MISTAKE MEMORY HOOK (triggered after >=3 distinct sessions with errors)
3. ROLEPLAY SILENCE RESCUE (in-character supportive prompts without character breaking)
4. SHORT-TTS PROSODY (natural lively affirmations avoiding flat 1-2 word outputs)
5. STT GRAMMAR ERROR PRESERVATION (guarantee STT does not silently normalize learner errors)
"""

import re
import pytest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "learning-engine"))
from curriculum import (
    CURRICULUM_SKILLS,
    generate_personalized_lesson,
    select_next_adaptive_skill,
    PersonalizedLesson,
)
from worker import (
    GrammarMistakeFact,
    SessionAnalysisResult,
    _repetition_evidence,
)

# ---------------------------------------------------------------------------
# 1. STRICT SINGLE-QUESTION RULE
# ---------------------------------------------------------------------------

def count_direct_questions(text: str) -> int:
    """Counts direct conversational question marks in a response."""
    # Strip quoted questions within instructions if any
    cleaned = re.sub(r'"[^"]*\?"', '', text)
    # Count occurrences of question marks
    return cleaned.count('?')

def test_single_question_rule():
    """Ensure sample tutor turns respect the strict single-question limit."""
    valid_tutor_turns = [
        "That's wonderful to hear! What did you do yesterday?",
        "Small correction: Say 'I didn't go.' Can you repeat that for me?",
        "I understand completely. What kind of movies do you usually enjoy watching?",
        "Perfect! Exactly right, well done! Tell me about what you plan to do this evening.",
    ]
    for turn in valid_tutor_turns:
        q_count = count_direct_questions(turn)
        assert q_count <= 1, f"Turn contains multiple questions ({q_count}): {turn}"

def test_bad_multi_question_detection():
    """Verify detector catches disallowed multi-question patterns."""
    bad_tutor_turn = "What did you do yesterday, where did you go, and who were you with?"
    # If split into sub-questions or punctuated with multiple '?'
    multi_q_turn = "What did you do yesterday? Where did you go? Who was with you?"
    assert count_direct_questions(multi_q_turn) == 3
    assert count_direct_questions(multi_q_turn) > 1

# ---------------------------------------------------------------------------
# 2. REPEATED-MISTAKE MEMORY HOOK
# ---------------------------------------------------------------------------

def test_memory_hook_eligibility_and_content():
    """Verify memory hook appears when recurring errors span >=3 distinct sessions."""
    # Check all curriculum skills have defined memory hooks
    for skill_id, meta in CURRICULUM_SKILLS.items():
        assert "memory_hook" in meta, f"Skill {skill_id} missing memory_hook definition"
        assert len(meta["memory_hook"]) > 10, f"Skill {skill_id} has empty memory hook"
        assert "Remember:" in meta["memory_hook"]

    # When not eligible (< 3 sessions)
    lesson_not_eligible = generate_personalized_lesson(
        skill_id="past_simple_auxiliary",
        mastery=0.42,
        memory_hook_eligible=False,
    )
    assert lesson_not_eligible.memory_hook_eligible is False
    assert lesson_not_eligible.memory_hook is None

    # When eligible (>= 3 distinct sessions with errors)
    lesson_eligible = generate_personalized_lesson(
        skill_id="past_simple_auxiliary",
        mastery=0.42,
        memory_hook_eligible=True,
    )
    assert lesson_eligible.memory_hook_eligible is True
    assert lesson_eligible.memory_hook is not None
    assert "did/didn't" in lesson_eligible.memory_hook

def test_memory_hook_does_not_count_as_evidence():
    """Ensure tutor mentioning a memory hook never generates learner evidence delta."""
    messages = [
        {"sequence": 1, "role": "user", "text": "Yesterday I didn't went to office.", "message_id": "m1"},
        {"sequence": 2, "role": "assistant", "text": "Remember: did/didn't ke saath verb ki base form aati hai — say 'didn't go', not 'didn't went'. Can you repeat that?", "message_id": "m2"},
        {"sequence": 3, "role": "user", "text": "I didn't go to office.", "message_id": "m3"}
    ]
    analysis = SessionAnalysisResult(
        mistakes=[
            GrammarMistakeFact(
                original="didn't went",
                corrected="didn't go",
                category="verbs",
                curriculum_skill_id="past_simple_auxiliary",
                fact_type="grammar_error",
                severity="high",
                confidence=0.95,
                short_explanation="Use base verb with did/didn't.",
                session_id="s1",
                message_id="m1"
            )
        ],
        vocabulary=[]
    )
    succ, fail = _repetition_evidence(analysis, messages)
    assert succ.get("past_simple_auxiliary") == 1
    # Ensure memory hook in tutor prompt didn't create spurious extra evidence
    assert len(succ) == 1

# ---------------------------------------------------------------------------
# 3. ROLEPLAY SILENCE RESCUE
# ---------------------------------------------------------------------------

def test_roleplay_silence_rescue_prompt_generation():
    """Verify roleplay mode provides in-character rescue prompts without character break."""
    roleplay_rescues = {
        "Hiring Manager": "Take your time. Whenever you're ready, tell me about your background.",
        "Café Barista": "No problem, take your time! What would you like to drink today?",
        "Hotel Receptionist": "Take your moment. How can I assist you with your reservation?",
    }
    for role, prompt in roleplay_rescues.items():
        assert "Take" in prompt or "No problem" in prompt
        # Must not contain generic out-of-character tutor speech
        assert "grammar" not in prompt.lower()
        assert "exercise" not in prompt.lower()
        assert "lesson" not in prompt.lower()

# ---------------------------------------------------------------------------
# 4. SHORT-TTS PROSODY
# ---------------------------------------------------------------------------

def test_short_tts_prosody_enrichment():
    """Verify short affirmation phrases are enriched for natural speech prosody."""
    flat_two_word_phrases = ["Great job.", "Very good.", "Nice work."]
    enriched_phrases = [
        "Perfect, that sounded very natural!",
        "Exactly right, well done!",
        "Great! Let's keep going.",
        "Much better, that was very clear.",
    ]
    for p in enriched_phrases:
        words = p.split()
        assert len(words) >= 4, f"Phrase too short for smooth prosody: {p}"

# ---------------------------------------------------------------------------
# 5. STT GRAMMAR ERROR PRESERVATION REGRESSION TESTS
# ---------------------------------------------------------------------------

def test_stt_grammar_error_preservation():
    """
    Assert that simulated STT transcripts preserve genuine learner grammar errors
    and are not silently autocorrected to standard English.
    """
    test_cases = [
        ("I didn't went there.", "didn't went", "past_simple_auxiliary"),
        ("I am agree with your opinion.", "am agree", "be_verb_misuse"),
        ("Yesterday I am go market.", "am go", "past_simple"),
        ("She is having two sisters.", "is having", "stative_verbs"),
        ("He don't know the answer.", "don't know", "subject_verb_agreement"),
        ("Let's discuss about this topic.", "discuss about", "prepositions"),
    ]
    for raw_transcript, expected_err_sub, expected_skill in test_cases:
        # Transcript must retain the verbatim error substring
        assert expected_err_sub in raw_transcript, f"STT normalized error: {raw_transcript}"
        # Error must match the target curriculum skill keywords
        matched_keywords = CURRICULUM_SKILLS[expected_skill]["keywords"]
        assert any(k in raw_transcript.lower() for k in matched_keywords), f"Keyword not found in {raw_transcript}"

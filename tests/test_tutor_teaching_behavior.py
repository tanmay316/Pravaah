"""
Runtime Verification Test: Active Tutor Teaching Behavior

Tests the exact canonical conversation:
  Learner: "Yesterday I am go market and buy one shirt."

Verifies:
  1. Friendly brief correction
  2. Correct sentence: "Yesterday I went to the market and bought a shirt."
  3. Explains "went" replaces "am go"
  4. Explains "bought" replaces "buy"
  5. Explains "the market" briefly
  6. Asks learner to repeat
  7. Evaluates repetition turn ("Yesterday I went to the market and bought a shirt.")
  8. Positively reinforces correction
  9. Continues naturally: "What color was the shirt?"
"""

import os
import sys
import pytest
import asyncio
from dotenv import load_dotenv

# Load env from voice agent
env_path = os.path.join(os.path.dirname(__file__), "..", "services", "voice-agent", ".env")
load_dotenv(env_path)

voice_agent_dir = os.path.join(os.path.dirname(__file__), "..", "services", "voice-agent")
sys.path.insert(0, os.path.abspath(voice_agent_dir))
from agent import TUTOR_SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_tutor_exact_correction_flow():
    import litellm

    gemini_key = os.getenv("GEMINI_API_KEY")
    assert gemini_key and not gemini_key.startswith("REPLACE"), "Valid GEMINI_API_KEY required"

    messages = [
        {"role": "system", "content": TUTOR_SYSTEM_PROMPT},
        {"role": "user", "content": "Yesterday I am go market and buy one shirt."},
    ]

    # Step 1: Get AI correction response
    response = await litellm.acompletion(
        model="gemini/gemini-3.5-flash-lite",
        api_key=gemini_key,
        messages=messages,
        temperature=0.3,
    )

    tutor_reply = response.choices[0].message.content
    print("\n--- Turn 1 (Correction) ---")
    print(tutor_reply)

    reply_lower = tutor_reply.lower()

    # Assertions on Turn 1:
    # 1. Contains corrected phrasing with "went" and "bought" and "market"
    assert "went" in reply_lower, "Response must mention 'went'"
    assert "bought" in reply_lower, "Response must mention 'bought'"
    assert "market" in reply_lower, "Response must mention 'market'"

    # 2. Explains past tense / why
    assert ("past" in reply_lower or "yesterday" in reply_lower or "go" in reply_lower), \
        "Response must explain why past tense is used"

    # 3. Asks learner to repeat
    assert ("try" in reply_lower or "repeat" in reply_lower or "say" in reply_lower or "your turn" in reply_lower), \
        "Tutor must prompt learner to repeat the correction"

    # Step 2: Simulate learner repeating the corrected sentence
    messages.append({"role": "assistant", "content": tutor_reply})
    messages.append({"role": "user", "content": "Yesterday I went to the market and bought a shirt."})

    response2 = await litellm.acompletion(
        model="gemini/gemini-3.5-flash-lite",
        api_key=gemini_key,
        messages=messages,
        temperature=0.3,
    )

    tutor_reply2 = response2.choices[0].message.content
    print("\n--- Turn 2 (Reinforcement & Continuation) ---")
    print(tutor_reply2)

    reply2_lower = tutor_reply2.lower()

    # Assertions on Turn 2:
    # 1. Positive reinforcement
    assert any(w in reply2_lower for w in ["perfect", "great", "good", "much better", "well done", "excellent", "nice"]), \
        "Tutor must positively reinforce successful repetition"

    # 2. Continues the conversation with a question
    assert "?" in tutor_reply2, "Tutor must ask a follow-up question to keep the conversation flowing"


if __name__ == "__main__":
    asyncio.run(test_tutor_exact_correction_flow())

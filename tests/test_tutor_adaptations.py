"""
Runtime Verification Test: Tutor Adaptations & Edge Cases

Tests:
  1. Over-correction protection (valid natural English must NOT be falsely corrected)
  2. Repeated mistake escalation
  3. Hindi-English code switching & Hindi assistance when stuck
"""

import os
import sys
import pytest
import asyncio
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), "..", "services", "voice-agent", ".env")
load_dotenv(env_path)

voice_agent_dir = os.path.join(os.path.dirname(__file__), "..", "services", "voice-agent")
sys.path.insert(0, os.path.abspath(voice_agent_dir))
from agent import build_mode_instructions

TUTOR_SYSTEM_PROMPT = build_mode_instructions("free_conversation", None, {})


async def _call_tutor_llm(messages: list[dict], temperature: float = 0.25) -> str:
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        from openai import AsyncOpenAI
        async with AsyncOpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1") as client:
            resp = await client.chat.completions.create(
                model=os.getenv("GROQ_VOICE_MODEL", "qwen/qwen3.8-27b"),
                messages=messages,
                temperature=temperature,
                max_tokens=200,
                reasoning_effort="none",
            )
            return resp.choices[0].message.content or ""
    import litellm
    gemini_key = os.getenv("GEMINI_API_KEY")
    response = await litellm.acompletion(
        model="gemini/gemini-3.5-flash-lite",
        api_key=gemini_key,
        messages=messages,
        temperature=temperature,
    )
    return response.choices[0].message.content or ""


@pytest.mark.asyncio
async def test_overcorrection_protection():
    """Tutor must NOT invent errors or correct natural fluent English."""
    valid_sentences = [
        "I'm heading to the grocery store to pick up some fresh apples and bread.",
        "Could you tell me what time the train is scheduled to leave?",
        "I really enjoyed reading the book you recommended last week.",
    ]

    for sentence in valid_sentences:
        messages = [
            {"role": "system", "content": TUTOR_SYSTEM_PROMPT},
            {"role": "user", "content": sentence},
        ]
        reply = await _call_tutor_llm(messages, temperature=0.2)
        reply_lower = reply.lower()
        print(f"\nUser: {sentence}\nTutor: {reply}")

        # The tutor should NOT say "correction", "you should say", "mistake"
        assert "small correction" not in reply_lower
        assert "you should say" not in reply_lower
        assert "mistake" not in reply_lower
        assert "?" in reply, "Tutor should keep conversation flowing naturally with a question"


@pytest.mark.asyncio
async def test_hindi_assistance_when_requested():
    """When learner asks in Hindi or is stuck, tutor clarifies in Hindi and returns to English."""
    messages = [
        {"role": "system", "content": TUTOR_SYSTEM_PROMPT},
        {"role": "user", "content": "Mujhe samajh nahi aaya, stative verbs kya hote hain?"},
    ]

    reply = await _call_tutor_llm(messages, temperature=0.3)
    print(f"\nHindi Assistance Test:\nTutor: {reply}")

    # Must explain and provide an English example / follow-up
    assert len(reply) > 20
    assert "?" in reply, "Should end with an encouraging prompt to practice in English"


@pytest.mark.asyncio
async def test_repeated_mistake_progression():
    """Repeated mistakes should be addressed with clear guidance."""
    # Occurrence 1
    messages = [
        {"role": "system", "content": TUTOR_SYSTEM_PROMPT},
        {"role": "user", "content": "I am having three brothers."},
    ]
    reply1 = await _call_tutor_llm(messages, temperature=0.25)
    print(f"\nOccurrence 1:\n{reply1}")
    assert "have" in reply1.lower()

    # Occurrence 2
    messages.append({"role": "assistant", "content": reply1})
    messages.append({"role": "user", "content": "Yes, and my friend is also having a big car."})
    reply2 = await _call_tutor_llm(messages, temperature=0.25)
    print(f"\nOccurrence 2:\n{reply2}")
    assert ("has" in reply2.lower() or "have" in reply2.lower())


if __name__ == "__main__":
    asyncio.run(test_overcorrection_protection())
    asyncio.run(test_hindi_assistance_when_requested())
    asyncio.run(test_repeated_mistake_progression())

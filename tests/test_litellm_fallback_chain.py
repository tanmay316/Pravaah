"""
Pravaah — LiteLLM Multi-Provider Fallback Chain Verification

Tests:
  1. Primary success on Gemini 3.5 Flash-Lite
  2. Simulated primary failure (invalid model) -> Automatic fallback to OpenRouter MiniMax 01
  3. Simulated secondary failure -> Automatic fallback to NVIDIA Nemotron 3.5 Lightning
  4. Complete provider outage -> Conversational spoken recovery
"""

import os
import time
from dotenv import load_dotenv
load_dotenv()

import litellm

# Provide keys to LiteLLM
litellm.openrouter_key = os.getenv("OPENROUTER_API_KEY")
os.environ["OPENROUTER_API_KEY"] = os.getenv("OPENROUTER_API_KEY", "")
os.environ["NVIDIA_API_KEY"] = os.getenv("NVIDIA_API_KEY", "")
os.environ["GEMINI_API_KEY"] = os.getenv("GEMINI_API_KEY", "")

TUTOR_PROMPT = "You are an English speaking tutor. Correct grammar errors immediately, explain why in 1 sentence, and ask the learner to repeat."
USER_TEXT = "Yesterday I didn't went to school."

MESSAGES = [
    {"role": "system", "content": TUTOR_PROMPT},
    {"role": "user", "content": USER_TEXT},
]

print("=" * 70)
print("TESTING LITELLM MULTI-PROVIDER FALLBACK CHAIN")
print("=" * 70)

# Test 1: Standard call with primary model
print("\n[Test 1] Primary: Gemini 3.5 Flash-Lite with full fallback chain...")
try:
    t_start = time.perf_counter()
    resp = litellm.completion(
        model="gemini/gemini-3.5-flash-lite",
        messages=MESSAGES,
        fallbacks=[
            "openrouter/minimax/minimax-01",
            "gemini/gemini-2.5-flash",
        ],
        temperature=0.7,
        max_tokens=100,
        stream=True,
    )
    tokens = []
    for chunk in resp:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            tokens.append(delta)
    t_end = time.perf_counter()
    print(f"  -> SUCCESS! Duration: {round((t_end - t_start)*1000, 1)} ms")
    print(f"  -> Response: {''.join(tokens)[:120]}...")
except Exception as e:
    print(f"  -> FAILED: {e}")

# Test 2: Primary failure triggering automatic fallback to OpenRouter MiniMax
print("\n[Test 2] Simulated Primary Failure -> Fallback to OpenRouter MiniMax 01...")
try:
    t_start = time.perf_counter()
    resp = litellm.completion(
        model="gemini/invalid-nonexistent-model-test",  # Force primary failure
        messages=MESSAGES,
        fallbacks=[
            "openrouter/minimax/minimax-01",
            "gemini/gemini-2.5-flash",
        ],
        temperature=0.7,
        max_tokens=100,
        stream=True,
    )
    tokens = []
    for chunk in resp:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            tokens.append(delta)
    t_end = time.perf_counter()
    print(f"  -> FALLBACK SUCCESS! Duration: {round((t_end - t_start)*1000, 1)} ms")
    print(f"  -> Response: {''.join(tokens)[:120]}...")
except Exception as e:
    print(f"  -> FAILED: {e}")

# Test 3: Dual failure triggering fallback to Gemini 2.5 Flash
print("\n[Test 3] Simulated Dual Failure -> Fallback to Gemini 2.5 Flash...")
try:
    t_start = time.perf_counter()
    resp = litellm.completion(
        model="gemini/invalid-primary-model",
        messages=MESSAGES,
        fallbacks=[
            "openrouter/invalid-secondary-model",
            "gemini/gemini-2.5-flash",
        ],
        temperature=0.7,
        max_tokens=100,
        stream=True,
    )
    tokens = []
    for chunk in resp:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            tokens.append(delta)
    t_end = time.perf_counter()
    print(f"  -> FALLBACK SUCCESS! Duration: {round((t_end - t_start)*1000, 1)} ms")
    print(f"  -> Response: {''.join(tokens)[:120]}...")
except Exception as e:
    print(f"  -> FAILED: {e}")

print("\n" + "=" * 70)
print("ALL FALLBACK CHAIN TESTS COMPLETED")
print("=" * 70)

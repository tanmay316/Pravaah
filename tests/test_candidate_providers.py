"""
Pravaah — Candidate Providers Benchmark & Verification (Phase 9)

Tests live streaming latency and tutor quality on:
  1. Google Gemini (Gemini 3.5 Flash-Lite)
  2. OpenRouter (MiniMax, LLaMA 3.3 70B, etc.)
  3. NVIDIA NIM (DeepSeek / LLaMA)
"""

import os
import sys
import time
import json
from dotenv import load_dotenv
load_dotenv()

import litellm

# Set API keys in litellm environment
os.environ["OPENROUTER_API_KEY"] = os.getenv("OPENROUTER_API_KEY", "")
os.environ["NVIDIA_API_KEY"] = os.getenv("NVIDIA_API_KEY", "")
os.environ["GEMINI_API_KEY"] = os.getenv("GEMINI_API_KEY", "")

TUTOR_TEST_PROMPT = """You are an English speaking tutor for a Hindi-speaking learner.
1. Actively correct grammar errors immediately.
2. Explain the rule briefly (1 sentence) and explain WHY.
3. Ask the learner to repeat the correct phrase once.
4. Ask at most ONE direct question per turn.
5. Be warm and encouraging."""

TEST_UTTERANCE = "Yesterday I didn't went to the office because I was sick."

CANDIDATES = [
    {
        "provider": "Google",
        "model": "gemini/gemini-3.5-flash-lite",
        "label": "Gemini 3.5 Flash-Lite",
        "kwargs": {},
    },
    {
        "provider": "OpenRouter",
        "model": "openrouter/minimax/minimax-01",
        "label": "OpenRouter MiniMax 01",
        "kwargs": {"api_key": os.getenv("OPENROUTER_API_KEY")},
    },
    {
        "provider": "OpenRouter",
        "model": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        "label": "OpenRouter LLaMA 3.3 70B (Free)",
        "kwargs": {"api_key": os.getenv("OPENROUTER_API_KEY")},
    },
    {
        "provider": "NVIDIA NIM",
        "model": "nvidia_nim/meta/llama-3.3-70b-instruct",
        "label": "NVIDIA NIM LLaMA 3.3 70B",
        "kwargs": {"api_key": os.getenv("NVIDIA_API_KEY"), "api_base": "https://integrate.api.nvidia.com/v1"},
    },
    {
        "provider": "NVIDIA NIM",
        "model": "nvidia_nim/deepseek-ai/deepseek-r1",
        "label": "NVIDIA NIM DeepSeek R1",
        "kwargs": {"api_key": os.getenv("NVIDIA_API_KEY"), "api_base": "https://integrate.api.nvidia.com/v1"},
    },
]


def test_candidate(cand):
    print(f"\nTesting: {cand['label']} ({cand['model']})...")
    messages = [
        {"role": "system", "content": TUTOR_TEST_PROMPT},
        {"role": "user", "content": TEST_UTTERANCE},
    ]

    t_start = time.perf_counter()
    first_token_time = None
    accumulated_tokens = []

    try:
        response = litellm.completion(
            model=cand["model"],
            messages=messages,
            temperature=0.7,
            max_tokens=150,
            stream=True,
            **cand["kwargs"],
        )

        for chunk in response:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                if first_token_time is None:
                    first_token_time = time.perf_counter()
                accumulated_tokens.append(delta)

        t_end = time.perf_counter()
        if first_token_time is None:
            first_token_time = t_end

        ttft_ms = round((first_token_time - t_start) * 1000, 2)
        total_ms = round((t_end - t_start) * 1000, 2)
        full_text = "".join(accumulated_tokens).strip()

        print(f"  -> SUCCESS! TTFT: {ttft_ms} ms | Total Time: {total_ms} ms")
        print(f"  -> Response Preview: {full_text[:120]}...")
        return {
            "model": cand["model"],
            "label": cand["label"],
            "status": "SUCCESS",
            "ttft_ms": ttft_ms,
            "total_ms": total_ms,
            "response": full_text,
        }
    except Exception as e:
        print(f"  -> FAILED: {e}")
        return {
            "model": cand["model"],
            "label": cand["label"],
            "status": "FAILED",
            "error": str(e),
        }


if __name__ == "__main__":
    results = []
    for cand in CANDIDATES:
        res = test_candidate(cand)
        results.append(res)
        time.sleep(1.0)

    print("\n" + "=" * 60)
    print("SUMMARY COMPARISON")
    print("=" * 60)
    for r in results:
        if r["status"] == "SUCCESS":
            print(f"{r['label']:<32} | TTFT: {r['ttft_ms']:>7} ms | Total: {r['total_ms']:>7} ms | OK")
        else:
            print(f"{r['label']:<32} | FAILED: {r.get('error', 'Unknown')[:40]}")

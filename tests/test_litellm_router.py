"""
Pravaah — LiteLLM Router & Async Fallback Verification
"""

import os
import asyncio
import time
from dotenv import load_dotenv
load_dotenv()

import litellm
from litellm import Router

# Initialize LiteLLM Router with model list & fallback definitions
model_list = [
    {
        "model_name": "primary_tutor",
        "litellm_params": {
            "model": "gemini/gemini-3.5-flash-lite",
            "api_key": os.getenv("GEMINI_API_KEY"),
        },
    },
    {
        "model_name": "openrouter_minimax",
        "litellm_params": {
            "model": "openrouter/minimax/minimax-01",
            "api_key": os.getenv("OPENROUTER_API_KEY"),
        },
    },
    {
        "model_name": "nvidia_nemotron",
        "litellm_params": {
            "model": "openai/nvidia/nemotron-3.5-lightning-30b-a3b",
            "api_base": "https://integrate.api.nvidia.com/v1",
            "api_key": os.getenv("NVIDIA_API_KEY"),
        },
    },
    {
        "model_name": "gemini_flash_backup",
        "litellm_params": {
            "model": "gemini/gemini-2.5-flash",
            "api_key": os.getenv("GEMINI_API_KEY"),
        },
    },
]

fallbacks = [
    {"primary_tutor": ["openrouter_minimax", "nvidia_nemotron", "gemini_flash_backup"]}
]

router = Router(
    model_list=model_list,
    fallbacks=fallbacks,
)

async def test_router_stream():
    messages = [
        {"role": "system", "content": "You are an English speaking tutor. Correct grammar errors immediately, explain why in 1 sentence, and ask the learner to repeat."},
        {"role": "user", "content": "Yesterday I didn't went to school."},
    ]

    print("\n[Router Test 1] Normal async streaming via router...")
    t_start = time.perf_counter()
    resp = await router.acompletion(
        model="primary_tutor",
        messages=messages,
        temperature=0.7,
        max_tokens=100,
        stream=True,
    )

    tokens = []
    first_token_time = None
    async for chunk in resp:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            if first_token_time is None:
                first_token_time = time.perf_counter()
            tokens.append(delta)

    t_end = time.perf_counter()
    ttft_ms = round((first_token_time - t_start) * 1000, 2)
    total_ms = round((t_end - t_start) * 1000, 2)
    print(f"  -> SUCCESS! TTFT: {ttft_ms} ms | Total: {total_ms} ms")
    print(f"  -> Response: {''.join(tokens)[:120]}...")

asyncio.run(test_router_stream())

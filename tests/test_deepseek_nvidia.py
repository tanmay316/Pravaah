import os
import time
from dotenv import load_dotenv
load_dotenv()

import litellm

nv_key = os.getenv("NVIDIA_API_KEY")

messages = [
    {"role": "system", "content": "You are an English speaking tutor. Correct grammar mistakes and explain why."},
    {"role": "user", "content": "Yesterday I didn't went to the market."},
]

t_start = time.perf_counter()
first_token_time = None
tokens = []

try:
    response = litellm.completion(
        model="openai/deepseek-ai/deepseek-v4-flash-0731",
        messages=messages,
        api_base="https://integrate.api.nvidia.com/v1",
        api_key=nv_key,
        temperature=0.7,
        max_tokens=150,
        stream=True,
    )

    for chunk in response:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            if first_token_time is None:
                first_token_time = time.perf_counter()
            tokens.append(delta)

    t_end = time.perf_counter()
    ttft_ms = round((first_token_time - t_start) * 1000, 2)
    total_ms = round((t_end - t_start) * 1000, 2)
    print(f"NVIDIA DeepSeek-v4-flash-0731 SUCCESS!")
    print(f"TTFT: {ttft_ms} ms | Total Time: {total_ms} ms")
    print(f"Response: {''.join(tokens).strip()}")
except Exception as e:
    print(f"Error testing DeepSeek-v4-flash-0731: {e}")

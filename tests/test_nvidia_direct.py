import os
import time
import requests
import json
from dotenv import load_dotenv
load_dotenv()

nv_key = os.getenv("NVIDIA_API_KEY")

headers = {
    "Authorization": f"Bearer {nv_key}",
    "Content-Type": "application/json",
}

payload = {
    "model": "deepseek-ai/deepseek-v4-flash-0731",
    "messages": [
        {"role": "system", "content": "You are an English speaking tutor. Correct grammar mistakes and explain why."},
        {"role": "user", "content": "Yesterday I didn't went to the market."},
    ],
    "temperature": 0.7,
    "max_tokens": 150,
    "stream": True,
}

t_start = time.perf_counter()
first_token_time = None
tokens = []

try:
    resp = requests.post(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        headers=headers,
        json=payload,
        stream=True,
        timeout=15,
    )
    print("NVIDIA Response Status Code:", resp.status_code)
    for line in resp.iter_lines():
        if line:
            line_str = line.decode("utf-8")
            if line_str.startswith("data: ") and line_str != "data: [DONE]":
                chunk = json.loads(line_str[6:])
                delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if delta:
                    if first_token_time is None:
                        first_token_time = time.perf_counter()
                    tokens.append(delta)

    t_end = time.perf_counter()
    if first_token_time is None:
        first_token_time = t_end
    ttft_ms = round((first_token_time - t_start) * 1000, 2)
    total_ms = round((t_end - t_start) * 1000, 2)
    print(f"Direct NVIDIA NIM deepseek-v4-flash-0731:")
    print(f"TTFT: {ttft_ms} ms | Total Time: {total_ms} ms")
    print(f"Response: {''.join(tokens).strip()}")
except Exception as e:
    print(f"Direct NVIDIA Error: {e}")

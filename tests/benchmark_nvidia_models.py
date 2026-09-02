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

CANDIDATES = [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "minimaxai/minimax-m3",
    "nvidia/mistral-nemo-minitron-8b-8k-instruct",
    "nv-mistralai/mistral-nemo-12b-instruct",
    "mistralai/mistral-7b-instruct-v0.3",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "deepseek-ai/deepseek-v4-flash-0731",
    "openai/gpt-oss-20b",
]

payload_template = {
    "messages": [
        {"role": "system", "content": "You are an English speaking tutor. Correct grammar mistakes in 1 short sentence, explain why, and ask the learner to repeat. Be brief."},
        {"role": "user", "content": "Yesterday I didn't went to the market."},
    ],
    "temperature": 0.7,
    "max_tokens": 100,
    "stream": True,
}

print("=" * 70)
print("BENCHMARKING NVIDIA NIM MODELS LIVE")
print("=" * 70)

for model_id in CANDIDATES:
    payload = dict(payload_template)
    payload["model"] = model_id

    t_start = time.perf_counter()
    first_token_time = None
    tokens = []

    try:
        resp = requests.post(
            "https://integrate.api.nvidia.com/v1/chat/completions",
            headers=headers,
            json=payload,
            stream=True,
            timeout=10,
        )

        if resp.status_code != 200:
            print(f"[{model_id}] HTTP {resp.status_code}: {resp.text[:100]}")
            continue

        for line in resp.iter_lines():
            if line:
                line_str = line.decode("utf-8")
                if line_str.startswith("data: ") and line_str != "data: [DONE]":
                    try:
                        chunk = json.loads(line_str[6:])
                        delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            if first_token_time is None:
                                first_token_time = time.perf_counter()
                            tokens.append(delta)
                    except Exception:
                        pass

        t_end = time.perf_counter()
        if first_token_time is None:
            first_token_time = t_end

        ttft_ms = round((first_token_time - t_start) * 1000, 2)
        total_ms = round((t_end - t_start) * 1000, 2)
        resp_text = "".join(tokens).strip()

        print(f"[{model_id}]")
        print(f"  -> TTFT: {ttft_ms} ms | Total: {total_ms} ms")
        print(f"  -> Response: {resp_text[:120]}...\n")
    except Exception as e:
        print(f"[{model_id}] ERROR: {e}\n")
    time.sleep(0.5)

import os
import time
import requests
import json
from dotenv import load_dotenv
load_dotenv()

nv_key = os.getenv("NVIDIA_API_KEY")
headers = {
    "Authorization": f"Bearer {nv_key}",
    "Content-Type": "application/json"
}

resp = requests.get("https://integrate.api.nvidia.com/v1/models", headers=headers, timeout=10)
data = resp.json()
all_models = [m["id"] for m in data.get("data", [])]

print(f"Total models available on NVIDIA NIM: {len(all_models)}")
print("\nAll models:")
for m in sorted(all_models):
    print(f" - {m}")

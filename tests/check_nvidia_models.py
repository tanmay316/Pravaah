import os
import requests
import json
from dotenv import load_dotenv
load_dotenv()

nv_key = os.getenv("NVIDIA_API_KEY")
headers = {"Authorization": f"Bearer {nv_key}"}

try:
    resp = requests.get("https://integrate.api.nvidia.com/v1/models", headers=headers, timeout=10)
    data = resp.json()
    print("NVIDIA NIM Status Code:", resp.status_code)
    if "data" in data:
        models = [m["id"] for m in data["data"]]
        print("Available NVIDIA NIM models (first 20):", models[:20])
    else:
        print("Response:", data)
except Exception as e:
    print("Error querying NVIDIA NIM:", e)

import json
import subprocess
import os

# 1. Read apps/expo/package.json
with open(r"c:\Users\Tms\Desktop\pravaah\apps\expo\package.json", "r") as f:
    expo_pkg = json.load(f)

print("=== EXPO / NODE DEPENDENCIES ===")
deps = expo_pkg.get("dependencies", {})
for pkg in ["expo", "react-native", "@livekit/react-native", "livekit-client", "@react-native-firebase/app", "@react-native-firebase/auth", "firebase", "react-native-web"]:
    print(f"{pkg}: {deps.get(pkg, 'Not in package.json')}")

# 2. Check Python packages
import importlib.metadata

print("\n=== PYTHON DEPENDENCIES ===")
for pkg in ["livekit", "livekit-agents", "livekit-plugins-groq", "livekit-plugins-openai", "livekit-plugins-silero", "litellm", "fastapi", "firebase-admin", "pyttsx3"]:
    try:
        ver = importlib.metadata.version(pkg)
        print(f"{pkg}: {ver}")
    except Exception as e:
        print(f"{pkg}: Not installed ({e})")

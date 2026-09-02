import io
import pyttsx3
import soundfile as sf
import tempfile
import os

engine = pyttsx3.init()
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    temp_path = f.name

engine.save_to_file("Hello! This is English Coach AI speaking to you.", temp_path)
engine.runAndWait()

with open(temp_path, "rb") as f:
    data = f.read()

os.remove(temp_path)
print(f"Generated {len(data)} bytes of real spoken English audio!")

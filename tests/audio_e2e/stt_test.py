import os
import requests
from dotenv import load_dotenv

load_dotenv(r"c:\Users\Tms\Desktop\pravaah\services\voice-agent\.env")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

def transcribe(audio_path, language=None):
    with open(audio_path, 'rb') as f:
        files = {
            'file': (os.path.basename(audio_path), f, 'audio/wav'),
            'model': (None, 'whisper-large-v3')
        }
        if language:
            files['language'] = (None, language)
            
        headers = {'Authorization': f'Bearer {GROQ_API_KEY}'}
        response = requests.post('https://api.groq.com/openai/v1/audio/transcriptions', headers=headers, files=files)
        return response.json()

if __name__ == "__main__":
    audio_files = ["test2_cs1.wav", "test2_cs2.wav", "test2_cs3.wav"]
    for fname in audio_files:
        path = os.path.join(r"c:\Users\Tms\Desktop\pravaah\tests\audio_e2e", fname)
        if not os.path.exists(path):
            print(f"File not found: {path}")
            continue
            
        print(f"\n--- {fname} ---")
        en_result = transcribe(path, language="en")
        print(f"Language='en': {en_result.get('text', en_result)}")
        
        hi_result = transcribe(path, language="hi")
        print(f"Language='hi': {hi_result.get('text', hi_result)}")

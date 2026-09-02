import os
from gtts import gTTS
from pydub import AudioSegment

AUDIO_DIR = os.path.dirname(__file__)

def generate_audio(text, filename, lang='en', tld='com'):
    """Generate audio using gTTS and convert to 16kHz mono WAV for LiveKit"""
    print(f"Generating audio for: '{text}' -> {filename}")
    temp_mp3 = os.path.join(AUDIO_DIR, "temp.mp3")
    final_wav = os.path.join(AUDIO_DIR, filename)
    
    tts = gTTS(text=text, lang=lang, tld=tld)
    tts.save(temp_mp3)
    
    # Convert to 16kHz mono WAV which is ideal for WebRTC
    audio = AudioSegment.from_mp3(temp_mp3)
    audio = audio.set_frame_rate(16000).set_channels(1)
    audio.export(final_wav, format="wav")
    
    os.remove(temp_mp3)
    print(f"Saved {final_wav}")

def main():
    print("Generating e2e test audio files...")
    
    # Priority 4: Tutor Behavior Test
    generate_audio(
        "Yesterday I am go market and buy one shirt.", 
        "test4_learner_turn1.wav", 
        lang="en", tld="co.in" # Indian English accent
    )
    
    generate_audio(
        "Yesterday I went to the market and bought a shirt.", 
        "test4_learner_turn2.wav", 
        lang="en", tld="co.in"
    )
    
    # Priority 2: STT Language testing (Code-switching)
    generate_audio(
        "Kal main office gaya tha, but I had an important meeting.",
        "test2_cs1.wav",
        lang="hi"
    )
    
    generate_audio(
        "Mujhe samajh nahi aa raha, can you explain this?",
        "test2_cs2.wav",
        lang="hi"
    )
    
    generate_audio(
        "Yesterday I went to office aur then I met my manager.",
        "test2_cs3.wav",
        lang="hi"
    )

    # Priority 5: Barge-in interruption
    generate_audio(
        "Wait, hold on, I have a question about that!",
        "test5_barge_in.wav",
        lang="en", tld="co.in"
    )
    
    # Priority 6: Long pauses
    # We will generate words and stitch them with pauses in pydub
    w1 = os.path.join(AUDIO_DIR, "w1.mp3")
    w2 = os.path.join(AUDIO_DIR, "w2.mp3")
    w3 = os.path.join(AUDIO_DIR, "w3.mp3")
    
    gTTS(text="Yesterday", lang="en", tld="co.in").save(w1)
    gTTS(text="I went", lang="en", tld="co.in").save(w2)
    gTTS(text="to the store", lang="en", tld="co.in").save(w3)
    
    a1 = AudioSegment.from_mp3(w1)
    a2 = AudioSegment.from_mp3(w2)
    a3 = AudioSegment.from_mp3(w3)
    
    pause_1s = AudioSegment.silent(duration=1500)
    pause_2s = AudioSegment.silent(duration=2500)
    pause_3s = AudioSegment.silent(duration=3500)
    
    combined = a1 + pause_1s + a2 + pause_2s + a3 + pause_3s
    combined = combined.set_frame_rate(16000).set_channels(1)
    
    final_pause_wav = os.path.join(AUDIO_DIR, "test6_pauses.wav")
    combined.export(final_pause_wav, format="wav")
    print(f"Saved {final_pause_wav}")
    
    os.remove(w1)
    os.remove(w2)
    os.remove(w3)
    
    print("Audio generation complete.")

if __name__ == "__main__":
    main()

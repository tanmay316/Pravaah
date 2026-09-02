import os
import pyttsx3
import soundfile as sf
import numpy as np

AUDIO_DIR = os.path.dirname(__file__)

def generate_audio_pyttsx3(text, filename):
    print(f"Generating audio for: '{text}' -> {filename}")
    temp_wav = os.path.join(AUDIO_DIR, "temp.wav")
    final_wav = os.path.join(AUDIO_DIR, filename)
    
    engine = pyttsx3.init()
    engine.setProperty('rate', 150)
    engine.save_to_file(text, temp_wav)
    engine.runAndWait()
    
    # Resample to 16kHz mono using soundfile and numpy
    data, samplerate = sf.read(temp_wav)
    
    # Convert to mono if stereo
    if len(data.shape) > 1:
        data = np.mean(data, axis=1)
        
    # Simple decimation/interpolation resampling if needed
    if samplerate != 16000:
        # Calculate ratio
        ratio = 16000 / samplerate
        new_length = int(len(data) * ratio)
        # Linear interpolation
        x = np.linspace(0, len(data) - 1, len(data))
        new_x = np.linspace(0, len(data) - 1, new_length)
        resampled_data = np.interp(new_x, x, data)
        samplerate = 16000
        data = resampled_data

    sf.write(final_wav, data, samplerate, subtype='PCM_16')
    
    if os.path.exists(temp_wav):
        try:
            os.remove(temp_wav)
        except:
            pass
    print(f"Saved {final_wav}")

def main():
    print("Generating e2e test audio files using pyttsx3...")
    
    generate_audio_pyttsx3("Yesterday I am go market and buy one shirt.", "test4_learner_turn1.wav")
    generate_audio_pyttsx3("Yesterday I went to the market and bought a shirt.", "test4_learner_turn2.wav")
    generate_audio_pyttsx3("Kal main office gaya tha, but I had an important meeting.", "test2_cs1.wav")
    generate_audio_pyttsx3("Mujhe samajh nahi aa raha, can you explain this?", "test2_cs2.wav")
    generate_audio_pyttsx3("Yesterday I went to office aur then I met my manager.", "test2_cs3.wav")
    generate_audio_pyttsx3("Wait, hold on, I have a question about that!", "test5_barge_in.wav")
    
    # Pauses test
    temp_w1 = os.path.join(AUDIO_DIR, "temp_w1.wav")
    temp_w2 = os.path.join(AUDIO_DIR, "temp_w2.wav")
    temp_w3 = os.path.join(AUDIO_DIR, "temp_w3.wav")
    
    engine = pyttsx3.init()
    engine.save_to_file("Yesterday", temp_w1)
    engine.save_to_file("I went", temp_w2)
    engine.save_to_file("to the store", temp_w3)
    engine.runAndWait()
    
    try:
        d1, sr = sf.read(temp_w1)
        d2, _ = sf.read(temp_w2)
        d3, _ = sf.read(temp_w3)
        
        # Make mono
        if len(d1.shape) > 1: d1 = np.mean(d1, axis=1)
        if len(d2.shape) > 1: d2 = np.mean(d2, axis=1)
        if len(d3.shape) > 1: d3 = np.mean(d3, axis=1)
        
        # Create pauses
        p1 = np.zeros(int(1.5 * sr))
        p2 = np.zeros(int(2.5 * sr))
        p3 = np.zeros(int(3.5 * sr))
        
        combined = np.concatenate([d1, p1, d2, p2, d3, p3])
        
        # Resample
        if sr != 16000:
            ratio = 16000 / sr
            new_len = int(len(combined) * ratio)
            combined = np.interp(np.linspace(0, len(combined)-1, new_len), np.linspace(0, len(combined)-1, len(combined)), combined)
            sr = 16000
            
        final_pause_wav = os.path.join(AUDIO_DIR, "test6_pauses.wav")
        sf.write(final_pause_wav, combined, sr, subtype='PCM_16')
        print(f"Saved {final_pause_wav}")
    except Exception as e:
        print(f"Error creating pauses audio: {e}")
        
    print("Audio generation complete.")

if __name__ == "__main__":
    main()

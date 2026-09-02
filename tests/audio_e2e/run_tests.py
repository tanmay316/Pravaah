import asyncio
import os
import time
import wave
import json
from livekit import rtc, api
from dotenv import load_dotenv

load_dotenv(r"c:\Users\Tms\Desktop\pravaah\services\voice-agent\.env")

# Setup connection info
URL = os.getenv("LIVEKIT_URL", "wss://pravaah-qj6q5gxo.livekit.cloud")
API_KEY = os.getenv("LIVEKIT_API_KEY")
API_SECRET = os.getenv("LIVEKIT_API_SECRET")
ROOM_NAME = "e2e-test-room-7"

AUDIO_DIR = os.path.dirname(__file__)

async def inject_audio(room: rtc.Room, audio_file: str):
    """Publish a local audio track from a WAV file to the room."""
    print(f"[Learner] Publishing audio from {audio_file}")
    
    # Read wave file
    wf = wave.open(audio_file, 'rb')
    sample_rate = wf.getframerate()
    channels = wf.getnchannels()
    
    source = rtc.AudioSource(sample_rate, channels)
    track = rtc.LocalAudioTrack.create_audio_track("learner-mic", source)
    
    options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    publication = await room.local_participant.publish_track(track, options)
    
    print(f"[Learner] Track published, playing audio...")
    
    # Stream the audio
    chunk_size = int(sample_rate / 100) # 10ms chunks
    while True:
        data = wf.readframes(chunk_size)
        if not data:
            break
            
        frame = rtc.AudioFrame(
            data=data,
            sample_rate=sample_rate,
            num_channels=channels,
            samples_per_channel=len(data) // (2 * channels)
        )
        await source.capture_frame(frame)
        await asyncio.sleep(0.01) # 10ms
        
    print(f"[Learner] Finished playing {audio_file}")
    await room.local_participant.unpublish_track(publication.sid)

async def test_priority_4():
    print("\n--- Running Priority 4: Tutor Behavior ---")
    
    # Create an API token for the learner
    token = api.AccessToken(API_KEY, API_SECRET).with_identity("test-learner").with_name("Test Learner").with_grants(api.VideoGrants(room_join=True, room=ROOM_NAME)).to_jwt()
    
    room = rtc.Room()
    
    @room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        print(f"[Learner] Subscribed to agent track: {track.name}")
        pass
        
    await room.connect(URL, token)
    print(f"[Learner] Connected to room {ROOM_NAME}")
    
    print("[Learner] Waiting 5 seconds for agent to connect and speak...")
    await asyncio.sleep(5)
    
    wav1 = os.path.join(AUDIO_DIR, "test4_learner_turn1.wav")
    if os.path.exists(wav1):
        await inject_audio(room, wav1)
    else:
        print(f"Error: {wav1} not found")
        
    print("[Learner] Waiting for tutor response (15s)...")
    await asyncio.sleep(15)
    
    wav2 = os.path.join(AUDIO_DIR, "test4_learner_turn2.wav")
    if os.path.exists(wav2):
        await inject_audio(room, wav2)
        
    print("[Learner] Waiting for tutor reinforcement (10s)...")
    await asyncio.sleep(10)
    
    await room.disconnect()
    print("--- Priority 4 Complete ---")

async def main():
    if not API_KEY or not API_SECRET:
        print("Error: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in env.")
        return
        
    await test_priority_4()

if __name__ == "__main__":
    asyncio.run(main())

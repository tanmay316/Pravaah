"""Multi-turn probe: does the coach keep replying past the first minute?"""
import asyncio, json, os, subprocess, time, uuid
from datetime import timedelta
from dotenv import load_dotenv
import edge_tts
from livekit import api, rtc

load_dotenv("services/voice-agent/.env")
URL, KEY, SECRET = os.environ["LIVEKIT_URL"], os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]
FFMPEG = r"ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
SR = 48000
LINES = [
    "Yesterday I go to market and buy one shirt.",
    "I am working in a software company since three years.",
    "My manager he is very strict but he help me a lot.",
    "Last weekend me and my friends went for a movie.",
    "I want to improve my English because I have interview next month.",
    "In my free time I like to playing cricket with my cousins.",
    "Tomorrow I will going to my hometown for a wedding.",
    "I didn't went to office today because I was sick.",
    "My mother cook very tasty food every Sunday.",
    "Can you tell me how to speak more fluently?",
]


async def pcm(text: str) -> bytes:
    mp3 = bytearray()
    async for c in edge_tts.Communicate(text, voice="en-IN-NeerjaNeural").stream():
        if c["type"] == "audio":
            mp3.extend(c["data"])
    return subprocess.run([FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(SR), "pipe:1"],
                          input=bytes(mp3), capture_output=True, check=True).stdout


async def main():
    clips = [await pcm(t) for t in LINES]
    room_name = f"session_probe_{uuid.uuid4().hex[:8]}"
    meta = {"user_id": "probe", "learner_name": "Probe", "mode": "free_conversation",
            "conversation_goal": "intro", "speech_language": "en", "tts_voice": "warm_male"}
    token = (api.AccessToken(KEY, SECRET).with_identity("probe").with_name("Probe")
             .with_grants(api.VideoGrants(room_join=True, room=room_name))
             .with_metadata(json.dumps(meta)).with_ttl(timedelta(minutes=10)).to_jwt())
    room = rtc.Room()
    t0 = time.monotonic()
    events = []

    def on_data(d):
        try:
            msg = json.loads(d.data.decode())
        except ValueError:
            return
        if msg.get("type") == "turn":
            events.append((time.monotonic() - t0, msg["speaker"], msg["text"][:70]))

    room.on("data_received", on_data)
    await room.connect(URL, token)
    src = rtc.AudioSource(SR, 1)
    await room.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track("mic", src),
                                               rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    await room.local_participant.publish_data(json.dumps({"type": "start_conversation"}).encode(), reliable=True)
    silence = rtc.AudioFrame.create(SR, 1, 480)

    async def send_silence(seconds):
        for _ in range(int(seconds * 100)):
            await src.capture_frame(silence)

    await send_silence(10)
    for clip in clips:
        events.append((time.monotonic() - t0, "SEND", ""))
        for i in range(0, len(clip), 960):
            await src.capture_frame(rtc.AudioFrame(clip[i:i + 960].ljust(960, b"\0"), SR, 1, 480))
        await send_silence(12)
    await send_silence(5)
    print(room_name)
    for t, who, text in events:
        print(f"{t:6.1f}s {who:8s} {text}")
    await room.disconnect()


asyncio.run(main())

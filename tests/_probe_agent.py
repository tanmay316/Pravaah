import asyncio, json, os, subprocess, time, uuid
from datetime import timedelta
from dotenv import load_dotenv
import edge_tts
from livekit import api, rtc

load_dotenv("services/voice-agent/.env")
URL, KEY, SECRET = os.environ["LIVEKIT_URL"], os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]
FFMPEG = r"ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
SR = 48000


async def learner_pcm(text: str) -> bytes:
    mp3 = bytearray()
    async for c in edge_tts.Communicate(text, voice="en-IN-NeerjaNeural").stream():
        if c["type"] == "audio":
            mp3.extend(c["data"])
    return subprocess.run([FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(SR), "pipe:1"],
                          input=bytes(mp3), capture_output=True, check=True).stdout


async def main():
    speech = await learner_pcm("Yesterday I go to market and buy one shirt.")
    room_name = f"session_probe_{uuid.uuid4().hex[:8]}"
    meta = {"user_id": "probe", "learner_name": "Probe", "mode": "free_conversation",
            "conversation_goal": "intro", "speech_language": "en", "tts_voice": "warm_male"}
    token = (api.AccessToken(KEY, SECRET).with_identity("probe").with_name("Probe")
             .with_grants(api.VideoGrants(room_join=True, room=room_name))
             .with_metadata(json.dumps(meta)).with_ttl(timedelta(minutes=5)).to_jwt())
    room = rtc.Room()
    t0 = time.monotonic()
    log, loud_times = [], []

    async def read_audio(track):
        async for ev in rtc.AudioStream(track):
            data = ev.frame.data
            if max(abs(data[i]) for i in range(0, len(data), 8)) > 800:
                loud_times.append(time.monotonic() - t0)

    def on_track(t, pub, p):
        if t.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.ensure_future(read_audio(t))

    room.on("participant_connected", lambda p: log.append(f"{time.monotonic()-t0:5.1f}s join {p.identity}"))
    room.on("track_subscribed", on_track)
    room.on("data_received", lambda d: log.append(f"{time.monotonic()-t0:5.1f}s data {d.data.decode()[:150]}"))
    await room.connect(URL, token)
    src = rtc.AudioSource(SR, 1)
    await room.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track("mic", src),
                                               rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    await room.local_participant.publish_data(json.dumps({"type": "start_conversation"}).encode(), reliable=True)
    silence = rtc.AudioFrame.create(SR, 1, 480)

    async def send_silence(seconds):
        for _ in range(int(seconds * 100)):
            await src.capture_frame(silence)

    await send_silence(12)
    speak_start = time.monotonic() - t0
    for i in range(0, len(speech), 960):
        await src.capture_frame(rtc.AudioFrame(speech[i:i + 960].ljust(960, b"\0"), SR, 1, 480))
    speak_end = time.monotonic() - t0
    await send_silence(14)
    greet = [t for t in loud_times if t < speak_start]
    reply = [t for t in loud_times if t > speak_end]
    print(room_name)
    print(f"greeting audio first at {greet[0]:.1f}s" if greet else "NO greeting audio")
    print(f"learner spoke {speak_start:.1f}-{speak_end:.1f}s")
    print(f"reply audio at {reply[0]:.1f}s = {reply[0]-speak_end:.2f}s after speech end" if reply else "NO reply audio")
    for e in log:
        print(e)
    await room.disconnect()


asyncio.run(main())

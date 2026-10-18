"""Joins a room as a learner who picked a specific coach voice; pair with `lk agent logs`."""
import asyncio, json, os, sys, uuid
from datetime import timedelta
from dotenv import load_dotenv
from livekit import api, rtc

load_dotenv("services/voice-agent/.env")


async def main(voice: str):
    room_name = f"session_probe_{uuid.uuid4().hex[:8]}"
    meta = {"user_id": "probe", "learner_name": "Probe", "mode": "free_conversation",
            "conversation_goal": "intro", "speech_language": "en", "tts_voice": voice}
    token = (api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
             .with_identity("probe").with_grants(api.VideoGrants(room_join=True, room=room_name))
             .with_metadata(json.dumps(meta)).with_ttl(timedelta(minutes=2)).to_jwt())
    room = rtc.Room()
    await room.connect(os.environ["LIVEKIT_URL"], token)
    src = rtc.AudioSource(48000, 1)
    await room.local_participant.publish_track(
        rtc.LocalAudioTrack.create_audio_track("mic", src),
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
    )
    await asyncio.sleep(15)
    await room.disconnect()
    print(room_name)


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "us_female"))

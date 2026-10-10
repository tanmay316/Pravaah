"""In-process Microsoft Edge neural TTS for LiveKit Agents.

Streams MP3 frames straight from the Edge speech websocket into the agent's audio track, so
the first syllable plays as soon as Edge sends it. The previous path went agent -> Render
(free tier, sleeps, buffers the whole clip) -> Edge and back, adding a cold-start-prone HTTP
hop to every coach turn.
"""

from __future__ import annotations

import asyncio
import uuid

import edge_tts
from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    APIConnectionError,
    APIConnectOptions,
    APITimeoutError,
    tts,
)

# Edge's default output format: audio-24khz-48kbitrate-mono-mp3
SAMPLE_RATE = 24000
NUM_CHANNELS = 1


class EdgeTTS(tts.TTS):
    def __init__(self, *, voice: str = "en-IN-PrabhatNeural", rate: str = "+0%") -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
        )
        self._voice = voice
        self._rate = rate

    @property
    def model(self) -> str:
        return "edge-tts"

    @property
    def provider(self) -> str:
        return "microsoft-edge"

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> "_EdgeChunkedStream":
        return _EdgeChunkedStream(tts=self, input_text=text, conn_options=conn_options)


class _EdgeChunkedStream(tts.ChunkedStream):
    def __init__(self, *, tts: EdgeTTS, input_text: str, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._edge = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=uuid.uuid4().hex,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            mime_type="audio/mpeg",
        )
        text = self.input_text.replace("*", "").replace("#", "").replace("`", "").strip()
        # Edge returns no audio for punctuation-only input; retrying cannot help.
        if not any(c.isalnum() for c in text):
            raise APIConnectionError("nothing speakable in TTS input", retryable=False)

        communicate = edge_tts.Communicate(
            text,
            voice=self._edge._voice,
            rate=self._edge._rate,
            connect_timeout=max(1, int(self._conn_options.timeout)),
            receive_timeout=15,
        )
        try:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    output_emitter.push(chunk["data"])
        except asyncio.TimeoutError:
            raise APITimeoutError() from None
        except Exception as exc:
            raise APIConnectionError(f"edge-tts failed: {exc}") from exc
        output_emitter.flush()

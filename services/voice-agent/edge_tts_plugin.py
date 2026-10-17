"""In-process Microsoft Edge neural TTS for LiveKit Agents with Persistent WebSocket Pooling & LRU Cache.

Optimizations over stock edge-tts:
  1. Persistent Pre-Warmed WebSocket Pool: Completes DNS + TCP + TLS + WebSocket handshake and
     sends `speech.config` AHEAD of time (and reuses open sockets across turns), eliminating
     ~600-700ms of connection setup latency from the critical TTFA path.
  2. In-Process MP3 Frame LRU Cache: Instant (<1ms) zero-network playback for pre-warmed
     greetings, short coaching acknowledgements, and repeated phrases.
  3. Seamless Fallback: If a pooled socket is ever closed by the remote peer, transparently
     falls back to a fresh `edge_tts.Communicate` stream with clock-skew recovery.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
import json
import logging
import time
import uuid

import aiohttp
import edge_tts
from edge_tts import communicate as _edge_comm
from edge_tts import constants as _edge_const
from edge_tts import drm as _edge_drm
from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    APIConnectionError,
    APIConnectOptions,
    APITimeoutError,
    tts,
)

logger = logging.getLogger("pravaah-edge-tts")

# Edge's default output format: audio-24khz-48kbitrate-mono-mp3
SAMPLE_RATE = 24000
NUM_CHANNELS = 1
MAX_WS_IDLE_SECONDS = 45.0
MAX_CACHE_ITEMS = 256

_SPEECH_CONFIG_PAYLOAD = json.dumps({
    "context": {
        "synthesis": {
            "audio": {
                "metadataoptions": {
                    "sentenceBoundaryEnabled": "false",
                    "wordBoundaryEnabled": "false",
                },
                "outputFormat": "audio-24khz-48kbitrate-mono-mp3",
            }
        }
    }
})

# Process-wide LRU cache of (voice, rate, text) -> list[bytes] MP3 chunks
_AUDIO_CACHE: OrderedDict[tuple[str, str, str], list[bytes]] = OrderedDict()


def _cache_get(key: tuple[str, str, str]) -> list[bytes] | None:
    chunks = _AUDIO_CACHE.get(key)
    if chunks is not None:
        _AUDIO_CACHE.move_to_end(key)
    return chunks


def _cache_put(key: tuple[str, str, str], chunks: list[bytes]) -> None:
    if not chunks:
        return
    _AUDIO_CACHE[key] = chunks
    _AUDIO_CACHE.move_to_end(key)
    while len(_AUDIO_CACHE) > MAX_CACHE_ITEMS:
        _AUDIO_CACHE.popitem(last=False)


def _clean_speakable_text(raw: str) -> str:
    return raw.replace("**", "").replace("*", "").replace("#", "").replace("`", "").strip()


class _PooledEdgeWS:
    """Wraps a pre-connected, pre-configured Edge TTS WebSocket."""

    def __init__(self, session: aiohttp.ClientSession, ws: aiohttp.ClientWebSocketResponse) -> None:
        self.session = session
        self.ws = ws
        self.last_used = time.monotonic()

    def is_usable(self) -> bool:
        return (
            not self.ws.closed
            and not self.session.closed
            and (time.monotonic() - self.last_used) < MAX_WS_IDLE_SECONDS
        )

    async def close(self) -> None:
        try:
            if not self.ws.closed:
                await self.ws.close()
        except Exception:
            pass
        try:
            if not self.session.closed:
                await self.session.close()
        except Exception:
            pass


class EdgeTTS(tts.TTS):
    def __init__(
        self,
        *,
        voice: str = "en-IN-PrabhatNeural",
        rate: str = "+0%",
        pool_size: int = 2,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
        )
        self._voice = voice
        self._rate = rate
        self._pool_size = max(1, pool_size)
        self._pool: list[_PooledEdgeWS] = []
        self._replenish_tasks: set[asyncio.Task] = set()

    @property
    def model(self) -> str:
        return "edge-tts"

    @property
    def provider(self) -> str:
        return "microsoft-edge"

    async def _create_warm_ws(self, timeout: float = 8.0) -> _PooledEdgeWS:
        session = aiohttp.ClientSession(
            trust_env=True,
            timeout=aiohttp.ClientTimeout(total=None, connect=timeout, sock_connect=timeout, sock_read=15.0),
        )
        try:
            ws = await session.ws_connect(
                f"{_edge_const.WSS_URL}&ConnectionId={_edge_comm.connect_id()}"
                f"&Sec-MS-GEC={_edge_drm.DRM.generate_sec_ms_gec()}"
                f"&Sec-MS-GEC-Version={_edge_const.SEC_MS_GEC_VERSION}",
                compress=15,
                headers=_edge_drm.DRM.headers_with_muid(_edge_const.WSS_HEADERS),
                ssl=_edge_comm._SSL_CTX,
            )
            await ws.send_str(
                f"X-Timestamp:{_edge_comm.date_to_string()}\r\n"
                "Content-Type:application/json; charset=utf-8\r\n"
                f"Path:speech.config\r\n\r\n{_SPEECH_CONFIG_PAYLOAD}\r\n"
            )
            return _PooledEdgeWS(session=session, ws=ws)
        except Exception as exc:
            await session.close()
            if isinstance(exc, aiohttp.ClientResponseError) and exc.status == 403:
                try:
                    _edge_drm.DRM.handle_client_response_error(exc)
                except Exception:
                    pass
            raise

    def _schedule_replenish(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        active_or_pending = len([p for p in self._pool if p.is_usable()]) + len(self._replenish_tasks)
        for _ in range(max(0, self._pool_size - active_or_pending)):
            task = loop.create_task(self._replenish_one())
            self._replenish_tasks.add(task)
            task.add_done_callback(self._replenish_tasks.discard)

    async def _replenish_one(self) -> None:
        try:
            conn = await self._create_warm_ws()
            self._pool.append(conn)
        except Exception as exc:
            logger.debug("EdgeTTS background socket warm note: %s", exc)

    async def _acquire_ws(self, timeout: float = 8.0) -> _PooledEdgeWS:
        while self._pool:
            conn = self._pool.pop(0)
            if conn.is_usable():
                self._schedule_replenish()
                return conn
            asyncio.create_task(conn.close())
        self._schedule_replenish()
        return await self._create_warm_ws(timeout=timeout)

    def _release_ws(self, conn: _PooledEdgeWS) -> None:
        conn.last_used = time.monotonic()
        if conn.is_usable() and len(self._pool) < self._pool_size:
            self._pool.append(conn)
        else:
            asyncio.create_task(conn.close())

    def prewarm(self) -> None:
        # LiveKit's FallbackAdapter calls this synchronously.
        self._schedule_replenish()

    async def warm_up(self, phrases: list[str] | None = None) -> None:
        """Pre-connect Edge TTS WebSockets and optionally pre-cache phrases (e.g. greeting)."""
        self._schedule_replenish()
        if not phrases:
            return
        for phrase in phrases:
            clean = _clean_speakable_text(phrase)
            if not clean or not any(c.isalnum() for c in clean):
                continue
            key = (self._voice, self._rate, clean)
            if _cache_get(key) is not None:
                continue
            try:
                chunks = await self._synthesize_to_chunks(clean, timeout=8.0)
                if chunks:
                    _cache_put(key, chunks)
            except Exception as exc:
                logger.debug("EdgeTTS phrase prewarm note: %s", exc)

    async def _synthesize_via_ws(self, conn: _PooledEdgeWS, text: str) -> list[bytes]:
        ssml = _edge_comm.mkssml(
            _edge_comm.TTSConfig(self._voice, self._rate, "+0%", "+0Hz", "SentenceBoundary"),
            text,
        )
        await conn.ws.send_str(
            _edge_comm.ssml_headers_plus_data(
                _edge_comm.connect_id(),
                _edge_comm.date_to_string(),
                ssml,
            )
        )
        chunks: list[bytes] = []
        async for msg in conn.ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                if len(msg.data) > 2:
                    hdr_len = int.from_bytes(msg.data[:2], "big")
                    params, data = _edge_comm.get_headers_and_data(msg.data, hdr_len)
                    if params.get(b"Path") == b"audio" and data:
                        chunks.append(data)
            elif msg.type == aiohttp.WSMsgType.TEXT:
                enc = msg.data.encode("utf-8")
                params, _ = _edge_comm.get_headers_and_data(enc, enc.find(b"\r\n\r\n"))
                if params.get(b"Path") == b"turn.end":
                    break
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                break
        return chunks

    async def _synthesize_to_chunks(self, text: str, timeout: float = 8.0) -> list[bytes]:
        conn: _PooledEdgeWS | None = None
        try:
            conn = await self._acquire_ws(timeout=timeout)
            chunks = await self._synthesize_via_ws(conn, text)
            if chunks:
                self._release_ws(conn)
                return chunks
            await conn.close()
        except Exception:
            if conn is not None:
                await conn.close()

        # Fallback to fresh Communicate stream
        communicate = edge_tts.Communicate(
            text,
            voice=self._voice,
            rate=self._rate,
            connect_timeout=max(1, int(timeout)),
            receive_timeout=15,
        )
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio" and chunk.get("data"):
                chunks.append(chunk["data"])
        return chunks

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> "_EdgeChunkedStream":
        self._schedule_replenish()
        return _EdgeChunkedStream(tts=self, input_text=text, conn_options=conn_options)

    async def aclose(self) -> None:
        for task in list(self._replenish_tasks):
            task.cancel()
        while self._pool:
            conn = self._pool.pop(0)
            await conn.close()


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
        text = _clean_speakable_text(self.input_text)
        # Edge returns no audio for punctuation-only input; retrying cannot help.
        if not any(c.isalnum() for c in text):
            raise APIConnectionError("nothing speakable in TTS input", retryable=False)

        cache_key = (self._edge._voice, self._edge._rate, text)
        cached_chunks = _cache_get(cache_key)
        if cached_chunks:
            for chunk_bytes in cached_chunks:
                output_emitter.push(chunk_bytes)
            output_emitter.flush()
            return

        collected: list[bytes] = []
        conn: _PooledEdgeWS | None = None
        try:
            conn = await self._edge._acquire_ws(timeout=max(1.0, float(self._conn_options.timeout)))
            ssml = _edge_comm.mkssml(
                _edge_comm.TTSConfig(self._edge._voice, self._edge._rate, "+0%", "+0Hz", "SentenceBoundary"),
                text,
            )
            await conn.ws.send_str(
                _edge_comm.ssml_headers_plus_data(
                    _edge_comm.connect_id(),
                    _edge_comm.date_to_string(),
                    ssml,
                )
            )
            async for msg in conn.ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    if len(msg.data) > 2:
                        hdr_len = int.from_bytes(msg.data[:2], "big")
                        params, data = _edge_comm.get_headers_and_data(msg.data, hdr_len)
                        if params.get(b"Path") == b"audio" and data:
                            collected.append(data)
                            output_emitter.push(data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    enc = msg.data.encode("utf-8")
                    params, _ = _edge_comm.get_headers_and_data(enc, enc.find(b"\r\n\r\n"))
                    if params.get(b"Path") == b"turn.end":
                        break
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break

            if collected:
                self._edge._release_ws(conn)
                if len(text) <= 240:
                    _cache_put(cache_key, collected)
                output_emitter.flush()
                return
            await conn.close()
        except Exception as ws_exc:
            if conn is not None:
                await conn.close()
            if collected:
                # Already pushed partial audio; flush cleanly instead of duplicating
                output_emitter.flush()
                return
            logger.debug("Pooled EdgeTTS WS fallback to Communicate (%s)", ws_exc)

        # Fallback: standard Communicate stream
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
                    data = chunk["data"]
                    collected.append(data)
                    output_emitter.push(data)
        except asyncio.TimeoutError:
            raise APITimeoutError() from None
        except Exception as exc:
            raise APIConnectionError(f"edge-tts failed: {exc}") from exc

        if collected and len(text) <= 240:
            _cache_put(cache_key, collected)
        output_emitter.flush()

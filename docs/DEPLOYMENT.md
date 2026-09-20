# English Coach AI — Deployment and Operations

## Topology: why the voice agent is deployed separately

The realtime voice agent and the REST API must not share a CPU.

A LiveKit agent has a hard realtime budget: it decodes Opus, runs Silero VAD over every ~32 ms
frame, and has to turn a transcript into audio inside a couple of hundred milliseconds. On a
0.1-vCPU shared instance it simply does not get scheduled often enough. The symptom in the logs
is unmistakable:

```text
WARNING:livekit.agents:job executor is unresponsive   delay=5692  job_id=... room=session_...
WARNING:livekit.agents:event loop blocked for 4180ms  cpu_time=0.03  gc_time=0.51
WARNING:livekit:livekit_api::signal_client - dropping pass-through signal — no stream available
```

`cpu_time` being near zero while `duration` is seconds means the process was *descheduled*, not
busy: the host took the CPU away. The learner hears silence and sees no transcript.

### Confirmed in production: co-hosting also OOM-kills the whole container

Render's free plan is 512MB. A live call runs Silero VAD, an STT stream, an LLM stream and TTS
synthesis all at once; production logs show `VAD inference is slower than realtime` delays
climbing from 0.2s to nearly 6s over a few seconds, then the container is gone and restarts from
scratch (Firebase credentials rewritten, uvicorn and the agent worker both re-registering). This
is Render's OOM killer, and it takes the **REST API down with the agent**, since they're the same
container. Any dashboard fetch during that restart window fails, which is exactly the "Could not
reach the coaching service" error a learner sees if they end a call while the container is mid
-restart. This is not a transient bug to retry around — it's the direct consequence of the two
workloads sharing 512MB, and it recurs under real voice-call load, not just at high concurrency.

So:

| Component | Where | Why |
|---|---|---|
| REST API + embedded TTS (`Dockerfile`) | Render free web service | Request/response, tolerates a slow CPU |
| Voice agent (`services/voice-agent/Dockerfile`) | LiveKit Cloud Agents, or an Oracle Cloud Always-Free VM | Needs a dedicated core and its own memory budget |

`RUN_VOICE_AGENT=false` is the default and must stay false on Render.

### Deploy the API to Render

Render reads `render.yaml`. Set these in the dashboard (all `sync: false`):
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`,
`FIREBASE_SERVICE_ACCOUNT_JSON`.

Note the free plan also sleeps after 15 minutes of inactivity; the first request after that takes
~30 s to wake. The client already surfaces this as a "server may be waking up" message.

### Deploy the agent to LiveKit Cloud Agents (free tier, recommended)

```bash
npm install -g livekit-cli
lk cloud auth
lk agent create --subdomain <your-livekit-subdomain>   # writes/updates livekit.toml
lk agent secrets set \
  GROQ_API_KEY=... \
  GEMINI_API_KEY=... \
  TTS_BASE_URL=https://<your-render-app>.onrender.com/v1
lk agent deploy
```

`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are injected by LiveKit Cloud.

### Alternative: Oracle Cloud Always-Free VM

4 Ampere cores and 24 GB RAM, free indefinitely. `scripts/oracle_setup.sh` brings up
`docker-compose.free-tier.yml`, which runs the API, a standalone TTS container and the agent with
`TTS_BASE_URL=http://tts-server:8880/v1`.

### Memory budget

The API image installs only `services/api` + `services/learning-engine` requirements. `litellm`
(~200 MB resident on import) is now an optional, lazily imported last-resort fallback, and the
unused `langgraph` dependency is gone. Expect the API container to sit well under the 512 MB free
tier limit. The agent image drops the `turn-detector` extra (which pulls `transformers` and an
ONNX model) and keeps only VAD-based endpointing.

The agent also holds one live LLM client per entry in its fallback chain for the whole session.
The conversational chain constructs Groq's 2 models plus only the top 2 Gemini models by quota
(`GEMINI_VOICE_MODEL_CHAIN`, defaults to the first two entries of `GEMINI_MODEL_CHAIN`) rather
than all 4 Gemini models — Groq is tried first and is reliable, so the extra Gemini fallbacks
were rarely-used dead weight. Even with this and a dedicated host, budget for Silero VAD +
PyTorch (~150-300 MB baseline) plus per-call STT/LLM/TTS streaming buffers when sizing a VM.

## Deployment philosophy

Start locally and use legitimate free tiers or self-hosted open-source components. Measure costs and latency with early users before purchasing infrastructure. Do not use fake identities, multiple-account schemes, automated key generation, or quota bypasses.

Firebase Spark is the initial platform for Auth, Firestore, Storage, Analytics, and App Check where its current quotas permit. Firebase is not the realtime voice server; LiveKit owns media transport.

## Configurations

Public Expo configuration may include Firebase client identifiers:

```text
EXPO_PUBLIC_FIREBASE_API_KEY
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
EXPO_PUBLIC_FIREBASE_PROJECT_ID
EXPO_PUBLIC_FIREBASE_APP_ID
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
EXPO_PUBLIC_API_URL
EXPO_PUBLIC_LIVEKIT_URL
```

These are inlined at build time. For the web build they must be present in `apps/expo/.env`
*before* `npm run build:web`, otherwise the bundle ships with no auth and no API base URL.

```bash
cd apps/expo
npm run build:web          # writes apps/expo/dist
cd ../.. && firebase deploy --only hosting
```

Server-only configuration includes:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
GEMINI_API_KEY
GROQ_API_KEY
OPENROUTER_API_KEY
LITELLM_MASTER_KEY
REDIS_URL
```

Use `.env.example` with placeholder names only. Never commit real values. Keep `LIVEKIT_URL` configurable so local, self-hosted, and managed LiveKit deployments share the same application design.

## Runtime services

- Expo app: Android, iOS, and web client.
- FastAPI: protected HTTP API and token/session issuer.
- LiveKit: configurable self-hosted or managed realtime server.
- Voice agent: Python worker registered with LiveKit.
- Learning engine: asynchronous worker/process.
- Redis: Optional distributed rate limiting or temporary state. If absent, fallback to an in-process or Firestore-based mechanism.
- Firestore: durable learner and session data.

## Observability

Instrument request, LiveKit session, STT, LLM, and TTS with OpenTelemetry. Record turn-detection time, STT latency, LLM first-token latency, TTS first-audio latency, end-to-end first-audio latency, provider, fallback status, and error codes. Keep sensitive content out of telemetry.

## Reliability and cost controls

Use configuration-driven provider fallbacks, small/fast models where sufficient, bounded conversation context, batched analysis, cached static curriculum, rate limits, and daily usage limits. Prefer local STT/TTS only where available compute supports it.

## Offline experience

Cache profile, lesson metadata, recent progress, and static curriculum. When offline, show cached dashboard and connection state, but disable realtime voice sessions clearly rather than pretending they are available.

## Release gates

Before production polish, verify Firebase authorization, short-lived LiveKit tokens, interruption/reconnect handling, analysis schema validation, provider fallback, usage limits, sensitive-log review, and the end-to-end first-MVP milestone from PRODUCT.md.

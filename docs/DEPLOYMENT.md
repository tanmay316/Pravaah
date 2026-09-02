# English Coach AI — Deployment and Operations

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

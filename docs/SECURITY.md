# English Coach AI — Security and Privacy

## Trust boundaries

The Expo client is untrusted. It may contain public Firebase configuration, but never AI-provider credentials, Firebase service-account credentials, LiveKit API secrets, LiteLLM keys, or database-administration credentials.

Only backend services receive provider secrets. A client receives only a Firebase ID token and a short-lived, scoped LiveKit access token.

## Authentication and authorization

1. The app authenticates with Firebase Auth.
2. FastAPI verifies the Firebase ID token on every protected request.
3. The API checks that the requested user/session belongs to the authenticated user.
4. The API creates an authorized room/session and mints a short-lived LiveKit token.
5. Firestore Security Rules enforce user ownership independently of the API.

Never trust a user ID supplied in a request body or a client-generated room permission.

## Data handling

- Store transcripts and learning records only when required for the product.
- Do not store raw audio permanently by default.
- Store timestamps using server timestamps.
- Provide a backend account deletion capability via `DELETE /api/me` which deletes the Firebase Auth account, Firestore user profile, sessions, messages, mistakes, vocabulary, and stats according to the documented retention policy.
- Avoid sending raw conversation content to product analytics.
- Keep only the minimum learner information necessary for personalization.

## Firestore access model

User-owned records must be scoped under `users/{userId}` or validated against an equivalent owner field. Rules must prevent one signed-in user from reading or changing another user’s profile, sessions, mistakes, vocabulary, or daily statistics.

## Input and model-output validation

- Validate all HTTP inputs with Pydantic schemas.
- Validate event payloads before persistence.
- Require structured LLM analysis responses and validate against schemas.
- Retry or discard malformed analysis output; never write arbitrary model JSON directly to Firestore.
- Treat transcripts and model outputs as untrusted content: guard against prompt injection and unsafe interpolation into prompts or logs.

## Abuse controls

Protect session creation and provider quotas with authenticated endpoints, rate limits, daily usage limits, short token lifetimes, and server-side enforcement. Do not build around account creation, API-key harvesting, or bypassing provider limits.

## Logging and Request Tracing

Every API response should include an `X-Request-ID` or equivalent. This ID should be propagated across the API and backend logs to connect the mobile request → FastAPI → LiveKit → STT → LLM → TTS without logging sensitive content.

Never log secrets, full access tokens, Firebase tokens, or unnecessary sensitive transcripts. Structured logs should prefer an internal user identifier/hash, session ID, provider, status, latency, token counts, and sanitized error code.

## Client security

Use App Check where compatible, protect API endpoints against replay and abuse, keep dependencies current, and show a generic learner-facing error instead of internal provider or credential failures.

# English Coach AI — Implementation Plan

## Monorepo / Repository Structure

```text
/
  apps/
    expo/               # Expo, React Native, TypeScript, Expo Router (Requires Dev Build)
  services/
    api/                # FastAPI, Pydantic, Firebase Admin
    voice-agent/        # Python, LiveKit Agents, Silero VAD, Groq Whisper, LiteLLM, Kokoro TTS
    learning-engine/    # Python, LangGraph, LLM for async analysis
  packages/
    shared-types/       # TypeScript & Python schemas for API and events
    config/             # Shared configuration settings
  firebase/
    firestore.rules     # Security rules
    indexes.json        # Firestore indexes
  infrastructure/       # Deployment scripts/configs
  docs/                 # Project documentation
```

## Services and Responsibilities

- **Expo App**: Handles UI, microphone permissions, LiveKit connection, local caching, Firebase Auth, rendering transcripts, and session summaries. MUST use Expo development builds (not Expo Go) to support LiveKit native modules.
- **FastAPI**: Validates Firebase Auth tokens, issues short-lived LiveKit tokens, handles token refresh, creates sessions in Firestore, enforces usage limits, and proxies learner data requests.
- **Voice Agent (Python)**: Joins LiveKit rooms, manages short conversation context (6-10 turns), handles VAD/turn detection, streams STT -> LiteLLM -> TTS, handles barge-in, and emits transcription events. Contains NO Firestore or business logic.
- **Learning Engine (Python)**: Subscribes to session events asynchronously via a local/async event dispatcher. Uses LangGraph to extract grammar/vocabulary insights, updates learner profiles, and plans the next lesson. Never blocks realtime operations.

## REST API Endpoints

- `GET /api/me/profile`: Fetch the authenticated learner's profile and progress.
- `GET /api/me/sessions`: List past practice sessions for the authenticated learner.
- `GET /api/me/progress`: Fetch progress/mastery metrics.
- `GET /api/me/mistakes`: Fetch recorded mistakes.
- `GET /api/me/vocabulary`: Fetch vocabulary history.
- `DELETE /api/me`: Delete the authenticated user account and all owned data.
- `POST /api/sessions`: Create a new session. Validates limits, provisions LiveKit token and room name.
- `POST /api/sessions/{session_id}/token/refresh`: Issue a new short-lived LiveKit token for an active session to support long-duration (1-2 hour) conversations.
- `GET /api/sessions/{session_id}`: Get a detailed summary of a specific session.

## Request / Response Schemas

**POST /api/sessions**
- **Request**: `{ "mode": "free_conversation" | "grammar_practice" | "roleplay" }`
- **Response**: `{ "session_id": "string", "livekit_token": "string", "room_name": "string" }`

**Common API Error Response**
- **Response Structure**:
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Daily practice limit reached.",
    "request_id": "req_123456789"
  }
}
```

## Authentication Flow

1. Client authenticates via Firebase Auth (Email/Google).
2. Client receives a Firebase ID Token.
3. Client attaches `Authorization: Bearer <ID_TOKEN>` to FastAPI requests.
4. FastAPI verifies the token via Firebase Admin SDK.
5. FastAPI verifies session ownership and issues a short-lived LiveKit token (scoped to the specific room).
6. Client connects to the LiveKit room using the token.
7. Client monitors token expiry and securely requests a renewed token from `/api/sessions/{session_id}/token/refresh` without disconnecting the realtime session.

## Firestore Collection / Document Schema (Option A: Subcollections)

```text
users/{uid}
  - profile: { level, native_language, target_language, daily_goal }
  - mastery: { grammar: {}, vocabulary: {} }
  - statistics: { total_sessions, practice_minutes }

users/{uid}/sessions/{sessionId}
  - start_time: timestamp
  - end_time: timestamp
  - mode: string
  - summary: string
  - metrics: { words_per_minute, ... }

users/{uid}/sessions/{sessionId}/messages/{messageId}
  - message_id: string
  - role: string (user | assistant | system)
  - text: string
  - sequence: number
  - timestamp: timestamp
  - duration_ms: number
  - interrupted: boolean

users/{uid}/mistakes/{mistakeId}
  - session_id: string
  - category: string (grammar | vocabulary)
  - original: string
  - corrected: string
  - severity: string
  - timestamp: timestamp

users/{uid}/vocabulary/{vocabularyId}
  - word: string
  - meaning: string
  - example: string
  - source_session_id: string
  - times_seen: number
  - times_used: number
  - mastery: number
  - last_seen: timestamp
  - created_at: timestamp
  - updated_at: timestamp

users/{uid}/dailyStats/{date}
  - practice_minutes: number
  - sessions_completed: number
```
*Note: `user_id` fields are omitted in nested subcollections as the parent path (`users/{uid}`) intrinsically defines ownership.*

## Indexes Required

- **Collection**: `sessions` (Group)
  - Fields: `start_time` DESC
- **Collection**: `mistakes` (Group)
  - Fields: `category` ASC, `timestamp` DESC
- **Collection**: `messages` (Group)
  - Fields: `sequence` ASC

## Session State Machine

A session moves through the following detailed states:
- `CREATED`: Session record created in backend.
- `TOKEN_ISSUED`: Short-lived LiveKit token generated.
- `CONNECTING`: Client is attempting to connect to LiveKit.
- `CONNECTED`: WebRTC connection established.
- `LISTENING`: Agent is awaiting user speech.
- `USER_SPEAKING`: VAD indicates the user is talking.
- `PROCESSING`: User finished speaking; STT -> LLM generation in progress.
- `AI_SPEAKING`: TTS is actively streaming to the user.
- `INTERRUPTED`: User barge-in detected; AI halts output.
- `RECONNECTING`: Network dropped; client is attempting to restore session.
- `ENDING`: Session termination initiated.
- `COMPLETED`: Session successfully closed and async analysis triggered.
- `FAILED`: Unrecoverable error occurred (e.g., token expired without refresh, media failure).

## LiveKit Token Lifecycle

- **Initial Token**: Issued upon `POST /api/sessions`. Short-lived (e.g., 15 minutes), strictly scoped (`roomJoin=true`).
- **Monitoring**: The client SDK monitors the token's remaining TTL.
- **Renewal**: Before expiry, the client calls `POST /api/sessions/{session_id}/token/refresh`.
- **Continuation**: The backend verifies authorization and issues a new token, which the client applies to the active room connection seamlessly, supporting multi-hour sessions.

## Realtime Event Contracts

Every event must include standard metadata for idempotency, deduplication, and reliable async processing:
```json
{
  "event_id": "evt_abc123",
  "event_version": 1,
  "event_type": "USER_UTTERANCE",
  "user_id": "uid_456",
  "session_id": "sess_789",
  "sequence": 42,
  "timestamp": "2026-08-29T10:00:00Z",
  "payload": {
    "text": "Hello there",
    "duration_ms": 1500
  }
}
```
**Delivery Mechanism**: Events are dispatched from the Voice Agent via a local/async event dispatcher to the learning worker, and then persisted to Firestore.

Additional metadata for `AI_RESPONSE` payload:
- `response_id`, `interrupted`, `first_audio_timestamp`, `completed_timestamp`, `model`, `provider`.

## Provider Interfaces

- `STTProvider`: Abstract STT behavior (e.g., Groq Whisper, local fallback).
- `TTSProvider`: Abstract TTS behavior (e.g., Kokoro).
*Note: `LiveKit` is used directly for realtime transport, and `LiteLLM` is used directly for LLM routing. No artificial abstractions for these two are needed.*

## Environment Variables

**Expo Client (`.env`)**
- `EXPO_PUBLIC_FIREBASE_API_KEY`
- `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
- `EXPO_PUBLIC_FIREBASE_APP_ID`
- `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`

**Backend Services (`.env`)**
- `FIREBASE_SERVICE_ACCOUNT_JSON` (Injected JSON secret)
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `GEMINI_API_KEY` (Free tier)
- `GROQ_API_KEY` (Free tier)
- `LITELLM_MASTER_KEY`
- `REDIS_URL` (Optional)

## Usage Accounting & Rate Limiting

- **Redis is Optional**: If `REDIS_URL` is provided, use it for distributed rate limiting. Otherwise, fallback to an in-process or Firestore-based mechanism.
- **Server-Side Tracking**: The backend accurately tracks session duration.
  - `usage_start`: Logged when the session begins.
  - `usage_heartbeat`: Updated periodically or via token refresh.
  - `usage_end`: Reconciled when the session concludes or times out.
- This protects against app crashes or force-closes bypassing duration accounting.

## Testing Strategy

Explicit testing is required for:
- Token refresh lifecycle.
- Duplicate event delivery (idempotency checks).
- Network reconnects and LiveKit resilience.
- Long pauses and turn-detection accuracy.
- Barge-in (interruption handling).
- Usage reconciliation after forced app closure.
- Authorization isolation (ensuring users cannot read/write others' data).
- Account deletion (cascading deletes of Auth + Firestore data).
- Malformed AI output from learning analysis.
- Provider fallback routing via LiteLLM.

## MVP Definition of Done

1. An authenticated learner can join a protected LiveKit room and maintain a session past the initial token expiry.
2. The learner can hold an interruptible voice conversation with a Python tutor agent.
3. The conversation transcript (messages) is saved.
4. Asynchronous grammar analysis extracts mistakes and vocabulary, saving them to Firestore subcollections without blocking the conversation.
5. The learner's profile and daily stats are updated correctly.
6. The learner can view a personalized recommended next lesson and session summary.
7. Account deletion and API error handling are fully implemented.

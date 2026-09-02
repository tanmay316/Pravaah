# English Coach AI — Agents & Coding Rules

This document outlines strict coding rules and constraints for all future AI (Codex) sessions when building the English Coach AI project. 

## 1. Architectural Boundaries (CRITICAL)

- **Strict Separation of Concerns**: Keep realtime voice processing (WebRTC/LiveKit, VAD, STT, LLM, TTS) **completely separate** from asynchronous learning analysis (LangGraph, Firestore updates, Grammar/Vocab analysis).
- **Never Block Realtime**: Firestore writes, LangGraph execution, analytics, and lesson planning MUST NEVER block the response to a learner's spoken turn.

## 2. Infrastructure & Cost Constraints

- **Strict ₹0 / Free-Tier**: Do not introduce paid dependencies, AWS RDS, paid Vector DBs, or services that lack a generous free tier.
- **No Mandatory Paid Providers**: Use Groq Whisper (free tier), Gemini (free tier), local Whisper, and Kokoro TTS. LiteLLM should handle fallbacks safely.
- **Redis Limitations**: Use Redis **only** for temporary caches, rate-limiting, and ephemeral session state. Do not use Redis as the primary database.
- **Durable Truth**: Use **Firebase Auth** and **Firestore** as the absolute source of truth for user profiles, session histories, and mastery data.

## 3. Expo & React Native Rules

- **Use Development Builds**: LiveKit requires native WebRTC modules. The app MUST be run as an Expo development build (`npx expo run:ios` / `npx expo run:android` / `npx expo start --dev-client`). **DO NOT** use Expo Go.
- **Secrets Management**: NEVER expose provider secrets (LiveKit API Keys, LLM Keys, Firebase Admin credentials) in the Expo client. Only use `EXPO_PUBLIC_` prefixes for safe Firebase client configuration.

## 4. Backend & API Rules

- **Input Validation**: Validate all HTTP inputs and model outputs using Pydantic schemas.
- **LiveKit Tokens**: Only issue short-lived, strictly scoped LiveKit tokens via the backend. The client should never mint its own tokens.
- **Authentication**: Trust nothing from the client except the Firebase ID token. Verify identity securely in the backend.

## 5. AI & Voice Agent Rules

- **Use LiveKit Agents 1.x `AgentSession`**: Do NOT use the deprecated `VoicePipelineAgent`. The current API is `AgentSession` + `Agent`.
- **Provider Agnostic**: Use adapter interfaces for STT and TTS. Use LiteLLM Proxy for LLM routing. Do not hardcode model/provider identifiers in business logic.
- **Minimal Context**: Send only 6-10 recent turns and a compact summary to the LLM during realtime conversation. Do NOT send the entire user database history.
- **No Phoneme Scoring in V1**: Do not attempt to implement phoneme-level pronunciation scoring using LLMs. This is reserved for V2 using specialized alignment models.
- **No Raw Audio Persistence**: Do not store raw audio to storage by default. Only store transcripts and extracted learning metadata.

## 6. Implementation Workflow

Before implementing a new feature:
1. Verify it adheres to the constraints in `IMPLEMENTATION.md` and this document.
2. Confirm that the implementation will not block the realtime critical path.
3. Ensure no new paid dependencies are required.
4. Verify all secrets remain strictly on the backend.

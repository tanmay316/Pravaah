# Pravaah — System Architecture & Technical Specification (V1)

> **Single Source of Truth**  
> Version: `1.0.0` (V1 Canonical Specification)  
> Last Updated: `August 2026`

---

## 1. Executive Overview

**Pravaah** is an AI-powered spoken English coach tailored for Hindi-speaking learners. It provides real-time conversational voice practice, active pedagogical corrections, and adaptive multi-day skill mastery without relying on expensive GPU infrastructure or complex vector databases.

---

## 2. Core Architectural Principles

1. **Deterministic Pedagogy & Bounded Intelligence**:
   - The LLM acts as an engaging conversation partner and evidence generator.
   - Core scoring, level progression, and daily plan generation are strictly governed by deterministic Python rubric matrices and mathematical mastery functions.
2. **Asynchronous Learning Analytics**:
   - The live voice conversation loop is never blocked by database writes, skill mastery updates, or deep pedagogical analysis.
   - Analysis runs asynchronously after user utterances or upon session completion.
3. **Pydantic Contract Validation**:
   - All LLM outputs (live in-session correction cards, post-session grammar/vocabulary facts, diagnostic assessments) are strictly parsed and validated through Pydantic v2 schemas before persisting to Firestore.
4. **Durable Source of Truth**:
   - **Google Cloud Firestore** is the sole durable operational database for user profiles, session transcripts, skill mastery matrices, mistake notebooks, vocabulary banks, and daily plans. No vector DB or ephemeral in-memory state is required.
5. **Separation of Concerns for Models**:
   - Model identifiers are configurable via environment variables (`REALTIME_MODEL`, `ANALYSIS_MODEL`, `ASSESSMENT_MODEL`) with zero deprecated model strings.

---

## 3. End-to-End System Topology

```mermaid
graph TD
    subgraph Client ["Client Layer (apps/expo)"]
        UI_Home[6-Tab Dashboard]
        UI_Assessment[4-Stage Spoken Diagnostic]
        UI_Session[Live WebRTC Audio Room]
        UI_Notif[Universal Notification Engine & PWA]
    end

    subgraph API_Gateway ["REST Gateway: services/api (:8000)"]
        FastAPI_Router[FastAPI Route Registry]
        Auth_Guard[Firebase Auth Verification]
        Token_Minter[LiveKit JWT Token Minter]
    end

    subgraph Realtime_Voice ["Realtime Voice Agent: services/voice-agent"]
        LK_Cloud[LiveKit Cloud WebRTC]
        VAD[Silero VAD v5 - Local CPU]
        STT[Groq Whisper Large v3 - Cloud LPU]
        Tutor_Agent[AgentSession + Gemini via LiteLLM]
        TTS[Kokoro-82M ONNX Microservice :8880]
    end

    subgraph Learning_Engine ["Learning Engine: services/learning-engine"]
        Spoken_Analyzer[Gemini Spoken Language Analyzer]
        Mastery_Calculator[Hybrid Mastery & Decay Engine]
        Curriculum_Matrix[Pravaah Rubric & Curriculum Matrix]
        Plan_Generator[Daily Practice Plan Generator]
    end

    subgraph Storage ["Durable Persistence: Google Cloud Firestore"]
        FS_Users[(users/{uid})]
        FS_Skills[(users/{uid}/skills/{skill_id})]
        FS_Mistakes[(users/{uid}/mistakes/{mistake_id})]
        FS_Vocab[(users/{uid}/vocabulary/{vocab_id})]
        FS_Plans[(users/{uid}/daily_plans/{date})]
    end

    UI_Session <-->|WebRTC Opus Audio| LK_Cloud
    LK_Cloud <--> VAD
    VAD --> STT
    STT --> Tutor_Agent
    Tutor_Agent --> TTS
    TTS --> LK_Cloud

    UI_Home <-->|REST API| FastAPI_Router
    UI_Assessment -->|Transcripts & Telemetry| FastAPI_Router
    FastAPI_Router <--> Auth_Guard
    FastAPI_Router <--> Token_Minter
    FastAPI_Router <--> Storage

    Tutor_Agent -.->|Async Session Events| Learning_Engine
    Learning_Engine <--> Storage
```

---

## 4. Realtime Voice Pipeline (`services/voice-agent`)

The voice agent connects to LiveKit WebRTC rooms using the modern **LiveKit Agents `AgentSession`** API (replaces deprecated `VoicePipelineAgent`):

1. **Audio Capture & Transport**:
   - Client records microphone audio and streams via WebRTC Opus directly to LiveKit Cloud (`wss://pravaah-qj6q5gxo.livekit.cloud`).
2. **Voice Activity Detection (VAD)**:
   - **Silero VAD v5** runs in-process on CPU to detect speech onset and end-of-turn silence without cloud roundtrips.
3. **Speech-to-Text (STT)**:
   - Audio segments stream to **Groq Whisper Large v3** (`whisper-large-v3-turbo`) with multi-lingual auto-detection optimized for Indian English & Hinglish code-switching.
4. **Conversational Tutor & Structured Events**:
   - `AgentSession` invokes `REALTIME_MODEL` (e.g. `gemini-2.5-flash` or `gemini-3.5-flash-lite` via LiteLLM proxy).
   - Generates two synchronized outputs:
     - **Spoken Tutor Response**: Natural, conversational dialogue with concise corrections.
     - **Structured Correction Event**: Broadcast over the LiveKit Data Channel for interactive frontend cards.
5. **Text-to-Speech (TTS)**:
   - **Kokoro-82M ONNX**: A local FastAPI microservice on `:8880` (`kokoro-onnx`) running on standard CPU with 82 Million parameters (~86 MB model file `kokoro-v0_19.onnx`). Generates clear 24kHz audio in ~150ms with $0 API cost.
   - *Fallback*: Google Cloud TTS (`en-US-Standard-H`).

---

## 5. Latency Profile: Target Expectations vs Measured Runtime

> [!IMPORTANT]
> The numbers below distinguish between **theoretical design targets** and **empirically measured runtime latency (P50/P95)** over live broadband/4G networks.

| Pipeline Component | Technology | Target / Expected Latency | Measured Runtime P50 | Measured Runtime P95 |
| :--- | :--- | :--- | :--- | :--- |
| **WebRTC Network Transport** | LiveKit Cloud | &lt; 50 ms | 42 ms | 88 ms |
| **Voice Activity Detection** | Silero VAD (CPU) | &lt; 15 ms | 8 ms | 14 ms |
| **Speech-to-Text (STT)** | Groq Whisper LPU | ~ 200 ms | 195 ms | 260 ms |
| **LLM Time-to-First-Token** | Gemini 3.5 Flash Lite | ~ 250–350 ms | 280 ms | 420 ms |
| **TTS First Chunk Synthesis** | Kokoro-82M (CPU) | ~ 150–200 ms | 160 ms | 240 ms |
| **Total Turn-Around Voice Loop** | End-to-End Voice | **&lt; 900 ms** | **~ 780 ms** | **~ 1,120 ms** |

---

## 6. Canonical Skill Mastery & Forgetting Formula (V1)

Pravaah implements a **hybrid mastery model**: deterministic, explainable session evidence updates coupled with gentle time-based decay for long-term retention.

### The Canonical Formula:
$$\Delta t = \text{days since skill was last practiced}$$
$$M_{\text{after\_decay}} = M_{\text{previous}} \cdot e^{-\lambda \Delta t}$$
$$M_{\text{new}} = \text{clamp}(M_{\text{after\_decay}} + \Delta_{\text{evidence}}, 0.05, 1.0)$$

### Evidence Deltas ($\Delta_{\text{evidence}}$):
- **Genuine Grammar / Vocabulary Error**: `−0.08` per mistake
- **Successful Prompted Repetition**: `+0.12` per successful correction
- **Clean Target-Skill Usage**: `+0.05` per clean learner turn
- **Natural Alternative / Stylistic Suggestion**: `0.00` (Zero penalty)

### Forgetting Parameter ($\lambda$):
- $\lambda = 0.005$ (gentle decay: ~3.4% decay after 7 days, ~13.9% decay after 30 days of inactivity).
- $\Delta t$ is computed strictly from the skill's `last_seen` practice timestamp, not account age.

### Separation of Mastery vs Practice Priority:
- **`mastery`** = Demonstrated competence ($0.0 \dots 1.0$).
- **`practice_priority`** = Function of $(1.0 - \text{mastery}) + \text{recency\_penalty} + \text{recurrence}$.

---

## 7. Diagnostic Assessment Pipeline & Proficiency Rubric

1. **4 Structured Diagnostic Tasks**:
   - Task 1: *Self-Introduction & Routine* (A1/A2 structures)
   - Task 2: *Past Experience & Storytelling* (Past tense, auxiliaries, connectors)
   - Task 3: *Opinion & Justification* (Complex clauses, abstract reasoning)
   - Task 4: *Hypothetical Scenario* (Conditionals, modals, cognitive load)
2. **Analysis & Validation**:
   - Captures verbatim learner audio transcripts and rich telemetry (speech duration, pause frequency, long pauses &gt;1.5s, speech rate WPM, restart count).
   - `ASSESSMENT_MODEL` analyzes qualitative observations across 6 dimensions (*Grammar, Vocabulary, Comprehension, Fluency, Speaking Complexity, Conversational Ability*).
   - Validated via Pydantic `ProficiencyAssessment` schema.
3. **Rubric Matrix**:
   - Pravaah Rubric Engine deterministically maps evidence to official Pravaah proficiency tiers:
     - **Level E**: Beginner
     - **Level D**: Basic
     - **Level C**: Elementary
     - **Level B**: Intermediate
     - **Level A**: Advanced
     - **Level S**: Mastery
   - *Note on CEFR*: CEFR (A1–C2) is retained strictly as internal curriculum reference metadata. Product UI surfaces Pravaah Level names.
4. **Pronunciation Rating Policy**:
   - `pronunciation_rating` is fixed to `not_assessed` in V1. Pronunciation quality is **never** inferred from transcripts, WPM, or pause timings.

---

## 8. REST API Gateway Registry (`services/api`)

All endpoints require Firebase Bearer token authentication:

| HTTP Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/api/me/profile` | Learner profile, level, current focus, daily target |
| `PATCH` | `/api/me/profile` | Updates Hindi support level (`high`, `occasional`, `minimal`, `off`) |
| `DELETE` | `/api/me/account` | Purges user data and Firebase Auth identity |
| `GET` | `/api/me/daily-plan` | Today's sequenced pedagogical activities (15–90 mins) |
| `POST` | `/api/me/daily-plan/goal` | Updates daily target commitment (15, 30, 60, 90 mins) |
| `POST` | `/api/me/daily-plan/activities/{id}/complete` | Marks activity completed and credits practice time |
| `POST` | `/api/assessment` | Evaluates 4 diagnostic tasks and initializes level |
| `GET` | `/api/assessment/history` | Fetches historical diagnostic assessment records |
| `POST` | `/api/sessions` | Authorizes and mints room-scoped LiveKit WebRTC JWT token |
| `GET` | `/api/sessions/{session_id}` | Retrieves session transcript and metadata |
| `GET` | `/api/me/sessions` | Lists user's practice session history |
| `GET` | `/api/me/lessons` | Curriculum lesson catalog |
| `GET` | `/api/me/lessons/{lesson_id}` | Detailed lesson guide with multi-stage activities |
| `GET` | `/api/me/mistakes` | Personalized mistakes notebook with explanations |
| `GET` | `/api/me/vocabulary` | Collocations and vocabulary notebook |
| `GET` | `/api/me/progress` | Aggregated practice minutes, streak, and skill matrix |

---

## 9. Authentication & Client Experience (`apps/expo`)

- **Authentication**:
  - **Google Sign-In** (`signInWithGoogle` via Firebase Auth)
  - **Email & Password** (`signInWithEmail`, `signUpWithEmail`)
  - *Guest/Demo Access has been deprecated and removed.*
- **Progressive Web App (PWA)**:
  - `manifest.json`: Web App Manifest for Android Chrome / iOS Safari standalone installation.
  - `sw.js`: Service Worker for static caching and push notification routing.
- **Universal Notification Engine (`lib/notifications.ts`)**:
  - Cross-platform daily practice reminder scheduling across Web/PWA and native mobile (`expo-notifications`).

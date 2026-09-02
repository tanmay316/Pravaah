# English Coach AI — Curriculum & Pedagogy

## 1. Educational Engine Overview

The application is not just an error-detector; it is a structured educational engine. The core pedagogical loop is:

`Learner weakness → Curriculum skill → Targeted practice activity`

Rather than generating arbitrary prompts for the "next lesson," the system maps detected mistakes to a structured curriculum matrix.

## 2. Internal Curriculum Matrix (CEFR Reference)

CEFR is retained internally to classify curriculum skills. It is not the
learner-facing proficiency label. The product displays the Pravaah scale:

| Pravaah level | Meaning | Internal CEFR reference |
| --- | --- | --- |
| E | Beginner — can understand and produce very basic English. | A1 |
| D | Basic — can communicate simple everyday information with significant help. | A1–A2 |
| C | Elementary — can handle familiar conversations but makes frequent grammar/vocabulary mistakes. | A2 |
| B | Intermediate — can hold everyday conversations, explain experiences and give opinions. | B1 |
| A | Advanced — can speak naturally and confidently about complex topics with relatively few errors. | B2–C1 |
| S | Mastery — can communicate fluently, precisely and naturally across everyday, academic and professional situations. | C1–C2+ |

S means **Pravaah Mastery**, not native-speaker status or an official CEFR
certification. Overall level changes only through a dedicated assessment that
reviews grammar, vocabulary, comprehension, fluency, speaking complexity,
pronunciation when available, and conversation ability. It is never derived
from a single session or an averaged score.

### A1 (Beginner)
- **Grammar**: Be verbs, Present simple, Basic questions (Wh- words), Articles (a/an/the), Singular/plural.
- **Vocabulary**: Everyday objects, family, numbers, days, time, basic food, directions.
- **Goals**: Can introduce themselves, ask simple questions, and communicate immediate needs.

### A2 (Elementary)
- **Grammar**: Past simple, Future (going to/will), Comparatives/Superlatives, Prepositions of time/place, Subject-verb agreement, Short vs. longer responses.
- **Vocabulary**: Travel, shopping, daily routines, hobbies, expressing simple preferences.
- **Goals**: Can handle routine tasks, describe past events, and maintain a simple conversation.

### B1 (Intermediate)
- **Grammar**: Present perfect, First/Second conditionals, Complex sentences (conjunctions), Modals (can/could/should).
- **Vocabulary**: Workplace English, expressing opinions, describing experiences, basic idioms.
- **Goals**: Can deal with most travel situations, describe experiences/events, and explain opinions.

### B2–C2 (Advanced/Fluent)
*(Deferred for V1, focus on A1–B1 core)*

## 3. Hindi-Speaker Specific Patterns

The learning engine must explicitly detect and correct common patterns typical of native Hindi speakers transitioning to English. Some common examples include:

| Common Pattern | Correct English | Curriculum Tag |
| --- | --- | --- |
| "I am having two brothers." | "I have two brothers." | Stative verbs (Present simple) |
| "I have one doubt." | "I have a question." | Vocabulary / Collocation |
| "He don't know." | "He doesn't know." | Subject-verb agreement |
| "I didn't went." | "I didn't go." | Past simple (Auxiliary + root) |
| "I am working here since two years." | "I have been working here for two years." | Present perfect continuous |
| "Discuss about this." | "Discuss this." | Preposition omission |
| "I am agree." | "I agree." | Be verb + main verb error |
| "She is knowing him." | "She knows him." | Stative verbs |

## 4. Hindi → English Support Progression

Hindi assistance is a **measurable learner setting**, not just a static prompt instruction. It dynamically scales with the learner's CEFR level and progress:

- **Beginner (A1)**: High Hindi support. The agent proactively uses Hindi to explain concepts and clarify tasks. English used is simple.
- **Intermediate (A2-B1)**: Occasional Hindi support. English is the normal operating mode; Hindi is used only for difficult concepts, on explicit request, or when the learner is stuck.
- **Advanced (B2+)**: English dominant / English only. Hindi support is completely disabled or strictly on request.

## 5. Measuring Progress Toward Fluency

The application does not make an absolute promise of "fluency." Instead, it measures quantitative and qualitative progress toward fluency.

**Fluency Metrics Tracked (via Telemetry and Analysis):**
- **Speaking confidence**: (Derived from response length and continuity)
- **Conversation length**: (Number of turns per session)
- **Words/minute**: (Speaking speed)
- **Pause frequency**: (Count of long hesitations/silences)
- **Grammar accuracy**: (Percentage of grammatically correct utterances)
- **Vocabulary diversity**: (Unique words used vs. total words)
- **Response complexity**: (Use of conjunctions and complex structures)
- **Self-correction frequency**: (Restarts and filler words)

*Example Learner Feedback*: "Your speaking fluency improved 14% this month, with fewer pauses and better past tense accuracy!"

## 6. Learner Profile Example

The output of the Learning Engine produces a highly targeted, structured profile:

```text
Pravaah level: C (Elementary)
CEFR reference: A2 (internal curriculum classification)

Grammar weaknesses:
 • past tense
 • articles
 • prepositions
 • subject-verb agreement

Speaking weaknesses:
 • hesitation
 • short answers

Vocabulary:
 • needs broader everyday vocabulary

Next lesson recommendation:
 Past tense practice + focusing on longer responses
```

## 7. V1 evidence and lesson-delivery rules

Skill mastery is evidence based and deterministic:

```text
mastery_new = clamp(mastery_current + Δ, 0.05, 1.0)
error                  Δ = -0.080
successful repetition  Δ = +0.120
clean usage            Δ = +0.050
natural alternative    Δ =  0.000
```

Only `grammar_error` and `vocabulary_error` carry a negative delta.
`natural_alternative` is stored as a suggestion and `no_issue` records no
negative learning fact. `attempts` counts learner evidence only;
`correction_attempts`, `successful_repetitions`, and `failed_repetitions`
describe the follow-up after a tutor explicitly requests a repetition. Tutor
messages never increment attempts.

When a completed session yields learning evidence, the engine updates the
skill, selects `current_focus`, saves a structured lesson under the learner,
and exposes that lesson on the Expo dashboard. Starting that card creates a
targeted practice session with the lesson skill attached to the session.

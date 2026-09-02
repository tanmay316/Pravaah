# English Coach AI — Product

## Purpose

English Coach AI helps primarily Hindi-speaking learners improve spoken English through natural daily conversations with an AI tutor. The product measures progress over time, remembers recurring weaknesses, and uses those signals to recommend the next practice.

The core loop is:

```text
Conversation → understanding → error detection → targeted practice → learner memory → next lesson
```

It is not a push-to-talk chatbot with a microphone.

## Initial audience

- Native language: Hindi (`hi`)
- Target language: English (`en`)
- Learner-facing levels: Pravaah E → D → C → B → A → S

CEFR A1–C2 remains an internal curriculum reference. A learner’s visible
Pravaah level is set only by a dedicated, multi-dimensional proficiency
assessment—not a single conversation, error count, or a numeric score.

The learner-profile model must be language-neutral so other native languages can be added without changing the core learning engine.

## Product principles

1. Make the exchange feel like a real conversation: tolerate pauses, broken English, and interruption.
2. Optimize for learning improvement, not messages sent or time in app.
3. Correct meaningful mistakes naturally during conversation. Explain important corrections briefly, ask the learner to repeat them when useful, then immediately return to the conversation. Store every meaningful correction for long-term learning and recurring-mistake analysis.
4. Use Hindi only when it genuinely helps, then reduce assistance as the learner improves.
5. Do not persist raw audio by default.

## Core user journey

```text
Sign in → onboarding → microphone permission → assessment → dashboard
  → speaking session → asynchronous analysis → summary → personalized next lesson
```

Onboarding collects native language, approximate English level, goal, daily target, and tutor style. The system may refine the level through an assessment.

## V1 scope

- Firebase sign-in and learner profile
- English-level selection
- Live voice conversation via WebRTC
- Short, supportive AI tutor replies with Hindi assistance when needed
- Live transcript
- Session history and summary
- Grammar corrections and vocabulary suggestions
- Recurring-mistake tracking and learner memory
- Basic progress dashboard
- Saved, structured personalized lessons shown on the dashboard and launched
  as targeted practice sessions
- Provider fallback and usage limits

## Deliberately deferred

- Phoneme-level pronunciation feedback
- Shadowing, debate, interview mode, and advanced fluency scoring
- Gamification, payments, social features, 3D avatars, and voice cloning

## Learning modes

Initial modes are free conversation, grammar practice, vocabulary practice, and roleplay. Later modes include storytelling, interview, debate, pronunciation practice, and shadowing.

Roleplay examples: restaurant, airport, shopping, office meeting, presentation, travel, making friends, telephone call, and customer support.

## Tutor behaviour

The tutor behaves as a natural conversation partner and an active English teacher. It corrects meaningful mistakes naturally during conversation, provides brief explanations, and asks the learner to repeat the correction. It alternates between teaching and conversation without destroying the flow. (See AI.md for the full behavioral specification).

## Success metric

The primary metric is weekly speaking improvement. Track measurable changes such as words per minute, long pauses, grammar accuracy, vocabulary use, and practice consistency. Engagement metrics are secondary.

## Definition of the first MVP milestone

An authenticated learner can join a protected LiveKit room, hold and interrupt a voice conversation with a Python tutor agent, have the transcript saved, receive asynchronous grammar analysis, see an updated learner profile and session summary, and obtain a recommended next lesson.

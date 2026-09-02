# English Coach AI — Realtime Voice System

## Objective

Create an interruptible spoken conversation, not a sequence of uploaded recordings. The critical metric is time from end of learner speech to first AI audio.

## Critical path

```text
Learner microphone → LiveKit/WebRTC → VAD + turn detection → streaming STT
  → streaming fast LLM → streaming TTS → LiveKit/WebRTC → learner speaker
```

Target each stage, then measure rather than promise: turn detection under 300 ms, STT final under 500 ms, LLM first token under 500 ms, and TTS first audio under 500 ms.

The primary realtime UX latency metric is **TTFA (Time To First Audio)**, measured as the time from the end of the learner's speech to the first AI audio.
Capture these metrics: `turn_detection_ms`, `stt_final_ms`, `llm_first_token_ms`, `tts_first_audio_ms`, and `ttfa_ms`.

## Realtime responsibilities

The Python LiveKit agent receives and publishes media, maintains only short session context, detects turns, handles barge-in, streams STT/LLM/TTS where provider support permits, publishes transcript updates, and emits events for asynchronous learning.

## Turn-taking

VAD answers whether speech is present. Turn detection answers whether the learner has finished a turn; they are distinct decisions. Support hesitation and long pauses without cutting off learners prematurely. When a learner begins talking while the tutor is speaking, stop or duck tutor output promptly and process the learner’s new turn.

## Failure behaviour

| Failure | Learner experience | System action |
| --- | --- | --- |
| STT unavailable | “Sorry, I didn’t catch that. Please try again.” | Retry/fallback; retain room state |
| LLM unavailable | Brief connection message | Try configured fallback model |
| TTS unavailable | Display response text | Keep session active and retry/fallback |
| LiveKit disconnect | Connection state shown | Reconnect safely, preserving local state |
| Firebase/API unavailable | Cached UI remains available | Queue/retry sync where safe |

Internal HTTP, rate-limit, provider, and key errors are never shown to learners.

## Session context

The agent receives system prompt, level-aware tutor instructions, compact learner summary, current lesson/mode, and recent turns. It must avoid blocking voice output on profile retrieval or learning analysis.

## Test matrix

Test interruptions, silence, long pauses, rapid speech, background noise, Indian English accents, Hindi-English code switching, poor networks, reconnects, and TTS interruption. Record WER, first-audio latency, false/missed interruptions, and reconnect success.

# Conversation as English practice

## Architecture

1. **Session setup (API):** resolve the learner's owned lesson or daily activity,
   or select a ranked focus for an untargeted conversation. Save a compact context
   snapshot: skill, rule, practice task, up to three real examples, Hindi support
   and recognition language. Refresh tokens retain this snapshot. Assessment
   sessions deliberately exclude coaching material.
2. **Realtime voice:** microphone processing → VAD → multilingual STT → spoken
   tutor → TTS. No Firestore reads or mastery computation in this path. The tutor
   corrects one genuine error, models the phrase, asks for a retry, evaluates it,
   then invites independent use. Correct English is not rewritten just for style.
3. **Optional live notes:** one cancellable async visual-card request per turn.
   Notes must quote the learner and meet a confidence threshold. They never
   schedule additional speech, change mastery, or block the tutor. Assessment
   turns do not produce cards.
4. **Session completion (API/learning engine):** persist the transcript, extract
   validated learner errors and vocabulary, then update mastery and recommend
   the next lesson. Provider/persistence failures are marked retryable, not
   counted as clean performance. Analysis results and completed learning updates
   have durable checkpoints. Completion waits for analysis; this is not a durable
   background-job queue, and clients must retry pending/failed completion requests.
5. **Next plan load:** one evidence ranking drives lessons and today's exercises.
   Recent/severe errors, failed retries, unfinished lesson deficits and mastery
   determine priority. Optional alternatives and Hindi translations are not
   English errors. Practice order is correction/retry → transfer → retention.
   Changed evidence refreshes pending slots while preserving issued IDs,
   completed work and explicitly started activities. Plans use UTC dates.

## Response and noise controls

- Spoken teaching is in the primary answer, not a delayed second voice which can
  interrupt the learner's next turn. The correction/retry exchange is consequently
  part of the transcript used for learning analysis.
- Trim a **copy** of context to ten recent items at `llm_node`, retaining the system
  instruction. Trimming `on_user_turn_completed` would invalidate LiveKit's
  preemptive generation and cause another model request. Full session transcripts
  remain separate from this short inference context.
- LLM failover starts after three seconds without a successful attempt. TTS
  fallbacks no longer retry the failed provider twice before switching.
- Microphone capture requests echo cancellation, noise suppression and automatic
  gain control. VAD uses a 0.65 activation threshold and requires a transcribed word
  for interruptions. Explicit non-speech transcripts raise LiveKit `StopResponse`
  instead of returning normally and allowing a reply. Real short answers such as
  “go”, “हाँ”, “जी”, “thanks” and “bye” remain valid speech.
- Recognition selection is **Auto**, **Hindi**, or **English**. Auto preserves
  code-switching; Hindi explicitly uses `hi` and full Whisper v3 by default.
  Both recognition models are configurable in the environment template. Hindi
  accuracy mode may be slower than turbo. STT is instructed not to silently repair
  the learner's grammar or translate their transcript.
- `VOICE_CARDS_ENABLED=false` disables optional card requests without disabling
  spoken tutoring or post-session analysis. No paid noise-cancellation service is
  required. VAD/text filters cannot reliably reject another person speaking nearby;
  use a headset or quieter location when possible.

## Verification and rollout

Offline suites: `test_voice_coaching`, `test_learning_priorities`, and
`test_tutor_session_context` under `tests/`. They cover production policy functions,
mocked provider/SDK boundaries, and in-memory Firestore transactions. They are not
an acoustic benchmark or proof that a language model always follows its prompt.

Rebuild/redeploy the API, voice agent and Expo client together. The new voice
policy module must ship alongside the agent. The cloud launcher and deployment
topology are unchanged; continue running the realtime agent separately from
memory-constrained API instances.

Before claiming faster production replies, compare logged `Voice timing` metrics
for STT delay, end-of-utterance delay, LLM TTFT and TTS TTFB using the same device,
provider region and workload. Measure end-of-speech to audible reply as well.
No production latency or Hindi accuracy figures have been measured for this change.

Live acceptance cases:

- Say “Yesterday I go to the market.” Expect a brief correction and a retry request
  before a new topic question. Retry correctly; expect acknowledgment and a new use.
- Say a valid sentence. Expect normal conversation, not a fabricated mistake.
- Say “मुझे अंग्रेज़ी सीखनी है” in Hindi mode. Check Devanagari transcription and an
  English model sentence; do not count it as an English grammar error.
- Test silence, fan noise, keyboard sounds, and short Hindi/English answers. Noise
  should not start a reply; soft legitimate answers must still be captured.
- End a session, reopen Plan, and verify ranked correction examples. Starting an
  activity then refreshing the plan must not change its target or lose progress.
- Verify assessment has no corrections/cards and restarting completion after a
  simulated provider failure does not double-count usage or mastery.
/**
 * Pravaah — Device text-to-speech (last-resort voice).
 *
 * The coach's voice normally arrives as a LiveKit audio track synthesised server-side. When
 * that path produces nothing — no agent in the room, or server TTS failing — the transcript
 * still arrives over the data channel, so the phone can read it aloud instead of the learner
 * sitting in silence.
 *
 * expo-speech wraps the OS voice on Android/iOS and the Web Speech API in the browser, so it
 * is free, offline, and adds nothing to the bundle size.
 */

import * as Speech from "expo-speech";

/** Preferred voice languages, best first. Indian English keeps the coach's accent consistent. */
const PREFERRED_LANGUAGES = ["en-IN", "en-GB", "en-US", "en"];

interface VoiceMatch {
  language?: string;
  voice?: string;
}

let cachedVoice: VoiceMatch | null | undefined;

async function resolveVoice(): Promise<VoiceMatch> {
  if (cachedVoice !== undefined) return cachedVoice ?? {};
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    // 1. Prefer Indian English Male voice
    const inMale = voices.find(
      (v) =>
        v.language?.toLowerCase().startsWith("en-in") &&
        (v.name?.toLowerCase().includes("male") ||
          v.name?.toLowerCase().includes("prabhat") ||
          v.name?.toLowerCase().includes("ravi") ||
          (v as any).gender === "male")
    );
    if (inMale) {
      cachedVoice = { language: inMale.language, voice: inMale.identifier };
      return cachedVoice;
    }

    // 2. Prefer any English Male voice
    const enMale = voices.find(
      (v) =>
        v.language?.toLowerCase().startsWith("en") &&
        (v.name?.toLowerCase().includes("male") ||
          v.name?.toLowerCase().includes("david") ||
          v.name?.toLowerCase().includes("george") ||
          v.name?.toLowerCase().includes("mark") ||
          v.name?.toLowerCase().includes("guy") ||
          (v as any).gender === "male")
    );
    if (enMale) {
      cachedVoice = { language: enMale.language, voice: enMale.identifier };
      return cachedVoice;
    }

    // 3. Fallback to language matching
    for (const lang of PREFERRED_LANGUAGES) {
      const match = voices.find((v) => v.language?.toLowerCase().startsWith(lang.toLowerCase()));
      if (match) {
        cachedVoice = { language: match.language, voice: match.identifier };
        return cachedVoice;
      }
    }
    cachedVoice = null;
  } catch {
    cachedVoice = null;
  }
  return cachedVoice ?? {};
}

export async function isDeviceSpeechAvailable(): Promise<boolean> {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    return voices.length > 0;
  } catch {
    // Android returns voices lazily and the web API needs a user gesture first; assume usable.
    return true;
  }
}

/**
 * Speaks `text` on the device. Resolves once playback finishes, is stopped, or errors, so the
 * caller can restore microphone state without guessing at a duration.
 */
export function speakOnDevice(text: string): Promise<void> {
  const clean = text.trim().slice(0, Speech.maxSpeechInputLength || 4000);
  if (!clean) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    resolveVoice()
      .then((voiceMatch) => {
        Speech.speak(clean, {
          language: voiceMatch.language,
          voice: voiceMatch.voice,
          rate: 0.95,
          pitch: 1.0,
          onDone: finish,
          onStopped: finish,
          onError: finish,
        });
      })
      .catch(finish);
  });
}

export async function stopDeviceSpeech(): Promise<void> {
  try {
    await Speech.stop();
  } catch {
    // Nothing queued.
  }
}

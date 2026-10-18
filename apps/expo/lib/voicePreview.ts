/**
 * Plays the bundled coach voice samples. They are recorded from the same Edge neural
 * voices the coach uses in sessions, so the learner hears exactly who they will practise with.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
import type { TtsVoice } from "./api";

const VOICE_SAMPLES: Record<TtsVoice, number> = {
  warm_male: require("../assets/voices/warm_male.mp3"),
  casual_male: require("../assets/voices/casual_male.mp3"),
  british_male: require("../assets/voices/british_male.mp3"),
  indian_male: require("../assets/voices/indian_male.mp3"),
  indian_female: require("../assets/voices/indian_female.mp3"),
  british_female: require("../assets/voices/british_female.mp3"),
  us_female: require("../assets/voices/us_female.mp3"),
};

export function useVoicePreview() {
  const soundRef = useRef<Audio.Sound | null>(null);
  const requestRef = useRef(0);
  const [playing, setPlaying] = useState<TtsVoice | null>(null);
  const playingRef = useRef<TtsVoice | null>(null);

  const setPlayingVoice = (voice: TtsVoice | null) => {
    playingRef.current = voice;
    setPlaying(voice);
  };

  const stop = useCallback(async () => {
    requestRef.current += 1;
    const sound = soundRef.current;
    soundRef.current = null;
    setPlayingVoice(null);
    if (sound) await sound.unloadAsync().catch(() => {});
  }, []);

  const play = useCallback(
    async (voice: TtsVoice) => {
      await stop();
      const request = requestRef.current;
      setPlayingVoice(voice);
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
        const { sound } = await Audio.Sound.createAsync(VOICE_SAMPLES[voice], { shouldPlay: true });
        // A newer tap or unmount happened while loading.
        if (request !== requestRef.current) {
          await sound.unloadAsync().catch(() => {});
          return;
        }
        soundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish && soundRef.current === sound) {
            stop();
          }
        });
      } catch (err) {
        console.warn("Voice sample playback failed:", err);
        if (request === requestRef.current) setPlayingVoice(null);
      }
    },
    [stop]
  );

  const toggle = useCallback(
    (voice: TtsVoice) => (playingRef.current === voice ? stop() : play(voice)),
    [play, stop]
  );

  useEffect(() => () => {
    requestRef.current += 1;
    soundRef.current?.unloadAsync().catch(() => {});
  }, []);

  return { playing, play, stop, toggle };
}

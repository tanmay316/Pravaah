/**
 * Pravaah — Mobile-First Realtime Speaking Session
 *
 * Immersive mobile call UI for spontaneous voice practice & LiveKit WebRTC pipeline:
 * - Fluid audio visualizer with reactive state colors (emerald, cyan, orchid)
 * - Mobile call header with live timer pill and quick-end control
 * - WhatsApp/iMessage-style conversational transcript bubbles
 * - Real-time slide-up recast cards with Hindi translations & grammar corrections
 * - Fixed bottom call controls with large thumb-accessible buttons
 */

// Must load before livekit-client: Hermes lacks TextDecoder/DOMException it needs at import.
import "../lib/polyfills";
// Side effect on native: registerGlobals() installs WebRTC before any Room is created.
import { startAudioSession, stopAudioSession } from "../lib/livekit";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Room, RoomEvent, Track, RemoteParticipant, RemoteTrackPublication } from "livekit-client";
import type { AudioCaptureOptions } from "livekit-client";
import {
  completeSession,
  createSession,
  ConversationGoal,
  SpeechLanguage,
} from "../lib/api";
import { prewarmDeviceSpeech, speakOnDevice, stopDeviceSpeech } from "../lib/deviceSpeech";
import { activityTitle, skillLabel } from "../lib/skills";
import { AppTheme, ThemeColors, theme, useTheme } from "../lib/theme";
import CoachAvatar, { AgentLevel, CoachAvatarState } from "../components/CoachAvatar";

export { default as ErrorBoundary } from "../components/ScreenError";

const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL || "wss://pravaah-qj6q5gxo.livekit.cloud";

// LiveKit AudioCaptureOptions map to browser media constraints (best effort per device).
const MICROPHONE_OPTIONS: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** How long a tutor turn waits for real agent audio before the device reads it aloud. */
const DEVICE_SPEECH_GRACE_MS = 1800;

type DeviceVoiceMode = "auto" | "on" | "off";

/** Session goals the coach knows how to open on and steer towards. */
const GOAL_OPTIONS: {
  goal: ConversationGoal;
  label: string;
  blurb: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { goal: "intro", label: "Coached conversation", blurb: "Speak, learn a correction, then retry", icon: "cafe-outline" },
  { goal: "grammar", label: "Grammar focus", blurb: "Polish tenses and sentence shape", icon: "construct-outline" },
  { goal: "vocabulary", label: "Vocabulary", blurb: "Natural expressions and collocations", icon: "book-outline" },
  { goal: "roleplay", label: "Roleplay", blurb: "Interview, meeting, client call", icon: "people-outline" },
  { goal: "fluency", label: "Speaking time", blurb: "Longer turns with focused feedback", icon: "mic-outline" },
];

const TOPIC_SUGGESTIONS = [
  "My daily routine",
  "My work",
  "Travel",
  "Movies & shows",
  "Cricket",
  "Technology",
  "Food & cooking",
  "College life",
  "Weekend plans",
];

/** Who Coach Pravaah plays opposite the learner in a roleplay session. */
const ROLEPLAY_ROLES = [
  "Hiring manager",
  "Client",
  "Team lead",
  "Hotel receptionist",
  "Waiter",
  "Customer support agent",
  "Shopkeeper",
  "Doctor",
  "Immigration officer",
  "College professor",
];

/** Situational topic suggestions shown instead of TOPIC_SUGGESTIONS while roleplay is selected. */
const ROLEPLAY_SITUATIONS = [
  "a job interview",
  "a client call",
  "a team standup",
  "ordering at a restaurant",
  "checking into a hotel",
  "a customer support call",
  "negotiating a price at a market",
  "a doctor's appointment",
  "asking for directions",
  "a college admission interview",
  "returning a faulty product",
  "a visa interview",
];

function defaultGoalForMode(mode?: string): ConversationGoal {
  switch (mode) {
    case "grammar_practice":
      return "grammar";
    case "vocabulary_practice":
      return "vocabulary";
    case "roleplay":
      return "roleplay";
    default:
      return "intro";
  }
}

/**
 * The daily plan (services/learning-engine/curriculum.py) labels its activities "vocabulary"
 * and "review", neither of which the backend's SessionMode enum accepts (it only knows
 * free_conversation / grammar_practice / vocabulary_practice / roleplay / assessment) —
 * launching one of those activities as-is 422s. Map them onto a mode the API understands
 * before it's used for anything.
 */
function normalizeSessionMode(mode?: string, targetSkill?: string): string {
  if (mode === "vocabulary") return "vocabulary_practice";
  if (mode === "review") return targetSkill === "collocations" ? "vocabulary_practice" : "grammar_practice";
  return mode || "free_conversation";
}

/** Combines the chosen role and situation into the single scenario string the agent reads. */
function buildRoleplayScenario(topic: string, role: string): string | undefined {
  const t = topic.trim();
  const r = role.trim();
  if (r && t) return `${t} — you play the ${r}`;
  if (r) return `a roleplay where you play the ${r}`;
  if (t) return t;
  return undefined;
}

interface TranscriptTurn {
  id: string;
  speaker: "learner" | "tutor";
  text: string;
  timestamp: string;
}

interface InSessionCorrection {
  card_type?: "translation" | "correction";
  original: string;
  corrected: string;
  explanation: string;
  target_skill?: string;
}

export default function SessionScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isCompact = width < 480;
  const { colors, isDark, toggleTheme, theme: activeTheme } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark, activeTheme), [colors, isDark, activeTheme]);
  const params = useLocalSearchParams<{
    mode?: string;
    target_skill?: string;
    lesson_id?: string;
    activity_title?: string;
    stage?: string;
  }>();

  // The learner chooses a topic and a goal before we create the session, because both are
  // baked into the LiveKit token the coach reads to build its opening line.
  const sessionMode = normalizeSessionMode(params.mode, params.target_skill);
  const [sessionStatus, setSessionStatus] = useState<
    "choosing" | "starting" | "active" | "ended"
  >("choosing");
  // A skill or activity title is the lesson, not a conversation subject, so the topic starts empty.
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState<ConversationGoal>(defaultGoalForMode(sessionMode));
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("en");

  const [roleplayRole, setRoleplayRole] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [learnerSpeakingSeconds, setLearnerSpeakingSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [saveIssue, setSaveIssue] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [activeCorrection, setActiveCorrection] = useState<InSessionCorrection | null>(null);
  const [correctionCount, setCorrectionCount] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [learnerSpeaking, setLearnerSpeaking] = useState(false);
  const [coachJoined, setCoachJoined] = useState(false);
  // LiveKit Agents publish their pipeline state as the `lk.agent.state` participant attribute.
  const [agentState, setAgentState] = useState<string | null>(null);
  const [deviceVoiceMode, setDeviceVoiceMode] = useState<DeviceVoiceMode>("auto");
  const [deviceVoiceActive, setDeviceVoiceActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // LiveKit Room ref
  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const agentAnalyserRef = useRef<any>(null);
  const agentLevelBufRef = useRef<Uint8Array | null>(null);

  // Web Audio Visualizer refs
  const audioContextRef = useRef<any>(null);
  const analyserRef = useRef<any>(null);
  const animFrameRef = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const coachWatchdogRef = useRef<any>(null);
  const transcriptScrollRef = useRef<ScrollView | null>(null);

  // Device-speech fallback bookkeeping.
  const hasRemoteAudioRef = useRef(false);
  const deviceVoiceModeRef = useRef<DeviceVoiceMode>("auto");
  const pendingSpeechRef = useRef<Map<string, any>>(new Map());
  const isMutedRef = useRef(false);
  const speakingOnDeviceRef = useRef(false);

  // Track whether we already pre-connected
  const preconnectedRef = useRef(false);

  // Animated wave bars (7 fluid bars)
  const waveAnim1 = useRef(new Animated.Value(10)).current;
  const waveAnim2 = useRef(new Animated.Value(14)).current;
  const waveAnim3 = useRef(new Animated.Value(18)).current;
  const waveAnim4 = useRef(new Animated.Value(22)).current;
  const waveAnim5 = useRef(new Animated.Value(18)).current;
  const waveAnim6 = useRef(new Animated.Value(14)).current;
  const waveAnim7 = useRef(new Animated.Value(10)).current;

  // Track agent speaking state for waveform suppression
  const agentSpeakingRef = useRef(false);

  // Real-time Audio Visualizer setup
  const setupAudioVisualizer = (mediaStream: MediaStream) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = audioContextRef.current || new AudioCtx();
        audioContextRef.current = ctx;
        if (ctx.state === "suspended") {
          ctx.resume();
        }

        const source = ctx.createMediaStreamSource(mediaStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let speakingDebounce = 0;

        const loop = () => {
          analyser.getByteFrequencyData(dataArray);
          const v1 = Math.max(10, (dataArray[2] / 255) * 50);
          const v2 = Math.max(14, (dataArray[3] / 255) * 65);
          const v3 = Math.max(18, (dataArray[5] / 255) * 75);
          const v4 = Math.max(22, (dataArray[7] / 255) * 85);
          const v5 = Math.max(18, (dataArray[9] / 255) * 75);
          const v6 = Math.max(14, (dataArray[11] / 255) * 65);
          const v7 = Math.max(10, (dataArray[13] / 255) * 50);

          const avgEnergy = (dataArray[2] + dataArray[4] + dataArray[6] + dataArray[8]) / 4;
          const isUserActuallySpeaking = avgEnergy > 45 && !agentSpeakingRef.current;

          if (isUserActuallySpeaking) {
            setLearnerSpeaking(true);
            speakingDebounce = 15;
            waveAnim1.setValue(v1);
            waveAnim2.setValue(v2);
            waveAnim3.setValue(v3);
            waveAnim4.setValue(v4);
            waveAnim5.setValue(v5);
            waveAnim6.setValue(v6);
            waveAnim7.setValue(v7);
          } else {
            if (speakingDebounce > 0) {
              speakingDebounce -= 1;
            } else {
              setLearnerSpeaking(false);
            }
            if (agentSpeakingRef.current) {
              const t = Date.now() / 180;
              waveAnim1.setValue(16 + Math.sin(t) * 6);
              waveAnim2.setValue(26 + Math.cos(t) * 8);
              waveAnim3.setValue(36 + Math.sin(t + 1) * 10);
              waveAnim4.setValue(44 + Math.cos(t + 1) * 12);
              waveAnim5.setValue(36 + Math.sin(t + 2) * 10);
              waveAnim6.setValue(26 + Math.cos(t + 2) * 8);
              waveAnim7.setValue(16 + Math.sin(t + 3) * 6);
            } else {
              waveAnim1.setValue(10);
              waveAnim2.setValue(14);
              waveAnim3.setValue(18);
              waveAnim4.setValue(22);
              waveAnim5.setValue(18);
              waveAnim6.setValue(14);
              waveAnim7.setValue(10);
            }
          }

          animFrameRef.current = requestAnimationFrame(loop);
        };
        animFrameRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.warn("Visualizer audio context error:", err);
      }
    }
  };

  const attachAgentAudio = (track: Track) => {
    if (track.kind !== Track.Kind.Audio) return;
    hasRemoteAudioRef.current = true;
    cancelPendingDeviceSpeech();
    stopDeviceSpeech().catch(() => {});
    if (Platform.OS !== "web") return;
    if (audioElementRef.current) {
      try {
        audioElementRef.current.remove();
      } catch {}
    }
    const audioElement = track.attach() as HTMLAudioElement;
    audioElementRef.current = audioElement;
    audioElement.autoplay = true;
    audioElement.style.display = "none";
    document.body.appendChild(audioElement);
    audioElement.play().catch((e) => console.debug("Audio play pending gesture:", e));

    // Tap the coach's voice for the avatar's lip-sync.
    try {
      const ctx = audioContextRef.current;
      if (ctx && track.mediaStreamTrack) {
        const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        agentAnalyserRef.current = analyser;
        agentLevelBufRef.current = new Uint8Array(analyser.fftSize);
      }
    } catch (e) {
      console.debug("Coach audio analyser note:", e);
    }
  };

  const getAgentLevel = (): AgentLevel => {
    const analyser = agentAnalyserRef.current;
    const buf = agentLevelBufRef.current;
    if (analyser && buf) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return { value: Math.min(1, Math.sqrt(sum / buf.length) * 5), live: true };
    }
    let level = 0;
    roomRef.current?.remoteParticipants.forEach((p) => {
      level = Math.max(level, p.audioLevel || 0);
    });
    return { value: Math.min(1, level * 2.5), live: false };
  };

  /**
   * Reads a coach turn aloud on the device and holds the microphone closed while it plays,
   * so the phone's own speaker doesn't get transcribed back as learner speech.
   */
  const speakTurnOnDevice = async (text: string) => {
    if (speakingOnDeviceRef.current) {
      await stopDeviceSpeech().catch(() => {});
    }
    // In auto mode, never speak on device if remote audio is actively playing
    if (deviceVoiceModeRef.current === "auto" && hasRemoteAudioRef.current) return;

    speakingOnDeviceRef.current = true;
    setDeviceVoiceActive(true);
    setAgentSpeaking(true);
    agentSpeakingRef.current = true;

    const room = roomRef.current;
    const shouldRestoreMic = !!room && !isMutedRef.current;
    try {
      if (shouldRestoreMic) {
        await room!.localParticipant.setMicrophoneEnabled(false);
      }
      await speakOnDevice(text);
    } catch (err) {
      console.debug("Device speech note:", err);
    } finally {
      if (shouldRestoreMic && roomRef.current) {
        await roomRef.current.localParticipant
          .setMicrophoneEnabled(true, MICROPHONE_OPTIONS)
          .catch(() => {});
      }
      speakingOnDeviceRef.current = false;
      setDeviceVoiceActive(false);
      setAgentSpeaking(false);
      agentSpeakingRef.current = false;
    }
  };

  /** Queues a coach turn, cancelled if real agent audio starts within the grace period. */
  const queueDeviceSpeech = (id: string, text: string) => {
    const mode = deviceVoiceModeRef.current;
    if (mode === "off") return;
    // In auto mode, if remote audio track is already subscribed and active, let server TTS play.
    if (mode === "auto" && hasRemoteAudioRef.current) return;

    const delay = mode === "on" ? 30 : DEVICE_SPEECH_GRACE_MS;
    const handle = setTimeout(() => {
      pendingSpeechRef.current.delete(id);
      if (deviceVoiceModeRef.current === "off") return;
      // The agent found its voice in the meantime; let it speak.
      if (deviceVoiceModeRef.current === "auto" && (hasRemoteAudioRef.current || agentSpeakingRef.current)) return;
      speakTurnOnDevice(text);
    }, delay);
    pendingSpeechRef.current.set(id, handle);
  };

  const cancelPendingDeviceSpeech = () => {
    pendingSpeechRef.current.forEach((handle) => clearTimeout(handle));
    pendingSpeechRef.current.clear();
  };

  // Create the session and join. Driven by an explicit tap so the browser lets us play
  // audio and so the topic/goal the learner picked is what the coach receives.
  const handleStartConversation = async () => {
    if (preconnectedRef.current) return;
    preconnectedRef.current = true;

    setSessionStatus("starting");
    setErrorMessage(null);

    try {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = audioContextRef.current || new AudioCtx();
          audioContextRef.current = ctx;
          if (ctx.state === "suspended") {
            await ctx.resume();
          }
        }
      }

      const sessionPromise = createSession({
        mode: sessionMode,
        targetSkill: params.target_skill,
        lessonId: params.lesson_id,
        topic,
        conversationGoal: goal,
        roleplayScenario: goal === "roleplay" ? buildRoleplayScenario(topic, roleplayRole) : undefined,
        speechLanguage,
      });

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: MICROPHONE_OPTIONS,
      });
      roomRef.current = room;
      // Warm DNS/TLS to LiveKit and the native audio session while the API mints the token.
      room.prepareConnection(LIVEKIT_URL).catch(() => {});
      await startAudioSession();

      const sessionRes = await sessionPromise;
      setSessionId(sessionRes.session_id);

      room.on(RoomEvent.Reconnecting, () => setReconnecting(true));
      room.on(RoomEvent.Reconnected, () => setReconnecting(false));
      room.on(RoomEvent.Disconnected, () => {
        setSessionStatus((prev) => (prev !== "ended" ? "ended" : prev));
      });

      room.on(RoomEvent.ParticipantConnected, (p) => {
        setCoachJoined(true);
        setAgentState(p.attributes?.["lk.agent.state"] ?? null);
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
        if (!p.isLocal) setAgentState(p.attributes?.["lk.agent.state"] ?? null);
      });

      room.on(RoomEvent.TrackSubscribed, attachAgentAudio);

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const remoteSpeaking = speakers.some((s) => !s.isLocal);
        // Web derives this from the mic analyser; native has only LiveKit's speaker updates.
        if (Platform.OS !== "web") setLearnerSpeaking(speakers.some((s) => s.isLocal));
        if (remoteSpeaking) {
          // Real coach audio wins over the device fallback.
          cancelPendingDeviceSpeech();
          stopDeviceSpeech().catch(() => {});
        }
        if (speakingOnDeviceRef.current) return;
        agentSpeakingRef.current = remoteSpeaking;
        setAgentSpeaking(remoteSpeaking);
        if (remoteSpeaking) {
          setLearnerSpeaking(false);
        }
      });

      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === "correction") {
            setActiveCorrection({
              card_type: data.card_type === "translation" ? "translation" : "correction",
              original: String(data.original ?? ""),
              corrected: String(data.corrected ?? ""),
              explanation: String(data.explanation ?? ""),
              target_skill: data.target_skill,
            });
            setCorrectionCount((prev) => prev + 1);
          } else if (data.type === "turn" && typeof data.text === "string" && data.text.trim()) {
            setTranscript((prev) => {
              const spk: "learner" | "tutor" = data.speaker === "learner" ? "learner" : "tutor";
              const last = prev[prev.length - 1];
              if (
                last &&
                last.speaker === spk &&
                last.text.trim().toLowerCase() === data.text.trim().toLowerCase()
              ) {
                return prev;
              }
              setTimeout(() => {
                transcriptScrollRef.current?.scrollToEnd({ animated: true });
              }, 100);
              const id = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
              if (spk === "tutor") {
                queueDeviceSpeech(id, data.text);
              }
              return [
                ...prev,
                {
                  id,
                  speaker: spk,
                  text: data.text,
                  timestamp:
                    data.timestamp ||
                    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                },
              ];
            });
          }
        } catch (e) {
          console.debug("Data message parse note:", e);
        }
      });

      await room.connect(LIVEKIT_URL, sessionRes.livekit_token);

      // Unlock playback for any track that arrived during connect.
      try {
        await room.startAudio();
        room.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            if (pub.track) attachAgentAudio(pub.track);
          });
        });
      } catch (e) {
        console.debug("Audio unlock note:", e);
      }

      await room.localParticipant.setMicrophoneEnabled(true, MICROPHONE_OPTIONS);

      room.localParticipant.audioTrackPublications.forEach((pub) => {
        if (pub.track?.mediaStream) {
          setupAudioVisualizer(pub.track.mediaStream);
        }
      });

      // Tells the agent the learner can hear us, so it greets immediately.
      try {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ type: "start_conversation" })),
          { reliable: true }
        );
      } catch (e) {
        console.debug("Start signal broadcast note:", e);
      }

      setSessionStatus("active");
      setCoachJoined(room.remoteParticipants.size > 0);
      room.remoteParticipants.forEach((p) => setAgentState(p.attributes?.["lk.agent.state"] ?? null));

      // A room with no agent in it looks identical to a working one from the client side,
      // so say so rather than leaving the learner talking to silence.
      coachWatchdogRef.current = setTimeout(() => {
        if (!roomRef.current || roomRef.current.remoteParticipants.size > 0) return;
        setErrorMessage(
          "Coach Pravaah hasn't joined this room, so there's nothing to speak or transcribe. " +
            "Check that the voice agent worker is deployed and registered with LiveKit."
        );
      }, 15000);

      timerRef.current = setInterval(() => {
        setSessionSeconds((prev) => prev + 1);
        setLearnerSpeaking((isSpeaking) => {
          if (isSpeaking) {
            setLearnerSpeakingSeconds((spk) => spk + 1);
          }
          return isSpeaking;
        });
      }, 1000);
    } catch (err: any) {
      console.warn("Start conversation error:", err);
      preconnectedRef.current = false;
      if (coachWatchdogRef.current) clearTimeout(coachWatchdogRef.current);
      const failedRoom = roomRef.current;
      roomRef.current = null;
      // Detach first: its Disconnected event would otherwise flip this screen to "ended".
      failedRoom?.removeAllListeners();
      try {
        failedRoom?.disconnect();
      } catch {}
      stopAudioSession().catch(() => {});
      setErrorMessage(
        err?.message === "NOT_AUTHENTICATED"
          ? "Your session expired. Please sign in again."
          : err?.name === "NotAllowedError"
          ? "Microphone access is blocked. Allow microphone access for Pravaah and try again."
          : err?.message || "Could not start the conversation. Please try again."
      );
      setSessionStatus("choosing");
    }
  };

  useEffect(() => {
    prewarmDeviceSpeech();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (coachWatchdogRef.current) clearTimeout(coachWatchdogRef.current);
      cancelPendingDeviceSpeech();
      stopDeviceSpeech();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioContextRef.current) {
        try {
          audioContextRef.current.close();
        } catch {}
      }
      if (audioElementRef.current) {
        audioElementRef.current.remove();
      }
      if (roomRef.current) {
        roomRef.current.disconnect();
      }
      stopAudioSession().catch(() => {});
    };
  }, []);

  const handleToggleMute = async () => {
    if (roomRef.current) {
      try {
        const nextMute = !isMuted;
        await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMute, MICROPHONE_OPTIONS);
        isMutedRef.current = nextMute;
        setIsMuted(nextMute);
      } catch (err) {
        console.warn("Mute error:", err);
      }
    } else {
      isMutedRef.current = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleToggleDeviceVoice = () => {
    const next: DeviceVoiceMode = deviceVoiceMode === "on" ? "auto" : "on";
    deviceVoiceModeRef.current = next;
    setDeviceVoiceMode(next);
    if (audioElementRef.current) {
      audioElementRef.current.muted = next === "on";
    }
    if (next === "auto") {
      cancelPendingDeviceSpeech();
      stopDeviceSpeech();
    }
  };

  const handleEndSession = () => {
    if (Platform.OS === "web" && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (timerRef.current) clearInterval(timerRef.current);
    if (coachWatchdogRef.current) clearTimeout(coachWatchdogRef.current);
    cancelPendingDeviceSpeech();
    stopDeviceSpeech();
    if (roomRef.current) {
      roomRef.current.disconnect();
    }
    stopAudioSession().catch(() => {});
    setSessionStatus("ended");
    setShowSummary(true);
  };

  const handleAdvanceAndReturn = async () => {
    if (savingSummary) return;
    setSavingSummary(true);
    setErrorMessage(null);
    try {
      if (sessionId) {
        const result = await completeSession(
          sessionId,
          sessionSeconds,
          undefined, // The server uses the saved lesson/activity and target skill.
          undefined,
          transcript.map((t) => ({
            role: t.speaker === "learner" ? "user" : "assistant",
            text: t.text,
            timestamp: t.timestamp,
          }))
        );
        if (result.retryable) {
          // The session and its minutes are already saved; only the coaching analysis
          // is outstanding. Offer a retry but never hold the learner on this screen.
          setSaveIssue(
            "Session saved. Your corrections and plan update are still being processed, so they may appear a little later."
          );
          return;
        }
      }
      router.replace("/");
    } catch (err: any) {
      setSaveIssue(
        err?.message === "NOT_AUTHENTICATED"
          ? "Your sign-in expired, so this session could not be saved."
          : err?.message || "Could not save this session."
      );
    } finally {
      setSavingSummary(false);
    }
  };

  const formatSeconds = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins < 10 ? `0${mins}` : mins}:${s < 10 ? `0${s}` : s}`;
  };

  const getSpeakingStateLabel = () => {
    if (reconnecting) return "Reconnecting";
    if (sessionStatus === "starting") return "Connecting";
    if (sessionStatus === "ended") return "Session ended";
    if (deviceVoiceActive) return "Coach speaking (device)";
    if (!coachJoined) return "Waiting for coach";
    if (agentSpeaking) return "Coach speaking";
    if (learnerSpeaking) return "You're speaking";
    if (isMuted) return "Muted";
    return "Listening";
  };

  const getSpeakingStateColor = () => {
    if (reconnecting || sessionStatus === "starting" || !coachJoined) return colors.amberWarning;
    if (sessionStatus === "ended") return colors.fog;
    if (agentSpeaking) return colors.irisBlue;
    if (learnerSpeaking) return colors.skyBlue;
    if (isMuted) return colors.fog;
    return colors.emeraldSuccess;
  };

  const getAvatarState = (): CoachAvatarState => {
    if (reconnecting || !coachJoined || agentState === "initializing") return "connecting";
    if (deviceVoiceActive || agentSpeaking || agentState === "speaking") return "speaking";
    if (agentState === "thinking") return "thinking";
    if (isMuted) return "muted";
    return "listening";
  };

  const latestTutorLine = [...transcript].reverse().find((t) => t.speaker === "tutor")?.text;

  // =========================================================================
  // VIEW 1: TOPIC & GOAL PICKER
  // =========================================================================
  if (sessionStatus === "choosing" || sessionStatus === "starting") {
    const isStarting = sessionStatus === "starting";
    const readyToStart = goal !== "roleplay" || !!(roleplayRole.trim() || topic.trim());
    const isRoleplay = goal === "roleplay";
    const topicSuggestions = isRoleplay ? ROLEPLAY_SITUATIONS : TOPIC_SUGGESTIONS;

    return (
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
        {/* Top Header */}
        <View style={styles.topHeader}>
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && styles.btnPressed]}
            onPress={() => router.replace("/")}
          >
            <Ionicons name="arrow-back" size={18} color={colors.textPrimary} />
            <Text style={styles.backBtnText}>Dashboard</Text>
          </Pressable>

          <View style={styles.topHeaderRight}>
            {params.stage ? (
              <View style={styles.stagePill}>
                <Text style={styles.stagePillText}>
                  {params.stage.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                </Text>
              </View>
            ) : null}

            <Pressable
              style={({ pressed }) => [styles.themeBtn, pressed && styles.btnPressed]}
              onPress={toggleTheme}
              accessibilityRole="button"
              accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.preSessionScroll,
            { paddingBottom: Math.max(insets.bottom + 24, 40) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.preSessionHero}>
            <Text style={styles.preSessionTitle}>
              {activityTitle(params.activity_title) || "What shall we talk about?"}
            </Text>
            <Text style={styles.preSessionSubhead}>
              Pick a subject and a goal. Practise your English with corrections,
              short explanations and a chance to try again.
            </Text>
          </View>

          {/* Step 1 — Topic */}
          <View style={styles.setupCard}>
            <Text style={styles.setupStepLabel}>
              {isRoleplay ? "Situation" : "Topic"}
            </Text>
            <TextInput
              style={styles.topicInput}
              placeholder={
                isRoleplay
                  ? "e.g. a job interview, hotel check-in…"
                  : "e.g. my new job, last weekend, cricket…"
              }
              placeholderTextColor={colors.fog}
              value={topic}
              onChangeText={setTopic}
              maxLength={120}
              returnKeyType="done"
            />
            <View style={styles.chipWrap}>
              {topicSuggestions.map((t) => {
                const selected = topic.trim().toLowerCase() === t.toLowerCase();
                return (
                  <Pressable
                    key={t}
                    style={[styles.suggestChip, selected && styles.suggestChipActive]}
                    onPress={() => setTopic(selected ? "" : t)}
                  >
                    <Text style={[styles.suggestChipText, selected && styles.suggestChipTextActive]}>
                      {t}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Step 2 — Goal */}
          <View style={styles.setupCard}>
            <Text style={styles.setupStepLabel}>Practice style</Text>
            <View style={styles.goalGrid}>
              {GOAL_OPTIONS.map((opt) => {
                const selected = goal === opt.goal;
                return (
                  <Pressable
                    key={opt.goal}
                    style={({ pressed }) => [
                      styles.goalCard,
                      isCompact ? styles.goalCardFull : styles.goalCardHalf,
                      selected && styles.goalCardActive,
                      pressed && styles.btnPressed,
                    ]}
                    onPress={() => setGoal(opt.goal)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                  >
                    <View
                      style={[
                        styles.goalIconBadge,
                        { backgroundColor: selected ? colors.irisBlue : colors.primarySoft },
                      ]}
                    >
                      <Ionicons
                        name={opt.icon}
                        size={18}
                        color={selected ? "#ffffff" : colors.irisBlue}
                      />
                    </View>
                    <View style={styles.goalCardTextCol}>
                      <Text style={[styles.goalCardTitle, selected && styles.goalCardTitleActive]}>
                        {opt.label}
                      </Text>
                      <Text style={styles.goalCardBlurb} numberOfLines={2}>
                        {opt.blurb}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {goal === "roleplay" ? (
              <View style={styles.scenarioBlock}>
                <Text style={styles.scenarioLabel}>Who should Coach Pravaah play?</Text>
                <View style={styles.chipWrap}>
                  {ROLEPLAY_ROLES.map((r) => {
                    const selected = roleplayRole === r;
                    return (
                      <Pressable
                        key={r}
                        style={[styles.suggestChip, selected && styles.suggestChipActive]}
                        onPress={() => setRoleplayRole(selected ? "" : r)}
                      >
                        <Text
                          style={[styles.suggestChipText, selected && styles.suggestChipTextActive]}
                        >
                          {r}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>

          {params.target_skill ? (
            <View style={styles.focusCard}>
              <Text style={styles.focusCardEyebrow}>Today's target skill</Text>
              <Text style={styles.focusCardTitle}>{skillLabel(params.target_skill)}</Text>
            </View>
          ) : null}

          <View style={styles.setupCard}>
            <Text style={styles.setupStepLabel}>Speech recognition language</Text>
            <View style={styles.chipWrap}>
              {([
                { value: "en", label: "English · best accuracy" },
                { value: "hi", label: "Hindi" },
                { value: "auto", label: "Auto detect" },
              ] as const).map((option) => (
                <Pressable
                  key={option.value}
                  style={[styles.suggestChip, speechLanguage === option.value && styles.suggestChipActive]}
                  onPress={() => setSpeechLanguage(option.value)}
                  disabled={isStarting}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: speechLanguage === option.value }}
                >
                  <Text style={[styles.suggestChipText, speechLanguage === option.value && styles.suggestChipTextActive]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={[styles.goalCardBlurb, { marginTop: 10 }]}>
              Auto supports switching languages. Choose Hindi or English if recognition gets your language wrong.
              This does not change your Hindi explanation preference.
            </Text>
          </View>

          <View style={styles.tipsCard}>
            <View style={styles.tipItem}>
              <Ionicons name="headset-outline" size={20} color={colors.irisBlue} />
              <Text style={styles.tipText}>Use headphones or earphones for best microphone clarity</Text>
            </View>
            <View style={styles.tipItem}>
              <Ionicons name="globe-outline" size={20} color={colors.skyBlue} />
              <Text style={styles.tipText}>
                If stuck, speak in Hindi, then practise the English version. A quieter spot helps recognition.
              </Text>
            </View>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={18} color={colors.crimsonError} />
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          <View style={styles.preSessionActionContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.startCallBtn,
                (isStarting || !readyToStart) && styles.btnDisabled,
                pressed && !isStarting && styles.btnPressed,
              ]}
              onPress={handleStartConversation}
              disabled={isStarting || !readyToStart}
            >
              {isStarting ? (
                <View style={styles.btnLoadingRow}>
                  <ActivityIndicator size="small" color={colors.textOnPrimary} />
                  <Text style={styles.startCallBtnText}>Connecting</Text>
                </View>
              ) : (
                <View style={styles.btnLoadingRow}>
                  <Ionicons name="mic-outline" size={20} color={colors.textOnPrimary} />
                  <Text style={styles.startCallBtnText}>
                    {topic.trim()
                      ? `Start talking about ${topic.trim()}`
                      : isRoleplay && roleplayRole.trim()
                      ? `Start roleplay with the ${roleplayRole}`
                      : "Start coached conversation"}
                  </Text>
                </View>
              )}
            </Pressable>

            <Pressable style={styles.cancelBtn} onPress={() => router.replace("/")}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // VIEW 2: ACTIVE LIVE CALL SCREEN
  // =========================================================================
  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 12) }]}>
      {/* Top Mobile Call Bar */}
      <View style={styles.activeCallHeader}>
        <View style={styles.callStatusBadge}>
          <View style={[styles.statusDot, { backgroundColor: getSpeakingStateColor() }]} />
          <Text style={[styles.statusText, { color: getSpeakingStateColor() }]}>
            {getSpeakingStateLabel()}
          </Text>
        </View>

        <View style={styles.topHeaderRight}>
          <View style={styles.callTimerPill}>
            <Ionicons name="time-outline" size={14} color={colors.textPrimary} />
            <Text style={styles.callTimerText}>{formatSeconds(sessionSeconds)}</Text>
          </View>

          <Pressable
            style={({ pressed }) => [styles.themeBtn, pressed && styles.btnPressed]}
            onPress={toggleTheme}
            accessibilityRole="button"
            accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={18} color={colors.textSecondary} />
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.quickEndBtn, pressed && styles.btnPressed]}
            onPress={handleEndSession}
          >
            <Text style={styles.quickEndBtnText}>End</Text>
          </Pressable>
        </View>
      </View>

      {/* Activity Context Sub-Header */}
      {params.activity_title ? (
        <View style={styles.activeActivityBar}>
          <Text style={styles.activeActivityTitle} numberOfLines={1}>
            {activityTitle(params.activity_title)}
          </Text>
        </View>
      ) : null}

      {/* Main Conversation Body */}
      <View style={styles.activeCallBody}>
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={colors.crimsonError} />
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        <CoachAvatar
          state={getAvatarState()}
          learnerSpeaking={learnerSpeaking}
          getLevel={getAgentLevel}
          caption={latestTutorLine}
          size={Math.min(180, Math.round(width * 0.4))}
          hint={
            isMuted
              ? "Microphone is muted"
              : speechLanguage === "hi"
              ? "Speak in Hindi. The coach replies in English."
              : "Speak in full sentences and pause when you finish."
          }
        />

        {/* Real-time Recast / Translation Floating Card */}
        {activeCorrection ? (
          <View
            style={[
              styles.liveCorrectionCard,
              activeCorrection.card_type === "translation" && styles.liveTranslationCard,
            ]}
          >
            <View style={styles.correctionTopRow}>
              <View
                style={[
                  styles.correctionPill,
                  activeCorrection.card_type === "translation" && styles.translationPill,
                ]}
              >
                <Text style={styles.correctionPillText}>
                  {activeCorrection.card_type === "translation" ? "In English" : "Quick correction"}
                </Text>
              </View>
              <Pressable onPress={() => setActiveCorrection(null)} hitSlop={12}>
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.correctionSpeechComparison}>
              <View style={styles.correctionLine}>
                <Ionicons name="close-circle" size={16} color={colors.crimsonError} />
                <Text style={styles.originalSpeechText} numberOfLines={3}>
                  {activeCorrection.original}
                </Text>
              </View>
              <View style={styles.correctionLine}>
                <Ionicons name="checkmark-circle" size={16} color={colors.emeraldSuccess} />
                <Text style={styles.betterSpeechText} numberOfLines={3}>
                  {activeCorrection.corrected}
                </Text>
              </View>
            </View>

            {activeCorrection.explanation ? (
              <Text style={styles.correctionWhyText} numberOfLines={3}>
                {activeCorrection.explanation}
              </Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [styles.gotItBtn, pressed && styles.btnPressed]}
              onPress={() => setActiveCorrection(null)}
            >
              <Text style={styles.gotItBtnText}>Got it</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Live Conversation Chat Transcript */}
        <View style={styles.transcriptSection}>
          <View style={styles.transcriptHeaderRow}>
            <Text style={styles.transcriptSectionLabel}>Transcript</Text>
            {correctionCount > 0 ? (
              <Text style={styles.transcriptCountLabel}>
                {correctionCount} correction{correctionCount === 1 ? "" : "s"}
              </Text>
            ) : null}
          </View>
          <ScrollView
            ref={transcriptScrollRef}
            contentContainerStyle={styles.transcriptContent}
            showsVerticalScrollIndicator={false}
          >
            {transcript.length === 0 ? (
              <View style={styles.emptyTranscriptBubble}>
                <Ionicons name="mic-outline" size={18} color={colors.irisBlue} />
                <Text style={styles.emptyTranscriptText}>
                  Your conversation will appear here as you speak.
                </Text>
              </View>
            ) : (
              transcript.map((t) => (
                <View
                  key={t.id}
                  style={[
                    styles.chatBubble,
                    t.speaker === "tutor" ? styles.bubbleTutor : styles.bubbleLearner,
                  ]}
                >
                  <View style={styles.bubbleHeaderRow}>
                    <Text
                      style={[
                        styles.bubbleSpeakerLabel,
                        t.speaker === "learner" && { color: "rgba(255, 255, 255, 0.85)" },
                      ]}
                    >
                      {t.speaker === "tutor" ? "Coach" : "You"}
                    </Text>
                    <Text
                      style={[
                        styles.bubbleTimestamp,
                        t.speaker === "learner" && { color: "rgba(255, 255, 255, 0.75)" },
                      ]}
                    >
                      {t.timestamp}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.bubbleText,
                      t.speaker === "learner" && { color: "#ffffff" },
                    ]}
                  >
                    {t.text}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>

      {/* Pinned Bottom Call Bar */}
      <View
        style={[
          styles.bottomCallBar,
          {
            paddingBottom: Math.max(insets.bottom, 12),
            height: 84 + Math.max(insets.bottom, 12),
          },
        ]}
      >
        {/* Mute Button */}
        <Pressable
          style={({ pressed }) => [
            styles.roundCallBtn,
            isMuted && styles.roundCallBtnActive,
            pressed && styles.btnPressed,
          ]}
          onPress={handleToggleMute}
        >
          <View style={[styles.roundCallCircle, isMuted && styles.roundCallCircleActive]}>
            <Ionicons
              name={isMuted ? "mic-off" : "mic"}
              size={24}
              color={isMuted ? colors.crimsonError : colors.textPrimary}
            />
          </View>
          <Text style={styles.roundCallBtnLabel}>{isMuted ? "Unmute" : "Mute"}</Text>
        </Pressable>

        {/* Device voice fallback. Auto kicks in only when no coach audio arrives. */}
        <Pressable
          style={({ pressed }) => [
            styles.roundCallBtn,
            deviceVoiceMode === "on" && styles.roundCallBtnOn,
            pressed && styles.btnPressed,
          ]}
          onPress={handleToggleDeviceVoice}
          accessibilityLabel="Read the coach's replies using the device voice"
        >
          <View style={[styles.roundCallCircle, deviceVoiceMode === "on" && styles.roundCallCircleOn]}>
            <Ionicons
              name={deviceVoiceMode === "on" ? "volume-high" : "phone-portrait-outline"}
              size={22}
              color={deviceVoiceMode === "on" ? colors.emeraldSuccess : colors.textPrimary}
            />
          </View>
          <Text style={styles.roundCallBtnLabel}>
            {deviceVoiceMode === "on" ? "Device voice" : "Auto voice"}
          </Text>
        </Pressable>

        {/* End Call Button */}
        <Pressable
          style={({ pressed }) => [styles.roundCallBtn, pressed && styles.btnPressed]}
          onPress={handleEndSession}
          accessibilityLabel="End session"
        >
          <View style={styles.roundEndBtn}>
            <Ionicons name="call" size={26} color="#ffffff" style={{ transform: [{ rotate: "135deg" }] }} />
          </View>
          <Text style={styles.roundEndBtnLabel}>End</Text>
        </Pressable>
      </View>

      {/* Session Summary Modal */}
      <Modal visible={showSummary} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.summaryCard, { paddingBottom: Math.max(insets.bottom + 20, 24) }]}>
            <View style={styles.summaryTopBadge}>
              <Ionicons name="checkmark-circle" size={14} color={colors.emeraldSuccess} />
              <Text style={styles.summaryTopBadgeText}>Session complete</Text>
            </View>

            <Text style={styles.summaryTitle}>Nice work</Text>
            <Text style={styles.summarySubtitle}>
              {activityTitle(params.activity_title) || "Spoken conversation"}
            </Text>

            {/* 4-Stat Mobile Grid */}
            <View style={styles.summaryGrid}>
              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{formatSeconds(sessionSeconds)}</Text>
                <Text style={styles.summaryStatLabel}>Duration</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>
                  {Platform.OS === "web" ? formatSeconds(learnerSpeakingSeconds) : "—"}
                </Text>
                <Text style={styles.summaryStatLabel}>Your speaking time</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{correctionCount}</Text>
                <Text style={styles.summaryStatLabel}>Corrections</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{transcript.length}</Text>
                <Text style={styles.summaryStatLabel}>Turns</Text>
              </View>
            </View>

            <Text style={styles.summarySavedNotice}>
              Save your conversation to update your plan. Recorded mistakes and vocabulary
              will appear on the dashboard after analysis.
            </Text>
            {saveIssue ? (
              <View style={styles.summaryNoticeBox}>
                <Ionicons name="information-circle-outline" size={18} color={colors.amberWarning} />
                <Text style={styles.summaryNoticeText}>{saveIssue}</Text>
              </View>
            ) : null}

            <Pressable
              style={({ pressed }) => [styles.primaryReturnBtn, pressed && styles.btnPressed]}
              onPress={handleAdvanceAndReturn}
              disabled={savingSummary}
            >
              {savingSummary ? (
                <ActivityIndicator size="small" color={colors.textOnPrimary} />
              ) : (
                <Text style={styles.primaryReturnBtnText}>
                  {saveIssue ? "Try saving again" : "Save and return to dashboard"}
                </Text>
              )}
            </Pressable>

            {saveIssue ? (
              <Pressable
                style={({ pressed }) => [styles.secondaryReturnBtn, pressed && styles.btnPressed]}
                onPress={() => router.replace("/")}
                disabled={savingSummary}
              >
                <Text style={styles.secondaryReturnBtnText}>Back to dashboard</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(colors: ThemeColors, isDark: boolean, activeTheme: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
    topHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
    },
    topHeaderRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 4,
    },
    backBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.bodySm,
      color: colors.textPrimary,
      fontWeight: "500",
    },
    themeBtn: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    stagePill: {
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    stagePillText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.irisBlue,
      fontWeight: "500",
    },
    preSessionScroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      alignItems: "center",
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    preSessionHero: {
      alignSelf: "stretch",
      marginTop: theme.spacing.sm,
      marginBottom: 24,
    },
    ambientPulseSphere: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: colors.powderBlue,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.lg,
      borderWidth: 2,
      borderColor: colors.powderBorder,
    },
    micCircleBadge: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.cardElevated,
      alignItems: "center",
      justifyContent: "center",
    },
    preSessionTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 6,
      lineHeight: 32,
      letterSpacing: -0.5,
    },
    preSessionSubhead: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      color: colors.textSecondary,
      lineHeight: 22,
    },
    setupCard: {
      width: "100%",
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 12,
      ...activeTheme.shadows.sm,
    },
    setupStepLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 12,
    },
    topicInput: {
      height: 48,
      borderRadius: 12,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: theme.spacing.md,
      color: colors.textPrimary,
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
      marginBottom: theme.spacing.md,
    },
    chipWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    suggestChip: {
      paddingHorizontal: 14,
      minHeight: 36,
      justifyContent: "center",
      borderRadius: theme.radii.full,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
    },
    suggestChipActive: {
      backgroundColor: colors.primarySoft,
      borderColor: colors.irisBlue,
    },
    suggestChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    suggestChipTextActive: {
      color: colors.irisBlue,
      fontWeight: "600",
    },
    goalGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
    },
    goalCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 64,
      padding: 14,
      borderRadius: 14,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
    },
    goalCardFull: {
      width: "100%",
    },
    goalCardHalf: {
      flexGrow: 1,
      flexBasis: "47%",
    },
    goalCardActive: {
      borderColor: colors.irisBlue,
      backgroundColor: colors.primarySoft,
    },
    goalIconBadge: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    goalCardTextCol: {
      flex: 1,
    },
    goalCardTitle: {
      fontFamily: theme.fonts.display,
      fontSize: theme.fontSizes.bodySm,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    goalCardTitleActive: {
      color: colors.textPrimary,
    },
    goalCardBlurb: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 17,
      marginTop: 2,
    },
    scenarioBlock: {
      marginTop: theme.spacing.lg,
    },
    scenarioLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.bodySm,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: theme.spacing.sm,
    },
    focusCard: {
      width: "100%",
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
      borderLeftWidth: 3,
      borderLeftColor: colors.irisBlue,
      marginBottom: 12,
    },
    focusCardEyebrow: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      fontWeight: "500",
      marginBottom: 4,
    },
    focusCardTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 17,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    tipsCard: {
      width: "100%",
      backgroundColor: colors.cardSubtle,
      borderRadius: 16,
      padding: 16,
      gap: 12,
      marginBottom: 24,
    },
    tipItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    tipText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 19,
    },
    errorBanner: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.crimsonWash,
      borderWidth: 1,
      borderColor: colors.crimsonError,
      borderRadius: 12,
      padding: 12,
      gap: 8,
      marginBottom: 12,
      width: "100%",
    },
    errorBannerText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.bodySm,
      fontWeight: "500",
      color: colors.crimsonError,
    },
    preSessionActionContainer: {
      width: "100%",
      gap: 12,
      marginTop: "auto",
    },
    startCallBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 20,
    },
    btnLoadingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    startCallBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    cancelBtn: {
      alignItems: "center",
      paddingVertical: 10,
    },
    cancelBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.bodySm,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    btnDisabled: {
      opacity: 0.5,
    },
    btnPressed: {
      opacity: 0.85,
    },
    activeCallHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 10,
      backgroundColor: colors.canvas,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    callStatusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
    },
    callTimerPill: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 4,
      paddingVertical: 5,
      gap: 4,
    },
    callTimerText: {
      fontFamily: theme.fonts.mono,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textPrimary,
    },
    quickEndBtn: {
      backgroundColor: colors.crimsonError,
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 10,
    },
    quickEndBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: "#ffffff",
    },
    activeActivityBar: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: 10,
    },
    activeActivityTitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textSecondary,
      fontWeight: "500",
    },
    activeCallBody: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
    },
    visualizerOrbContainer: {
      alignItems: "center",
      marginVertical: theme.spacing.md,
    },
    visualizerOrb: {
      width: 130,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.cardElevated,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      marginBottom: 8,
      ...activeTheme.shadows.card,
    },
    waveBarsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      height: 50,
    },
    waveBar: {
      width: 4,
      borderRadius: theme.radii.full,
    },
    visualizerHintText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.textSecondary,
    },
    liveCorrectionCard: {
      backgroundColor: colors.cardElevated,
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      borderLeftWidth: 3,
      borderLeftColor: colors.irisBlue,
      marginBottom: 10,
      ...activeTheme.shadows.card,
    },
    liveTranslationCard: {
      borderLeftColor: colors.skyBlue,
    },
    correctionTopRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8,
    },
    correctionPill: {
      paddingVertical: 2,
    },
    translationPill: {},
    correctionPillText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    correctionSpeechComparison: {
      gap: 6,
      marginBottom: 8,
    },
    correctionLine: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    originalSpeechText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      textDecorationLine: "line-through",
    },
    betterSpeechText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    correctionWhyText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 17,
      marginBottom: 8,
    },
    gotItBtn: {
      alignSelf: "flex-end",
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 10,
    },
    gotItBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.irisBlue,
      fontWeight: "600",
    },
    transcriptSection: {
      flex: 1,
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 88,
      ...activeTheme.shadows.sm,
    },
    transcriptHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    transcriptCountLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.textSecondary,
      fontWeight: "500",
    },
    transcriptSectionLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textPrimary,
      fontWeight: "600",
    },
    transcriptContent: {
      gap: 10,
      paddingBottom: 8,
    },
    emptyTranscriptBubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 14,
    },
    emptyTranscriptText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
    },
    chatBubble: {
      maxWidth: "88%",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 16,
    },
    bubbleTutor: {
      alignSelf: "flex-start",
      backgroundColor: colors.cardSubtle,
      borderTopLeftRadius: 4,
    },
    bubbleLearner: {
      alignSelf: "flex-end",
      backgroundColor: colors.primary,
      borderTopRightRadius: 4,
    },
    bubbleHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 3,
      gap: 8,
    },
    bubbleSpeakerLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 11,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    bubbleTimestamp: {
      fontFamily: theme.fonts.sans,
      fontSize: 11,
      color: colors.textMuted,
    },
    bubbleText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    bottomCallBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.cardElevated,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      flexDirection: "row",
      justifyContent: "space-around",
      alignItems: "center",
      paddingHorizontal: theme.spacing.xl,
    },
    roundCallBtn: {
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      minWidth: 80,
    },
    roundCallBtnActive: {
      opacity: 0.95,
    },
    roundCallBtnOn: {
      opacity: 1,
    },
    roundCallCircle: {
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: colors.cardSubtle,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    roundCallCircleActive: {
      backgroundColor: colors.crimsonWash,
      borderColor: colors.crimsonError,
    },
    roundCallCircleOn: {
      backgroundColor: colors.emeraldWash,
      borderColor: colors.emeraldSuccess,
    },
    roundCallBtnLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    roundEndBtn: {
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: colors.crimsonError,
      alignItems: "center",
      justifyContent: "center",
    },
    roundEndBtnLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.crimsonError,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(10, 13, 18, 0.65)",
      justifyContent: "flex-end",
    },
    summaryCard: {
      backgroundColor: colors.cardElevated,
      borderTopLeftRadius: theme.radii.xl,
      borderTopRightRadius: theme.radii.xl,
      padding: 24,
      borderWidth: 1,
      borderColor: colors.border,
    },
    summaryTopBadge: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.emeraldWash,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      marginBottom: 12,
    },
    summaryTopBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.emeraldSuccess,
    },
    summaryTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      color: colors.textPrimary,
      textAlign: "center",
      marginBottom: 4,
      letterSpacing: -0.5,
    },
    summarySubtitle: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
      color: colors.textSecondary,
      textAlign: "center",
      marginBottom: theme.spacing.lg,
    },
    summaryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      marginBottom: theme.spacing.lg,
    },
    summaryStatTile: {
      flexGrow: 1,
      flexBasis: "45%",
      borderRadius: 14,
      padding: 14,
      backgroundColor: colors.cardSubtle,
    },
    summaryStatValue: {
      fontFamily: theme.fonts.display,
      fontSize: 22,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 2,
    },
    summaryStatLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      fontWeight: "400",
    },
    summarySavedNotice: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      textAlign: "center",
      marginBottom: theme.spacing.lg,
      lineHeight: 19,
    },
    summaryNoticeBox: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: colors.solarGradient,
      borderWidth: 1,
      borderColor: colors.solarBorder,
      borderRadius: 12,
      padding: 12,
      marginBottom: theme.spacing.md,
    },
    summaryNoticeText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textPrimary,
    },
    primaryReturnBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryReturnBtn: {
      height: 48,
      marginTop: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryReturnBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.bodySm,
      fontWeight: "500",
      color: colors.textPrimary,
    },
    primaryReturnBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
  });
}

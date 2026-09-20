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

import { useState, useEffect, useRef } from "react";
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
import { speakOnDevice, stopDeviceSpeech } from "../lib/deviceSpeech";
import { skillLabel } from "../lib/skills";
import { theme } from "../lib/theme";

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

/**
 * The learner already chose a specific skill or lesson to open this session, so the topic
 * step defaults to that skill or lesson name instead of asking them to type it again.
 */
function defaultTopicFor(
  mode?: string,
  targetSkill?: string,
  activityTitle?: string,
  lessonId?: string
): string {
  if (activityTitle && activityTitle.trim() && activityTitle !== "Spoken Practice") {
    return activityTitle.trim();
  }
  if (targetSkill && targetSkill.trim()) {
    return skillLabel(targetSkill);
  }
  if (lessonId && lessonId.trim()) {
    return lessonId
      .replace(/^lesson_/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "";
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
  const [topic, setTopic] = useState(() =>
    defaultTopicFor(sessionMode, params.target_skill, params.activity_title, params.lesson_id)
  );
  const [goal, setGoal] = useState<ConversationGoal>(defaultGoalForMode(sessionMode));
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("auto");

  // Sync topic whenever incoming params update or load
  useEffect(() => {
    const def = defaultTopicFor(sessionMode, params.target_skill, params.activity_title, params.lesson_id);
    if (def && (!topic || topic.trim() === "")) {
      setTopic(def);
    }
  }, [params.target_skill, params.activity_title, params.lesson_id, sessionMode]);
  const [roleplayRole, setRoleplayRole] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [learnerSpeakingSeconds, setLearnerSpeakingSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [activeCorrection, setActiveCorrection] = useState<InSessionCorrection | null>(null);
  const [correctionCount, setCorrectionCount] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [learnerSpeaking, setLearnerSpeaking] = useState(false);
  const [coachJoined, setCoachJoined] = useState(false);
  const [deviceVoiceMode, setDeviceVoiceMode] = useState<DeviceVoiceMode>("auto");
  const [deviceVoiceActive, setDeviceVoiceActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // LiveKit Room ref
  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

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
  };

  /**
   * Reads a coach turn aloud on the device and holds the microphone closed while it plays,
   * so the phone's own speaker doesn't get transcribed back as learner speech.
   */
  const speakTurnOnDevice = async (text: string) => {
    if (speakingOnDeviceRef.current) return;
    // Never speak on device if remote audio is playing or coach is present
    if (hasRemoteAudioRef.current && agentSpeakingRef.current) return;

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
    // When connected to LiveKit room with an agent, NEVER talk over the server agent!
    if (mode === "auto" && (hasRemoteAudioRef.current || coachJoined || !!roomRef.current)) return;

    const delay = mode === "on" ? 150 : 8000;
    const handle = setTimeout(() => {
      pendingSpeechRef.current.delete(id);
      if (deviceVoiceModeRef.current === "off") return;
      // The agent found its voice in the meantime; let it speak.
      if (deviceVoiceModeRef.current === "auto" && (hasRemoteAudioRef.current || agentSpeakingRef.current || coachJoined)) return;
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

      const sessionRes = await createSession({
        mode: sessionMode,
        targetSkill: params.target_skill,
        lessonId: params.lesson_id,
        topic,
        conversationGoal: goal,
        roleplayScenario: goal === "roleplay" ? buildRoleplayScenario(topic, roleplayRole) : undefined,
        speechLanguage,
      });
      setSessionId(sessionRes.session_id);

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: MICROPHONE_OPTIONS,
      });
      roomRef.current = room;

      room.on(RoomEvent.Reconnecting, () => setReconnecting(true));
      room.on(RoomEvent.Reconnected, () => setReconnecting(false));
      room.on(RoomEvent.Disconnected, () => {
        setSessionStatus((prev) => (prev !== "ended" ? "ended" : prev));
      });

      room.on(RoomEvent.ParticipantConnected, () => setCoachJoined(true));

      room.on(RoomEvent.TrackSubscribed, attachAgentAudio);

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const remoteSpeaking = speakers.some((s) => !s.isLocal);
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
              card_type: data.card_type || "correction",
              original: data.original,
              corrected: data.corrected,
              explanation: data.explanation,
              target_skill: data.target_skill,
            });
            setCorrectionCount((prev) => prev + 1);
          } else if (data.type === "turn" && data.text) {
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
      try {
        roomRef.current?.disconnect();
      } catch {}
      roomRef.current = null;
      setErrorMessage(
        err?.message === "NOT_AUTHENTICATED"
          ? "Your session expired. Please sign in again."
          : err?.message || "Could not start the conversation. Please try again."
      );
      setSessionStatus("choosing");
    }
  };

  useEffect(() => {
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
          setErrorMessage("Your session is saved, but learning analysis or plan updates could not finish. Tap the save button again to retry without counting the session twice.");
          return;
        }
      }
      router.replace("/");
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not save this session. Please retry.");
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
    if (reconnecting) return "RECONNECTING...";
    if (sessionStatus === "starting") return "CONNECTING...";
    if (sessionStatus === "ended") return "SESSION ENDED";
    if (deviceVoiceActive) return "COACH SPEAKING (DEVICE)";
    if (!coachJoined) return "WAITING FOR COACH...";
    if (agentSpeaking) return "COACH SPEAKING";
    if (learnerSpeaking) return "YOU ARE SPEAKING";
    if (isMuted) return "MUTED";
    return "LISTENING...";
  };

  const getSpeakingStateColor = () => {
    if (reconnecting || sessionStatus === "starting" || !coachJoined) return theme.colors.amberWarning;
    if (sessionStatus === "ended") return theme.colors.fog;
    if (agentSpeaking) return theme.colors.orchidBloom;
    if (learnerSpeaking) return theme.colors.cyanSignal;
    if (isMuted) return theme.colors.fog;
    return theme.colors.emeraldSuccess;
  };

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
            <Ionicons name="arrow-back" size={20} color={theme.colors.pure} />
            <Text style={styles.backBtnText}>Dashboard</Text>
          </Pressable>

          {params.stage ? (
            <View style={styles.stagePill}>
              <Text style={styles.stagePillText}>
                {params.stage.replace(/_/g, " ").toUpperCase()}
              </Text>
            </View>
          ) : null}
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
              {params.activity_title || "What shall we talk about?"}
            </Text>
            <Text style={styles.preSessionSubhead}>
              Pick a subject and a goal. Practise your English with corrections,
              short explanations and a chance to try again.
            </Text>
          </View>

          {/* Step 1 — Topic */}
          <View style={styles.setupCard}>
            <Text style={styles.setupStepLabel}>
              1 · {isRoleplay ? "THE SITUATION" : "YOUR TOPIC"}
            </Text>
            <TextInput
              style={styles.topicInput}
              placeholder={
                isRoleplay
                  ? "e.g. a job interview, hotel check-in…"
                  : "e.g. my new job, last weekend, cricket…"
              }
              placeholderTextColor={theme.colors.steel}
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
            <Text style={styles.setupStepLabel}>2 · HOW SHOULD WE PRACTISE?</Text>
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
                    <Ionicons
                      name={opt.icon}
                      size={20}
                      color={selected ? theme.colors.irisGleam : theme.colors.ash}
                    />
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
              <Text style={styles.focusCardEyebrow}>TODAY'S TARGET SKILL</Text>
              <Text style={styles.focusCardTitle}>{skillLabel(params.target_skill)}</Text>
            </View>
          ) : null}

          <View style={styles.setupCard}>
            <Text style={styles.setupStepLabel}>3 · SPEECH RECOGNITION LANGUAGE</Text>
            <View style={styles.chipWrap}>
              {([
                { value: "auto", label: "Auto · Hindi / English" },
                { value: "hi", label: "Hindi" },
                { value: "en", label: "English" },
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
            <Text style={styles.goalCardBlurb}>
              Auto supports switching languages. Choose Hindi or English if recognition gets your language wrong.
              This does not change your Hindi explanation preference.
            </Text>
          </View>

          <View style={styles.tipsCard}>
            <View style={styles.tipItem}>
              <Ionicons name="headset-outline" size={20} color={theme.colors.paleIris} />
              <Text style={styles.tipText}>Use headphones or earphones for best microphone clarity</Text>
            </View>
            <View style={styles.tipItem}>
              <Ionicons name="globe-outline" size={20} color={theme.colors.cyanSignal} />
              <Text style={styles.tipText}>
                If stuck, speak in Hindi, then practise the English version. A quieter spot helps recognition.
              </Text>
            </View>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
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
                  <ActivityIndicator size="small" color={theme.colors.void} />
                  <Text style={styles.startCallBtnText}>Connecting to Coach…</Text>
                </View>
              ) : (
                <View style={styles.btnLoadingRow}>
                  <Ionicons name="call" size={20} color={theme.colors.void} />
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

        <View style={styles.callTimerPill}>
          <Ionicons name="time-outline" size={13} color={theme.colors.cloud} />
          <Text style={styles.callTimerText}>{formatSeconds(sessionSeconds)}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [styles.quickEndBtn, pressed && styles.btnPressed]}
          onPress={handleEndSession}
        >
          <Text style={styles.quickEndBtnText}>End</Text>
        </Pressable>
      </View>

      {/* Activity Context Sub-Header */}
      {params.activity_title ? (
        <View style={styles.activeActivityBar}>
          <Text style={styles.activeActivityTitle} numberOfLines={1}>
            {params.activity_title}
          </Text>
        </View>
      ) : null}

      {/* Main Conversation Body */}
      <View style={styles.activeCallBody}>
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Dynamic Glowing Audio Orb */}
        <View style={styles.visualizerOrbContainer}>
          <View style={[styles.visualizerOrb, { borderColor: getSpeakingStateColor() }]}>
            <View style={styles.waveBarsRow}>
              <Animated.View style={[styles.waveBar, { height: waveAnim1, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim2, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim3, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim4, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim5, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim6, backgroundColor: getSpeakingStateColor() }]} />
              <Animated.View style={[styles.waveBar, { height: waveAnim7, backgroundColor: getSpeakingStateColor() }]} />
            </View>
          </View>
          <Text style={styles.visualizerHintText}>
            {isMuted
              ? "Microphone is muted"
              : agentSpeaking
              ? "Coach is speaking..."
              : learnerSpeaking
              ? "Listening to your voice..."
              : "Speak naturally in English or Hindi"}
          </Text>
        </View>

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
                  {activeCorrection.card_type === "translation" ? "🌐 HINDI ➔ ENGLISH" : "💡 COACH RECAST"}
                </Text>
              </View>
              <Pressable onPress={() => setActiveCorrection(null)} hitSlop={12}>
                <Ionicons name="close" size={18} color={theme.colors.ash} />
              </Pressable>
            </View>

            <View style={styles.correctionSpeechComparison}>
              <Text style={styles.originalSpeechText}>
                {activeCorrection.card_type === "translation" ? "Hindi: " : "Said: "}
                "{activeCorrection.original}"
              </Text>
              <Text style={styles.betterSpeechText}>
                {activeCorrection.card_type === "translation" ? "English: " : "Better: "}
                "{activeCorrection.corrected}"
              </Text>
            </View>

            {activeCorrection.explanation ? (
              <Text style={styles.correctionWhyText}>💡 {activeCorrection.explanation}</Text>
            ) : null}
            <Text style={styles.correctionWhyText}>
              Say the English sentence aloud, then try your own example. It is okay to need another attempt.
            </Text>

            <Pressable
              style={({ pressed }) => [styles.gotItBtn, pressed && styles.btnPressed]}
              onPress={() => setActiveCorrection(null)}
            >
              <Text style={styles.gotItBtnText}>Keep practising →</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Live Conversation Chat Transcript */}
        <View style={styles.transcriptSection}>
          <Text style={styles.transcriptSectionLabel}>LIVE TRANSCRIPT</Text>
          <ScrollView
            ref={transcriptScrollRef}
            contentContainerStyle={styles.transcriptContent}
            showsVerticalScrollIndicator={false}
          >
            {transcript.length === 0 ? (
              <View style={styles.emptyTranscriptBubble}>
                <Ionicons name="mic-outline" size={16} color={theme.colors.fog} />
                <Text style={styles.emptyTranscriptText}>
                  Speak now. Your conversation will appear here in real time...
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
                    <Text style={styles.bubbleSpeakerLabel}>
                      {t.speaker === "tutor" ? "COACH PRAVAAH" : "YOU"}
                    </Text>
                    <Text style={styles.bubbleTimestamp}>{t.timestamp}</Text>
                  </View>
                  <Text style={styles.bubbleText}>{t.text}</Text>
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
            height: 80 + Math.max(insets.bottom, 12),
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
          <Ionicons
            name={isMuted ? "mic-off" : "mic"}
            size={24}
            color={isMuted ? theme.colors.crimsonError : theme.colors.pure}
          />
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
          <Ionicons
            name={deviceVoiceMode === "on" ? "volume-high" : "phone-portrait-outline"}
            size={22}
            color={deviceVoiceMode === "on" ? theme.colors.emeraldSuccess : theme.colors.pure}
          />
          <Text style={styles.roundCallBtnLabel}>
            {deviceVoiceMode === "on" ? "Device" : "Auto"}
          </Text>
        </Pressable>

        {/* End Call Button */}
        <Pressable
          style={({ pressed }) => [styles.roundEndBtn, pressed && styles.btnPressed]}
          onPress={handleEndSession}
        >
          <Ionicons name="call" size={26} color={theme.colors.pure} style={{ transform: [{ rotate: "135deg" }] }} />
          <Text style={styles.roundEndBtnLabel}>End Session</Text>
        </Pressable>
      </View>

      {/* Session Summary Modal */}
      <Modal visible={showSummary} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.summaryCard, { paddingBottom: Math.max(insets.bottom + 20, 24) }]}>
            <View style={styles.summaryTopBadge}>
              <Text style={styles.summaryTopBadgeText}>SESSION COMPLETED 🎉</Text>
            </View>

            <Text style={styles.summaryTitle}>
              <Text style={styles.heroHeadlineItalic}>Great</Text> practice session!
            </Text>
            <Text style={styles.summarySubtitle}>
              {params.activity_title || "Spoken Conversation"}
            </Text>

            {/* 4-Stat Mobile Grid */}
            <View style={styles.summaryGrid}>
              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{formatSeconds(sessionSeconds)}</Text>
                <Text style={styles.summaryStatLabel}>DURATION</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>
                  {Platform.OS === "web" ? formatSeconds(learnerSpeakingSeconds) : "—"}
                </Text>
                <Text style={styles.summaryStatLabel}>DETECTED SPEECH (EST.)</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{correctionCount}</Text>
                <Text style={styles.summaryStatLabel}>RECASTS</Text>
              </View>

              <View style={styles.summaryStatTile}>
                <Text style={styles.summaryStatValue}>{transcript.length}</Text>
                <Text style={styles.summaryStatLabel}>TURNS</Text>
              </View>
            </View>

            <Text style={styles.summarySavedNotice}>
              Save your conversation to update your plan. Recorded mistakes and vocabulary
              will appear on the dashboard after analysis.
            </Text>
            {errorMessage ? <Text style={styles.errorBannerText}>{errorMessage}</Text> : null}

            <Pressable
              style={({ pressed }) => [styles.primaryReturnBtn, pressed && styles.btnPressed]}
              onPress={handleAdvanceAndReturn}
              disabled={savingSummary}
            >
              {savingSummary ? (
                <ActivityIndicator size="small" color={theme.colors.void} />
              ) : (
                <Text style={styles.primaryReturnBtnText}>Save & return to Dashboard →</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.abyss,
  },
  topHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radii.full,
  },
  backBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.pure,
    fontWeight: "600",
  },
  stagePill: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radii.full,
  },
  stagePillText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.paleIris,
    fontWeight: "700",
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
    alignItems: "center",
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.xl,
  },
  ambientPulseSphere: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
  },
  micCircleBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  preSessionTitle: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingMd,
    color: theme.colors.cloud,
    textAlign: "center",
    marginBottom: 8,
  },
  preSessionSubhead: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: theme.spacing.md,
  },
  setupCard: {
    width: "100%",
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.md,
  },
  setupStepLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    fontWeight: "700",
    color: theme.colors.paleIris,
    marginBottom: theme.spacing.md,
  },
  topicInput: {
    height: theme.mobile.minTouchSize,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    paddingHorizontal: theme.spacing.md,
    color: theme.colors.pure,
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
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: "center",
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  suggestChipActive: {
    backgroundColor: "rgba(132, 125, 255, 0.16)",
    borderColor: theme.colors.borderIris,
  },
  suggestChipText: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    color: theme.colors.ash,
  },
  suggestChipTextActive: {
    color: theme.colors.paleIris,
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
    gap: 10,
    minHeight: theme.mobile.minTouchSize + 12,
    padding: theme.spacing.md,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  goalCardFull: {
    width: "100%",
  },
  goalCardHalf: {
    flexGrow: 1,
    flexBasis: "47%",
  },
  goalCardActive: {
    borderColor: theme.colors.borderIris,
    backgroundColor: "rgba(132, 125, 255, 0.12)",
  },
  goalCardTextCol: {
    flex: 1,
  },
  goalCardTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  goalCardTitleActive: {
    color: theme.colors.pure,
  },
  goalCardBlurb: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.fog,
    lineHeight: 15,
    marginTop: 2,
  },
  scenarioBlock: {
    marginTop: theme.spacing.lg,
  },
  scenarioLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    marginBottom: theme.spacing.sm,
  },
  focusCard: {
    width: "100%",
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    marginBottom: theme.spacing.md,
  },
  focusCardEyebrow: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.paleIris,
    letterSpacing: 0.8,
    fontWeight: "700",
    marginBottom: 4,
  },
  focusCardTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "700",
    color: theme.colors.pure,
  },
  tipsCard: {
    width: "100%",
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 12,
    marginBottom: theme.spacing.xl,
  },
  tipItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  tipText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.ash,
    lineHeight: 16,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 82, 82, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
    borderRadius: theme.radii.sm,
    padding: 10,
    gap: 8,
    marginBottom: theme.spacing.md,
    width: "100%",
  },
  errorBannerText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.crimsonError,
  },
  preSessionActionContainer: {
    width: "100%",
    gap: 12,
    marginTop: "auto",
  },
  startCallBtn: {
    height: 52,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.pure,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.glowIris,
  },
  btnLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  startCallBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "700",
    color: theme.colors.void,
  },
  cancelBtn: {
    alignItems: "center",
    paddingVertical: 10,
  },
  cancelBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.fog,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  activeCallHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
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
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  callTimerPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    gap: 4,
  },
  callTimerText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  quickEndBtn: {
    backgroundColor: "rgba(255, 82, 82, 0.2)",
    borderWidth: 1,
    borderColor: theme.colors.crimsonError,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
  },
  quickEndBtnText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.crimsonError,
  },
  activeActivityBar: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 6,
    backgroundColor: theme.colors.surfaceElevated,
  },
  activeActivityTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.paleIris,
    fontWeight: "600",
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
    backgroundColor: theme.colors.graphiteCard,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginBottom: 8,
    ...theme.shadows.card,
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
    color: theme.colors.ash,
  },
  liveCorrectionCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    marginBottom: 10,
    ...theme.shadows.card,
  },
  liveTranslationCard: {
    borderColor: theme.colors.borderCyan,
  },
  correctionTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  correctionPill: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.xs,
  },
  translationPill: {
    backgroundColor: "rgba(0, 179, 221, 0.15)",
  },
  correctionPillText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.paleIris,
  },
  correctionSpeechComparison: {
    gap: 4,
    marginBottom: 6,
  },
  originalSpeechText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.crimsonError,
  },
  betterSpeechText: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.emeraldSuccess,
  },
  correctionWhyText: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.ash,
    lineHeight: 15,
    marginBottom: 8,
  },
  gotItBtn: {
    alignSelf: "flex-end",
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: theme.radii.xs,
  },
  gotItBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.pure,
    fontWeight: "600",
  },
  transcriptSection: {
    flex: 1,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: 12,
    marginBottom: 80,
  },
  transcriptSectionLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.fog,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  transcriptContent: {
    gap: 8,
    paddingBottom: 8,
  },
  emptyTranscriptBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 12,
  },
  emptyTranscriptText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.fog,
  },
  chatBubble: {
    maxWidth: "88%",
    padding: 10,
    borderRadius: theme.radii.md,
  },
  bubbleTutor: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    borderTopLeftRadius: 2,
  },
  bubbleLearner: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(0, 179, 221, 0.15)",
    borderWidth: 1,
    borderColor: theme.colors.borderCyan,
    borderTopRightRadius: 2,
  },
  bubbleHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
    gap: 8,
  },
  bubbleSpeakerLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    fontWeight: "700",
    color: theme.colors.paleIris,
  },
  bubbleTimestamp: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    color: theme.colors.fog,
  },
  bubbleText: {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    color: theme.colors.pure,
    lineHeight: 18,
  },
  bottomCallBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.glassNav,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingHorizontal: theme.spacing.xl,
  },
  roundCallBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  roundCallBtnActive: {
    opacity: 0.9,
  },
  roundCallBtnOn: {
    opacity: 1,
  },
  roundCallBtnLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.ash,
  },
  roundEndBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.crimsonError,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadows.card,
  },
  roundEndBtnLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 9,
    fontWeight: "700",
    color: theme.colors.pure,
    marginTop: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "flex-end",
  },
  summaryCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderTopLeftRadius: theme.radii.xl,
    borderTopRightRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  summaryTopBadge: {
    alignSelf: "center",
    backgroundColor: "rgba(56, 211, 159, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    marginBottom: theme.spacing.sm,
  },
  summaryTopBadgeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.emeraldSuccess,
  },
  summaryTitle: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingMd,
    color: theme.colors.pure,
    textAlign: "center",
    marginBottom: 4,
  },
  summarySubtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
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
    width: "48%",
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.md,
    padding: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  summaryStatValue: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.headingSm,
    fontWeight: "700",
    color: theme.colors.pure,
    marginBottom: 2,
  },
  summaryStatLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.fog,
    fontWeight: "700",
  },
  summarySavedNotice: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.fog,
    textAlign: "center",
    marginBottom: theme.spacing.lg,
  },
  primaryReturnBtn: {
    height: 48,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.pure,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryReturnBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm + 1,
    fontWeight: "700",
    color: theme.colors.void,
  },
  heroHeadlineItalic: {
    fontStyle: "italic",
    color: theme.colors.irisGleam,
  },
});

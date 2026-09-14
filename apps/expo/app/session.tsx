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
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Room, RoomEvent, Track, RemoteParticipant, RemoteTrackPublication } from "livekit-client";
import { completeDailyActivity, completeSession, createSession } from "../lib/api";
import { theme } from "../lib/theme";

const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL || "wss://pravaah-qj6q5gxo.livekit.cloud";

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
  const params = useLocalSearchParams<{
    mode?: string;
    target_skill?: string;
    lesson_id?: string;
    activity_title?: string;
    stage?: string;
  }>();

  const [sessionStatus, setSessionStatus] = useState<
    "preconnecting" | "ready" | "starting" | "active" | "ended"
  >("preconnecting");
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
  const [repetitionCount, setRepetitionCount] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [learnerSpeaking, setLearnerSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [preconnectError, setPreconnectError] = useState(false);

  // LiveKit Room ref
  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  // Web Audio Visualizer refs
  const audioContextRef = useRef<any>(null);
  const analyserRef = useRef<any>(null);
  const animFrameRef = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const transcriptScrollRef = useRef<ScrollView | null>(null);

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

  // Pre-connect on screen mount
  useEffect(() => {
    if (preconnectedRef.current) return;
    preconnectedRef.current = true;

    const preconnect = async () => {
      try {
        const sessionRes = await createSession(
          params.mode || "free_conversation",
          params.target_skill,
          params.lesson_id
        );
        setSessionId(sessionRes.session_id);

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        roomRef.current = room;

        room.on(RoomEvent.Connected, () => {
          setSessionStatus("ready");
          setReconnecting(false);
        });

        room.on(RoomEvent.Reconnecting, () => {
          setReconnecting(true);
        });

        room.on(RoomEvent.Reconnected, () => {
          setReconnecting(false);
        });

        room.on(RoomEvent.Disconnected, () => {
          setSessionStatus((prev) => (prev !== "ended" ? "ended" : prev));
        });

        room.on(RoomEvent.TrackSubscribed, (track: Track) => {
          if (track.kind === Track.Kind.Audio) {
            if (Platform.OS === "web") {
              if (audioElementRef.current) {
                try {
                  audioElementRef.current.remove();
                } catch {}
              }
              const audioElement = track.attach();
              audioElementRef.current = audioElement;
              audioElement.autoplay = true;
              audioElement.style.display = "none";
              document.body.appendChild(audioElement);
              audioElement.play().catch((e) => console.debug("Audio play pending click gesture:", e));
            }
          }
        });

        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const remoteSpeaking = speakers.some((s) => !s.isLocal);
          agentSpeakingRef.current = remoteSpeaking;
          setAgentSpeaking(remoteSpeaking);
          if (remoteSpeaking) {
            setLearnerSpeaking(false);
          }
        });

        room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
          try {
            const str = new TextDecoder().decode(payload);
            const data = JSON.parse(str);
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
                if (last && last.speaker === spk && last.text.trim().toLowerCase() === data.text.trim().toLowerCase()) {
                  return prev;
                }
                const nextList = [
                  ...prev,
                  {
                    id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                    speaker: spk,
                    text: data.text,
                    timestamp: data.timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  },
                ];
                setTimeout(() => {
                  transcriptScrollRef.current?.scrollToEnd({ animated: true });
                }, 100);
                return nextList;
              });
            }
          } catch (e) {
            console.debug("Data message parse note:", e);
          }
        });

        await room.connect(LIVEKIT_URL, sessionRes.livekit_token);
      } catch (err: any) {
        console.warn("Pre-connect error:", err);
        setPreconnectError(true);
        setErrorMessage(err.message || "Failed to prepare session. Please try again.");
        setSessionStatus("ready");
      }
    };

    preconnect();
  }, [params.lesson_id, params.mode, params.target_skill]);

  // Start Speaking
  const handleStartConversation = async () => {
    try {
      setSessionStatus("starting");
      setErrorMessage(null);

      if (Platform.OS === "web" && typeof window !== "undefined") {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          if (ctx.state === "suspended") {
            await ctx.resume();
          }
        }
      }

      const room = roomRef.current;
      if (!room) {
        throw new Error("Room not initialized. Please try again.");
      }

      try {
        await room.startAudio();
        if (audioElementRef.current) {
          await audioElementRef.current.play().catch(() => {});
        }
        if (Platform.OS === "web") {
          room.remoteParticipants.forEach((p) => {
            p.trackPublications.forEach((pub) => {
              if (pub.track && pub.track.kind === Track.Kind.Audio) {
                if (!audioElementRef.current || !document.body.contains(audioElementRef.current)) {
                  const el = pub.track.attach();
                  audioElementRef.current = el;
                  el.autoplay = true;
                  el.style.display = "none";
                  document.body.appendChild(el);
                }
                audioElementRef.current?.play().catch((e) => console.debug("Audio play catch:", e));
              }
            });
          });
        }
      } catch (e) {
        console.debug("Audio unlock note:", e);
      }

      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      });

      const audioTracks = room.localParticipant.audioTrackPublications;
      audioTracks.forEach((pub) => {
        if (pub.track?.mediaStream) {
          setupAudioVisualizer(pub.track.mediaStream);
        }
      });

      try {
        const startMsg = JSON.stringify({ type: "start_conversation" });
        await room.localParticipant.publishData(new TextEncoder().encode(startMsg), { reliable: true });
      } catch (e) {
        console.debug("Start signal broadcast note:", e);
      }

      setSessionStatus("active");

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
      setErrorMessage(err.message || "Failed to enable microphone. Please try again.");
      setSessionStatus("ready");
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
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
        await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMute);
        setIsMuted(nextMute);
      } catch (err) {
        console.warn("Mute error:", err);
      }
    } else {
      setIsMuted(!isMuted);
    }
  };

  const handleEndSession = () => {
    if (Platform.OS === "web" && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (timerRef.current) clearInterval(timerRef.current);
    if (roomRef.current) {
      roomRef.current.disconnect();
    }
    setSessionStatus("ended");
    setShowSummary(true);
  };

  const handleAdvanceAndReturn = async () => {
    setSavingSummary(true);
    try {
      const durMins = Math.max(1, Math.round(sessionSeconds / 60));

      if (sessionId) {
        await completeSession(
          sessionId,
          sessionSeconds,
          params.lesson_id,
          params.target_skill,
          transcript.map((t) => ({
            role: t.speaker === "learner" ? "user" : "assistant",
            text: t.text,
            timestamp: t.timestamp,
          }))
        ).catch((err) => console.warn("completeSession notice:", err));
      }

      if (params.lesson_id) {
        await completeDailyActivity(
          params.lesson_id,
          sessionId || "sess_active",
          durMins
        ).catch((err) => console.warn("completeDailyActivity notice:", err));
      }
    } catch (err) {
      console.warn("Complete activity error:", err);
    } finally {
      setSavingSummary(false);
      router.replace("/");
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
    if (agentSpeaking) return "COACH SPEAKING";
    if (learnerSpeaking) return "YOU ARE SPEAKING";
    if (isMuted) return "MUTED";
    return "LISTENING...";
  };

  const getSpeakingStateColor = () => {
    if (reconnecting || sessionStatus === "starting") return theme.colors.amberWarning;
    if (sessionStatus === "ended") return theme.colors.fog;
    if (agentSpeaking) return theme.colors.orchidBloom;
    if (learnerSpeaking) return theme.colors.cyanSignal;
    if (isMuted) return theme.colors.fog;
    return theme.colors.emeraldSuccess;
  };

  // =========================================================================
  // VIEW 1: PRE-SESSION SETUP SCREEN
  // =========================================================================
  if (sessionStatus === "preconnecting" || sessionStatus === "ready" || sessionStatus === "starting") {
    const isConnecting = sessionStatus === "preconnecting";
    const isStarting = sessionStatus === "starting";
    const isReady = sessionStatus === "ready" && !preconnectError;

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
          showsVerticalScrollIndicator={false}
        >
          {/* Hero Visual Sphere */}
          <View style={styles.preSessionHero}>
            <View style={styles.ambientPulseSphere}>
              <View style={styles.micCircleBadge}>
                <Ionicons name="mic" size={40} color={theme.colors.irisGleam} />
              </View>
            </View>

            <Text style={styles.preSessionTitle}>
              {params.activity_title || "English Voice Practice"}
            </Text>
            <Text style={styles.preSessionSubhead}>
              Speak freely. Hindi or English — Coach Pravaah will listen and guide you naturally.
            </Text>
          </View>

          {params.target_skill ? (
            <View style={styles.focusCard}>
              <Text style={styles.focusCardEyebrow}>TODAY'S TARGET SKILL</Text>
              <Text style={styles.focusCardTitle}>
                {params.target_skill.replace(/_/g, " ").toUpperCase()}
              </Text>
            </View>
          ) : null}

          {/* Audio Tips */}
          <View style={styles.tipsCard}>
            <View style={styles.tipItem}>
              <Ionicons name="headset-outline" size={20} color={theme.colors.paleIris} />
              <Text style={styles.tipText}>Use headphones or earphones for best microphone clarity</Text>
            </View>
            <View style={styles.tipItem}>
              <Ionicons name="globe-outline" size={20} color={theme.colors.cyanSignal} />
              <Text style={styles.tipText}>
                If stuck, speak in Hindi — coach provides instant English recasts
              </Text>
            </View>
          </View>

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          {/* Primary Action */}
          <View style={styles.preSessionActionContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.startCallBtn,
                (!isReady || isStarting) && styles.btnDisabled,
                pressed && isReady && styles.btnPressed,
              ]}
              onPress={handleStartConversation}
              disabled={!isReady || isStarting}
            >
              {isStarting || isConnecting ? (
                <View style={styles.btnLoadingRow}>
                  <ActivityIndicator size="small" color={theme.colors.void} />
                  <Text style={styles.startCallBtnText}>
                    {isStarting ? "Connecting to Coach..." : "Preparing Live Audio..."}
                  </Text>
                </View>
              ) : (
                <View style={styles.btnLoadingRow}>
                  <Ionicons name="call" size={20} color={theme.colors.void} />
                  <Text style={styles.startCallBtnText}>Start Conversation 🎙️</Text>
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

            <Pressable
              style={({ pressed }) => [styles.gotItBtn, pressed && styles.btnPressed]}
              onPress={() => setActiveCorrection(null)}
            >
              <Text style={styles.gotItBtnText}>Got it 👍</Text>
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
                  {formatSeconds(learnerSpeakingSeconds || Math.max(1, Math.round(sessionSeconds * 0.45)))}
                </Text>
                <Text style={styles.summaryStatLabel}>SPEAKING TIME</Text>
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
              Your conversation was saved to your profile. Mistakes and vocabulary are updated.
            </Text>

            <Pressable
              style={({ pressed }) => [styles.primaryReturnBtn, pressed && styles.btnPressed]}
              onPress={handleAdvanceAndReturn}
              disabled={savingSummary}
            >
              {savingSummary ? (
                <ActivityIndicator size="small" color={theme.colors.void} />
              ) : (
                <Text style={styles.primaryReturnBtnText}>Return to Dashboard →</Text>
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

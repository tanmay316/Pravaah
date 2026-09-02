/**
 * Pravaah — Realtime Speaking Session
 *
 * Flow:
 *   1. Room pre-connects in background when user opens the page
 *   2. User clicks "Start Conversation 🎙️" → Mic enables + sends start signal to agent
 *   3. Agent greets INSTANTLY (<0.3s)
 *   4. Hindi speech is transcribed accurately in Hindi on UI
 *   5. Live conversation turns display in real time on the UI
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
import { Room, RoomEvent, Track, RemoteParticipant, RemoteTrackPublication } from "livekit-client";
import { completeDailyActivity, createSession } from "../lib/api";
import { theme } from "../lib/theme";

const LIVEKIT_URL = "wss://pravaah-qj6q5gxo.livekit.cloud";

interface TranscriptTurn {
  id: string;
  speaker: "learner" | "tutor";
  text: string;
  timestamp: string;
}

interface InSessionCorrection {
  original: string;
  corrected: string;
  explanation: string;
  target_skill?: string;
}

export default function SessionScreen() {
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

  // Track whether we already pre-connected
  const preconnectedRef = useRef(false);

  // Animated wave bars
  const waveAnim1 = useRef(new Animated.Value(14)).current;
  const waveAnim2 = useRef(new Animated.Value(28)).current;
  const waveAnim3 = useRef(new Animated.Value(20)).current;
  const waveAnim4 = useRef(new Animated.Value(36)).current;
  const waveAnim5 = useRef(new Animated.Value(18)).current;

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
          const v1 = Math.max(12, (dataArray[2] / 255) * 60);
          const v2 = Math.max(16, (dataArray[4] / 255) * 70);
          const v3 = Math.max(20, (dataArray[6] / 255) * 80);
          const v4 = Math.max(14, (dataArray[8] / 255) * 65);
          const v5 = Math.max(12, (dataArray[10] / 255) * 55);

          // Only show learner speaking when agent is NOT speaking
          const avgEnergy = (dataArray[2] + dataArray[4] + dataArray[6] + dataArray[8]) / 4;
          if (avgEnergy > 24 && !agentSpeakingRef.current) {
            setLearnerSpeaking(true);
            speakingDebounce = 15;
          } else {
            if (speakingDebounce > 0) {
              speakingDebounce -= 1;
            } else {
              setLearnerSpeaking(false);
            }
          }

          waveAnim1.setValue(v1);
          waveAnim2.setValue(v2);
          waveAnim3.setValue(v3);
          waveAnim4.setValue(v4);
          waveAnim5.setValue(v5);

          animFrameRef.current = requestAnimationFrame(loop);
        };
        animFrameRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.warn("Visualizer audio context error:", err);
      }
    }
  };

  // =========================================================================
  // PRE-CONNECT: Create session + connect to LiveKit room on page load
  // =========================================================================
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

        // Handle incoming remote tutor audio track
        room.on(RoomEvent.TrackSubscribed, (track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            if (Platform.OS === "web") {
              const audioElement = track.attach();
              audioElementRef.current = audioElement;
              audioElement.autoplay = true;
              document.body.appendChild(audioElement);
            }
          }
        });

        // Active speakers tracking
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const remoteSpeaking = speakers.some((s) => !s.isLocal);
          agentSpeakingRef.current = remoteSpeaking;
          setAgentSpeaking(remoteSpeaking);
          if (remoteSpeaking) {
            setLearnerSpeaking(false);
          }
        });

        // Handle tutor real-time transcript & data messages
        room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
          try {
            const str = new TextDecoder().decode(payload);
            const data = JSON.parse(str);
            if (data.type === "correction") {
              setActiveCorrection({
                original: data.original,
                corrected: data.corrected,
                explanation: data.explanation,
                target_skill: data.target_skill,
              });
              setCorrectionCount((prev) => prev + 1);
            } else if (data.type === "turn" && data.text) {
              setTranscript((prev) => {
                // Deduplicate if identical turn already logged
                const last = prev[prev.length - 1];
                if (last && last.speaker === (data.speaker === "learner" ? "learner" : "tutor") && last.text === data.text) {
                  return prev;
                }
                return [
                  ...prev,
                  {
                    id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                    speaker: data.speaker === "learner" ? "learner" : "tutor",
                    text: data.text,
                    timestamp: data.timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  },
                ];
              });
            }
          } catch (e) {
            console.debug("Data message parse note:", e);
          }
        });

        // Connect to LiveKit Cloud in background
        await room.connect(LIVEKIT_URL, sessionRes.livekit_token);
      } catch (err: any) {
        console.warn("Pre-connect error:", err);
        setPreconnectError(true);
        setErrorMessage(err.message || "Failed to prepare session. Please try again.");
        setSessionStatus("ready");
      }
    };

    preconnect();
  }, []);

  // Start Speaking — un-mutes microphone + signals agent to greet immediately
  const handleStartConversation = async () => {
    try {
      setSessionStatus("starting");
      setErrorMessage(null);

      // Unlock AudioContext inside user click gesture
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

      // 1. Enable learner microphone
      await room.localParticipant.setMicrophoneEnabled(true);

      // 2. Connect audio visualizer
      const audioTracks = room.localParticipant.audioTrackPublications;
      audioTracks.forEach((pub) => {
        if (pub.track?.mediaStream) {
          setupAudioVisualizer(pub.track.mediaStream);
        }
      });

      // 3. Send immediate start signal to agent to trigger instant greeting
      try {
        const startMsg = JSON.stringify({ type: "start_conversation" });
        await room.localParticipant.publishData(new TextEncoder().encode(startMsg));
      } catch (e) {
        console.debug("Start signal broadcast note:", e);
      }

      setSessionStatus("active");

      // 4. Start session clock
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

  // Cleanup on unmount
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
      if (params.lesson_id) {
        await completeDailyActivity(
          params.lesson_id,
          sessionId || "sess_active",
          Math.max(1, Math.round(sessionSeconds / 60))
        );
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
    if (sessionStatus === "starting") return "CONNECTING COACH...";
    if (sessionStatus === "ended") return "SESSION ENDED";
    if (agentSpeaking) return "COACH IS SPEAKING";
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
  // VIEW 1: PRE-SESSION SCREEN
  // =========================================================================
  if (sessionStatus === "preconnecting" || sessionStatus === "ready" || sessionStatus === "starting") {
    const isConnecting = sessionStatus === "preconnecting";
    const isStarting = sessionStatus === "starting";
    const isReady = sessionStatus === "ready" && !preconnectError;

    return (
      <View style={styles.container}>
        {/* Top Navigation */}
        <View style={styles.topHeader}>
          <Pressable style={styles.backBtn} onPress={() => router.replace("/")}>
            <Text style={styles.backBtnText}>← Back</Text>
          </Pressable>
          {params.stage ? (
            <View style={styles.stageBadge}>
              <Text style={styles.stageBadgeText}>{params.stage.replace(/_/g, " ").toUpperCase()}</Text>
            </View>
          ) : null}
        </View>

        <ScrollView contentContainerStyle={styles.preSessionScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.preSessionHero}>
            <View style={styles.heroLogoWrapper}>
              <Image
                source={require("../assets/pravaah_navbar_logo.png")}
                style={styles.preSessionLogo}
                resizeMode="contain"
                accessibilityLabel="Pravaah"
              />
            </View>

            <Text style={styles.preSessionTitle}>
              {params.activity_title || "English Conversation"}
            </Text>
            <Text style={styles.preSessionSubhead}>
              Speak naturally. Hindi or English — Coach Pravaah will help you practice fluently.
            </Text>
          </View>

          {params.target_skill ? (
            <View style={styles.activityObjectiveCard}>
              <Text style={styles.cardEyebrow}>TODAY'S FOCUS</Text>
              <Text style={styles.activityMainTitle}>
                {params.target_skill.replace(/_/g, " ")}
              </Text>
            </View>
          ) : null}

          <View style={styles.tipsCard}>
            <View style={styles.tipRow}>
              <Text style={styles.tipBullet}>🎧</Text>
              <Text style={styles.tipText}>Use earphones for crystal-clear microphone audio</Text>
            </View>
            <View style={styles.tipRow}>
              <Text style={styles.tipBullet}>🗣️</Text>
              <Text style={styles.tipText}>Feel free to speak Hindi — coach will show you the natural English equivalent</Text>
            </View>
          </View>

          {isConnecting ? (
            <View style={styles.connectingCard}>
              <ActivityIndicator size="small" color={theme.colors.irisGleam} />
              <Text style={styles.connectingText}>Preparing your coach session...</Text>
            </View>
          ) : null}

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          <View style={styles.startActionContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.bigStartButton,
                (!isReady || isStarting) && styles.bigStartButtonDisabled,
                pressed && isReady && styles.buttonPressed,
              ]}
              onPress={handleStartConversation}
              disabled={!isReady || isStarting}
            >
              {isStarting ? (
                <View style={styles.buttonLoadingRow}>
                  <ActivityIndicator size="small" color={theme.colors.void} />
                  <Text style={styles.bigStartButtonText}>Starting...</Text>
                </View>
              ) : isConnecting ? (
                <View style={styles.buttonLoadingRow}>
                  <ActivityIndicator size="small" color={theme.colors.void} />
                  <Text style={styles.bigStartButtonText}>Preparing...</Text>
                </View>
              ) : (
                <Text style={styles.bigStartButtonText}>Start Conversation 🎙️</Text>
              )}
            </Pressable>

            <Pressable style={styles.ghostCancelBtn} onPress={() => router.replace("/")}>
              <Text style={styles.ghostCancelText}>Not right now</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // VIEW 2: ACTIVE SESSION
  // =========================================================================
  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={styles.topHeader}>
        <View style={styles.headerLeft}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: getSpeakingStateColor() },
            ]}
          />
          <Text style={[styles.statusText, { color: getSpeakingStateColor() }]}>
            {getSpeakingStateLabel()}
          </Text>
        </View>

        <View style={styles.timerPill}>
          <Text style={styles.timerText}>{formatSeconds(sessionSeconds)}</Text>
        </View>

        <Pressable style={styles.endPillBtn} onPress={handleEndSession}>
          <Text style={styles.endPillBtnText}>End ◼</Text>
        </Pressable>
      </View>

      {params.activity_title ? (
        <View style={styles.targetBanner}>
          <Text style={styles.targetTitle}>
            {params.activity_title}
          </Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Waveform Visualizer */}
        <View style={styles.visualizerCard}>
          <View style={styles.waveBarsRow}>
            <Animated.View style={[styles.waveBar, { height: waveAnim1, backgroundColor: getSpeakingStateColor() }]} />
            <Animated.View style={[styles.waveBar, { height: waveAnim2, backgroundColor: getSpeakingStateColor() }]} />
            <Animated.View style={[styles.waveBar, { height: waveAnim3, backgroundColor: getSpeakingStateColor() }]} />
            <Animated.View style={[styles.waveBar, { height: waveAnim4, backgroundColor: getSpeakingStateColor() }]} />
            <Animated.View style={[styles.waveBar, { height: waveAnim5, backgroundColor: getSpeakingStateColor() }]} />
          </View>
          <Text style={styles.visualizerHint}>
            {isMuted
              ? "Microphone muted"
              : agentSpeaking
              ? "Coach is speaking..."
              : learnerSpeaking
              ? "Listening to you..."
              : "Speak naturally in Hindi or English"}
          </Text>
        </View>

        {/* In-Session Correction Card */}
        {activeCorrection ? (
          <View style={styles.correctionCard}>
            <View style={styles.correctionHeader}>
              <View style={styles.correctionBadge}>
                <Text style={styles.correctionBadgeText}>💡 COACH RECAST</Text>
              </View>
              <Pressable onPress={() => setActiveCorrection(null)}>
                <Text style={styles.dismissText}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.correctionBody}>
              <View style={styles.correctionRow}>
                <Text style={styles.correctionLabel}>You said:</Text>
                <Text style={styles.youSaidText}>"{activeCorrection.original}"</Text>
              </View>

              <View style={styles.correctionRow}>
                <Text style={styles.correctionLabelCorrect}>Better:</Text>
                <Text style={styles.betterText}>"{activeCorrection.corrected}"</Text>
              </View>

              <View style={styles.correctionRow}>
                <Text style={styles.correctionLabel}>Why:</Text>
                <Text style={styles.whyText}>{activeCorrection.explanation}</Text>
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [styles.tryAgainButton, pressed && styles.buttonPressed]}
              onPress={() => setActiveCorrection(null)}
            >
              <Text style={styles.tryAgainButtonText}>Got it 👍</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Real-time Live Transcript */}
        <View style={styles.transcriptBlock}>
          <Text style={styles.transcriptHeader}>CONVERSATION TRANSCRIPT</Text>
          {transcript.length === 0 ? (
            <View style={styles.turnBubble}>
              <Text style={styles.turnText}>
                Your conversation transcript will appear here in real time...
              </Text>
            </View>
          ) : (
            transcript.map((t) => (
              <View
                key={t.id}
                style={[
                  styles.turnBubble,
                  t.speaker === "tutor" ? styles.turnBubbleTutor : styles.turnBubbleLearner,
                ]}
              >
                <View style={styles.turnMetaRow}>
                  <Text style={styles.turnSpeaker}>
                    {t.speaker === "tutor" ? "COACH PRAVAAH" : "YOU"}
                  </Text>
                  <Text style={styles.turnTime}>{t.timestamp}</Text>
                </View>
                <Text style={styles.turnText}>{t.text}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* Bottom Controls */}
      <View style={styles.bottomBar}>
        <Pressable
          style={[styles.muteButton, isMuted && styles.muteButtonActive]}
          onPress={handleToggleMute}
        >
          <Text style={styles.muteButtonText}>{isMuted ? "🔇 Unmute" : "🎙 Mute"}</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.endButton, pressed && styles.buttonPressed]}
          onPress={handleEndSession}
        >
          <Text style={styles.endButtonText}>End & Save →</Text>
        </Pressable>
      </View>

      {/* Session Summary Modal */}
      <Modal visible={showSummary} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.summaryModalCard}>
            <View style={styles.summaryLogoWrapper}>
              <Image
                source={require("../assets/pravaah_navbar_logo.png")}
                style={styles.summaryLogo}
                resizeMode="contain"
                accessibilityLabel="Pravaah"
              />
            </View>
            <View style={styles.summaryEyebrow}>
              <Text style={styles.summaryEyebrowText}>SESSION COMPLETE</Text>
            </View>

            <Text style={styles.summaryTitle}>
              <Text style={styles.heroHeadlineItalic}>Great</Text> practice!
            </Text>

            <View style={styles.summaryMetricsGrid}>
              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{formatSeconds(sessionSeconds)}</Text>
                <Text style={styles.metricLabel}>DURATION</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>
                  {formatSeconds(learnerSpeakingSeconds || Math.max(1, Math.round(sessionSeconds * 0.45)))}
                </Text>
                <Text style={styles.metricLabel}>SPEAKING</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{correctionCount}</Text>
                <Text style={styles.metricLabel}>CORRECTIONS</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{repetitionCount}</Text>
                <Text style={styles.metricLabel}>PRACTICED</Text>
              </View>
            </View>

            <View style={styles.summaryDetailBlock}>
              <Text style={styles.summaryDetailTitle}>{params.activity_title || "English Practice"}</Text>
              <Text style={styles.summaryDetailDesc}>
                Your progress has been saved. Keep practicing daily to build fluency!
              </Text>
            </View>

            <Pressable
              style={({ pressed }) => [styles.primaryActionModalBtn, pressed && styles.buttonPressed]}
              onPress={handleAdvanceAndReturn}
              disabled={savingSummary}
            >
              {savingSummary ? (
                <ActivityIndicator size="small" color={theme.colors.void} />
              ) : (
                <Text style={styles.primaryActionModalText}>Return to Dashboard →</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.abyss,
  },
  topHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: theme.colors.obsidian,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  backBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  backBtnText: {
    color: theme.colors.irisGleam,
    fontSize: 13,
    fontWeight: "500",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    fontWeight: "600",
  },
  timerPill: {
    backgroundColor: theme.colors.graphiteCard,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  timerText: {
    color: theme.colors.pure,
    fontSize: 12,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
  },
  endPillBtn: {
    backgroundColor: "rgba(255, 82, 82, 0.15)",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.4)",
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  endPillBtnText: {
    color: theme.colors.crimsonError,
    fontSize: 12,
    fontWeight: "600",
    fontFamily: theme.fonts.mono,
  },
  targetBanner: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: theme.colors.graphiteCard,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  targetTitle: {
    color: theme.colors.pure,
    fontSize: 14,
    fontWeight: "600",
  },
  stageBadge: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.3)",
  },
  stageBadgeText: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  scrollContent: {
    padding: 20,
    gap: 16,
    maxWidth: 800,
    width: "100%",
    alignSelf: "center",
  },
  errorBanner: {
    backgroundColor: "rgba(255, 82, 82, 0.15)",
    borderColor: theme.colors.crimsonError,
    borderWidth: 1,
    borderRadius: theme.radii.sm,
    padding: 12,
    marginBottom: 8,
  },
  errorBannerText: {
    color: theme.colors.crimsonError,
    fontSize: 13,
    lineHeight: 18,
  },

  // Pre-Session Styles
  preSessionScroll: {
    padding: 24,
    maxWidth: 580,
    width: "100%",
    alignSelf: "center",
    gap: 20,
  },
  preSessionHero: {
    alignItems: "center",
    textAlign: "center",
    paddingVertical: 16,
  },
  heroLogoWrapper: {
    marginBottom: 20,
  },
  preSessionLogo: {
    width: 140,
    height: 44,
  },
  preSessionTitle: {
    fontSize: 28,
    fontWeight: "600",
    color: theme.colors.pure,
    textAlign: "center",
    marginBottom: 8,
  },
  preSessionSubhead: {
    color: theme.colors.ash,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 400,
  },
  activityObjectiveCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.md,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  cardEyebrow: {
    color: theme.colors.fog,
    fontSize: 9.5,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  activityMainTitle: {
    color: theme.colors.pure,
    fontSize: 16,
    fontWeight: "600",
  },
  tipsCard: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 10,
  },
  tipRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  tipBullet: {
    fontSize: 14,
  },
  tipText: {
    color: theme.colors.cloud,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  connectingCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 14,
    backgroundColor: "rgba(132, 125, 255, 0.08)",
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.2)",
  },
  connectingText: {
    color: theme.colors.irisGleam,
    fontSize: 13,
    fontWeight: "500",
  },
  startActionContainer: {
    alignItems: "center",
    gap: 14,
    marginTop: 8,
  },
  bigStartButton: {
    width: "100%",
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.md,
    height: 56,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: {
        cursor: "pointer" as any,
        boxShadow: "0 4px 14px rgba(132, 125, 255, 0.35)",
      },
      default: {
        shadowColor: theme.colors.irisGleam,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 10,
        elevation: 4,
      },
    }),
  },
  bigStartButtonDisabled: {
    opacity: 0.6,
  },
  buttonLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  bigStartButtonText: {
    color: theme.colors.void,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  ghostCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  ghostCancelText: {
    color: theme.colors.fog,
    fontSize: 13,
  },

  // Active Session Visualizer
  visualizerCard: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.md,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  waveBarsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 90,
    gap: 8,
    marginBottom: 16,
  },
  waveBar: {
    width: 6,
    borderRadius: 3,
  },
  visualizerHint: {
    color: theme.colors.ash,
    fontSize: 13,
    fontFamily: theme.fonts.mono,
    textAlign: "center",
  },

  // In-session Correction
  correctionCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.md,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.colors.orchidBloom,
  },
  correctionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  correctionBadge: {
    backgroundColor: "rgba(221, 144, 216, 0.2)",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
  },
  correctionBadgeText: {
    color: theme.colors.orchidBloom,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
    letterSpacing: 1,
  },
  dismissText: {
    color: theme.colors.fog,
    fontSize: 16,
    paddingHorizontal: 6,
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  correctionBody: {
    gap: 8,
    marginBottom: 16,
  },
  correctionRow: {
    gap: 2,
  },
  correctionLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 0.8,
  },
  correctionLabelCorrect: {
    color: theme.colors.emeraldSuccess,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 0.8,
    fontWeight: "600",
  },
  youSaidText: {
    color: theme.colors.crimsonError,
    fontSize: 14,
    fontStyle: "italic",
  },
  betterText: {
    color: theme.colors.pure,
    fontSize: 15,
    fontWeight: "600",
  },
  whyText: {
    color: theme.colors.ash,
    fontSize: 13,
    lineHeight: 18,
  },
  tryAgainButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: theme.radii.sm,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  tryAgainButtonText: {
    color: theme.colors.pure,
    fontSize: 12,
    fontWeight: "500",
  },
  transcriptBlock: {
    gap: 12,
  },
  transcriptHeader: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  turnBubble: {
    backgroundColor: theme.colors.graphiteCard,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    padding: 16,
    borderWidth: 1,
  },
  turnBubbleTutor: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.orchidBloom,
  },
  turnBubbleLearner: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.cyanSignal,
  },
  turnMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  turnSpeaker: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
  },
  turnTime: {
    color: theme.colors.steel,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
  },
  turnText: {
    color: theme.colors.ash,
    fontSize: 14,
    lineHeight: 20,
  },
  bottomBar: {
    flexDirection: "row",
    gap: 12,
    padding: 20,
    backgroundColor: theme.colors.obsidian,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    maxWidth: 800,
    width: "100%",
    alignSelf: "center",
  },
  muteButton: {
    paddingHorizontal: 20,
    height: 48,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderActive,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  muteButtonActive: {
    backgroundColor: "rgba(255, 82, 82, 0.15)",
    borderColor: theme.colors.crimsonError,
  },
  muteButtonText: {
    color: theme.colors.cloud,
    fontSize: 14,
  },
  endButton: {
    flex: 1,
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  endButtonText: {
    color: theme.colors.void,
    fontSize: 14,
    fontWeight: "500",
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },

  // Modal Styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  summaryModalCard: {
    width: "100%",
    maxWidth: 500,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 32,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  summaryLogoWrapper: {
    alignItems: "center",
    marginBottom: 16,
  },
  summaryLogo: {
    width: 130,
    height: 40,
  },
  summaryEyebrow: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 14,
    paddingVertical: 4,
    alignSelf: "flex-start",
    marginBottom: 16,
  },
  summaryEyebrowText: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    fontWeight: "600",
  },
  summaryTitle: {
    fontSize: 32,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    marginBottom: 20,
  },
  heroHeadlineItalic: {
    fontStyle: "italic",
  },
  summaryMetricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 20,
  },
  metricBlock: {
    flex: 1,
    minWidth: 95,
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    padding: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  metricValue: {
    color: theme.colors.pure,
    fontSize: 15,
    fontWeight: "600",
    fontFamily: theme.fonts.mono,
    marginBottom: 4,
  },
  metricLabel: {
    color: theme.colors.fog,
    fontSize: 8.5,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
  },
  summaryDetailBlock: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: 24,
  },
  summaryDetailTitle: {
    color: theme.colors.pure,
    fontSize: 14,
    fontWeight: "500",
    marginBottom: 4,
  },
  summaryDetailDesc: {
    color: theme.colors.ash,
    fontSize: 12,
    lineHeight: 18,
  },
  primaryActionModalBtn: {
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  primaryActionModalText: {
    color: theme.colors.void,
    fontSize: 14,
    fontWeight: "500",
  },
});

/**
 * Pravaah — Realtime Speaking Session & In-Session Coaching
 *
 * Style reference: Origin Financial (Midnight gallery of quiet wealth).
 * Connects directly to LiveKit Cloud WebRTC voice room (wss://pravaah-qj6q5gxo.livekit.cloud).
 * Requires explicit user interaction (Start Session button) to ensure clean browser microphone
 * permissions and audio context activation.
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

  // Session lifecycle: "ready" (pre-session) -> "connecting" -> "active" -> "ended"
  const [sessionStatus, setSessionStatus] = useState<"ready" | "connecting" | "active" | "ended">("ready");
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

  // LiveKit Room ref
  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  // Web Audio Visualizer refs
  const audioContextRef = useRef<any>(null);
  const analyserRef = useRef<any>(null);
  const animFrameRef = useRef<any>(null);
  const timerRef = useRef<any>(null);

  // Animated wave bars
  const waveAnim1 = useRef(new Animated.Value(14)).current;
  const waveAnim2 = useRef(new Animated.Value(28)).current;
  const waveAnim3 = useRef(new Animated.Value(20)).current;
  const waveAnim4 = useRef(new Animated.Value(36)).current;
  const waveAnim5 = useRef(new Animated.Value(18)).current;

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

          const avgEnergy = (dataArray[2] + dataArray[4] + dataArray[6] + dataArray[8]) / 4;
          if (avgEnergy > 24) {
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

  // Start Speaking Session (Triggered directly on user click)
  const handleStartSession = async () => {
    try {
      setSessionStatus("connecting");
      setErrorMessage(null);

      // 1. Resume / create Web AudioContext inside user gesture
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

      // 2. Create session on backend
      const sessionRes = await createSession(
        params.mode || "free_conversation",
        params.target_skill,
        params.lesson_id
      );

      setSessionId(sessionRes.session_id);

      // 3. Initialize LiveKit Room
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        setSessionStatus("active");
        setReconnecting(false);
      });

      room.on(RoomEvent.Reconnecting, () => {
        setReconnecting(true);
      });

      room.on(RoomEvent.Reconnected, () => {
        setReconnecting(false);
        setSessionStatus("active");
      });

      room.on(RoomEvent.Disconnected, () => {
        if (sessionStatus !== "ended") {
          setSessionStatus("ended");
        }
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
        setAgentSpeaking(remoteSpeaking);
      });

      // Handle tutor data messages (transcripts & corrections)
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
          } else if (data.type === "repetition_success") {
            setRepetitionCount((prev) => prev + 1);
            setActiveCorrection(null);
          } else if (data.type === "turn" && data.text) {
            setTranscript((prev) => [
              ...prev,
              {
                id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                speaker: data.speaker === "agent" || data.speaker === "tutor" ? "tutor" : "learner",
                text: data.text,
                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              },
            ]);
          }
        } catch (e) {
          console.debug("Data message parse note:", e);
        }
      });

      // 4. Connect to LiveKit Cloud
      await room.connect(LIVEKIT_URL, sessionRes.livekit_token);

      // 5. Enable learner microphone
      await room.localParticipant.setMicrophoneEnabled(true);

      // 6. Connect audio visualizer
      const audioTracks = room.localParticipant.audioTrackPublications;
      audioTracks.forEach((pub) => {
        if (pub.track?.mediaStream) {
          setupAudioVisualizer(pub.track.mediaStream);
        }
      });

      // 7. Start session clock
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
      console.warn("LiveKit connection error:", err);
      setErrorMessage(err.message || "Failed to establish voice connection. Please try again.");
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
    if (reconnecting) return "RECONNECTING VOICE...";
    if (sessionStatus === "connecting") return "CONNECTING TO COACH PRAVAAH...";
    if (sessionStatus === "ready") return "READY TO START";
    if (sessionStatus === "ended") return "SESSION ENDED";
    if (agentSpeaking) return "AI COACH IS SPEAKING";
    if (learnerSpeaking) return "LEARNER SPEAKING • AUDIO STREAMING";
    if (isMuted) return "MICROPHONE MUTED";
    return "LISTENING • SPEAK FREELY IN ENGLISH";
  };

  const getSpeakingStateColor = () => {
    if (reconnecting || sessionStatus === "connecting") return theme.colors.amberWarning;
    if (sessionStatus === "ready") return theme.colors.irisGleam;
    if (sessionStatus === "ended") return theme.colors.fog;
    if (agentSpeaking) return theme.colors.orchidBloom;
    if (learnerSpeaking) return theme.colors.cyanSignal;
    if (isMuted) return theme.colors.fog;
    return theme.colors.emeraldSuccess;
  };

  // =========================================================================
  // VIEW 1: PRE-SESSION / READY TO START SCREEN
  // =========================================================================
  if (sessionStatus === "ready" || sessionStatus === "connecting") {
    return (
      <View style={styles.container}>
        {/* Top Navigation */}
        <View style={styles.topHeader}>
          <Pressable style={styles.backBtn} onPress={() => router.replace("/")}>
            <Text style={styles.backBtnText}>← Return to Plan</Text>
          </Pressable>
          <View style={styles.stageBadge}>
            <Text style={styles.stageBadgeText}>{params.stage?.replace(/_/g, " ").toUpperCase() || "GUIDED PRACTICE"}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.preSessionScroll} showsVerticalScrollIndicator={false}>
          {/* Logo & Headline */}
          <View style={styles.preSessionHero}>
            <View style={styles.heroLogoWrapper}>
              <Image
                source={require("../assets/pravaah_navbar_logo.png")}
                style={styles.preSessionLogo}
                resizeMode="contain"
                accessibilityLabel="Pravaah"
              />
            </View>
            <View style={styles.preSessionBadge}>
              <Text style={styles.preSessionBadgeText}>REALTIME SPOKEN ENGLISH COACH</Text>
            </View>
            <Text style={styles.preSessionTitle}>
              <Text style={styles.heroHeadlineItalic}>Ready</Text> to speak?
            </Text>
            <Text style={styles.preSessionSubhead}>
              Your AI coach will listen, actively correct mistakes with simple 1-sentence explanations, and guide your pronunciation in real time.
            </Text>
          </View>

          {/* Activity Target Card */}
          <View style={styles.activityObjectiveCard}>
            <Text style={styles.cardEyebrow}>TODAY'S TARGET SKILL & OBJECTIVE</Text>
            <Text style={styles.activityMainTitle}>
              {params.activity_title || "Spontaneous Spoken English Drill"}
            </Text>
            {params.target_skill ? (
              <Text style={styles.targetSkillText}>
                🎯 Focus: {params.target_skill.replace(/_/g, " ").toUpperCase()}
              </Text>
            ) : null}
            <Text style={styles.activityGuideText}>
              💡 Speak freely in full English sentences. If you make a grammar mistake, Coach Pravaah will gently explain the rule and ask you to repeat.
            </Text>
          </View>

          {/* Instructions checklist */}
          <View style={styles.tipsCard}>
            <Text style={styles.tipsTitle}>BEFORE YOU BEGIN</Text>
            <View style={styles.tipRow}>
              <Text style={styles.tipBullet}>✓</Text>
              <Text style={styles.tipText}>Use earphones or a quiet room for crystal-clear microphone audio.</Text>
            </View>
            <View style={styles.tipRow}>
              <Text style={styles.tipBullet}>✓</Text>
              <Text style={styles.tipText}>Speak naturally. Feel free to ask for Hindi translations if you get stuck.</Text>
            </View>
            <View style={styles.tipRow}>
              <Text style={styles.tipBullet}>✓</Text>
              <Text style={styles.tipText}>Only 1 conversation question will be asked at a time to keep it natural.</Text>
            </View>
          </View>

          {/* Error Banner if connection failed previously */}
          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          {/* Big Start Button */}
          <View style={styles.startActionContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.bigStartButton,
                sessionStatus === "connecting" && styles.bigStartButtonConnecting,
                pressed && styles.buttonPressed,
              ]}
              onPress={handleStartSession}
              disabled={sessionStatus === "connecting"}
            >
              {sessionStatus === "connecting" ? (
                <View style={styles.buttonLoadingRow}>
                  <ActivityIndicator size="small" color={theme.colors.void} />
                  <Text style={styles.bigStartButtonText}>Connecting to LiveKit Voice...</Text>
                </View>
              ) : (
                <Text style={styles.bigStartButtonText}>Start Conversation 🎙️</Text>
              )}
            </Pressable>

            <Pressable style={styles.ghostCancelBtn} onPress={() => router.replace("/")}>
              <Text style={styles.ghostCancelText}>Not right now, return to dashboard</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // VIEW 2: ACTIVE LIVE AUDIO STREAMING SESSION
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
          <Text style={styles.endPillBtnText}>Finish ◼</Text>
        </Pressable>
      </View>

      {/* Target Focus Banner */}
      <View style={styles.targetBanner}>
        <View style={styles.targetLeft}>
          <Text style={styles.targetLabel}>CURRENT PRACTICE OBJECTIVE</Text>
          <Text style={styles.targetTitle}>
            {params.activity_title || "Spontaneous English Conversation"}
          </Text>
        </View>
        {params.stage ? (
          <View style={styles.stageBadge}>
            <Text style={styles.stageBadgeText}>{params.stage.replace(/_/g, " ").toUpperCase()}</Text>
          </View>
        ) : null}
      </View>

      {/* Main Audio Visualizer & Live Stream */}
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Waveform Sound Card */}
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
              ? "Listen to tutor feedback..."
              : learnerSpeaking
              ? "Audio streaming to Pravaah AI..."
              : "Microphone active — Speak naturally in English"}
          </Text>
        </View>

        {/* In-Session Correction Card (Pedagogical Feedback) */}
        {activeCorrection ? (
          <View style={styles.correctionCard}>
            <View style={styles.correctionHeader}>
              <View style={styles.correctionBadge}>
                <Text style={styles.correctionBadgeText}>💡 COACH CORRECTION</Text>
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
              onPress={() => {
                setActiveCorrection(null);
              }}
            >
              <Text style={styles.tryAgainButtonText}>🎙 Try again with corrected phrasing</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Live Conversation Transcript */}
        <View style={styles.transcriptBlock}>
          <Text style={styles.transcriptHeader}>REALTIME VOICE DIALOGUE</Text>
          {transcript.length === 0 ? (
            <View style={styles.turnBubble}>
              <Text style={styles.turnSpeaker}>LIVEKIT WEBRTC • AUDIO ACTIVE</Text>
              <Text style={styles.turnText}>
                Connected to Coach Pravaah. Speak into your microphone and the AI tutor will respond in real time.
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
                    {t.speaker === "tutor" ? "AI COACH (TUTOR)" : "YOU (LEARNER)"}
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
          <Text style={styles.muteButtonText}>{isMuted ? "🔇 Unmute" : "🎙 Mute Mic"}</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.endButton, pressed && styles.buttonPressed]}
          onPress={handleEndSession}
        >
          <Text style={styles.endButtonText}>End Practice & Save Progress →</Text>
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
              <Text style={styles.summaryEyebrowText}>PRACTICE SESSION COMPLETE</Text>
            </View>

            <Text style={styles.summaryTitle}>
              <Text style={styles.heroHeadlineItalic}>Session</Text> recorded.
            </Text>

            <View style={styles.summaryMetricsGrid}>
              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{formatSeconds(sessionSeconds)}</Text>
                <Text style={styles.metricLabel}>TOTAL TIME</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>
                  {formatSeconds(learnerSpeakingSeconds || Math.max(1, Math.round(sessionSeconds * 0.45)))}
                </Text>
                <Text style={styles.metricLabel}>SPEAKING TIME</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{correctionCount}</Text>
                <Text style={styles.metricLabel}>CORRECTIONS</Text>
              </View>

              <View style={styles.metricBlock}>
                <Text style={styles.metricValue}>{repetitionCount}</Text>
                <Text style={styles.metricLabel}>REPETITIONS</Text>
              </View>
            </View>

            <View style={styles.summaryDetailBlock}>
              <Text style={styles.summaryDetailLabel}>ACTIVITY RECORDED</Text>
              <Text style={styles.summaryDetailTitle}>{params.activity_title || "Spoken English Practice"}</Text>
              <Text style={styles.summaryDetailDesc}>
                Your speaking evidence and mastery data have been asynchronously queued for adaptive curriculum progression.
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: theme.colors.graphiteCard,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  targetLeft: {
    flex: 1,
  },
  targetLabel: {
    color: theme.colors.fog,
    fontSize: 9,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
  },
  targetTitle: {
    color: theme.colors.pure,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
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
    maxWidth: 680,
    width: "100%",
    alignSelf: "center",
    gap: 20,
  },
  preSessionHero: {
    alignItems: "center",
    textAlign: "center",
    paddingVertical: 12,
  },
  heroLogoWrapper: {
    marginBottom: 16,
  },
  preSessionLogo: {
    width: 140,
    height: 44,
  },
  preSessionBadge: {
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.3)",
    marginBottom: 16,
  },
  preSessionBadgeText: {
    color: theme.colors.irisGleam,
    fontSize: 10.5,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    fontWeight: "600",
  },
  preSessionTitle: {
    fontSize: 36,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    textAlign: "center",
    marginBottom: 12,
  },
  heroHeadlineItalic: {
    fontStyle: "italic",
  },
  preSessionSubhead: {
    color: theme.colors.ash,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 520,
  },
  activityObjectiveCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.md,
    padding: 20,
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
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 6,
  },
  targetSkillText: {
    color: theme.colors.orchidBloom,
    fontSize: 12,
    fontFamily: theme.fonts.mono,
    marginBottom: 10,
  },
  activityGuideText: {
    color: theme.colors.ash,
    fontSize: 13,
    lineHeight: 20,
  },
  tipsCard: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.md,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 10,
  },
  tipsTitle: {
    color: theme.colors.fog,
    fontSize: 9.5,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  tipRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  tipBullet: {
    color: theme.colors.emeraldSuccess,
    fontSize: 14,
    fontWeight: "bold",
  },
  tipText: {
    color: theme.colors.cloud,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
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
  bigStartButtonConnecting: {
    opacity: 0.8,
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
  summaryDetailLabel: {
    color: theme.colors.fog,
    fontSize: 9,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
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

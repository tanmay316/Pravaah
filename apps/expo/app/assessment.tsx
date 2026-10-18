/**
 * Pravaah — Mobile-First Spoken English Diagnostic Assessment
 *
 * Connects to LiveKit Cloud WebRTC voice pipeline for real-time speech evaluation.
 * Gathers task-aware linguistic evidence across 4 diagnostic tasks:
 *   1. Introduction & Daily Routine (A1/A2)
 *   2. Past Experience & Storytelling (A2/B1)
 *   3. Opinion & Reasoning (B1/B2)
 *   4. Hypothetical & Complex Discussion (B2/C1)
 *
 * Mobile-first experience with:
 * - 4-step segmented progress bar
 * - Collapsible Hindi hint accordion
 * - Large thumb recording trigger with live animated visualizer
 * - Native diagnostic report card with CEFR reference and daily plan generator
 */

// Must load before livekit-client: Hermes lacks TextDecoder/DOMException it needs at import.
import "../lib/polyfills";
import { startAudioSession, stopAudioSession } from "../lib/livekit";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  createSession,
  submitProficiencyAssessment,
  setDailyGoal,
  AssessmentTaskEvidence,
  ProficiencyAssessmentRecord,
  PRAVAAH_LEVEL_NAMES,
} from "../lib/api";
import { skillLabel } from "../lib/skills";
import { AppTheme, ThemeColors, theme, useTheme } from "../lib/theme";

const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL || "wss://pravaah-qj6q5gxo.livekit.cloud";

interface AssessmentQuestion {
  id: string;
  stage: number;
  stageTitle: string;
  question: string;
  hindiHint: string;
  evalTarget: string;
  suggestedSeconds: number;
}

const ASSESSMENT_QUESTIONS: AssessmentQuestion[] = [
  {
    id: "task_1_intro",
    stage: 1,
    stageTitle: "Introduction and daily routine",
    question: "Tell me about yourself, what you do every day, and why you want to improve your spoken English.",
    hindiHint: "अपने बारे में बताइए, आपका दैनिक काम क्या है, और आप अंग्रेज़ी क्यों सुधारना चाहते हैं।",
    evalTarget: "Present simple stability, basic everyday vocabulary, and immediate responsiveness.",
    suggestedSeconds: 30,
  },
  {
    id: "task_2_past",
    stage: 2,
    stageTitle: "Past experience and storytelling",
    question: "Describe a memorable day from your past, or explain a challenge you recently overcame.",
    hindiHint: "अपने अतीत का कोई यादगार दिन बताइए या हाल ही में सुलझाई किसी समस्या के बारे में बात करें।",
    evalTarget: "Past tense auxiliaries (did/didn't + base verb), irregular verbs, and narrative sequencing.",
    suggestedSeconds: 40,
  },
  {
    id: "task_3_opinion",
    stage: 3,
    stageTitle: "Opinion and reasoning",
    question: "Do you prefer working from home or from an office? Explain your reasons with clear examples.",
    hindiHint: "क्या आपको घर से काम करना पसंद है या दफ़्तर से? अपने कारणों को उदाहरण सहित समझाइए।",
    evalTarget: "Stative verbs (agree, prefer), comparative structures, and connecting phrases.",
    suggestedSeconds: 45,
  },
  {
    id: "task_4_hypothetical",
    stage: 4,
    stageTitle: "Hypothetical discussion",
    question: "If you could change one thing about how people communicate in modern workplaces, what would it be and why?",
    hindiHint: "यदि आप आधुनिक कार्यस्थलों में लोगों के बातचीत करने के तरीके में कोई बदलाव कर सकें, तो वह क्या होगा और क्यों?",
    evalTarget: "Conditionals, modal verbs, complex syntax, and professional nuance.",
    suggestedSeconds: 45,
  },
];

function getSpeechRecognition(): any | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return SR ? new SR() : null;
}

export default function AssessmentScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark, toggleTheme, theme: activeTheme } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark, activeTheme), [colors, isDark, activeTheme]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const [showHindi, setShowHindi] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState(30);

  // LiveKit Connection State
  const [livekitConnected, setLivekitConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Collected evidence across all 4 tasks
  const [taskEvidences, setTaskEvidences] = useState<AssessmentTaskEvidence[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [liveInterim, setLiveInterim] = useState("");

  // Telemetry trackers for current task
  const taskStartTimeRef = useRef<number>(0);
  const speechStartTimeRef = useRef<number>(0);
  const pauseCountRef = useRef<number>(0);
  const longPauseCountRef = useRef<number>(0);
  const restartCountRef = useRef<number>(0);
  const lastSoundTimeRef = useRef<number>(0);
  const lastSpeechTimeRef = useRef<number>(0);
  const committedTextRef = useRef<string>("");
  const isRecordingRef = useRef<boolean>(false);
  const lastTasksRef = useRef<AssessmentTaskEvidence[]>([]);

  // Result state
  const [assessmentResult, setAssessmentResult] = useState<ProficiencyAssessmentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // LiveKit & Audio refs
  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<any>(null);
  const mediaStreamRef = useRef<any>(null);
  const analyserRef = useRef<any>(null);
  const animFrameRef = useRef<any>(null);

  // Animated wave bars
  const barAnim1 = useRef(new Animated.Value(12)).current;
  const barAnim2 = useRef(new Animated.Value(24)).current;
  const barAnim3 = useRef(new Animated.Value(18)).current;
  const barAnim4 = useRef(new Animated.Value(32)).current;
  const barAnim5 = useRef(new Animated.Value(16)).current;

  // Initialize LiveKit voice room session
  useEffect(() => {
    let roomInstance: Room | null = null;

    async function initLiveKitAssessment() {
      try {
        const sessionRes = await createSession({
          mode: "assessment",
          conversationGoal: "assessment",
        });
        setSessionId(sessionRes.session_id);

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
        });
        roomRef.current = room;
        roomInstance = room;

        room.on(RoomEvent.Connected, () => {
          setLivekitConnected(true);
        });

        room.on(RoomEvent.Disconnected, () => {
          setLivekitConnected(false);
        });

        room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
          if (!isRecordingRef.current) return;
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (data.type === "turn" && data.speaker === "learner" && typeof data.text === "string") {
              const incoming = data.text.trim();
              if (!incoming) return;
              const now = Date.now();
              if (!speechStartTimeRef.current) speechStartTimeRef.current = now;
              if (lastSpeechTimeRef.current > 0) {
                const gap = now - lastSpeechTimeRef.current;
                if (gap > 650) {
                  pauseCountRef.current += 1;
                  if (gap > 1600) {
                    longPauseCountRef.current += 1;
                  }
                }
              }
              lastSpeechTimeRef.current = now;
              // On native Android/iOS (or browsers without Web Speech API), LiveKit Whisper STT
              // is the primary verbatim transcript source. Avoid duplicating if Web Speech already appended it.
              if (!recognitionRef.current || !committedTextRef.current.toLowerCase().includes(incoming.toLowerCase())) {
                committedTextRef.current = (committedTextRef.current + " " + incoming).trim();
                setCurrentTranscript(committedTextRef.current);
              }
            }
          } catch {}
        });

        await startAudioSession();
        await room.connect(LIVEKIT_URL, sessionRes.livekit_token);
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch (err: any) {
        console.warn("LiveKit assessment room notice:", err);
      }
    }

    initLiveKitAssessment();

    return () => {
      if (audioElementRef.current) audioElementRef.current.remove();
      if (roomInstance) roomInstance.disconnect();
      stopAudioSession().catch(() => {});
    };
  }, []);

  const setupAudioCapture = async () => {
    taskStartTimeRef.current = Date.now();
    speechStartTimeRef.current = 0;
    pauseCountRef.current = 0;
    longPauseCountRef.current = 0;
    restartCountRef.current = 0;
    lastSoundTimeRef.current = Date.now();
    lastSpeechTimeRef.current = 0;
    committedTextRef.current = "";

    if (Platform.OS === "web" && typeof window !== "undefined") {
      try {
        let stream = mediaStreamRef.current;
        if (!stream && navigator.mediaDevices) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: true,
              echoCancellation: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
          mediaStreamRef.current = stream;
        }

        if (stream) {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          if (ctx.state === "suspended") {
            try {
              await ctx.resume();
            } catch {}
          }

          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          let isSpeaking = false;
          let silenceStart = 0;

          const updateBars = () => {
            analyser.getByteFrequencyData(dataArray);
            const energy = (dataArray[1] + dataArray[2] + dataArray[3] + dataArray[4] + dataArray[5]) / 5;

            const now = Date.now();
            if (energy > 16) {
              if (!isSpeaking) {
                isSpeaking = true;
                if (!speechStartTimeRef.current) speechStartTimeRef.current = now;
                if (silenceStart > 0) {
                  const pauseDuration = now - silenceStart;
                  if (pauseDuration > 450) {
                    pauseCountRef.current += 1;
                    if (pauseDuration > 1500) {
                      longPauseCountRef.current += 1;
                    }
                  }
                }
              }
              lastSoundTimeRef.current = now;
            } else {
              if (isSpeaking) {
                isSpeaking = false;
                silenceStart = now;
              }
            }

            barAnim1.setValue(Math.max(10, (dataArray[2] / 255) * 65));
            barAnim2.setValue(Math.max(14, (dataArray[4] / 255) * 75));
            barAnim3.setValue(Math.max(18, (dataArray[6] / 255) * 85));
            barAnim4.setValue(Math.max(12, (dataArray[8] / 255) * 70));
            barAnim5.setValue(Math.max(10, (dataArray[10] / 255) * 60));
            animFrameRef.current = requestAnimationFrame(updateBars);
          };
          animFrameRef.current = requestAnimationFrame(updateBars);
        }
      } catch (err) {
        console.warn("Audio telemetry notice:", err);
      }
    }
  };

  const startRecording = async () => {
    isRecordingRef.current = true;
    setCurrentTranscript("");
    setLiveInterim("");
    if (roomRef.current) {
      roomRef.current.localParticipant
        .setMicrophoneEnabled(true, {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        })
        .then(() => {
          roomRef.current?.localParticipant.audioTrackPublications.forEach((pub) => {
            if (pub.track?.mediaStream) {
              mediaStreamRef.current = pub.track.mediaStream;
            }
          });
        })
        .catch(() => {});
    }
    await setupAudioCapture();

    const recognition = getSpeechRecognition();
    if (recognition) {
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-IN";

      recognition.onresult = (event: any) => {
        let sessionFinal = "";
        let sessionInterim = "";
        const now = Date.now();

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = (result[0]?.transcript || "").trim();
          if (!text) continue;

          if (lastSpeechTimeRef.current > 0) {
            const gap = now - lastSpeechTimeRef.current;
            if (gap > 650) {
              pauseCountRef.current += 1;
              if (gap > 1600) {
                longPauseCountRef.current += 1;
              }
            }
          }
          lastSpeechTimeRef.current = now;

          if (result.isFinal) {
            sessionFinal += text + " ";
            if (/\b(\w+)\s+\1\b/i.test(text) || /\b(I|we|they|he|she|it)\s+\w+\s+\1\b/i.test(text)) {
              restartCountRef.current += 1;
            }
          } else {
            sessionInterim += text + " ";
          }
        }

        if (sessionFinal) {
          committedTextRef.current = (committedTextRef.current + " " + sessionFinal).trim();
          setCurrentTranscript(committedTextRef.current);
          setLiveInterim("");
        } else if (sessionInterim) {
          setLiveInterim(sessionInterim);
        }
      };

      recognition.onerror = () => {};
      recognition.onend = () => {
        if (isRecordingRef.current) {
          try {
            recognition.start();
          } catch {}
        }
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
      } catch {}
    }
  };

  const stopRecording = () => {
    if (roomRef.current) {
      roomRef.current.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }

    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
    }

    barAnim1.setValue(12);
    barAnim2.setValue(24);
    barAnim3.setValue(18);
    barAnim4.setValue(32);
    barAnim5.setValue(16);
  };

  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => setRecordedSeconds((prev) => prev + 1), 1000);
    } else {
      setRecordedSeconds(0);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  const currentQ = ASSESSMENT_QUESTIONS[currentStep];

  const handleToggleRecording = () => {
    if (!isRecording) {
      setIsRecording(true);
      startRecording();
    } else {
      setIsRecording(false);
      isRecordingRef.current = false;
      stopRecording();

      const spokenText = (committedTextRef.current + " " + liveInterim).trim() || currentTranscript.trim();
      saveTaskEvidenceAndAdvance(spokenText);
    }
  };

  const saveTaskEvidenceAndAdvance = (verbatimTranscript: string) => {
    const now = Date.now();
    const durationMs = taskStartTimeRef.current > 0 ? now - taskStartTimeRef.current : recordedSeconds * 1000;
    const latencyMs =
      speechStartTimeRef.current > 0 && taskStartTimeRef.current > 0
        ? Math.max(0, speechStartTimeRef.current - taskStartTimeRef.current)
        : 0;

    const wordCount = verbatimTranscript ? verbatimTranscript.split(/\s+/).filter(Boolean).length : 0;

    const transcriptRestarts =
      (verbatimTranscript.match(/\b(\w+)\s+\1\b/gi) || []).length +
      (verbatimTranscript.match(/\b(I\s+\w+)\s+I\s+\w+/gi) || []).length +
      (verbatimTranscript.match(/\b(want to|prefer to)\s+\w+\s+(want to|prefer to)/gi) || []).length +
      (verbatimTranscript.match(/\b(was|is|are|were)\s+\w+\s+\1\b/gi) || []).length;
    const finalRestarts = Math.max(restartCountRef.current, transcriptRestarts);

    let finalPauses = pauseCountRef.current;
    let finalLongPauses = longPauseCountRef.current;
    const durationSec = durationMs / 1000.0;
    if (finalPauses === 0 && durationSec > 8 && wordCount > 8) {
      finalPauses = Math.max(1, Math.floor(wordCount / 12));
      if (durationSec > 25 && finalLongPauses === 0) {
        finalLongPauses = 1;
      }
    }

    const taskEvidence: AssessmentTaskEvidence = {
      task_id: currentQ.id,
      task_title: currentQ.stageTitle,
      prompt: currentQ.question,
      transcript: verbatimTranscript,
      duration_ms: durationMs,
      word_count: wordCount,
      pause_count: finalPauses,
      long_pause_count: finalLongPauses,
      restart_count: finalRestarts,
      response_latency_ms: latencyMs,
      turn_count: 1,
    };

    const updatedTasks = [...taskEvidences, taskEvidence];
    setTaskEvidences(updatedTasks);
    setCurrentTranscript("");
    setLiveInterim("");
    committedTextRef.current = "";

    if (currentStep < ASSESSMENT_QUESTIONS.length - 1) {
      setCurrentStep((prev) => prev + 1);
    } else {
      handleFinalizeAssessment(updatedTasks);
    }
  };

  const handleSkipQuestion = () => {
    setIsRecording(false);
    isRecordingRef.current = false;
    stopRecording();
    const spokenText = (committedTextRef.current + " " + liveInterim).trim() || currentTranscript.trim();
    saveTaskEvidenceAndAdvance(spokenText);
  };

  const handleFinalizeAssessment = async (finalTasks: AssessmentTaskEvidence[]) => {
    lastTasksRef.current = finalTasks;
    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await submitProficiencyAssessment({
        session_id: sessionId || undefined,
        tasks: finalTasks,
        goal_minutes: selectedGoal,
      });

      if (response && response.assessment) {
        setAssessmentResult(response.assessment);
      } else {
        setError("Assessment completed but the diagnostic score could not be processed.");
      }
      setCompleted(true);
    } catch (err: any) {
      console.warn("Assessment submission error:", err);
      setError(err.message || "Failed to submit assessment to server. Please try again.");
      setCompleted(true);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFinishAndStartPlan = async () => {
    try {
      await setDailyGoal(selectedGoal);
    } catch {}
    router.replace("/");
  };

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  // =========================================================================
  // VIEW: ANALYSIS IN PROGRESS
  // =========================================================================
  if (isAnalyzing) {
    return (
      <View style={[styles.screen, styles.centerView]}>
        <View style={styles.analyzingCard}>
          <ActivityIndicator size="large" color={colors.irisBlue} />
          <Text style={styles.analyzingHeading}>Analysing your answers</Text>
          <Text style={styles.analyzingDesc}>
            Checking fluency, grammar, pauses and vocabulary. This takes a few seconds.
          </Text>
        </View>
      </View>
    );
  }

  // =========================================================================
  // VIEW: ASSESSMENT RESULT REPORT CARD
  // =========================================================================
  if (completed && assessmentResult) {
    const { pravaah_level, cefr_reference, criteria, notes, strengths, weaknesses } = assessmentResult;
    const levelName = PRAVAAH_LEVEL_NAMES[pravaah_level] || (assessmentResult as any).name || "Elementary";

    return (
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 12) }]}>
        <ScrollView
          contentContainerStyle={[
            styles.resultScroll,
            { paddingBottom: Math.max(insets.bottom + 20, 32) },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.resultHeaderCard}>
            <View style={styles.scorePill}>
              <Text style={styles.scorePillText}>Assessment complete</Text>
            </View>

            <Text style={styles.resultHeadline}>
              Level {pravaah_level}{" "}
              <Text style={styles.resultHeadlineSub}>· {levelName}</Text>
            </Text>

            <View style={styles.cefrBadgeRow}>
              <Text style={styles.cefrBadgeText}>CEFR {cefr_reference}</Text>
            </View>

            <Text style={styles.resultOverviewText}>
              {criteria || "Your spoken diagnostic has been processed and saved to your profile."}
            </Text>
          </View>

          {/* AI Diagnostic Notes */}
          {notes ? (
            <View style={styles.cardBox}>
              <Text style={styles.cardBoxLabel}>Observations</Text>
              <Text style={styles.cardBoxText}>{notes}</Text>
            </View>
          ) : null}

          {/* Strengths & Focus Skills */}
          <View style={styles.strengthsWeaknessesRow}>
            <View style={styles.halfCard}>
              <Text style={styles.cardBoxLabel}>Strengths</Text>
              <View style={styles.chipWrap}>
                {strengths && strengths.length > 0 ? (
                  strengths.map((str: string, idx: number) => (
                    <View key={idx} style={styles.strengthChip}>
                      <Text style={styles.strengthChipText}>{skillLabel(str)}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.emptyNotice}>Baseline developing</Text>
                )}
              </View>
            </View>

            <View style={styles.halfCard}>
              <Text style={styles.cardBoxLabel}>Focus areas</Text>
              <View style={styles.chipWrap}>
                {weaknesses && weaknesses.length > 0 ? (
                  weaknesses.map((weak: string, idx: number) => (
                    <View key={idx} style={styles.weaknessChip}>
                      <Text style={styles.weaknessChipText}>{skillLabel(weak)}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.emptyNotice}>None diagnosed</Text>
                )}
              </View>
            </View>
          </View>

          {/* Filler Words */}
          {assessmentResult.filler_words_detected && assessmentResult.filler_words_detected.length > 0 ? (
            <View style={styles.cardBox}>
              <Text style={styles.cardBoxLabel}>Filler words</Text>
              <View style={styles.chipWrap}>
                {assessmentResult.filler_words_detected.map((filler, idx) => (
                  <View key={idx} style={styles.fillerChip}>
                    <Text style={styles.fillerChipText}>"{filler}"</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {/* Daily Goal Commitment */}
          <View style={styles.cardBox}>
            <Text style={styles.cardBoxLabel}>Daily practice goal</Text>
            <View style={styles.goalChipsRow}>
              {[15, 30, 60, 90].map((mins) => (
                <Pressable
                  key={mins}
                  style={[styles.goalChip, selectedGoal === mins && styles.goalChipActive]}
                  onPress={() => setSelectedGoal(mins)}
                >
                  <Text
                    style={[
                      styles.goalChipText,
                      selectedGoal === mins && styles.goalChipTextActive,
                    ]}
                  >
                    {mins} min
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Finish Button */}
          <Pressable
            style={({ pressed }) => [styles.finishBtn, pressed && styles.btnPressed]}
            onPress={handleFinishAndStartPlan}
          >
            <Text style={styles.finishBtnText}>
              Start today's practice
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // =========================================================================
  // VIEW: IN-PROGRESS QUESTION STEP
  // =========================================================================
  const displayTranscript = (currentTranscript + " " + liveInterim).trim();

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 12) }]}>
      {/* Top Mobile Stepper Bar */}
      <View style={styles.assessmentHeader}>
        <Pressable
          style={({ pressed }) => [styles.exitBtn, pressed && styles.btnPressed]}
          onPress={() => router.replace("/")}
        >
          <Ionicons name="close" size={20} color={colors.textPrimary} />
        </Pressable>

        {/* 4-Step Progress Indicator */}
        <View style={styles.stepperContainer}>
          {ASSESSMENT_QUESTIONS.map((q, idx) => (
            <View
              key={q.id}
              style={[
                styles.stepperBar,
                idx <= currentStep && styles.stepperBarActive,
                idx === currentStep && styles.stepperBarCurrent,
              ]}
            />
          ))}
        </View>

        <View style={styles.stepNumPill}>
          <Text style={styles.stepNumPillText}>{currentStep + 1}/4</Text>
        </View>

        <Pressable
          style={({ pressed }) => [styles.exitBtn, pressed && styles.btnPressed]}
          onPress={toggleTheme}
          accessibilityRole="button"
          accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={18} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.assessmentScroll,
          { paddingBottom: Math.max(insets.bottom + 20, 32) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Stage Eyebrow */}
        <View style={styles.stageEyebrow}>
          <Text style={styles.stageEyebrowText}>
            Task {currentStep + 1} of {ASSESSMENT_QUESTIONS.length} · {currentQ.stageTitle}
          </Text>
        </View>

        {/* Question Prompt */}
        <Text style={styles.questionPrompt}>{currentQ.question}</Text>

        {/* Hindi Guide Accordion */}
        <Pressable
          style={styles.hindiAccordionHeader}
          onPress={() => setShowHindi(!showHindi)}
        >
          <Ionicons name="language" size={18} color={colors.irisBlue} />
          <Text style={styles.hindiAccordionTitle}>
            {showHindi ? "Hide Hindi guide" : "Show Hindi translation"}
          </Text>
          <Ionicons
            name={showHindi ? "chevron-up" : "chevron-down"}
            size={18}
            color={colors.textSecondary}
          />
        </Pressable>

        {showHindi ? (
          <View style={styles.hindiBodyCard}>
            <Text style={styles.hindiBodyText}>{currentQ.hindiHint}</Text>
          </View>
        ) : null}

        {/* Animated Waveform Visualizer */}
        <View style={styles.waveVisualizerBox}>
          <View style={styles.waveBarsRow}>
            <Animated.View style={[styles.waveBar, { height: barAnim1 }]} />
            <Animated.View style={[styles.waveBar, { height: barAnim2 }]} />
            <Animated.View style={[styles.waveBar, { height: barAnim3 }]} />
            <Animated.View style={[styles.waveBar, { height: barAnim4 }]} />
            <Animated.View style={[styles.waveBar, { height: barAnim5 }]} />
          </View>

          <Text style={styles.timerOrHintText}>
            {isRecording
              ? `Recording: 0:${recordedSeconds < 10 ? `0${recordedSeconds}` : recordedSeconds}`
              : "Tap microphone below to speak in English"}
          </Text>
        </View>

        {/* Live Verbatim Speech Preview */}
        {displayTranscript ? (
          <View style={styles.liveTranscriptCard}>
            <Text style={styles.liveTranscriptLabel}>Transcript</Text>
            <Text style={styles.liveTranscriptText}>"{displayTranscript}"</Text>
          </View>
        ) : isRecording ? (
          <View style={styles.liveTranscriptCard}>
            <Text style={styles.liveTranscriptLabel}>Listening</Text>
            <Text style={styles.liveTranscriptText}>Speak naturally — speech will appear here.</Text>
          </View>
        ) : null}

        {/* Action Controls */}
        <View style={styles.bottomActions}>
          <Pressable
            style={({ pressed }) => [
              styles.recordActionBtn,
              isRecording && styles.recordActionBtnActive,
              pressed && styles.btnPressed,
            ]}
            onPress={handleToggleRecording}
          >
            <Ionicons
              name={isRecording ? "stop" : "mic"}
              size={22}
              color="#ffffff"
            />
            <Text
              style={[
                styles.recordActionBtnText,
                isRecording && styles.recordActionBtnTextActive,
              ]}
            >
              {isRecording ? "Finish speaking" : "Tap to speak"}
            </Text>
          </Pressable>

          <Pressable
            style={styles.skipTaskBtn}
            onPress={handleSkipQuestion}
          >
            <Text style={styles.skipTaskBtnText}>
              {currentStep < ASSESSMENT_QUESTIONS.length - 1 ? "Skip this task" : "Finish assessment"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors, isDark: boolean, activeTheme: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
    centerView: {
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing.xl,
    },
    analyzingCard: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 28,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      maxWidth: 420,
      width: "100%",
      gap: 12,
      ...activeTheme.shadows.sm,
    },
    analyzingHeading: {
      fontFamily: theme.fonts.display,
      fontSize: 20,
      fontWeight: "600",
      color: colors.textPrimary,
      textAlign: "center",
    },
    analyzingDesc: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 22,
    },
    assessmentHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 14,
      gap: 10,
    },
    exitBtn: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    stepperContainer: {
      flex: 1,
      flexDirection: "row",
      gap: 6,
    },
    stepperBar: {
      flex: 1,
      height: 6,
      borderRadius: theme.radii.full,
      backgroundColor: isDark ? colors.cardSubtle : colors.mistGray,
    },
    stepperBarActive: {
      backgroundColor: colors.irisBlue,
    },
    stepperBarCurrent: {
      backgroundColor: colors.irisBlue,
    },
    stepNumPill: {
      paddingHorizontal: 4,
    },
    stepNumPillText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    assessmentScroll: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    stageEyebrow: {
      alignSelf: "flex-start",
      marginBottom: 8,
    },
    stageEyebrowText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.irisBlue,
    },
    questionPrompt: {
      fontFamily: theme.fonts.display,
      fontSize: 22,
      fontWeight: "600",
      color: colors.textPrimary,
      lineHeight: 30,
      letterSpacing: -0.3,
      marginBottom: 20,
    },
    hindiAccordionHeader: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.cardElevated,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 8,
      marginBottom: 12,
    },
    hindiAccordionTitle: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
      fontWeight: "500",
    },
    hindiBodyCard: {
      backgroundColor: colors.cardSubtle,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
    },
    hindiBodyText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    waveVisualizerBox: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 24,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 12,
      ...activeTheme.shadows.sm,
    },
    waveBarsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      height: 60,
      marginBottom: 8,
    },
    waveBar: {
      width: 6,
      borderRadius: theme.radii.full,
      backgroundColor: colors.irisBlue,
    },
    timerOrHintText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    liveTranscriptCard: {
      backgroundColor: colors.cardElevated,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      borderLeftWidth: 3,
      borderLeftColor: colors.irisBlue,
      marginBottom: 20,
    },
    liveTranscriptLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
      marginBottom: 4,
    },
    liveTranscriptText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      color: colors.textPrimary,
      lineHeight: 22,
    },
    bottomActions: {
      marginTop: "auto",
      gap: 12,
      paddingTop: theme.spacing.md,
    },
    recordActionBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      gap: 8,
    },
    recordActionBtnActive: {
      backgroundColor: colors.crimsonError,
    },
    recordActionBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: "#ffffff",
    },
    recordActionBtnTextActive: {
      color: "#ffffff",
    },
    skipTaskBtn: {
      alignItems: "center",
      paddingVertical: 10,
    },
    skipTaskBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    btnPressed: {
      opacity: 0.85,
    },
    resultScroll: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.md,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
      gap: theme.spacing.md,
    },
    resultHeaderCard: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 24,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      ...activeTheme.shadows.sm,
    },
    scorePill: {
      backgroundColor: colors.emeraldWash,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      marginBottom: 12,
    },
    scorePillText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.emeraldSuccess,
    },
    resultHeadline: {
      fontFamily: theme.fonts.display,
      fontSize: 30,
      fontWeight: "600",
      color: colors.textPrimary,
      letterSpacing: -0.6,
      marginBottom: 6,
    },
    resultHeadlineSub: {
      color: colors.textSecondary,
      fontWeight: "500",
    },
    cefrBadgeRow: {
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      marginBottom: 14,
    },
    cefrBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.irisBlue,
    },
    resultOverviewText: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 22,
    },
    cardBox: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardBoxLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 10,
    },
    cardBoxText: {
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
      color: colors.textPrimary,
      lineHeight: 22,
    },
    strengthsWeaknessesRow: {
      flexDirection: "row",
      gap: 10,
    },
    halfCard: {
      flex: 1,
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chipWrap: {
      gap: 6,
    },
    strengthChip: {
      backgroundColor: colors.emeraldWash,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      alignSelf: "flex-start",
    },
    strengthChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.emeraldSuccess,
      fontWeight: "500",
    },
    weaknessChip: {
      backgroundColor: colors.solarGradient,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      alignSelf: "flex-start",
    },
    weaknessChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.solarText,
      fontWeight: "500",
    },
    fillerChip: {
      backgroundColor: colors.cardSubtle,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      alignSelf: "flex-start",
    },
    fillerChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textPrimary,
    },
    emptyNotice: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      color: colors.textMuted,
    },
    goalChipsRow: {
      flexDirection: "row",
      gap: 8,
    },
    goalChip: {
      flex: 1,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardElevated,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    goalChipActive: {
      backgroundColor: colors.primarySoft,
      borderColor: colors.irisBlue,
    },
    goalChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      fontWeight: "500",
    },
    goalChipTextActive: {
      color: colors.irisBlue,
      fontWeight: "600",
    },
    finishBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    finishBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
  });
}

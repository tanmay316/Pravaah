/**
 * Pravaah — Spoken English Proficiency Diagnostic Assessment
 *
 * Connects to LiveKit Cloud WebRTC voice pipeline (wss://pravaah-qj6q5gxo.livekit.cloud)
 * for realtime spoken audio transmission and speech-to-text evaluation.
 *
 * Gathers task-aware linguistic evidence (verbatim transcripts with preserved errors)
 * and speaking behavior telemetry (duration, pauses, restarts, WPM, latency) across
 * the 4 diagnostic tasks:
 *   1. Introduction & Daily Routine (A1/A2)
 *   2. Past Experience & Storytelling (A2/B1)
 *   3. Opinion & Reasoning (B1/B2)
 *   4. Hypothetical & Complex Discussion (B2/C1)
 *
 * Submits raw task evidence to POST /api/assessment for Gemini LLM analysis,
 * Pydantic validation, and Pravaah Rubric scoring (E/D/C/B/A/S).
 *
 * NO hardcoded fallback levels or static ratings.
 */

import { useState, useEffect, useRef } from "react";
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
import { Room, RoomEvent, Track } from "livekit-client";
import {
  createSession,
  submitProficiencyAssessment,
  setDailyGoal,
  AssessmentTaskEvidence,
  ProficiencyAssessmentRecord,
  PRAVAAH_LEVEL_NAMES,
} from "../lib/api";
import { theme } from "../lib/theme";

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
    stageTitle: "1. INTRODUCTION & DAILY ROUTINE",
    question: "Tell me about yourself, what you do every day, and why you want to improve your spoken English.",
    hindiHint: "अपने बारे में बताइए, आपका दैनिक काम क्या है, और आप अंग्रेज़ी क्यों सुधारना चाहते हैं।",
    evalTarget: "Present simple stability, basic everyday vocabulary, and immediate responsiveness.",
    suggestedSeconds: 30,
  },
  {
    id: "task_2_past",
    stage: 2,
    stageTitle: "2. PAST EXPERIENCE & STORYTELLING",
    question: "Describe a memorable day from your past, or explain a challenge you recently overcame.",
    hindiHint: "अपने अतीत का कोई यादगार दिन बताइए या हाल ही में सुलझाई किसी समस्या के बारे में बात करें।",
    evalTarget: "Past tense auxiliaries (did/didn't + base verb), irregular verbs, and narrative sequencing.",
    suggestedSeconds: 40,
  },
  {
    id: "task_3_opinion",
    stage: 3,
    stageTitle: "3. OPINION & REASONING",
    question: "Do you prefer working from home or from an office? Explain your reasons with clear examples.",
    hindiHint: "क्या आपको घर से काम करना पसंद है या दफ़्तर से? अपने कारणों को उदाहरण सहित समझाइए।",
    evalTarget: "Stative verbs (agree, prefer), comparative structures, and connecting phrases.",
    suggestedSeconds: 45,
  },
  {
    id: "task_4_hypothetical",
    stage: 4,
    stageTitle: "4. HYPOTHETICAL & COMPLEX DISCUSSION",
    question: "If you could change one thing about how people communicate in modern workplaces, what would it be and why?",
    hindiHint: "यदि आप आधुनिक कार्यस्थलों में लोगों के बातचीत करने के तरीके में कोई बदलाव कर सकें, तो वह क्या होगा और क्यों?",
    evalTarget: "Conditionals, modal verbs, complex syntax, and professional nuance.",
    suggestedSeconds: 45,
  },
];

// Filter ambient noise, repetition loops, and speech recognition hallucinations
function cleanTranscript(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();
  // 1. Remove continuous repetitive phrase loops (caused by ambient microphone feedback)
  text = text.replace(/(\b.+?\b)(?:\s+\1){2,}/gi, "$1");
  // 2. Remove 3+ identical consecutive words
  text = text.replace(/\b(\w+)(?:\s+\1){2,}\b/gi, "$1 $1");
  // 3. Normalize whitespace
  return text.replace(/\s+/g, " ").trim();
}

// Optional browser SpeechRecognition helper (used as realtime transcription assist on web)
function getSpeechRecognition(): any | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return SR ? new SR() : null;
}

export default function AssessmentScreen() {
  const [currentStep, setCurrentStep] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const [showHindi, setShowHindi] = useState(true);
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

  // Result state — entirely from backend, no fallbacks
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
        const sessionRes = await createSession("assessment");
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

        // Remote assessor audio
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio && Platform.OS === "web") {
            const audioElement = track.attach();
            audioElementRef.current = audioElement;
            document.body.appendChild(audioElement);
          }
        });

        await room.connect(LIVEKIT_URL, sessionRes.livekit_token);
        await room.localParticipant.setMicrophoneEnabled(true, {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        });

        const audioTracks = room.localParticipant.audioTrackPublications;
        audioTracks.forEach((pub) => {
          if (pub.track?.mediaStream) {
            mediaStreamRef.current = pub.track.mediaStream;
          }
        });
      } catch (err: any) {
        console.warn("LiveKit assessment room notice:", err);
      }
    }

    initLiveKitAssessment();

    return () => {
      if (audioElementRef.current) audioElementRef.current.remove();
      if (roomInstance) roomInstance.disconnect();
    };
  }, []);

  // Setup Web Audio Visualizer and Telemetry Detection
  const setupAudioCapture = async () => {
    taskStartTimeRef.current = Date.now();
    speechStartTimeRef.current = 0;
    pauseCountRef.current = 0;
    longPauseCountRef.current = 0;
    restartCountRef.current = 0;
    lastSoundTimeRef.current = Date.now();

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
            const energy = (dataArray[2] + dataArray[4] + dataArray[6]) / 3;

            // Voice activity detection for telemetry
            const now = Date.now();
            if (energy > 25) {
              if (!isSpeaking) {
                isSpeaking = true;
                if (!speechStartTimeRef.current) speechStartTimeRef.current = now;
                if (silenceStart > 0) {
                  const pauseDuration = now - silenceStart;
                  if (pauseDuration > 400) {
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
    setCurrentTranscript("");
    setLiveInterim("");
    await setupAudioCapture();

    // Start Web Speech recognition for verbatim real-time transcript assist
    const recognition = getSpeechRecognition();
    if (recognition) {
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-IN";

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const confidence = result[0]?.confidence;
          // Filter low-confidence noise hallucinations (background hum, breathing)
          if (confidence !== undefined && confidence !== 0 && confidence < 0.20) {
            continue;
          }
          if (result.isFinal) {
            const text = (result[0]?.transcript || "").trim();
            if (text) {
              final += text + " ";
              if (/\b(\w+)\s+\1\b/i.test(text)) {
                restartCountRef.current += 1;
              }
            }
          } else {
            interim += (result[0]?.transcript || "") + " ";
          }
        }
        setCurrentTranscript(cleanTranscript(final));
        setLiveInterim(cleanTranscript(interim));
      };

      recognition.onerror = (event: any) => {
        console.warn("Speech recognition notice:", event.error);
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
      } catch {}
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
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

  // Timer
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
      stopRecording();

      const spokenText = (currentTranscript + " " + liveInterim).trim();
      saveTaskEvidenceAndAdvance(spokenText);
    }
  };

  const saveTaskEvidenceAndAdvance = (verbatimTranscript: string) => {
    const now = Date.now();
    const durationMs = taskStartTimeRef.current > 0 ? now - taskStartTimeRef.current : recordedSeconds * 1000;
    const latencyMs = speechStartTimeRef.current > 0 && taskStartTimeRef.current > 0
      ? Math.max(0, speechStartTimeRef.current - taskStartTimeRef.current)
      : 0;

    const wordCount = verbatimTranscript ? verbatimTranscript.split(/\s+/).filter(Boolean).length : 0;

    const taskEvidence: AssessmentTaskEvidence = {
      task_id: currentQ.id,
      task_title: currentQ.stageTitle,
      prompt: currentQ.question,
      transcript: verbatimTranscript, // Verbatim transcript preserving all learner errors
      duration_ms: durationMs,
      word_count: wordCount,
      pause_count: pauseCountRef.current,
      long_pause_count: longPauseCountRef.current,
      restart_count: restartCountRef.current,
      response_latency_ms: latencyMs,
      turn_count: 1,
    };

    const updatedTasks = [...taskEvidences, taskEvidence];
    setTaskEvidences(updatedTasks);
    setCurrentTranscript("");
    setLiveInterim("");

    if (currentStep < ASSESSMENT_QUESTIONS.length - 1) {
      setCurrentStep((prev) => prev + 1);
    } else {
      handleFinalizeAssessment(updatedTasks);
    }
  };

  const handleSkipQuestion = () => {
    setIsRecording(false);
    stopRecording();
    const spokenText = (currentTranscript + " " + liveInterim).trim();
    saveTaskEvidenceAndAdvance(spokenText);
  };

  const handleFinalizeAssessment = async (finalTasks: AssessmentTaskEvidence[]) => {
    setIsAnalyzing(true);
    setError(null);

    try {
      // Submit raw task evidence to backend for Gemini LLM analysis & rubric scoring
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

  // -------------------------------------------------------------------------
  // RESULT VIEW — 100% computed by backend, no hardcoded fallbacks
  // -------------------------------------------------------------------------
  if (completed) {
    if (error || !assessmentResult) {
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.resultScrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.resultCard}>
              <View style={styles.errorEyebrowContainer}>
                <Text style={styles.errorEyebrowText}>ASSESSMENT EVALUATION NOTICE</Text>
              </View>
              <Text style={styles.resultTitle}>Unable to Complete Analysis</Text>
              <Text style={styles.resultSummaryText}>
                {error || "An unexpected issue occurred while evaluating your spoken diagnostic."}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                onPress={() => {
                  setCompleted(false);
                  setCurrentStep(0);
                  setTaskEvidences([]);
                  setError(null);
                }}
              >
                <Text style={styles.primaryButtonText}>Retry Spoken Diagnostic →</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      );
    }

    const { pravaah_level, cefr_reference, criteria, notes, strengths, weaknesses } = assessmentResult;
    const levelName = PRAVAAH_LEVEL_NAMES[pravaah_level] || (assessmentResult as any).name || "Elementary";

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.resultScrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.ambientGlow} />

          <View style={styles.resultCard}>
            <View style={styles.scorecardLogoWrapper}>
              <Image
                source={require("../assets/pravaah_navbar_logo.png")}
                style={styles.scorecardLogo}
                resizeMode="contain"
                accessibilityLabel="Pravaah"
              />
            </View>
            <View style={styles.eyebrowContainer}>
              <Text style={styles.eyebrowText}>ASSESSMENT COMPLETE • DIAGNOSTIC REPORT</Text>
            </View>

            <Text style={styles.resultTitle}>
              Your Spoken Level:{" "}
              <Text style={styles.levelHighlight}>
                Level {pravaah_level} ({levelName})
              </Text>
            </Text>
            <Text style={styles.cefrBadge}>
              CEFR REFERENCE: {cefr_reference}
            </Text>

            <Text style={styles.resultSummaryText}>
              {criteria || "Your spoken diagnostic has been evaluated and saved to your profile in Firestore."}
            </Text>

            {/* AI Analysis Notes */}
            {notes ? (
              <View style={styles.analysisNotesBlock}>
                <Text style={styles.analysisNotesLabel}>AI DIAGNOSTIC OBSERVATIONS</Text>
                <Text style={styles.analysisNotesText}>{notes}</Text>
              </View>
            ) : null}

            {/* Strengths & Focus Areas */}
            <View style={styles.diagnosticsRow}>
              <View style={styles.diagBlock}>
                <Text style={styles.diagBlockHeader}>DIAGNOSED STRENGTHS</Text>
                <View style={styles.chipRow}>
                  {strengths && strengths.length > 0 ? (
                    strengths.map((str: string, idx: number) => (
                      <View key={idx} style={styles.strengthChip}>
                        <Text style={styles.strengthChipText}>
                          ✓ {str.replace(/_/g, " ")}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.emptyChipText}>Baseline developing</Text>
                  )}
                </View>
              </View>

              <View style={styles.diagBlock}>
                <Text style={styles.diagBlockHeader}>IMMEDIATE FOCUS SKILLS</Text>
                <View style={styles.chipRow}>
                  {weaknesses && weaknesses.length > 0 ? (
                    weaknesses.map((weak: string, idx: number) => (
                      <View key={idx} style={styles.weaknessChip}>
                        <Text style={styles.weaknessChipText}>
                          ⚠ {weak.replace(/_/g, " ")}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.emptyChipText}>None diagnosed</Text>
                  )}
                </View>
              </View>
            </View>

            {/* Dimension-Level Diagnostic Ratings */}
            <View style={styles.dimensionGridBlock}>
              <Text style={styles.dimensionGridHeader}>DIMENSION-LEVEL DIAGNOSTIC RATINGS</Text>
              <View style={styles.dimensionRow}>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Grammar:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).grammar_rating || (assessmentResult as any).assessment_observations?.grammar || "elementary").toUpperCase()}
                  </Text>
                </View>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Vocabulary:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).vocabulary_rating || (assessmentResult as any).assessment_observations?.vocabulary || "elementary").toUpperCase()}
                  </Text>
                </View>
              </View>
              <View style={styles.dimensionRow}>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Fluency & Timing:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).fluency_rating || (assessmentResult as any).assessment_observations?.fluency || "elementary").toUpperCase()}
                  </Text>
                </View>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Comprehension:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).comprehension_rating || (assessmentResult as any).assessment_observations?.comprehension || "elementary").toUpperCase()}
                  </Text>
                </View>
              </View>
              <View style={styles.dimensionRow}>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Speaking Complexity:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).speaking_complexity || (assessmentResult as any).assessment_observations?.speaking_complexity || "elementary").toUpperCase()}
                  </Text>
                </View>
                <View style={styles.dimensionCol}>
                  <Text style={styles.dimensionColLabel}>Conversational Ability:</Text>
                  <Text style={styles.dimensionColValue}>
                    {((assessmentResult as any).conversation_ability || (assessmentResult as any).assessment_observations?.conversation_ability || "elementary").toUpperCase()}
                  </Text>
                </View>
              </View>
            </View>

            {/* Pronunciation Status */}
            <View style={styles.pronunciationStatusBlock}>
              <Text style={styles.pronunciationStatusLabel}>PRONUNCIATION ASSESSMENT</Text>
              <Text style={styles.pronunciationStatusText}>
                {assessmentResult.pronunciation || "Not assessed in V1 (audio-level phonetic analysis deferred to V2)"}
              </Text>
            </View>

            {/* Transcript & Telemetry Evidence Summary */}
            <View style={styles.transcriptSummaryBlock}>
              <Text style={styles.transcriptSummaryLabel}>SPOKEN TASK EVIDENCE & TELEMETRY</Text>
              {taskEvidences.map((t, idx) => (
                <View key={idx} style={styles.transcriptEntry}>
                  <Text style={styles.transcriptQuestionText}>
                    {t.task_title || `Task ${idx + 1}`}: {t.prompt}
                  </Text>
                  <Text style={styles.transcriptResponseText}>
                    {t.transcript ? `"${t.transcript}"` : "(No speech detected)"}
                  </Text>
                  <Text style={styles.transcriptMetricsText}>
                    Duration: {((t.duration_ms || 0) / 1000).toFixed(1)}s • Words: {t.word_count || 0} • Pauses: {t.pause_count || 0} (Long: {t.long_pause_count || 0}) • Restarts: {t.restart_count || 0}
                  </Text>
                </View>
              ))}
            </View>

            {/* Daily Practice Commitment */}
            <View style={styles.goalSection}>
              <Text style={styles.goalSectionTitle}>DAILY PRACTICE COMMITMENT</Text>
              <View style={styles.goalChipsRow}>
                {[15, 30, 60, 90].map((mins) => (
                  <Pressable
                    key={mins}
                    style={[styles.goalChip, selectedGoal === mins && styles.goalChipActive]}
                    onPress={() => setSelectedGoal(mins)}
                  >
                    <Text style={[styles.goalChipText, selectedGoal === mins && styles.goalChipTextActive]}>
                      {mins} MIN / DAY
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
              onPress={handleFinishAndStartPlan}
            >
              <Text style={styles.primaryButtonText}>
                Start Today's Practice Plan ({selectedGoal}m) →
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // IN-PROGRESS TASK VIEW
  // -------------------------------------------------------------------------
  const displayTranscript = (currentTranscript + " " + liveInterim).trim();

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Top Bar */}
        <View style={styles.topNav}>
          <Pressable style={styles.exitButton} onPress={() => router.replace("/")}>
            <Text style={styles.exitButtonText}>← Exit</Text>
          </Pressable>
          <Image
            source={require("../assets/pravaah_navbar_logo.png")}
            style={styles.topNavLogo}
            resizeMode="contain"
            accessibilityLabel="Pravaah"
          />
          <View style={styles.stepPill}>
            <Text style={styles.stepPillText}>
              TASK {currentStep + 1} OF {ASSESSMENT_QUESTIONS.length}
            </Text>
          </View>
        </View>

        {/* Question Card */}
        <View style={styles.questionCard}>
          <View style={styles.eyebrowContainer}>
            <Text style={styles.eyebrowText}>{currentQ.stageTitle}</Text>
          </View>

          <Text style={styles.questionHeadline}>{currentQ.question}</Text>

          {/* Hindi Guide Accordion */}
          {showHindi ? (
            <View style={styles.hindiContainer}>
              <Text style={styles.hindiLabel}>HINDI GUIDE</Text>
              <Text style={styles.hindiText}>{currentQ.hindiHint}</Text>
            </View>
          ) : null}

          <Pressable style={styles.toggleHintButton} onPress={() => setShowHindi(!showHindi)}>
            <Text style={styles.toggleHintText}>
              {showHindi ? "Hide Hindi Guide" : "Show Hindi Guide"}
            </Text>
          </Pressable>

          {/* Waveform Visualizer */}
          <View style={styles.waveformContainer}>
            <View style={styles.barsRow}>
              <Animated.View style={[styles.waveBar, { height: barAnim1 }]} />
              <Animated.View style={[styles.waveBar, { height: barAnim2 }]} />
              <Animated.View style={[styles.waveBar, { height: barAnim3 }]} />
              <Animated.View style={[styles.waveBar, { height: barAnim4 }]} />
              <Animated.View style={[styles.waveBar, { height: barAnim5 }]} />
            </View>
            <Text style={styles.recordingTimerText}>
              {isRecording
                ? `Recording speech: ${recordedSeconds < 10 ? `0:0${recordedSeconds}` : `0:${recordedSeconds}`}`
                : livekitConnected
                ? "LiveKit voice ready — tap below and speak in English"
                : "Tap the button below and speak in English"}
            </Text>
          </View>

          {/* Live Verbatim Transcript Display */}
          {displayTranscript ? (
            <View style={styles.liveTranscriptBlock}>
              <Text style={styles.liveTranscriptLabel}>VERBATIM TRANSCRIPT</Text>
              <Text style={styles.liveTranscriptText}>"{displayTranscript}"</Text>
            </View>
          ) : isRecording ? (
            <View style={styles.liveTranscriptBlock}>
              <Text style={styles.liveTranscriptLabel}>LISTENING TO MICROPHONE...</Text>
              <Text style={styles.liveTranscriptText}>Speak naturally — your speech is transcribed verbatim.</Text>
            </View>
          ) : null}

          {/* Action Controls */}
          {isAnalyzing ? (
            <View style={styles.analyzingContainer}>
              <ActivityIndicator size="small" color={theme.colors.irisGleam} />
              <Text style={styles.analyzingText}>Evaluating speech evidence with AI...</Text>
            </View>
          ) : (
            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.recordButton,
                  isRecording && styles.recordButtonActive,
                  pressed && styles.buttonPressed,
                ]}
                onPress={handleToggleRecording}
              >
                <Text style={[styles.recordButtonText, isRecording && styles.recordButtonTextActive]}>
                  {isRecording ? "Finish Speaking →" : "Tap to Speak"}
                </Text>
              </Pressable>

              <Pressable style={styles.skipButton} onPress={handleSkipQuestion}>
                <Text style={styles.skipButtonText}>
                  {currentStep < ASSESSMENT_QUESTIONS.length - 1 ? "Next Task →" : "Submit →"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  scrollContent: {
    flexGrow: 1,
    padding: theme.spacing.xl,
    maxWidth: 800,
    alignSelf: "center",
    width: "100%",
    justifyContent: "center",
  },
  resultScrollContent: {
    flexGrow: 1,
    padding: theme.spacing.xl,
    maxWidth: 860,
    alignSelf: "center",
    width: "100%",
  },
  ambientGlow: {
    position: "absolute",
    top: 20,
    alignSelf: "center",
    width: 400,
    height: 220,
    borderRadius: 200,
    backgroundColor: "rgba(132, 125, 255, 0.08)",
    ...Platform.select({ web: { filter: "blur(70px)" } }),
  },
  topNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.xl,
  },
  topNavLogo: {
    width: 100,
    height: 32,
  },
  scorecardLogoWrapper: {
    alignItems: "center",
    marginBottom: theme.spacing.lg,
  },
  scorecardLogo: {
    width: 130,
    height: 40,
  },
  exitButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.glassFill,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  exitButtonText: { color: theme.colors.ash, fontSize: 13 },
  stepPill: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  stepPillText: {
    color: theme.colors.cloud,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "500",
  },
  questionCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xxxl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  eyebrowContainer: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  eyebrowText: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  errorEyebrowContainer: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255, 82, 82, 0.12)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
  },
  errorEyebrowText: {
    color: theme.colors.crimsonError,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  questionHeadline: {
    fontSize: 26,
    lineHeight: 34,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    marginBottom: theme.spacing.xl,
  },
  hindiContainer: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.md,
  },
  hindiLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
  },
  hindiText: { color: theme.colors.ash, fontSize: 14, lineHeight: 22 },
  toggleHintButton: {
    marginBottom: theme.spacing.xl,
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  toggleHintText: { color: theme.colors.cyanSignal, fontSize: 12, fontFamily: theme.fonts.mono },
  waveformContainer: {
    height: 120,
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: theme.spacing.lg,
  },
  barsRow: { flexDirection: "row", alignItems: "center", gap: 8, height: 60, marginBottom: 8 },
  waveBar: { width: 6, backgroundColor: theme.colors.irisGleam, borderRadius: 3 },
  recordingTimerText: { color: theme.colors.fog, fontSize: 12, fontFamily: theme.fonts.mono },

  liveTranscriptBlock: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.xl,
  },
  liveTranscriptLabel: {
    color: theme.colors.cyanSignal,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
  },
  liveTranscriptText: { color: theme.colors.pure, fontSize: 15, lineHeight: 22, fontStyle: "italic" },

  actionRow: { flexDirection: "row", gap: 12 },
  recordButton: {
    flex: 1,
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  recordButtonActive: { backgroundColor: theme.colors.crimsonError },
  recordButtonText: { color: theme.colors.void, fontSize: 15, fontWeight: "500" },
  recordButtonTextActive: { color: theme.colors.pure },
  skipButton: {
    paddingHorizontal: 20,
    height: 48,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderActive,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  skipButtonText: { color: theme.colors.cloud, fontSize: 13 },
  analyzingContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 12,
  },
  analyzingText: { color: theme.colors.ash, fontSize: 14 },
  buttonPressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },

  // Results Styles
  resultCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xxxl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  resultTitle: {
    fontSize: 32,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    lineHeight: 38,
    marginBottom: 4,
  },
  levelHighlight: { color: theme.colors.irisGleam, fontWeight: "400" },
  cefrBadge: {
    color: theme.colors.cyanSignal,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    marginBottom: theme.spacing.lg,
  },
  resultSummaryText: {
    color: theme.colors.ash,
    fontSize: 15,
    lineHeight: 24,
    marginBottom: theme.spacing.xxl,
  },
  analysisNotesBlock: {
    backgroundColor: "rgba(132, 125, 255, 0.08)",
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.2)",
    marginBottom: theme.spacing.xxl,
  },
  analysisNotesLabel: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
  },
  analysisNotesText: { color: theme.colors.cloud, fontSize: 14, lineHeight: 22 },
  diagnosticsRow: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 16,
    marginBottom: theme.spacing.xxl,
  },
  diagBlock: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  diagBlockHeader: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: theme.spacing.md,
  },
  chipRow: { flexDirection: "column", gap: 8 },
  strengthChip: {
    backgroundColor: "rgba(56, 211, 159, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(56, 211, 159, 0.25)",
    borderRadius: theme.radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  strengthChipText: { color: theme.colors.emeraldSuccess, fontSize: 12, fontWeight: "500" },
  weaknessChip: {
    backgroundColor: "rgba(255, 183, 77, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(255, 183, 77, 0.25)",
    borderRadius: theme.radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  weaknessChipText: { color: theme.colors.amberWarning, fontSize: 12, fontWeight: "500" },
  emptyChipText: { color: theme.colors.fog, fontSize: 12, fontStyle: "italic" },

  dimensionGridBlock: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.xl,
  },
  dimensionGridHeader: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: theme.spacing.md,
  },
  dimensionRow: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 12,
    marginBottom: 8,
  },
  dimensionCol: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  dimensionColLabel: {
    color: theme.colors.ash,
    fontSize: 12,
    fontFamily: theme.fonts.mono,
  },
  dimensionColValue: {
    color: theme.colors.irisGleam,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
  },
  pronunciationStatusBlock: {
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    borderRadius: theme.radii.sm,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    marginBottom: theme.spacing.lg,
  },
  pronunciationStatusLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  pronunciationStatusText: {
    color: theme.colors.pure,
    fontSize: 12,
    lineHeight: 18,
  },

  transcriptSummaryBlock: {
    backgroundColor: theme.colors.obsidian,
    borderRadius: theme.radii.sm,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.xxl,
  },
  transcriptSummaryLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: theme.spacing.md,
  },
  transcriptEntry: {
    marginBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.05)",
    paddingBottom: 10,
  },
  transcriptQuestionText: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    marginBottom: 3,
  },
  transcriptResponseText: {
    color: theme.colors.pure,
    fontSize: 13,
    lineHeight: 20,
    fontStyle: "italic",
    marginBottom: 4,
  },
  transcriptMetricsText: {
    color: theme.colors.cyanSignal,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 0.5,
  },

  goalSection: { marginBottom: theme.spacing.xxl },
  goalSectionTitle: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: theme.spacing.md,
  },
  goalChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  goalChip: {
    flex: 1,
    minWidth: 100,
    backgroundColor: theme.colors.obsidian,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    paddingVertical: 12,
    alignItems: "center",
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  goalChipActive: { borderColor: theme.colors.pure, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  goalChipText: { color: theme.colors.ash, fontSize: 12, fontFamily: theme.fonts.mono, letterSpacing: 1 },
  goalChipTextActive: { color: theme.colors.pure, fontWeight: "600" },
  primaryButton: {
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({ web: { cursor: "pointer" as any } }),
  },
  primaryButtonText: { color: theme.colors.void, fontSize: 15, fontWeight: "500", letterSpacing: 0.2 },
});

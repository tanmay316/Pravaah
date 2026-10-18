/**
 * Free lesson player: rule card, then multiple choice, translation, word order and listening
 * exercises. Missed exercises come back once at the end. Runs entirely on the device.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { completePracticeLesson, getPractice, type PracticeProgress } from "../../lib/api";
import { findLesson, type Exercise } from "../../lib/course";
import { speakOnDevice, stopDeviceSpeech } from "../../lib/deviceSpeech";
import { theme, useTheme, type ThemeColors } from "../../lib/theme";

type Stage = "intro" | "practice" | "saving" | "done";

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]/g, "").replace(/\s+/g, " ").trim();

export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lesson = findLesson(String(id || ""));
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>("intro");
  const [queue, setQueue] = useState<number[]>(() => (lesson ? lesson.exercises.map((_, i) => i) : []));
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [built, setBuilt] = useState<{ word: string; key: string }[]>([]);
  const [checked, setChecked] = useState<null | boolean>(null);
  const firstTry = useRef<Record<number, boolean>>({});
  const [result, setResult] = useState<{ correct: number; total: number; xp: number; stars: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const progressBefore = useRef<number | null>(null);

  const exerciseIndex = queue[position];
  const exercise: Exercise | undefined = lesson?.exercises[exerciseIndex];

  const wordBank = useMemo(() => {
    if (!exercise || exercise.type !== "order") return [];
    return shuffle([...exercise.answer.split(" "), ...(exercise.extra || [])]).map((word, i) => ({ word, key: `${i}-${word}` }));
  }, [exercise, position]);

  useEffect(() => {
    if (stage === "practice" && exercise?.type === "listen") speakOnDevice(exercise.audio);
  }, [stage, position]);

  useEffect(() => {
    getPractice()
      .then((progress) => (progressBefore.current = progress.xp_total))
      .catch(() => {});
    return () => {
      stopDeviceSpeech();
    };
  }, []);

  if (!lesson) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.title}>Lesson not found</Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.replace("/")}>
          <Text style={styles.primaryBtnText}>Back to home</Text>
        </Pressable>
      </View>
    );
  }

  const total = lesson.exercises.length;
  const canCheck = exercise?.type === "order" ? built.length > 0 : selected !== null;

  const check = () => {
    if (!exercise || checked !== null) return;
    const correct =
      exercise.type === "order"
        ? normalize(built.map((b) => b.word).join(" ")) === normalize(exercise.answer)
        : selected === exercise.answer;
    if (!(exerciseIndex in firstTry.current)) {
      firstTry.current[exerciseIndex] = correct;
      if (!correct) setQueue((prev) => [...prev, exerciseIndex]);
    }
    setChecked(correct);
  };

  const finish = async () => {
    const correct = Object.values(firstTry.current).filter(Boolean).length;
    setStage("saving");
    setSaveError(null);
    try {
      const progress: PracticeProgress = await completePracticeLesson(lesson.id, correct, total);
      const xp = progressBefore.current === null ? 0 : progress.xp_total - progressBefore.current;
      setResult({ correct, total, xp: Math.max(xp, 0), stars: progress.lessons[lesson.id]?.stars ?? 1 });
      setStage("done");
    } catch (err: any) {
      setSaveError(err?.message || "Could not save your progress.");
      setStage("practice");
    }
  };

  const next = () => {
    if (position + 1 >= queue.length) {
      finish();
      return;
    }
    stopDeviceSpeech();
    setPosition((p) => p + 1);
    setSelected(null);
    setBuilt([]);
    setChecked(null);
  };

  // ---------------------------------------------------------------- intro
  if (stage === "intro") {
    return (
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
        <View style={styles.topBar}>
          <Pressable style={styles.iconBtn} onPress={() => router.back()} accessibilityLabel="Close lesson">
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>{lesson.description}</Text>
          <Text style={styles.title}>{lesson.title}</Text>
          <View style={styles.tipCard}>
            <Text style={styles.tipTitle}>{lesson.tip.title}</Text>
            <Text style={styles.tipText}>{lesson.tip.english}</Text>
            <View style={styles.hindiBox}>
              <Text style={styles.hindiLabel}>हिंदी में</Text>
              <Text style={styles.hindiText}>{lesson.tip.hindi}</Text>
            </View>
            {lesson.tip.examples.map((example) => (
              <Pressable key={example} style={styles.exampleRow} onPress={() => speakOnDevice(example)}>
                <Ionicons name="volume-medium-outline" size={18} color={colors.irisBlue} />
                <Text style={styles.exampleText}>{example}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.meta}>{total} exercises · about 3 minutes</Text>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            onPress={() => setStage("practice")}
          >
            <Text style={styles.primaryBtnText}>Start lesson</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------- done
  if (stage === "done" && result) {
    const accuracy = Math.round((result.correct / result.total) * 100);
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <View style={styles.doneIcon}>
          <Ionicons name="trophy-outline" size={36} color={colors.irisBlue} />
        </View>
        <Text style={styles.title}>Lesson complete</Text>
        <Text style={styles.subtitle}>{lesson.title}</Text>
        <View style={styles.starRow}>
          {[1, 2, 3].map((n) => (
            <Ionicons key={n} name={n <= result.stars ? "star" : "star-outline"} size={28} color={colors.amberWarning} />
          ))}
        </View>
        <View style={styles.resultRow}>
          <View style={styles.resultTile}>
            <Text style={styles.resultValue}>+{result.xp}</Text>
            <Text style={styles.resultLabel}>XP earned</Text>
          </View>
          <View style={styles.resultTile}>
            <Text style={styles.resultValue}>{accuracy}%</Text>
            <Text style={styles.resultLabel}>Accuracy</Text>
          </View>
        </View>
        <View style={styles.doneActions}>
          <Pressable style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]} onPress={() => router.back()}>
            <Text style={styles.primaryBtnText}>Continue</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------- practice
  const progressPct = Math.min(100, (position / queue.length) * 100);
  const isRetry = position >= total;

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
      <View style={styles.topBar}>
        <Pressable style={styles.iconBtn} onPress={() => router.back()} accessibilityLabel="Close lesson">
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {isRetry ? <Text style={styles.retryNote}>Let's try this one again</Text> : null}
        {exercise ? <Text style={styles.prompt}>{exercise.prompt}</Text> : null}

        {exercise?.type === "choice" && exercise.sentence ? (
          <Text style={styles.sentence}>{exercise.sentence}</Text>
        ) : null}
        {exercise?.type === "translate" ? <Text style={styles.hindiPrompt}>{exercise.hindi}</Text> : null}
        {exercise?.type === "order" && exercise.hindi ? <Text style={styles.hindiPrompt}>{exercise.hindi}</Text> : null}
        {exercise?.type === "listen" ? (
          <View style={styles.listenRow}>
            <Pressable style={styles.speakBtn} onPress={() => speakOnDevice(exercise.audio)} accessibilityLabel="Play audio">
              <Ionicons name="volume-high" size={28} color="#ffffff" />
            </Pressable>
            <Pressable style={styles.slowBtn} onPress={() => speakOnDevice(exercise.audio, 0.65)} accessibilityLabel="Play slowly">
              <Ionicons name="speedometer-outline" size={18} color={colors.irisBlue} />
              <Text style={styles.slowText}>Slower</Text>
            </Pressable>
          </View>
        ) : null}

        {exercise && exercise.type !== "order" ? (
          <View style={styles.options}>
            {exercise.options.map((option, i) => {
              const isSelected = selected === i;
              const showCorrect = checked !== null && i === exercise.answer;
              const showWrong = checked === false && isSelected;
              return (
                <Pressable
                  key={option}
                  style={[
                    styles.option,
                    isSelected && styles.optionSelected,
                    showCorrect && styles.optionCorrect,
                    showWrong && styles.optionWrong,
                  ]}
                  onPress={() => checked === null && setSelected(i)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={styles.optionText}>{option}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {exercise?.type === "order" ? (
          <>
            <View style={styles.answerLine}>
              {built.length === 0 ? <Text style={styles.answerPlaceholder}>Tap the words below</Text> : null}
              {built.map((tile, i) => (
                <Pressable
                  key={tile.key}
                  style={styles.tile}
                  onPress={() => checked === null && setBuilt((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Text style={styles.tileText}>{tile.word}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.bank}>
              {wordBank.map((tile) => {
                const isUsed = built.some((b) => b.key === tile.key);
                return (
                  <Pressable
                    key={tile.key}
                    style={[styles.tile, isUsed && styles.tileUsed]}
                    disabled={isUsed || checked !== null}
                    onPress={() => setBuilt((prev) => [...prev, tile])}
                  >
                    <Text style={[styles.tileText, isUsed && styles.tileTextUsed]}>{tile.word}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}

        {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
      </ScrollView>

      <View
        style={[
          styles.footer,
          checked === true && styles.footerCorrect,
          checked === false && styles.footerWrong,
          { paddingBottom: Math.max(insets.bottom + 12, 20) },
        ]}
      >
        {checked !== null && exercise ? (
          <View style={styles.feedback}>
            <View style={styles.feedbackHeader}>
              <Ionicons
                name={checked ? "checkmark-circle" : "close-circle"}
                size={22}
                color={checked ? colors.emeraldSuccess : colors.crimsonError}
              />
              <Text style={[styles.feedbackTitle, { color: checked ? colors.emeraldSuccess : colors.crimsonError }]}>
                {checked ? "Correct" : "Not quite"}
              </Text>
            </View>
            {!checked && exercise.type === "order" ? (
              <Text style={styles.feedbackAnswer}>Answer: {exercise.answer}</Text>
            ) : null}
            <Text style={styles.feedbackText}>{exercise.explanation}</Text>
          </View>
        ) : null}
        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            checked === false && styles.primaryBtnWrong,
            !canCheck && checked === null && styles.disabled,
            pressed && styles.pressed,
          ]}
          disabled={stage === "saving" || (!canCheck && checked === null)}
          onPress={checked === null ? check : saveError ? finish : next}
        >
          {stage === "saving" ? (
            <ActivityIndicator color={colors.textOnPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>{checked === null ? "Check" : saveError ? "Try saving again" : "Continue"}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.canvas },
    center: { alignItems: "center", justifyContent: "center", padding: 24 },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingBottom: 8,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    iconBtn: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    progressTrack: { flex: 1, height: 10, borderRadius: 999, backgroundColor: colors.cardSubtle, overflow: "hidden" },
    progressFill: { height: "100%", borderRadius: 999, backgroundColor: colors.irisBlue },
    content: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 24,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    eyebrow: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.irisBlue, marginBottom: 6 },
    title: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      letterSpacing: -0.5,
      color: colors.textPrimary,
      marginBottom: 16,
      textAlign: "left",
    },
    subtitle: { fontFamily: theme.fonts.sans, fontSize: 15, color: colors.textSecondary, marginTop: -8, marginBottom: 16 },
    tipCard: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 10,
    },
    tipTitle: { fontFamily: theme.fonts.sans, fontSize: 17, fontWeight: "600", color: colors.textPrimary },
    tipText: { fontFamily: theme.fonts.sans, fontSize: 15, lineHeight: 22, color: colors.textPrimary },
    hindiBox: { backgroundColor: colors.cardSubtle, borderRadius: 12, padding: 12, gap: 4 },
    hindiLabel: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "500", color: colors.textSecondary },
    hindiText: { fontFamily: theme.fonts.sans, fontSize: 15, lineHeight: 23, color: colors.textPrimary },
    exampleRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
    exampleText: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 15, color: colors.textPrimary },
    meta: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 14 },
    retryNote: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.amberWarning, marginBottom: 6 },
    prompt: { fontFamily: theme.fonts.display, fontSize: 20, fontWeight: "600", color: colors.textPrimary, marginBottom: 14 },
    sentence: {
      fontFamily: theme.fonts.sans,
      fontSize: 18,
      lineHeight: 26,
      color: colors.textPrimary,
      backgroundColor: colors.cardSubtle,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16,
    },
    hindiPrompt: {
      fontFamily: theme.fonts.sans,
      fontSize: 18,
      lineHeight: 28,
      color: colors.textPrimary,
      backgroundColor: colors.cardSubtle,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16,
    },
    listenRow: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 },
    speakBtn: {
      width: 64,
      height: 64,
      borderRadius: 18,
      backgroundColor: colors.irisBlue,
      alignItems: "center",
      justifyContent: "center",
    },
    slowBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      height: 40,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    slowText: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "500", color: colors.irisBlue },
    options: { gap: 10 },
    option: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      borderRadius: 14,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    optionSelected: { borderColor: colors.irisBlue, backgroundColor: colors.primarySoft },
    optionCorrect: { borderColor: colors.emeraldSuccess, backgroundColor: colors.emeraldWash },
    optionWrong: { borderColor: colors.crimsonError, backgroundColor: colors.crimsonWash },
    optionText: { fontFamily: theme.fonts.sans, fontSize: 16, lineHeight: 22, color: colors.textPrimary },
    answerLine: {
      minHeight: 64,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingBottom: 12,
      marginBottom: 20,
    },
    answerPlaceholder: { fontFamily: theme.fonts.sans, fontSize: 15, color: colors.textMuted },
    bank: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
    tile: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    tileUsed: { backgroundColor: colors.cardSubtle, borderColor: colors.cardSubtle },
    tileText: { fontFamily: theme.fonts.sans, fontSize: 16, color: colors.textPrimary },
    tileTextUsed: { color: "transparent" },
    errorText: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.crimsonError, marginTop: 16 },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.canvas,
      gap: 12,
    },
    footerCorrect: { backgroundColor: colors.emeraldWash, borderTopColor: colors.emeraldWash },
    footerWrong: { backgroundColor: colors.crimsonWash, borderTopColor: colors.crimsonWash },
    feedback: { gap: 4, maxWidth: theme.mobile.maxContentWidth, width: "100%", alignSelf: "center" },
    feedbackHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    feedbackTitle: { fontFamily: theme.fonts.sans, fontSize: 17, fontWeight: "600" },
    feedbackAnswer: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textPrimary },
    feedbackText: { fontFamily: theme.fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textPrimary },
    primaryBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    primaryBtnWrong: { backgroundColor: colors.crimsonError },
    primaryBtnText: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textOnPrimary },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
    doneIcon: {
      width: 80,
      height: 80,
      borderRadius: 24,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 16,
    },
    starRow: { flexDirection: "row", gap: 6, marginBottom: 20 },
    resultRow: { flexDirection: "row", gap: 12, marginBottom: 28 },
    resultTile: {
      minWidth: 120,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      borderRadius: 16,
      paddingVertical: 14,
      paddingHorizontal: 18,
    },
    resultValue: { fontFamily: theme.fonts.display, fontSize: 24, fontWeight: "600", color: colors.textPrimary },
    resultLabel: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    doneActions: { width: "100%", maxWidth: 360 },
  });
}

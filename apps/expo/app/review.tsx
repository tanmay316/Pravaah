/**
 * Free word review with spaced repetition. Cards you know come back later; cards you miss
 * come back today.
 */

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { getPractice, submitCardReview } from "../lib/api";
import { speakOnDevice, stopDeviceSpeech } from "../lib/deviceSpeech";
import { theme, useTheme, type ThemeColors } from "../lib/theme";
import { buildReviewQueue, type WordCard } from "../lib/wordDeck";

export default function ReviewScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [queue, setQueue] = useState<WordCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState<{ card_id: string; correct: boolean }[]>([]);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<{ known: number; learning: number; xp: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startXp, setStartXp] = useState(0);

  useEffect(() => {
    getPractice()
      .then((progress) => {
        setStartXp(progress.xp_total);
        setQueue(buildReviewQueue(progress.cards, progress.today));
      })
      .catch((err) => {
        setError(err?.message || "Could not load your words.");
        setQueue([]);
      });
    return () => {
      stopDeviceSpeech();
    };
  }, []);

  const submit = async (all: { card_id: string; correct: boolean }[]) => {
    setSaving(true);
    setError(null);
    try {
      const progress = await submitCardReview(all);
      const known = all.filter((a) => a.correct).length;
      setSummary({ known, learning: all.length - known, xp: Math.max(0, progress.xp_total - startXp) });
    } catch (err: any) {
      setError(err?.message || "Could not save your review.");
    } finally {
      setSaving(false);
    }
  };

  const answer = (correct: boolean) => {
    if (!queue) return;
    const next = [...answers, { card_id: queue[index].id, correct }];
    setAnswers(next);
    stopDeviceSpeech();
    if (index + 1 >= queue.length) {
      submit(next);
    } else {
      setIndex(index + 1);
      setRevealed(false);
    }
  };

  const header = (
    <View style={styles.topBar}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()} accessibilityLabel="Close review">
        <Ionicons name="close" size={22} color={colors.textSecondary} />
      </Pressable>
      {queue && queue.length > 0 && !summary ? (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(index / queue.length) * 100}%` }]} />
        </View>
      ) : null}
    </View>
  );

  if (queue === null) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.irisBlue} />
      </View>
    );
  }

  if (summary || queue.length === 0 || saving) {
    return (
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
        {header}
        <View style={styles.centerBody}>
          {saving ? (
            <ActivityIndicator color={colors.irisBlue} />
          ) : (
            <>
              <View style={styles.doneIcon}>
                <Ionicons name={summary ? "checkmark-done" : "sparkles-outline"} size={34} color={colors.irisBlue} />
              </View>
              <Text style={styles.title}>{summary ? "Review complete" : "All caught up"}</Text>
              <Text style={styles.subtitle}>
                {summary
                  ? `${summary.known} known · ${summary.learning} to practise again · +${summary.xp} XP`
                  : error || "No words are due right now. Come back tomorrow for your next review."}
              </Text>
              {error && summary === null && answers.length > 0 ? (
                <Pressable style={styles.primaryBtn} onPress={() => submit(answers)}>
                  <Text style={styles.primaryBtnText}>Try saving again</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.primaryBtn} onPress={() => router.back()}>
                  <Text style={styles.primaryBtnText}>Done</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    );
  }

  const card = queue[index];
  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
      {header}
      <View style={styles.body}>
        <Text style={styles.counter}>
          {index + 1} of {queue.length}
        </Text>
        <Pressable
          style={styles.card}
          onPress={() => setRevealed(true)}
          accessibilityRole="button"
          accessibilityLabel={revealed ? card.term : `${card.term}. Tap to reveal the meaning`}
        >
          <Text style={styles.category}>{card.category}</Text>
          <Text style={styles.term}>{card.term}</Text>
          <Pressable style={styles.speakBtn} onPress={() => speakOnDevice(card.term, 0.85)} hitSlop={8}>
            <Ionicons name="volume-medium-outline" size={20} color={colors.irisBlue} />
          </Pressable>
          {revealed ? (
            <View style={styles.back}>
              <Text style={styles.hindi}>{card.hindi}</Text>
              <Pressable style={styles.exampleRow} onPress={() => speakOnDevice(card.example)}>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.example}>{card.example}</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.reveal}>Tap to see the meaning</Text>
          )}
        </Pressable>
      </View>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
        {revealed ? (
          <View style={styles.answerRow}>
            <Pressable style={[styles.answerBtn, styles.answerBtnSecondary]} onPress={() => answer(false)}>
              <Text style={styles.answerBtnSecondaryText}>Still learning</Text>
            </Pressable>
            <Pressable style={styles.answerBtn} onPress={() => answer(true)}>
              <Text style={styles.primaryBtnText}>I knew it</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.primaryBtn} onPress={() => setRevealed(true)}>
            <Text style={styles.primaryBtnText}>Show meaning</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.canvas },
    center: { alignItems: "center", justifyContent: "center" },
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
    body: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    centerBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 4 },
    counter: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginBottom: 10, textAlign: "center" },
    card: {
      minHeight: 300,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      padding: 24,
      alignItems: "center",
      justifyContent: "center",
    },
    category: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.irisBlue,
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      overflow: "hidden",
      marginBottom: 14,
      textTransform: "capitalize",
    },
    term: {
      fontFamily: theme.fonts.display,
      fontSize: 30,
      fontWeight: "600",
      letterSpacing: -0.5,
      color: colors.textPrimary,
      textAlign: "center",
    },
    speakBtn: {
      marginTop: 12,
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    reveal: { fontFamily: theme.fonts.sans, fontSize: 14, color: colors.textMuted, marginTop: 24 },
    back: { marginTop: 20, alignItems: "center", gap: 12, alignSelf: "stretch" },
    hindi: { fontFamily: theme.fonts.sans, fontSize: 20, lineHeight: 30, fontWeight: "500", color: colors.textPrimary, textAlign: "center" },
    exampleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.cardSubtle,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 14,
      alignSelf: "stretch",
    },
    example: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 15, lineHeight: 21, color: colors.textPrimary },
    title: {
      fontFamily: theme.fonts.display,
      fontSize: 24,
      fontWeight: "600",
      color: colors.textPrimary,
      marginTop: 4,
    },
    subtitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      lineHeight: 22,
      color: colors.textSecondary,
      textAlign: "center",
      marginBottom: 24,
      maxWidth: 320,
    },
    doneIcon: {
      width: 76,
      height: 76,
      borderRadius: 22,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 12,
    },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 14,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    answerRow: { flexDirection: "row", gap: 10 },
    answerBtn: {
      flex: 1,
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    answerBtnSecondary: { backgroundColor: colors.cardElevated, borderWidth: 1, borderColor: colors.border },
    answerBtnSecondaryText: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    primaryBtn: {
      height: 52,
      minWidth: 240,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 20,
    },
    primaryBtnText: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textOnPrimary },
  });
}

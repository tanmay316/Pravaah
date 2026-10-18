/**
 * Learn tab: free course path, daily quests, word review and the AI coach entry point.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Entitlements, PracticeProgress } from "../lib/api";
import { ALL_LESSONS, COURSE, isLessonUnlocked, levelForXp } from "../lib/course";
import { speakOnDevice } from "../lib/deviceSpeech";
import { theme, useTheme, type ThemeColors } from "../lib/theme";
import { dueCount, phraseOfTheDay, WORD_DECK } from "../lib/wordDeck";

interface Props {
  practice: PracticeProgress | null;
  entitlements: Entitlements | null;
  onOpenCoach: () => void;
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

export default function LearnHome({ practice, entitlements, onOpenCoach }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const xpTotal = practice?.xp_total ?? 0;
  const xpToday = practice?.xp_today ?? 0;
  const goal = practice?.daily_xp_goal ?? 30;
  const today = practice?.today ?? new Date().toISOString().slice(0, 10);
  const lessons = practice?.lessons ?? {};
  const cards = practice?.cards ?? {};
  const level = levelForXp(xpTotal);
  const due = dueCount(cards, today);
  const newWords = WORD_DECK.filter((card) => !cards[card.id]).length;
  const phrase = phraseOfTheDay(today);
  const week = practice?.week_xp ?? [];
  const weekMax = Math.max(goal, ...week.map((d) => d.xp));
  const nextLesson = ALL_LESSONS.find((lesson) => !lessons[lesson.id]);

  const quests = [
    { icon: "book-outline", label: "Finish a lesson", value: practice?.lessons_today ?? 0, target: 1 },
    { icon: "flash-outline", label: `Earn ${goal} XP`, value: xpToday, target: goal },
    { icon: "albums-outline", label: "Review 10 words", value: practice?.cards_reviewed_today ?? 0, target: 10 },
  ];
  const questsDone = quests.filter((q) => q.value >= q.target).length;

  const coach = entitlements?.is_premium
    ? { title: "Talk with your AI coach", detail: "Practise speaking and get corrected as you talk.", cta: "Open coach", action: onOpenCoach }
    : entitlements?.demo_available !== false
    ? {
        title: "Try your AI speaking coach",
        detail: "One free 5-minute voice conversation with instant corrections.",
        cta: "Start free demo",
        action: () => router.push("/session"),
      }
    : {
        title: "Unlock your AI speaking coach",
        detail: "Daily voice conversations, corrections and a personal plan.",
        cta: "See Premium",
        action: () => router.push("/premium"),
      };

  return (
    <View style={styles.wrap}>
      {/* Level, daily XP and this week */}
      <View style={styles.card}>
        <View style={styles.levelRow}>
          <View>
            <Text style={styles.levelLabel}>Level {level.level}</Text>
            <Text style={styles.levelSub}>
              {level.needed - level.current} XP to level {level.level + 1}
            </Text>
          </View>
          <View style={styles.xpPill}>
            <Ionicons name="flash" size={14} color={colors.amberWarning} />
            <Text style={styles.xpPillText}>{xpTotal} XP</Text>
          </View>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.min(100, (level.current / level.needed) * 100)}%` }]} />
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>
              {xpToday}
              <Text style={styles.statOf}> / {goal}</Text>
            </Text>
            <Text style={styles.statLabel}>XP today</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{practice?.streak_days ?? 0}</Text>
            <Text style={styles.statLabel}>Day streak</Text>
          </View>
          <View style={[styles.stat, styles.weekStat]}>
            <View style={styles.weekBars}>
              {week.map((day) => {
                const isToday = day.date === today;
                const height = Math.max(4, Math.round((day.xp / weekMax) * 32));
                return (
                  <View key={day.date} style={styles.weekCol}>
                    <View
                      style={[
                        styles.weekBar,
                        { height },
                        day.xp > 0 && styles.weekBarActive,
                        isToday && styles.weekBarToday,
                      ]}
                    />
                    <Text style={[styles.weekDay, isToday && styles.weekDayToday]}>
                      {DAY_LETTERS[new Date(`${day.date}T00:00:00Z`).getUTCDay()]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      </View>

      {/* Continue / next lesson */}
      {nextLesson ? (
        <Pressable
          style={({ pressed }) => [styles.continueCard, pressed && styles.pressed]}
          onPress={() => router.push(`/lesson/${nextLesson.id}`)}
        >
          <View style={styles.continueText}>
            <Text style={styles.continueEyebrow}>{Object.keys(lessons).length ? "Continue learning" : "Start learning"}</Text>
            <Text style={styles.continueTitle}>{nextLesson.title}</Text>
            <Text style={styles.continueDetail}>{nextLesson.description}</Text>
          </View>
          <View style={styles.playCircle}>
            <Ionicons name="play" size={20} color="#ffffff" style={{ marginLeft: 2 }} />
          </View>
        </Pressable>
      ) : null}

      {/* Daily quests */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Daily quests</Text>
          <Text style={styles.cardMeta}>
            {questsDone} of {quests.length} done
          </Text>
        </View>
        {quests.map((quest) => {
          const done = quest.value >= quest.target;
          return (
            <View key={quest.label} style={styles.questRow}>
              <View style={[styles.questIcon, done && styles.questIconDone]}>
                <Ionicons
                  name={(done ? "checkmark" : quest.icon) as any}
                  size={16}
                  color={done ? "#ffffff" : colors.irisBlue}
                />
              </View>
              <View style={styles.questBody}>
                <Text style={styles.questLabel}>{quest.label}</Text>
                <View style={styles.questTrack}>
                  <View
                    style={[
                      styles.questFill,
                      done && styles.questFillDone,
                      { width: `${Math.min(100, (quest.value / quest.target) * 100)}%` },
                    ]}
                  />
                </View>
              </View>
              <Text style={styles.questCount}>
                {Math.min(quest.value, quest.target)}/{quest.target}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Word review */}
      <Pressable style={({ pressed }) => [styles.card, styles.reviewCard, pressed && styles.pressed]} onPress={() => router.push("/review")}>
        <View style={styles.reviewIcon}>
          <Ionicons name="albums-outline" size={22} color={colors.irisBlue} />
        </View>
        <View style={styles.reviewText}>
          <Text style={styles.cardTitle}>Word review</Text>
          <Text style={styles.cardMeta}>
            {due > 0 ? `${due} word${due === 1 ? "" : "s"} due today` : newWords > 0 ? `${newWords} new words to learn` : "All caught up"}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.fog} />
      </Pressable>

      {/* Phrase of the day */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Phrase of the day</Text>
          <Pressable onPress={() => speakOnDevice(phrase.example)} hitSlop={8} accessibilityLabel="Listen">
            <Ionicons name="volume-medium-outline" size={20} color={colors.irisBlue} />
          </Pressable>
        </View>
        <Text style={styles.phrase}>{phrase.term}</Text>
        <Text style={styles.phraseHindi}>{phrase.hindi}</Text>
        <Text style={styles.phraseExample}>{phrase.example}</Text>
      </View>

      {/* AI coach */}
      <View style={[styles.card, styles.coachCard]}>
        <View style={styles.coachHeader}>
          <View style={styles.coachIcon}>
            <Ionicons name="mic" size={20} color="#ffffff" />
          </View>
          {!entitlements?.is_premium ? (
            <View style={styles.premiumTag}>
              <Ionicons name="diamond-outline" size={12} color={colors.irisBlue} />
              <Text style={styles.premiumTagText}>Premium</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.coachTitle}>{coach.title}</Text>
        <Text style={styles.coachDetail}>{coach.detail}</Text>
        <Pressable style={({ pressed }) => [styles.coachBtn, pressed && styles.pressed]} onPress={coach.action}>
          <Text style={styles.coachBtnText}>{coach.cta}</Text>
        </Pressable>
      </View>

      {/* Course path */}
      {COURSE.map((unit, unitIndex) => {
        const finished = unit.lessons.filter((lesson) => lessons[lesson.id]).length;
        return (
          <View key={unit.id} style={styles.unit}>
            <View style={styles.unitHeader}>
              <Text style={styles.unitEyebrow}>Unit {unitIndex + 1}</Text>
              <Text style={styles.unitTitle}>{unit.title}</Text>
              <Text style={styles.unitMeta}>
                {unit.description} · {finished}/{unit.lessons.length} done
              </Text>
            </View>
            <View style={styles.card}>
              {unit.lessons.map((lesson, i) => {
                const result = lessons[lesson.id];
                const unlocked = isLessonUnlocked(lesson.id, lessons);
                const isNext = nextLesson?.id === lesson.id;
                return (
                  <Pressable
                    key={lesson.id}
                    style={({ pressed }) => [
                      styles.lessonRow,
                      i === unit.lessons.length - 1 && styles.lessonRowLast,
                      pressed && unlocked && styles.pressed,
                    ]}
                    disabled={!unlocked}
                    onPress={() => router.push(`/lesson/${lesson.id}`)}
                    accessibilityLabel={`${lesson.title}${unlocked ? "" : ", locked"}`}
                  >
                    <View
                      style={[
                        styles.lessonNode,
                        result && styles.lessonNodeDone,
                        isNext && styles.lessonNodeNext,
                        !unlocked && styles.lessonNodeLocked,
                      ]}
                    >
                      <Ionicons
                        name={result ? "checkmark" : isNext ? "play" : unlocked ? "ellipse-outline" : "lock-closed"}
                        size={result || isNext ? 18 : 14}
                        color={result || isNext ? "#ffffff" : colors.fog}
                      />
                    </View>
                    <View style={styles.lessonText}>
                      <Text style={[styles.lessonTitle, !unlocked && styles.lessonTitleLocked]}>{lesson.title}</Text>
                      <Text style={styles.lessonDetail}>{lesson.description}</Text>
                    </View>
                    {result ? (
                      <View style={styles.stars}>
                        {[1, 2, 3].map((n) => (
                          <Ionicons
                            key={n}
                            name={n <= result.stars ? "star" : "star-outline"}
                            size={13}
                            color={n <= result.stars ? colors.amberWarning : colors.fog}
                          />
                        ))}
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: 14 },
    card: {
      backgroundColor: colors.cardElevated,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 18,
    },
    pressed: { opacity: 0.85 },
    cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
    cardTitle: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    cardMeta: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary },
    levelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    levelLabel: { fontFamily: theme.fonts.display, fontSize: 22, fontWeight: "600", letterSpacing: -0.4, color: colors.textPrimary },
    levelSub: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    xpPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.cardSubtle,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    xpPillText: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "600", color: colors.textPrimary },
    track: { height: 8, borderRadius: 999, backgroundColor: colors.cardSubtle, overflow: "hidden", marginTop: 14 },
    fill: { height: "100%", borderRadius: 999, backgroundColor: colors.irisBlue },
    statsRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 18, gap: 12 },
    stat: { flex: 1 },
    weekStat: { flex: 1.6, alignItems: "flex-end" },
    statValue: { fontFamily: theme.fonts.display, fontSize: 20, fontWeight: "600", color: colors.textPrimary },
    statOf: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "400", color: colors.textSecondary },
    statLabel: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
    weekBars: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
    weekCol: { alignItems: "center", gap: 4 },
    weekBar: { width: 10, borderRadius: 4, backgroundColor: colors.cardSubtle },
    weekBarActive: { backgroundColor: colors.skyBlue },
    weekBarToday: { backgroundColor: colors.irisBlue },
    weekDay: { fontFamily: theme.fonts.sans, fontSize: 10, color: colors.textMuted },
    weekDayToday: { color: colors.irisBlue, fontWeight: "600" },
    continueCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: colors.primary,
      borderRadius: 20,
      padding: 18,
    },
    continueText: { flex: 1 },
    continueEyebrow: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "500", color: "rgba(255,255,255,0.8)" },
    continueTitle: { fontFamily: theme.fonts.display, fontSize: 19, fontWeight: "600", color: "#ffffff", marginTop: 2 },
    continueDetail: { fontFamily: theme.fonts.sans, fontSize: 13, color: "rgba(255,255,255,0.85)", marginTop: 2 },
    playCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: "rgba(255,255,255,0.2)",
      alignItems: "center",
      justifyContent: "center",
    },
    questRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
    questIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    questIconDone: { backgroundColor: colors.emeraldSuccess },
    questBody: { flex: 1, gap: 6 },
    questLabel: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "500", color: colors.textPrimary },
    questTrack: { height: 6, borderRadius: 999, backgroundColor: colors.cardSubtle, overflow: "hidden" },
    questFill: { height: "100%", borderRadius: 999, backgroundColor: colors.irisBlue },
    questFillDone: { backgroundColor: colors.emeraldSuccess },
    questCount: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textSecondary, minWidth: 40, textAlign: "right" },
    reviewCard: { flexDirection: "row", alignItems: "center", gap: 14 },
    reviewIcon: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    reviewText: { flex: 1, gap: 2 },
    phrase: { fontFamily: theme.fonts.display, fontSize: 20, fontWeight: "600", color: colors.textPrimary },
    phraseHindi: { fontFamily: theme.fonts.sans, fontSize: 15, color: colors.textSecondary, marginTop: 4 },
    phraseExample: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
      backgroundColor: colors.cardSubtle,
      borderRadius: 10,
      padding: 10,
      marginTop: 10,
    },
    coachCard: { borderColor: colors.irisBlue },
    coachHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
    coachIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.irisBlue,
      alignItems: "center",
      justifyContent: "center",
    },
    premiumTag: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.primarySoft,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    premiumTagText: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "600", color: colors.irisBlue },
    coachTitle: { fontFamily: theme.fonts.display, fontSize: 18, fontWeight: "600", color: colors.textPrimary },
    coachDetail: { fontFamily: theme.fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textSecondary, marginTop: 4 },
    coachBtn: {
      marginTop: 14,
      height: 46,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    coachBtnText: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textOnPrimary },
    unit: { gap: 10, marginTop: 6 },
    unitHeader: { paddingHorizontal: 4 },
    unitEyebrow: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "600", color: colors.irisBlue },
    unitTitle: { fontFamily: theme.fonts.display, fontSize: 19, fontWeight: "600", color: colors.textPrimary, marginTop: 2 },
    unitMeta: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    lessonRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    lessonRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
    lessonNode: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      alignItems: "center",
      justifyContent: "center",
    },
    lessonNodeDone: { backgroundColor: colors.emeraldSuccess, borderColor: colors.emeraldSuccess },
    lessonNodeNext: { backgroundColor: colors.irisBlue, borderColor: colors.irisBlue },
    lessonNodeLocked: { backgroundColor: colors.cardSubtle, borderColor: colors.cardSubtle },
    lessonText: { flex: 1 },
    lessonTitle: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textPrimary },
    lessonTitleLocked: { color: colors.textMuted },
    lessonDetail: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 1 },
    stars: { flexDirection: "row", gap: 1 },
  });
}

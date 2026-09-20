/**
 * Pravaah — Mobile-First Central Learning Hub & Dashboard
 *
 * Designed for native mobile touch interaction:
 * - Native Mobile App Bar (Top) with user greeting, streak flame pill, and level badge
 * - Fixed Frosted Glass Bottom Navigation Bar (Plan, Lessons, Mistakes, Vocab, Profile)
 * - Thumb-friendly touch targets, fluid card elevations, and safe area handling
 * - 100% Realtime Backend Data sync with zero mock fallbacks
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  getProfile,
  getDailyPlan,
  getMistakes,
  getVocabulary,
  getProgress,
  getLessons,
  getFocusSkills,
  refreshDailyPlan,
  setDailyGoal,
  updateProfile,
  deleteAccount,
  LearnerProfile,
  DailyLearningPlan,
  DailyPlanActivity,
  FocusSkill,
  LessonRecord,
  Mistake,
  VocabularyEntry,
  ProgressSummary,
  PRAVAAH_LEVEL_NAMES,
  COACH_VOICES,
  TtsVoice,
} from "../lib/api";
import { signOut } from "../lib/firebase";
import { skillLabel } from "../lib/skills";
import { theme } from "../lib/theme";
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendLocalNotification,
  scheduleDailyPracticeReminder,
} from "../lib/notifications";

type NavTab = "plan" | "lessons" | "mistakes" | "vocabulary" | "profile";

const FOCUS_REASON_LABELS: Record<FocusSkill["reason"], string> = {
  recent_mistakes: "RECENT MISTAKES",
  recent_vocabulary_errors: "VOCABULARY TO RETRY",
  failed_repetitions: "KEEPS SLIPPING",
  unfinished_lesson: "FINISH THIS LESSON",
  low_mastery: "NEEDS WORK",
  developing: "DEVELOPING",
  mastered: "MASTERED",
};

function formatDayLabel(iso?: string): string {
  if (!iso) return "Earlier";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

interface MistakeGroup {
  skillId: string;
  title: string;
  total: number;
  latestIso?: string;
  days: { key: string; label: string; items: Mistake[] }[];
}

/** Groups mistakes by curriculum skill, then by calendar day, newest first. */
function groupMistakes(mistakes: Mistake[]): MistakeGroup[] {
  const bySkill = new Map<string, Mistake[]>();
  for (const m of mistakes) {
    const key = m.curriculum_skill_id || m.category || "sentence_structure";
    const list = bySkill.get(key);
    if (list) list.push(m);
    else bySkill.set(key, [m]);
  }

  const groups: MistakeGroup[] = [];
  bySkill.forEach((items, skillId) => {
    const sorted = [...items].sort(
      (a, b) =>
        new Date(b.created_at || b.timestamp || 0).getTime() -
        new Date(a.created_at || a.timestamp || 0).getTime()
    );

    const byDay = new Map<string, Mistake[]>();
    for (const m of sorted) {
      const iso = m.created_at || m.timestamp;
      const date = iso ? new Date(iso) : null;
      const key =
        date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown";
      const dayList = byDay.get(key);
      if (dayList) dayList.push(m);
      else byDay.set(key, [m]);
    }

    groups.push({
      skillId,
      title: skillLabel(skillId),
      total: sorted.length,
      latestIso: sorted[0]?.created_at || sorted[0]?.timestamp,
      days: Array.from(byDay.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([key, items]) => ({
          key,
          label: formatDayLabel(items[0]?.created_at || items[0]?.timestamp),
          items,
        })),
    });
  });

  return groups.sort((a, b) => b.total - a.total);
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isWide = width >= 720;
  const [activeTab, setActiveTab] = useState<NavTab>("plan");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [dailyPlan, setDailyPlan] = useState<DailyLearningPlan | null>(null);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [vocabulary, setVocabulary] = useState<VocabularyEntry[]>([]);
  const [lessons, setLessons] = useState<LessonRecord[]>([]);
  const [focusSkills, setFocusSkills] = useState<FocusSkill[]>([]);
  const [progress, setProgress] = useState<ProgressSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [refreshingPlan, setRefreshingPlan] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [pendingGoal, setPendingGoal] = useState<number | null>(null);

  // Request sequence IDs to eliminate race conditions
  const goalRequestIdRef = useRef<number>(0);
  const hindiRequestIdRef = useRef<number>(0);
  const voiceRequestIdRef = useRef<number>(0);

  // Fetch real data from backend
  const loadData = useCallback(async () => {
    setErrorMessage(null);
    try {
      const [profData, planData, mstkData, vocData, lessonData, focusData, progData] =
        await Promise.all([
          getProfile().catch((e) => {
            console.warn("Profile fetch error:", e);
            return null;
          }),
          getDailyPlan().catch((e) => {
            console.warn("Daily plan fetch error:", e);
            return null;
          }),
          getMistakes().catch(() => [] as Mistake[]),
          getVocabulary().catch(() => [] as VocabularyEntry[]),
          getLessons().catch(() => [] as LessonRecord[]),
          getFocusSkills().catch(() => [] as FocusSkill[]),
          getProgress().catch(() => ({ total_sessions: 0, total_practice_minutes: 0 })),
        ]);

      if (profData) setProfile(profData);
      if (planData) setDailyPlan(planData);
      setMistakes(mstkData);
      setVocabulary(vocData);
      setLessons(lessonData);
      setFocusSkills(focusData);
      setProgress(progData);

      if (!profData && !planData) {
        setErrorMessage("Could not reach the coaching service. Pull down to retry.");
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to load dashboard data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  // Wait for real server IDs and ranking; fabricated optimistic activities cannot launch.
  const handleGoalChange = async (minutes: number) => {
    if (savingGoal || refreshingPlan) return;
    const reqId = ++goalRequestIdRef.current;
    setSavingGoal(true);
    setPendingGoal(minutes);
    setErrorMessage(null);
    try {
      const res = await setDailyGoal(minutes);
      if (reqId === goalRequestIdRef.current) {
        setDailyPlan(res.daily_plan);
        setProfile((prev) => prev ? { ...prev, daily_goal_minutes: res.daily_goal_minutes } : null);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not update your goal. Your previous plan is unchanged.");
    } finally {
      if (reqId === goalRequestIdRef.current) {
        setSavingGoal(false);
        setPendingGoal(null);
      }
    }
  };

  // Instant optimistic update for Hindi support level
  const handleHindiSupportChange = (level: string) => {
    const reqId = ++hindiRequestIdRef.current;

    setProfile((prev) => (prev ? { ...prev, hindi_support: level } : {
      uid: "user_local",
      pravaah_level: "C",
      native_language: "hi",
      target_language: "en",
      daily_goal_minutes: 30,
      hindi_support: level,
    }));

    updateProfile({ hindi_support: level })
      .then((updated) => {
        if (reqId === hindiRequestIdRef.current && updated) {
          setProfile(updated);
        }
      })
      .catch((err) => {
        console.warn("Hindi support background update error:", err);
      });
  };

  // The agent reads this at session start, so only the next session changes voice.
  const handleVoiceChange = (voice: TtsVoice) => {
    const reqId = ++voiceRequestIdRef.current;
    setProfile((prev) => (prev ? { ...prev, tts_voice: voice } : prev));
    updateProfile({ tts_voice: voice })
      .then((updated) => {
        if (reqId === voiceRequestIdRef.current && updated) setProfile(updated);
      })
      .catch((err) => console.warn("Coach voice update error:", err));
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace("/auth");
  };

  const handleSaveProfile = async () => {
    const name = editName.trim();
    if (!name) return;
    setSavingProfile(true);
    try {
      const updated = await updateProfile({ display_name: name });
      setProfile(updated);
      setEditingProfile(false);
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not save your profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRefreshPlan = async () => {
    setRefreshingPlan(true);
    try {
      const [plan, focus] = await Promise.all([
        refreshDailyPlan(),
        getFocusSkills().catch(() => focusSkills),
      ]);
      setDailyPlan(plan);
      setFocusSkills(focus);
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not rebuild today's plan.");
    } finally {
      setRefreshingPlan(false);
    }
  };

  const [notificationPermission, setNotificationPermission] = useState<string>("default");
  const [reminderTime, setReminderTime] = useState<string>("20:00");
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(true);
  const [notificationFeedback, setNotificationFeedback] = useState<string | null>(null);

  useEffect(() => {
    getNotificationPermissionStatus().then((status) => {
      setNotificationPermission(status);
    });
  }, []);

  const handleRequestNotification = async () => {
    const granted = await requestNotificationPermission();
    const status = await getNotificationPermissionStatus();
    setNotificationPermission(status);
    if (granted) {
      setNotificationFeedback("Reminders enabled! You will receive daily practice alerts.");
      setTimeout(() => setNotificationFeedback(null), 4000);
    }
  };

  const handleTestNotification = async () => {
    const focusSkill = profile?.current_focus || "past_simple_auxiliary";
    const sent = await sendLocalNotification(
      "🎙️ Pravaah — Daily Practice Reminder",
      `Your English session is ready. Today's focus: ${focusSkill.replace(/_/g, " ")}.`,
      { type: "test_notification" }
    );
    if (sent) {
      setNotificationFeedback("Test reminder sent! Check your notifications.");
    } else {
      setNotificationFeedback("Please enable notification permissions in your device settings.");
    }
    setTimeout(() => setNotificationFeedback(null), 4500);
  };

  const handleSelectReminderTime = async (time: string, hour: number, min: number) => {
    setReminderTime(time);
    setReminderEnabled(true);
    await scheduleDailyPracticeReminder(hour, min, profile?.current_focus || undefined);
    setNotificationFeedback(`Daily reminder scheduled for ${time}!`);
    setTimeout(() => setNotificationFeedback(null), 3500);
  };

  const handleDeleteAccount = () => {
    const doDelete = async () => {
      try {
        await deleteAccount();
        await signOut();
        router.replace("/auth");
      } catch (err: any) {
        console.warn("Delete account error:", err);
        setErrorMessage(err?.message || "Could not delete the account. Please try again.");
      }
    };

    const message =
      "This permanently deletes your account, sessions, mistakes and vocabulary. It cannot be undone.";

    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(`Delete account?\n\n${message}`)) {
        doDelete();
      }
      return;
    }

    Alert.alert("Delete account?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doDelete },
    ]);
  };

  const handleStartNextActivity = () => {
    if (savingGoal || refreshingPlan) return;
    const nextAct = dailyPlan?.activities.find((a) => !a.is_completed);
    router.push({
      pathname: "/session",
      params: {
        mode: nextAct?.mode || "free_conversation",
        target_skill: nextAct?.target_skill || "",
        lesson_id: nextAct?.activity_id || "",
        activity_title: nextAct?.title || "Spoken Practice",
        stage: nextAct?.stage || "guided_practice",
      },
    });
  };

  const handleLaunchActivity = (act: DailyPlanActivity) => {
    if (savingGoal || refreshingPlan) return;
    router.push({
      pathname: "/session",
      params: {
        mode: act.mode || "free_conversation",
        target_skill: act.target_skill || "",
        lesson_id: act.activity_id || "",
        activity_title: act.title || "Spoken Practice",
        stage: act.stage || "guided_practice",
      },
    });
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.irisGleam} />
        <Text style={styles.loadingText}>Syncing with Coach Pravaah...</Text>
      </View>
    );
  }

  const userLevel = profile?.pravaah_level || "unassessed";
  const levelName = PRAVAAH_LEVEL_NAMES[userLevel] || (userLevel === "unassessed" ? "Unassessed" : "Elementary");
  const cefrRef = profile?.cefr_reference || (userLevel === "unassessed" ? "Not Assessed" : "A1");
  const currentGoal = dailyPlan?.goal_minutes || profile?.daily_goal_minutes || 30;
  const selectedGoal = pendingGoal ?? currentGoal;
  const completedMins = dailyPlan?.completed_minutes || 0;
  const progressPercent = currentGoal > 0 ? Math.min(100, Math.round((completedMins / currentGoal) * 100)) : 0;
  // The engine sequences correction, transfer and review. Skill priority is not
  // an activity ordering: sorting by it would move retention ahead of practice.
  const orderedActivities = dailyPlan?.activities || [];
  const nextUnfinishedActivity = orderedActivities.find((a) => !a.is_completed);
  const completedActivityCount = orderedActivities.filter((a) => a.is_completed).length;

  // Identity comes from the signed-in account, resolved server-side from the Firebase token.
  const displayName = profile?.display_name || profile?.email?.split("@")[0] || "";
  const firstName = displayName ? displayName.split(/[\s._-]+/)[0] : "";
  const initials = (displayName || "?")
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  const streakDays = profile?.streak_days ?? 0;
  const totalSessions = progress?.total_sessions ?? profile?.total_sessions ?? 0;
  const totalMinutes = Math.round(progress?.total_practice_minutes ?? profile?.total_practice_minutes ?? 0);
  const mistakeGroups = groupMistakes(mistakes);
  const priorityFocus = focusSkills.filter((s) => s.reason !== "mastered").slice(0, 4);

  return (
    <View style={styles.screen}>
      {/* ------------------------------------------------------------------- */}
      {/* MOBILE APP BAR (HEADER) */}
      {/* ------------------------------------------------------------------- */}
      <View style={[styles.mobileAppBar, { paddingTop: Math.max(insets.top, 12) }]}>
        <View style={styles.appBarLeft}>
          <Pressable style={styles.appBarBrand} onPress={() => setActiveTab("plan")}>
            <Image
              source={require("../assets/pravaah_navbar_logo.png")}
              style={styles.brandLogoImage}
              resizeMode="contain"
              accessibilityLabel="Pravaah"
            />
          </Pressable>
          {isWide && firstName ? (
            <Text style={styles.appBarGreeting} numberOfLines={1}>
              Hi, {firstName}
            </Text>
          ) : null}
        </View>

        <View style={styles.appBarRight}>
          {/* Streak Badge */}
          {streakDays > 0 ? (
            <View style={styles.streakBadge}>
              <Text style={styles.streakEmoji}>🔥</Text>
              <Text style={styles.streakCount}>{streakDays}d</Text>
            </View>
          ) : null}

          {/* Level Pill */}
          <Pressable
            style={styles.levelBadge}
            onPress={() => (userLevel === "unassessed" ? router.push("/assessment") : setActiveTab("profile"))}
          >
            <Text style={styles.levelBadgeText}>
              {userLevel === "unassessed" ? "⚡ ASSESS" : `⚡ LVL ${userLevel}`}
            </Text>
          </Pressable>

          {/* Profile / Avatar Shortcut */}
          <Pressable
            style={[styles.avatarBtn, activeTab === "profile" && styles.avatarBtnActive]}
            onPress={() => setActiveTab("profile")}
            accessibilityLabel={displayName ? `Profile: ${displayName}` : "Profile"}
          >
            {initials && initials !== "?" ? (
              <Text style={styles.avatarInitials}>{initials}</Text>
            ) : (
              <Ionicons
                name={activeTab === "profile" ? "person" : "person-outline"}
                size={18}
                color={activeTab === "profile" ? theme.colors.pure : theme.colors.ash}
              />
            )}
          </Pressable>
        </View>
      </View>

      {/* ------------------------------------------------------------------- */}
      {/* MAIN SCROLLABLE CONTENT */}
      {/* ------------------------------------------------------------------- */}
      <ScrollView
        style={styles.mainContainer}
        contentContainerStyle={[
          styles.mainScroll,
          {
            maxWidth: isWide ? 960 : theme.mobile.maxContentWidth,
            paddingBottom: theme.mobile.tabBarHeight + Math.max(insets.bottom, 12) + 24,
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.irisGleam}
            colors={[theme.colors.irisGleam]}
          />
        }
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={16} color={theme.colors.crimsonError} />
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* ================================================================= */}
        {/* TAB 1: TODAY'S PLAN */}
        {/* ================================================================= */}
        {activeTab === "plan" && (
          <View style={styles.tabContent}>
            {/* HERO QUICK-ACTION CARD */}
            <View style={styles.heroActionCard}>
              <View style={styles.ambientCardGlow} />

              <View style={styles.heroTopRow}>
                <View style={styles.heroEyebrowPill}>
                  <View style={styles.greenPulse} />
                  <Text style={styles.heroEyebrowText}>
                    {userLevel === "unassessed" ? "DIAGNOSTIC PENDING" : `LEVEL ${userLevel} • READY`}
                  </Text>
                </View>
                <Text style={styles.heroCefrText}>CEFR {cefrRef}</Text>
              </View>

              <Text style={styles.heroHeadline}>
                {firstName ? (
                  <>
                    <Text style={styles.heroHeadlineItalic}>{firstName}</Text>, own your fluency today.
                  </>
                ) : (
                  <>
                    <Text style={styles.heroHeadlineItalic}>Own</Text> your fluency today.
                  </>
                )}
              </Text>
              <Text style={styles.heroSubhead}>
                Coached conversations: understand a correction, retry it, then use it in your own words.
              </Text>

              {userLevel === "unassessed" ? (
                <Pressable
                  style={({ pressed }) => [styles.primaryHeroBtn, pressed && styles.btnPressed]}
                  onPress={() => router.push("/assessment")}
                >
                  <Ionicons name="mic" size={20} color={theme.colors.void} />
                  <Text style={styles.primaryHeroBtnText}>Take Spoken Diagnostic (3 min) →</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.primaryHeroBtn, pressed && styles.btnPressed]}
                  onPress={handleStartNextActivity}
                  disabled={savingGoal || refreshingPlan}
                >
                  <Ionicons name="mic" size={20} color={theme.colors.void} />
                  <Text style={styles.primaryHeroBtnText}>
                    {nextUnfinishedActivity
                      ? `Continue: ${nextUnfinishedActivity.title.split(":")[0]} (${nextUnfinishedActivity.duration_minutes}m) →`
                      : "Start Daily Spoken Practice →"}
                  </Text>
                </Pressable>
              )}
            </View>

            {/* DAILY COMMITMENT & PROGRESS MODULE */}
            <View style={styles.cardContainer}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardEyebrow}>DAILY COMMITMENT</Text>
                  <Text style={styles.cardTitle}>
                    {completedMins} of {currentGoal} min completed
                  </Text>
                </View>
                <View style={styles.progressPercentPill}>
                  <Text style={styles.progressPercentText}>{progressPercent}%</Text>
                </View>
              </View>

              {/* Goal Selection Pills */}
              <View style={styles.goalChipsRow}>
                {[15, 30, 60, 90].map((mins) => (
                  <Pressable
                    key={mins}
                    style={[
                      styles.goalChip,
                      selectedGoal === mins && styles.goalChipActive,
                    ]}
                    onPress={() => handleGoalChange(mins)}
                    disabled={savingGoal || refreshingPlan}
                  >
                    <Text
                      style={[
                        styles.goalChipText,
                        selectedGoal === mins && styles.goalChipTextActive,
                      ]}
                    >
                      {mins}m
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Progress Bar Track */}
              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
              </View>

              {savingGoal ? (
                <View style={styles.goalStatusRow}>
                  <ActivityIndicator size="small" color={theme.colors.paleIris} />
                  <Text style={styles.progressSubtext}>
                    Rebuilding today's exercises for {pendingGoal ?? selectedGoal} minutes...
                  </Text>
                </View>
              ) : (
                <Text style={styles.progressSubtext}>
                  {completedActivityCount} of {orderedActivities.length} exercises finished today
                </Text>
              )}
            </View>

            {/* ACTIVITY SEQUENCE TIMELINE */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>TODAY'S EXERCISES</Text>
              <Pressable
                style={({ pressed }) => [styles.refreshPlanBtn, pressed && styles.btnPressed]}
                onPress={handleRefreshPlan}
                disabled={refreshingPlan || savingGoal}
              >
                {refreshingPlan ? (
                  <ActivityIndicator size="small" color={theme.colors.paleIris} />
                ) : (
                  <>
                    <Ionicons name="refresh" size={13} color={theme.colors.paleIris} />
                    <Text style={styles.refreshPlanText}>REBUILD</Text>
                  </>
                )}
              </Pressable>
            </View>

            {priorityFocus.length > 0 ? (
              <Text style={styles.planRationaleText}>
                Built around {priorityFocus.slice(0, 2).map((s) => s.title).join(" and ")}.
              </Text>
            ) : null}

            <View style={styles.activityList}>
              {!dailyPlan?.activities || dailyPlan.activities.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="sparkles-outline" size={28} color={theme.colors.fog} />
                  <Text style={styles.emptyCardText}>
                    Select a daily goal above to initialize your tailored practice sequence.
                  </Text>
                </View>
              ) : (
                orderedActivities.map((activity, idx) => {
                  const isCurrent =
                    activity.activity_id === nextUnfinishedActivity?.activity_id;
                  const modeIcon =
                    activity.mode === "free_conversation"
                      ? "cafe-outline"
                      : activity.mode === "grammar_practice"
                      ? "radio-button-on-outline"
                      : activity.mode === "roleplay"
                      ? "people-outline"
                      : activity.mode === "review"
                      ? "refresh-outline"
                      : "chatbubble-ellipses-outline";

                  return (
                    <Pressable
                      key={activity.activity_id}
                      style={({ pressed }) => [
                        styles.activityCard,
                        activity.is_completed && styles.activityCardCompleted,
                        isCurrent && styles.activityCardCurrent,
                        pressed && styles.btnPressed,
                      ]}
                      onPress={() => handleLaunchActivity(activity)}
                      disabled={savingGoal || refreshingPlan}
                    >
                      <View style={styles.activityCardLeft}>
                        <View
                          style={[
                            styles.stepIconCircle,
                            activity.is_completed && styles.stepCircleCompleted,
                            isCurrent && styles.stepCircleCurrent,
                          ]}
                        >
                          {activity.is_completed ? (
                            <Ionicons name="checkmark" size={16} color={theme.colors.emeraldSuccess} />
                          ) : isCurrent ? (
                            <Ionicons name="play" size={14} color={theme.colors.void} />
                          ) : (
                            <Text style={styles.stepNumText}>{idx + 1}</Text>
                          )}
                        </View>
                      </View>

                      <View style={styles.activityCardBody}>
                        <View style={styles.activityBadgeRow}>
                          <View style={styles.modeTag}>
                            <Ionicons name={modeIcon as any} size={12} color={theme.colors.paleIris} />
                            <Text style={styles.modeTagText}>
                              {activity.mode === "free_conversation"
                                ? "CONVERSATION"
                                : activity.mode === "grammar_practice"
                                ? "PRECISION"
                                : activity.mode === "roleplay"
                                ? "ROLEPLAY"
                                : activity.mode === "review"
                                ? "REVIEW"
                                : "VOCABULARY"}
                            </Text>
                          </View>
                          <Text style={styles.activityDurationText}>
                            {activity.duration_minutes} min
                          </Text>
                          {activity.is_completed ? (
                            <View style={styles.doneBadge}>
                              <Text style={styles.doneBadgeText}>DONE</Text>
                            </View>
                          ) : isCurrent ? (
                            <View style={styles.upNextBadge}>
                              <Text style={styles.upNextBadgeText}>NEXT</Text>
                            </View>
                          ) : null}
                        </View>

                        <Text style={styles.activityTitle} numberOfLines={2}>
                          {activity.title}
                        </Text>
                        <Text style={styles.activityObjective} numberOfLines={2}>
                          {activity.objective}
                        </Text>
                        {activity.target_skill ? (
                          <View style={styles.activitySkillChip}>
                            <Text style={styles.activitySkillChipText} numberOfLines={1}>
                              {skillLabel(activity.target_skill)}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={styles.activityCardRight}>
                        <Ionicons
                          name="chevron-forward"
                          size={18}
                          color={isCurrent ? theme.colors.irisGleam : theme.colors.steel}
                        />
                      </View>
                    </Pressable>
                  );
                })
              )}
            </View>

            {/* PRACTICE MODES GRID */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>PRACTICE MODES</Text>
            </View>

            <View style={styles.categoryGrid}>
              {/* Tile 1: Grammar */}
              <Pressable
                style={({ pressed }) => [
                  styles.categoryTile,
                  isWide && styles.categoryTileWide,
                  { backgroundColor: theme.colors.irisGleam },
                  pressed && styles.btnPressed,
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/session",
                    params: {
                      mode: "grammar_practice",
                      target_skill: profile?.current_focus || "past_simple_auxiliary",
                      activity_title: "Targeted Grammar Practice",
                    },
                  })
                }
              >
                <Text style={styles.categoryTileMono}>MODULE 01 • GRAMMAR</Text>
                <Text style={styles.categoryTileHeading}>Targeted Grammar Precision</Text>
                <Text style={styles.categoryTileDesc}>
                  Eliminate recurring grammar errors through natural conversational drills.
                </Text>
                <Text style={styles.categoryTileCta}>Start Grammar Session →</Text>
              </Pressable>

              {/* Tile 2: Vocabulary */}
              <Pressable
                style={({ pressed }) => [
                  styles.categoryTile,
                  isWide && styles.categoryTileWide,
                  { backgroundColor: theme.colors.orchidBloom },
                  pressed && styles.btnPressed,
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/session",
                    params: {
                      mode: "vocabulary_practice",
                      target_skill: "collocations",
                      activity_title: "Collocations & Phrasing",
                    },
                  })
                }
              >
                <Text style={[styles.categoryTileMono, { color: theme.colors.void }]}>MODULE 02 • VOCABULARY</Text>
                <Text style={[styles.categoryTileHeading, { color: theme.colors.void }]}>Collocations & Phrasing</Text>
                <Text style={[styles.categoryTileDesc, { color: "rgba(0, 0, 0, 0.75)" }]}>
                  Learn and speak natural English collocations in context.
                </Text>
                <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Vocabulary Session →</Text>
              </Pressable>

              {/* Tile 3: Fluency */}
              <Pressable
                style={({ pressed }) => [
                  styles.categoryTile,
                  isWide && styles.categoryTileWide,
                  { backgroundColor: theme.colors.cyanSignal },
                  pressed && styles.btnPressed,
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/session",
                    params: {
                      mode: "free_conversation",
                      activity_title: "Coached Conversation",
                    },
                  })
                }
              >
                <Text style={[styles.categoryTileMono, { color: theme.colors.void }]}>MODULE 03 • FLUENCY</Text>
                <Text style={[styles.categoryTileHeading, { color: theme.colors.void }]}>Coached Conversation</Text>
                <Text style={[styles.categoryTileDesc, { color: "rgba(0, 0, 0, 0.75)" }]}>
                  Talk about your interests while practising a priority skill, with explanations and retries.
                </Text>
                <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Coached Conversation →</Text>
              </Pressable>

              {/* Tile 4: Roleplay */}
              <Pressable
                style={({ pressed }) => [
                  styles.categoryTile,
                  isWide && styles.categoryTileWide,
                  { backgroundColor: theme.colors.periwinkle },
                  pressed && styles.btnPressed,
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/session",
                    params: {
                      mode: "roleplay",
                      activity_title: "Workplace Dialogue Simulation",
                    },
                  })
                }
              >
                <Text style={[styles.categoryTileMono, { color: theme.colors.void }]}>MODULE 04 • ROLEPLAY</Text>
                <Text style={[styles.categoryTileHeading, { color: theme.colors.void }]}>Situational Dialogue & Roleplay</Text>
                <Text style={[styles.categoryTileDesc, { color: "rgba(0, 0, 0, 0.75)" }]}>
                  Apply your speech in real-world scenarios: workplace, interviews, and discussions.
                </Text>
                <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Roleplay Session →</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: LESSONS & FOCUS */}
        {/* ================================================================= */}
        {activeTab === "lessons" && (
          <View style={styles.tabContent}>
            <View style={styles.tabHeroSection}>
              <Text style={styles.tabHeroEyebrow}>ADAPTIVE CURRICULUM</Text>
              <Text style={styles.tabHeroHeadline}>
                <Text style={styles.heroHeadlineItalic}>Targeted</Text> lesson progression.
              </Text>
              <Text style={styles.tabHeroSubhead}>
                Dynamic exercises sequenced based on your recorded speaking evidence.
              </Text>
            </View>

            {/* Recommended Lesson Banner */}
            {profile?.recommended_lesson ? (
              <View style={styles.cardContainer}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.stagePill}>
                    <Text style={styles.stagePillText}>
                      {profile.recommended_lesson.stage?.toUpperCase() || "RECOMMENDED LESSON"}
                    </Text>
                  </View>
                  <Text style={styles.cefrRefText}>
                    MASTERY {Math.round((profile.recommended_lesson.mastery_score || 0) * 100)}%
                  </Text>
                </View>

                <Text style={styles.lessonTitle}>{profile.recommended_lesson.lesson_title}</Text>
                <Text style={styles.lessonRule}>{profile.recommended_lesson.rule_summary}</Text>

                <View style={styles.goalTipBox}>
                  <Ionicons name="information-circle-outline" size={16} color={theme.colors.paleIris} />
                  <Text style={styles.goalTipText}>
                    {profile.recommended_lesson.practice_activity}
                  </Text>
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryHeroBtn, { marginTop: 12 }, pressed && styles.btnPressed]}
                  onPress={() =>
                    router.push({
                      pathname: "/session",
                      params: {
                        mode: profile.recommended_lesson?.category === "vocabulary" ? "vocabulary_practice" : "grammar_practice",
                        target_skill: profile.recommended_lesson?.target_skill_id,
                        lesson_id: profile.recommended_lesson?.lesson_id,
                        activity_title: profile.recommended_lesson?.lesson_title,
                        stage: profile.recommended_lesson?.stage,
                      },
                    })
                  }
                >
                  <Text style={styles.primaryHeroBtnText}>Launch Targeted Lesson →</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Ionicons name="clipboard-outline" size={28} color={theme.colors.fog} />
                <Text style={styles.emptyCardText}>
                  Complete a 3-minute spoken assessment to receive tailored recommendations.
                </Text>
                <Pressable
                  style={[styles.smallActionBtn, { marginTop: 12 }]}
                  onPress={() => router.push("/assessment")}
                >
                  <Text style={styles.smallActionBtnText}>Take Assessment →</Text>
                </Pressable>
              </View>
            )}

            {/* Curriculum Skills Mastery List */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>FIX THESE FIRST</Text>
              <Text style={styles.sectionBadge}>RANKED</Text>
            </View>

            {focusSkills.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="trending-up-outline" size={28} color={theme.colors.fog} />
                <Text style={styles.emptyCardText}>
                  Finish one conversation and your ranked improvement plan will appear here.
                </Text>
              </View>
            ) : (
              <View style={styles.activityList}>
                {focusSkills.map((skill, idx) => {
                  const pct = Math.round(skill.mastery * 100);
                  const isTop = idx === 0 && skill.reason !== "mastered";
                  return (
                    <Pressable
                      key={skill.skill_id}
                      style={({ pressed }) => [
                        styles.focusCardRow,
                        isTop && styles.focusCardRowTop,
                        pressed && styles.btnPressed,
                      ]}
                      onPress={() =>
                        router.push({
                          pathname: "/session",
                          params: {
                            mode: skill.category === "vocabulary" ? "vocabulary_practice" : "grammar_practice",
                            target_skill: skill.skill_id,
                            activity_title: skill.title,
                            stage: skill.stage,
                          },
                        })
                      }
                    >
                      <View style={styles.focusRankBadge}>
                        <Text style={styles.focusRankText}>{idx + 1}</Text>
                      </View>

                      <View style={styles.focusCardBody}>
                        <View style={styles.focusCardTopRow}>
                          <Text style={styles.focusSkillTitle} numberOfLines={1}>
                            {skill.title}
                          </Text>
                          <Text style={styles.focusMasteryText}>{pct}%</Text>
                        </View>

                        <View style={styles.skillTrack}>
                          <View
                            style={[
                              styles.skillFill,
                              {
                                width: `${pct}%`,
                                backgroundColor:
                                  skill.mastery > 0.75
                                    ? theme.colors.emeraldSuccess
                                    : skill.mastery > 0.5
                                    ? theme.colors.irisGleam
                                    : theme.colors.amberWarning,
                              },
                            ]}
                          />
                        </View>

                        <View style={styles.focusMetaRow}>
                          <View style={styles.focusReasonPill}>
                            <Text style={styles.focusReasonText}>
                              {FOCUS_REASON_LABELS[skill.reason] || skill.reason.replace(/_/g, " ").toUpperCase()}
                            </Text>
                          </View>
                          {skill.mistake_count > 0 ? (
                            <Text style={styles.focusMetaText}>
                              {skill.mistake_count} logged · last{" "}
                              {formatDayLabel(skill.last_mistake_at || undefined).toLowerCase()}
                            </Text>
                          ) : (
                            <Text style={styles.focusMetaText}>CEFR {skill.cefr_level}</Text>
                          )}
                        </View>

                        {isTop && skill.rule_summary ? (
                          <Text style={styles.focusRuleText} numberOfLines={3}>
                            {skill.rule_summary}
                          </Text>
                        ) : null}
                        {isTop ? skill.recent_examples?.slice(0, 2).map((example, exampleIndex) => (
                          <Text key={exampleIndex} style={styles.focusRuleText}>
                            “{example.original}” → “{example.corrected}”
                          </Text>
                        )) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {/* Lesson history */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>LESSON HISTORY</Text>
              <Text style={styles.sectionBadge}>{lessons.length} LESSONS</Text>
            </View>

            <View style={styles.activityList}>
              {lessons.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="time-outline" size={28} color={theme.colors.fog} />
                  <Text style={styles.emptyCardText}>
                    Lessons you launch will be recorded here with their mastery movement.
                  </Text>
                </View>
              ) : (
                lessons.map((lesson) => {
                  const delta = (lesson.mastery_after ?? 0) - (lesson.mastery_before ?? 0);
                  const done = lesson.completion_status === "completed";
                  return (
                    <Pressable
                      key={lesson.lesson_id}
                      style={({ pressed }) => [styles.lessonHistoryCard, pressed && styles.btnPressed]}
                      onPress={() =>
                        router.push({
                          pathname: "/session",
                          params: {
                            mode: "grammar_practice",
                            target_skill: lesson.source_skill_id,
                            lesson_id: lesson.lesson_id,
                            activity_title: lesson.lesson_title || lesson.source_skill_id,
                            stage: lesson.stage || "guided_practice",
                          },
                        })
                      }
                    >
                      <View style={styles.lessonHistoryTop}>
                        <Text style={styles.lessonHistoryTitle} numberOfLines={1}>
                          {lesson.lesson_title || lesson.source_skill_id.replace(/_/g, " ")}
                        </Text>
                        <View style={done ? styles.doneBadge : styles.upNextBadge}>
                          <Text style={done ? styles.doneBadgeText : styles.upNextBadgeText}>
                            {(lesson.completion_status || "recommended").toUpperCase()}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.lessonHistoryMetaRow}>
                        <Text style={styles.lessonHistoryMeta}>
                          {(lesson.stage || "guided practice").replace(/_/g, " ")}
                        </Text>
                        <Text style={styles.lessonHistoryMeta}>
                          {lesson.attempts ?? 0} attempts
                        </Text>
                        <Text
                          style={[
                            styles.lessonHistoryMeta,
                            delta > 0 && { color: theme.colors.emeraldSuccess },
                            delta < 0 && { color: theme.colors.crimsonError },
                          ]}
                        >
                          mastery {Math.round((lesson.mastery_after ?? 0) * 100)}%
                          {delta !== 0 ? ` (${delta > 0 ? "+" : ""}${Math.round(delta * 100)})` : ""}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 3: MISTAKES NOTEBOOK */}
        {/* ================================================================= */}
        {activeTab === "mistakes" && (
          <View style={styles.tabContent}>
            <View style={styles.tabHeroSection}>
              <Text style={styles.tabHeroEyebrow}>ERROR LOG & RECASTS</Text>
              <Text style={styles.tabHeroHeadline}>
                <Text style={styles.heroHeadlineItalic}>Review</Text> past corrections.
              </Text>
              <Text style={styles.tabHeroSubhead}>
                Grouped by grammar point. Tap one to see every time it came up, day by day.
              </Text>
            </View>

            {mistakes.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="checkmark-circle-outline" size={32} color={theme.colors.emeraldSuccess} />
                <Text style={styles.emptyCardText}>
                  No mistakes logged yet. Once you finish a voice session, coach recasts appear here.
                </Text>
              </View>
            ) : (
              <View style={styles.activityList}>
                {mistakeGroups.map((group) => {
                  const open = expandedSkill === group.skillId;
                  return (
                    <View key={group.skillId} style={styles.skillGroupCard}>
                      <Pressable
                        style={styles.skillGroupHeader}
                        onPress={() => setExpandedSkill(open ? null : group.skillId)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                      >
                        <View style={styles.skillGroupHeaderText}>
                          <Text style={styles.skillGroupTitle}>{group.title}</Text>
                          <Text style={styles.skillGroupMeta}>
                            {group.total} {group.total === 1 ? "mistake" : "mistakes"} · last{" "}
                            {formatDayLabel(group.latestIso).toLowerCase()}
                          </Text>
                        </View>
                        <View style={styles.skillGroupCountPill}>
                          <Text style={styles.skillGroupCountText}>{group.total}</Text>
                        </View>
                        <Ionicons
                          name={open ? "chevron-up" : "chevron-down"}
                          size={18}
                          color={theme.colors.fog}
                        />
                      </Pressable>

                      {open ? (
                        <View style={styles.skillGroupBody}>
                          {group.days.map((day) => (
                            <View key={day.key} style={styles.dayBlock}>
                              <Text style={styles.dayBlockLabel}>{day.label.toUpperCase()}</Text>

                              {day.items.map((m) => (
                                <View key={m.mistake_id} style={styles.mistakeCard}>
                                  <View style={styles.mistakeCardHeader}>
                                    <View style={styles.mistakeTag}>
                                      <Text style={styles.mistakeTagText}>
                                        {(m.category || "Grammar").replace(/_/g, " ").toUpperCase()}
                                      </Text>
                                    </View>
                                    <Text style={styles.mistakeSeverityText}>
                                      {(m.severity || "medium").toUpperCase()}
                                    </Text>
                                  </View>

                                  <View style={styles.mistakeCompareBox}>
                                    <View style={styles.saidHeader}>
                                      <Ionicons name="close-circle" size={14} color={theme.colors.crimsonError} />
                                      <Text style={styles.saidLabel}>YOU SAID:</Text>
                                    </View>
                                    <Text style={styles.saidText}>"{m.original}"</Text>
                                  </View>

                                  <View style={styles.recastCompareBox}>
                                    <View style={styles.recastHeader}>
                                      <Ionicons name="checkmark-circle" size={14} color={theme.colors.emeraldSuccess} />
                                      <Text style={styles.recastLabel}>COACH RECAST:</Text>
                                    </View>
                                    <Text style={styles.recastText}>"{m.corrected}"</Text>
                                  </View>

                                  {m.explanation ? (
                                    <Text style={styles.mistakeWhyText}>💡 {m.explanation}</Text>
                                  ) : null}
                                </View>
                              ))}
                            </View>
                          ))}

                          <Pressable
                            style={({ pressed }) => [styles.smallActionBtn, pressed && styles.btnPressed]}
                            onPress={() =>
                              router.push({
                                pathname: "/session",
                                params: {
                                  mode: "grammar_practice",
                                  target_skill: group.skillId,
                                  activity_title: `Fix: ${group.title}`,
                                  stage: "guided_practice",
                                },
                              })
                            }
                          >
                            <Text style={styles.smallActionBtnText}>
                              Practise {group.title} now →
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 4: VOCABULARY NOTEBOOK */}
        {/* ================================================================= */}
        {activeTab === "vocabulary" && (
          <View style={styles.tabContent}>
            <View style={styles.tabHeroSection}>
              <Text style={styles.tabHeroEyebrow}>SPOKEN VOCABULARY</Text>
              <Text style={styles.tabHeroHeadline}>
                <Text style={styles.heroHeadlineItalic}>Natural</Text> expressions.
              </Text>
              <Text style={styles.tabHeroSubhead}>
                Idioms and professional phrasing acquired across your conversations.
              </Text>
            </View>

            <View style={styles.activityList}>
              {vocabulary.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="book-outline" size={32} color={theme.colors.fog} />
                  <Text style={styles.emptyCardText}>
                    Vocabulary and collocations from your voice sessions will automatically be collected here.
                  </Text>
                </View>
              ) : (
                vocabulary.map((v) => (
                  <View key={v.vocabulary_id} style={styles.vocabCard}>
                    <View style={styles.vocabHeaderRow}>
                      <Text style={styles.vocabTerm}>{v.term || v.word || "Expression"}</Text>
                      <Ionicons name="bookmark" size={16} color={theme.colors.irisGleam} />
                    </View>

                    {v.context || v.example ? (
                      <Text style={styles.vocabContext}>"{v.context || v.example}"</Text>
                    ) : null}

                    {v.natural_usage_tip || v.meaning ? (
                      <View style={styles.vocabTipBox}>
                        <Ionicons name="sparkles" size={14} color={theme.colors.paleIris} />
                        <Text style={styles.vocabTipText}>
                          {v.natural_usage_tip || v.meaning}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 5: PROFILE, PROGRESS & SETTINGS */}
        {/* ================================================================= */}
        {activeTab === "profile" && (
          <View style={styles.tabContent}>
            {/* User Identity Card */}
            <View style={styles.profileHeroCard}>
              <View style={styles.avatarLargeCircle}>
                {initials && initials !== "?" ? (
                  <Text style={styles.avatarLargeInitials}>{initials}</Text>
                ) : (
                  <Ionicons name="person" size={32} color={theme.colors.pure} />
                )}
              </View>
              <Text style={styles.profileTitle}>{displayName || "Your profile"}</Text>
              {profile?.email ? (
                <Text style={styles.profileEmail}>{profile.email}</Text>
              ) : null}

              <View style={styles.profileBadgeRow}>
                <View style={styles.profileLevelBadge}>
                  <Ionicons name="ribbon-outline" size={13} color={theme.colors.paleIris} />
                  <Text style={styles.profileLevelBadgeText}>
                    {userLevel === "unassessed" ? "Not assessed" : `Level ${userLevel} · ${levelName}`}
                  </Text>
                </View>
                {userLevel !== "unassessed" ? (
                  <View style={styles.profileCefrBadge}>
                    <Text style={styles.profileCefrBadgeText}>CEFR {cefrRef}</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.profileActionsRow}>
                <Pressable
                  style={({ pressed }) => [styles.editProfileBtn, pressed && styles.btnPressed]}
                  onPress={() => {
                    setEditName(profile?.display_name || displayName);
                    setEditingProfile(true);
                  }}
                >
                  <Ionicons name="create-outline" size={16} color={theme.colors.cloud} />
                  <Text style={styles.editProfileBtnText}>Edit profile</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [styles.retakeAssessmentBtn, pressed && styles.btnPressed]}
                  onPress={() => router.push("/assessment")}
                >
                  <Ionicons name="mic-outline" size={16} color={theme.colors.paleIris} />
                  <Text style={styles.retakeAssessmentBtnText}>
                    {userLevel === "unassessed" ? "Take assessment" : "Retake assessment"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Quick Stats Grid */}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Ionicons name="chatbubbles-outline" size={16} color={theme.colors.paleIris} />
                <Text style={styles.statNum}>{totalSessions}</Text>
                <Text style={styles.statLbl}>SESSIONS</Text>
              </View>
              <View style={styles.statBox}>
                <Ionicons name="time-outline" size={16} color={theme.colors.paleIris} />
                <Text style={styles.statNum}>{totalMinutes}m</Text>
                <Text style={styles.statLbl}>PRACTISED</Text>
              </View>
              <View style={styles.statBox}>
                <Ionicons name="flame-outline" size={16} color={theme.colors.amberWarning} />
                <Text style={styles.statNum}>{streakDays}</Text>
                <Text style={styles.statLbl}>DAY STREAK</Text>
              </View>
            </View>

            {/* Learning snapshot from real recorded evidence */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>YOUR LEARNING</Text>
              <View style={styles.profileInfoRow}>
                <Text style={styles.profileInfoLabel}>Working on</Text>
                <Text style={styles.profileInfoValue} numberOfLines={1}>
                  {priorityFocus[0] ? priorityFocus[0].title : "Start a session to set this"}
                </Text>
              </View>
              <View style={styles.profileInfoRow}>
                <Text style={styles.profileInfoLabel}>Daily goal</Text>
                <Text style={styles.profileInfoValue}>{currentGoal} minutes</Text>
              </View>
              <View style={styles.profileInfoRow}>
                <Text style={styles.profileInfoLabel}>Corrections saved</Text>
                <Text style={styles.profileInfoValue}>{mistakes.length}</Text>
              </View>
              <View style={[styles.profileInfoRow, styles.profileInfoRowLast]}>
                <Text style={styles.profileInfoLabel}>Words collected</Text>
                <Text style={styles.profileInfoValue}>{vocabulary.length}</Text>
              </View>
            </View>

            {/* Coach voice */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>COACH VOICE</Text>
              <Text style={styles.settingsGroupDesc}>
                Choose who you practise with. This applies to your next session.
              </Text>

              <View style={styles.voiceList}>
                {COACH_VOICES.map((voice) => {
                  const active = (profile?.tts_voice || "indian_female") === voice.value;
                  return (
                    <Pressable
                      key={voice.value}
                      style={[styles.voiceRow, active && styles.voiceRowActive]}
                      onPress={() => handleVoiceChange(voice.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                    >
                      <Ionicons
                        name={active ? "radio-button-on" : "radio-button-off"}
                        size={18}
                        color={active ? theme.colors.irisGleam : theme.colors.fog}
                      />
                      <Text style={[styles.voiceRowText, active && styles.voiceRowTextActive]}>
                        {voice.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Preferences Group: Hindi Support */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>HINDI EXPLANATION SUPPORT</Text>
              <Text style={styles.settingsGroupDesc}>
                Controls how often Coach Pravaah explains a correction in Hindi. Practice sentences
                always stay in English.
              </Text>

              <View style={styles.supportChipsRow}>
                {["high", "occasional", "minimal", "off"].map((lvl) => (
                  <Pressable
                    key={lvl}
                    style={[
                      styles.supportChip,
                      profile?.hindi_support === lvl && styles.supportChipActive,
                    ]}
                    onPress={() => handleHindiSupportChange(lvl)}
                  >
                    <Text
                      style={[
                        styles.supportChipText,
                        profile?.hindi_support === lvl && styles.supportChipTextActive,
                      ]}
                    >
                      {lvl.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Notifications & Reminders */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>DAILY PRACTICE REMINDERS</Text>
              <Text style={styles.settingsGroupDesc}>
                Set a regular time to receive a push notification for your daily speaking practice.
              </Text>

              {notificationFeedback ? (
                <View style={styles.feedbackBanner}>
                  <Text style={styles.feedbackBannerText}>{notificationFeedback}</Text>
                </View>
              ) : null}

              <View style={styles.timeChipsRow}>
                {[
                  { time: "08:00 AM", h: 8, m: 0 },
                  { time: "01:00 PM", h: 13, m: 0 },
                  { time: "08:00 PM", h: 20, m: 0 },
                  { time: "09:30 PM", h: 21, m: 30 },
                ].map((slot) => (
                  <Pressable
                    key={slot.time}
                    style={[
                      styles.timeChip,
                      reminderTime === slot.time && styles.timeChipActive,
                    ]}
                    onPress={() => handleSelectReminderTime(slot.time, slot.h, slot.m)}
                  >
                    <Text
                      style={[
                        styles.timeChipText,
                        reminderTime === slot.time && styles.timeChipTextActive,
                      ]}
                    >
                      {slot.time}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.notifActionsRow}>
                {notificationPermission !== "granted" ? (
                  <Pressable
                    style={styles.notifActionBtn}
                    onPress={handleRequestNotification}
                  >
                    <Text style={styles.notifActionBtnText}>Enable Reminders</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.notifActionBtn}
                    onPress={handleTestNotification}
                  >
                    <Text style={styles.notifActionBtnText}>Send Test Reminder</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {/* Account Actions */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>ACCOUNT</Text>
              <Pressable
                style={({ pressed }) => [styles.signOutBtn, pressed && styles.btnPressed]}
                onPress={handleSignOut}
              >
                <Ionicons name="log-out-outline" size={18} color={theme.colors.pure} />
                <Text style={styles.signOutBtnText}>Sign Out</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.deleteBtn, pressed && styles.btnPressed]}
                onPress={handleDeleteAccount}
              >
                <Ionicons name="trash-outline" size={16} color={theme.colors.crimsonError} />
                <Text style={styles.deleteBtnText}>Delete Account & History</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>

      {/* ------------------------------------------------------------------- */}
      {/* MOBILE BOTTOM NAVIGATION BAR */}
      {/* ------------------------------------------------------------------- */}
      <View
        style={[
          styles.bottomTabBar,
          {
            paddingBottom: Math.max(insets.bottom, 10),
            height: theme.mobile.tabBarHeight + Math.max(insets.bottom, 10),
          },
        ]}
      >
        <Pressable
          style={[styles.tabItem, activeTab === "plan" && styles.tabItemActive]}
          onPress={() => setActiveTab("plan")}
        >
          <Ionicons
            name={activeTab === "plan" ? "calendar" : "calendar-outline"}
            size={22}
            color={activeTab === "plan" ? theme.colors.pure : theme.colors.fog}
          />
          <Text style={[styles.tabItemLabel, activeTab === "plan" && styles.tabItemLabelActive]}>
            Plan
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "lessons" && styles.tabItemActive]}
          onPress={() => setActiveTab("lessons")}
        >
          <Ionicons
            name={activeTab === "lessons" ? "library" : "library-outline"}
            size={22}
            color={activeTab === "lessons" ? theme.colors.pure : theme.colors.fog}
          />
          <Text style={[styles.tabItemLabel, activeTab === "lessons" && styles.tabItemLabelActive]}>
            Lessons
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "mistakes" && styles.tabItemActive]}
          onPress={() => setActiveTab("mistakes")}
        >
          <Ionicons
            name={activeTab === "mistakes" ? "alert-circle" : "alert-circle-outline"}
            size={22}
            color={activeTab === "mistakes" ? theme.colors.pure : theme.colors.fog}
          />
          <Text style={[styles.tabItemLabel, activeTab === "mistakes" && styles.tabItemLabelActive]}>
            Mistakes
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "vocabulary" && styles.tabItemActive]}
          onPress={() => setActiveTab("vocabulary")}
        >
          <Ionicons
            name={activeTab === "vocabulary" ? "bookmark" : "bookmark-outline"}
            size={22}
            color={activeTab === "vocabulary" ? theme.colors.pure : theme.colors.fog}
          />
          <Text style={[styles.tabItemLabel, activeTab === "vocabulary" && styles.tabItemLabelActive]}>
            Vocab
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "profile" && styles.tabItemActive]}
          onPress={() => setActiveTab("profile")}
        >
          <Ionicons
            name={activeTab === "profile" ? "person" : "person-outline"}
            size={22}
            color={activeTab === "profile" ? theme.colors.pure : theme.colors.fog}
          />
          <Text style={[styles.tabItemLabel, activeTab === "profile" && styles.tabItemLabelActive]}>
            Profile
          </Text>
        </Pressable>
      </View>

      {/* Edit profile */}
      <Modal visible={editingProfile} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.editSheet, { paddingBottom: Math.max(insets.bottom + 16, 20) }]}>
            <Text style={styles.editSheetTitle}>Edit profile</Text>

            <Text style={styles.inputLabelText}>DISPLAY NAME</Text>
            <TextInput
              style={styles.editInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="How should your coach address you?"
              placeholderTextColor={theme.colors.steel}
              autoCapitalize="words"
              maxLength={60}
            />
            {profile?.email ? (
              <Text style={styles.editHintText}>Signed in as {profile.email}</Text>
            ) : null}

            <View style={styles.editSheetActions}>
              <Pressable
                style={styles.editCancelBtn}
                onPress={() => setEditingProfile(false)}
                disabled={savingProfile}
              >
                <Text style={styles.editCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.editSaveBtn,
                  (!editName.trim() || savingProfile) && styles.btnDisabledSoft,
                  pressed && styles.btnPressed,
                ]}
                onPress={handleSaveProfile}
                disabled={!editName.trim() || savingProfile}
              >
                {savingProfile ? (
                  <ActivityIndicator size="small" color={theme.colors.void} />
                ) : (
                  <Text style={styles.editSaveText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  loadingText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
  },
  mobileAppBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 12,
    backgroundColor: theme.colors.glassNav,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
    zIndex: 10,
  },
  appBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexShrink: 1,
  },
  appBarGreeting: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    flexShrink: 1,
  },
  appBarBrand: {
    flexDirection: "row",
    alignItems: "center",
  },
  brandLogoImage: {
    width: 110,
    height: 32,
  },
  appBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  streakBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 183, 77, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 183, 77, 0.28)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 3,
  },
  streakEmoji: {
    fontSize: 12,
  },
  streakCount: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.amberWarning,
  },
  levelBadge: {
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    borderRadius: theme.radii.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  levelBadgeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.paleIris,
  },
  avatarBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBtnActive: {
    borderColor: theme.colors.irisGleam,
    backgroundColor: theme.colors.graphite,
  },
  avatarInitials: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  avatarLargeInitials: {
    fontFamily: theme.fonts.sans,
    fontSize: 24,
    fontWeight: "700",
    color: theme.colors.pure,
  },
  profileEmail: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    marginTop: 2,
  },
  editProfileBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: theme.spacing.md,
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  editProfileBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "600",
    color: theme.colors.cloud,
  },
  editSheet: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    backgroundColor: theme.colors.graphiteCard,
    borderTopLeftRadius: theme.radii.xl,
    borderTopRightRadius: theme.radii.xl,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  editSheetTitle: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingSm,
    color: theme.colors.cloud,
    marginBottom: theme.spacing.lg,
  },
  inputLabelText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    fontWeight: "700",
    color: theme.colors.fog,
    marginBottom: 6,
  },
  editInput: {
    height: theme.mobile.minTouchSize,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    paddingHorizontal: theme.spacing.md,
    color: theme.colors.pure,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
  },
  editHintText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.fog,
    marginTop: 8,
  },
  editSheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 12,
    marginTop: theme.spacing.xl,
  },
  editCancelBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  editCancelText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
  },
  editSaveBtn: {
    minHeight: 44,
    minWidth: 100,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.pure,
  },
  editSaveText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "700",
    color: theme.colors.void,
  },
  btnDisabledSoft: {
    opacity: 0.45,
  },
  refreshPlanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: theme.radii.full,
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
  },
  refreshPlanText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: theme.colors.paleIris,
  },
  planRationaleText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.ash,
    marginTop: -8,
  },
  skillGroupCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  skillGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: theme.spacing.md,
    minHeight: theme.mobile.minTouchSize,
  },
  skillGroupHeaderText: {
    flex: 1,
  },
  skillGroupTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  skillGroupMeta: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.fog,
    marginTop: 2,
  },
  skillGroupCountPill: {
    minWidth: 26,
    height: 22,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radii.full,
    backgroundColor: "rgba(255, 82, 82, 0.15)",
  },
  skillGroupCountText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.crimsonError,
  },
  skillGroupBody: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    gap: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    paddingTop: theme.spacing.md,
  },
  dayBlock: {
    gap: 8,
  },
  dayBlockLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    letterSpacing: 0.8,
    fontWeight: "700",
    color: theme.colors.paleIris,
  },
  focusCardRow: {
    flexDirection: "row",
    gap: 12,
    padding: theme.spacing.md,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.graphiteCard,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  focusCardRowTop: {
    borderColor: theme.colors.borderIris,
    backgroundColor: "rgba(132, 125, 255, 0.08)",
  },
  focusRankBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
  },
  focusRankText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  focusCardBody: {
    flex: 1,
    gap: 6,
  },
  focusCardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  focusSkillTitle: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "700",
    color: theme.colors.cloud,
  },
  focusMasteryText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.ash,
  },
  focusMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  focusReasonPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: theme.radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
  focusReasonText: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    fontWeight: "700",
    color: theme.colors.paleIris,
  },
  focusMetaText: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    color: theme.colors.fog,
  },
  focusRuleText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.ash,
    marginTop: 2,
  },
  lessonHistoryCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: 8,
  },
  lessonHistoryTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  lessonHistoryTitle: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "700",
    color: theme.colors.cloud,
    textTransform: "capitalize",
  },
  lessonHistoryMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  lessonHistoryMeta: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.fog,
    textTransform: "uppercase",
  },
  mainContainer: {
    flex: 1,
  },
  mainScroll: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    width: "100%",
    alignSelf: "center",
  },
  tabContent: {
    gap: theme.spacing.lg,
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
    marginBottom: theme.spacing.sm,
  },
  errorBannerText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.crimsonError,
  },
  heroActionCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    overflow: "hidden",
    ...theme.shadows.card,
  },
  ambientCardGlow: {
    position: "absolute",
    top: -40,
    right: -40,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: theme.colors.glowIris,
    pointerEvents: "none",
  },
  heroTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.sm,
  },
  heroEyebrowPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
    gap: 6,
  },
  greenPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.emeraldSuccess,
  },
  heroEyebrowText: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.micro,
    color: theme.colors.ash,
    letterSpacing: 0.8,
    fontWeight: "600",
  },
  heroCefrText: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.micro,
    color: theme.colors.paleIris,
    fontWeight: "700",
  },
  heroHeadline: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingMd,
    color: theme.colors.cloud,
    marginBottom: 4,
  },
  heroHeadlineItalic: {
    fontStyle: "italic",
    color: theme.colors.irisGleam,
  },
  heroSubhead: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    lineHeight: 18,
    marginBottom: theme.spacing.lg,
  },
  primaryHeroBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.pure,
    height: 48,
    borderRadius: theme.radii.sm,
    gap: 8,
  },
  primaryHeroBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm + 1,
    fontWeight: "700",
    color: theme.colors.void,
  },
  cardContainer: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    ...theme.shadows.sm,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  cardEyebrow: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.fog,
    letterSpacing: 0.8,
    fontWeight: "600",
  },
  cardTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "600",
    color: theme.colors.cloud,
    marginTop: 2,
  },
  progressPercentPill: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
  },
  progressPercentText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.irisGleam,
  },
  goalChipsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: theme.spacing.md,
  },
  goalChip: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  goalChipActive: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.irisGleam,
  },
  goalChipText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.ash,
    fontWeight: "600",
  },
  goalChipTextActive: {
    color: theme.colors.pure,
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: theme.colors.abyss,
    borderRadius: 3,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: theme.colors.irisGleam,
    borderRadius: 3,
  },
  progressSubtext: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.micro + 1,
    color: theme.colors.fog,
  },
  goalStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 4,
  },
  sectionTitle: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ash,
    letterSpacing: 1.0,
  },
  sectionBadge: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.fog,
  },
  activityList: {
    gap: 10,
  },
  emptyCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 8,
  },
  emptyCardText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    textAlign: "center",
    lineHeight: 18,
  },
  smallActionBtn: {
    backgroundColor: theme.colors.pure,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radii.sm,
  },
  smallActionBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "600",
    color: theme.colors.void,
  },
  activityCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  activityCardCompleted: {
    opacity: 0.75,
    backgroundColor: "rgba(22, 23, 26, 0.6)",
  },
  activityCardCurrent: {
    borderColor: theme.colors.borderIris,
    backgroundColor: "rgba(28, 29, 34, 0.95)",
  },
  activityCardLeft: {
    marginRight: 12,
  },
  stepIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.abyss,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleCompleted: {
    backgroundColor: "rgba(56, 211, 159, 0.15)",
    borderColor: theme.colors.emeraldSuccess,
  },
  stepCircleCurrent: {
    backgroundColor: theme.colors.pure,
    borderColor: theme.colors.pure,
  },
  stepNumText: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.fog,
  },
  activityCardBody: {
    flex: 1,
  },
  activityBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  modeTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radii.xs,
  },
  modeTagText: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    color: theme.colors.paleIris,
    fontWeight: "700",
  },
  activityDurationText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.fog,
  },
  doneBadge: {
    backgroundColor: "rgba(56, 211, 159, 0.12)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radii.xs,
  },
  doneBadgeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    color: theme.colors.emeraldSuccess,
    fontWeight: "700",
  },
  upNextBadge: {
    backgroundColor: "rgba(132, 125, 255, 0.18)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radii.xs,
  },
  upNextBadgeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    color: theme.colors.irisGleam,
    fontWeight: "700",
  },
  activityTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm + 1,
    fontWeight: "600",
    color: theme.colors.cloud,
    marginBottom: 2,
  },
  activitySkillChip: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
    backgroundColor: "rgba(132, 125, 255, 0.10)",
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
  },
  activitySkillChipText: {
    fontFamily: theme.fonts.sans,
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.paleIris,
  },
  activityObjective: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.micro + 2,
    color: theme.colors.ash,
    lineHeight: 16,
  },
  activityCardRight: {
    marginLeft: 8,
  },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
  },
  categoryTile: {
    flexGrow: 1,
    flexBasis: "100%",
    borderRadius: theme.radii.tile,
    padding: 24,
    minHeight: 190,
    justifyContent: "space-between",
    ...theme.shadows.card,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  categoryTileWide: {
    flexBasis: "47%",
  },
  categoryTileMono: {
    color: theme.colors.pure,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "700",
  },
  categoryTileHeading: {
    fontSize: 22,
    fontFamily: theme.fonts.serif,
    color: theme.colors.pure,
    lineHeight: 28,
    marginVertical: 10,
  },
  categoryTileDesc: {
    fontSize: 13,
    fontFamily: theme.fonts.sans,
    color: "rgba(255, 255, 255, 0.88)",
    lineHeight: 18,
    marginBottom: 16,
  },
  categoryTileCta: {
    fontSize: 12,
    fontWeight: "700",
    fontFamily: theme.fonts.sans,
    color: theme.colors.pure,
  },
  tabHeroSection: {
    marginBottom: 4,
  },
  tabHeroEyebrow: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.paleIris,
    letterSpacing: 1.0,
    fontWeight: "700",
    marginBottom: 2,
  },
  tabHeroHeadline: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingMd,
    color: theme.colors.cloud,
    marginBottom: 4,
  },
  tabHeroSubhead: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    lineHeight: 18,
  },
  stagePill: {
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
  },
  stagePillText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.paleIris,
    fontWeight: "700",
  },
  cefrRefText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.fog,
  },
  lessonTitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.headingSm,
    fontWeight: "700",
    color: theme.colors.cloud,
    marginBottom: 6,
  },
  lessonRule: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    lineHeight: 18,
    marginBottom: 10,
  },
  goalTipBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.abyss,
    padding: 10,
    borderRadius: theme.radii.sm,
    gap: 8,
  },
  goalTipText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.cloud,
  },
  skillRow: {
    paddingVertical: 10,
  },
  skillRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
  },
  skillRowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  skillNameText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.cloud,
    fontWeight: "600",
  },
  skillPercentText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.ash,
  },
  skillTrack: {
    height: 6,
    backgroundColor: theme.colors.abyss,
    borderRadius: 3,
    overflow: "hidden",
  },
  skillFill: {
    height: "100%",
    borderRadius: 3,
  },
  mistakeCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 10,
  },
  mistakeCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  mistakeTag: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.xs,
  },
  mistakeTagText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.paleIris,
    fontWeight: "700",
  },
  mistakeSeverityText: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.amberWarning,
    fontWeight: "600",
  },
  mistakeCompareBox: {
    backgroundColor: "rgba(255, 82, 82, 0.08)",
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.crimsonError,
    borderRadius: theme.radii.xs,
    padding: 10,
  },
  saidHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
  },
  saidLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.crimsonError,
    fontWeight: "700",
  },
  saidText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.cloud,
    fontStyle: "italic",
  },
  recastCompareBox: {
    backgroundColor: "rgba(56, 211, 159, 0.08)",
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.emeraldSuccess,
    borderRadius: theme.radii.xs,
    padding: 10,
  },
  recastHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
  },
  recastLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.emeraldSuccess,
    fontWeight: "700",
  },
  recastText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.pure,
    fontWeight: "600",
  },
  mistakeWhyText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.ash,
    lineHeight: 16,
  },
  vocabCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 6,
  },
  vocabHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  vocabTerm: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.subheading,
    fontWeight: "700",
    color: theme.colors.pure,
  },
  vocabContext: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    fontStyle: "italic",
  },
  vocabTipBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.abyss,
    padding: 8,
    borderRadius: theme.radii.sm,
    gap: 6,
    marginTop: 4,
  },
  vocabTipText: {
    flex: 1,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.paleIris,
  },
  profileHeroCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  avatarLargeCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 2,
    borderColor: theme.colors.irisGleam,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.sm,
  },
  profileTitle: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingSm,
    color: theme.colors.pure,
    marginBottom: 2,
  },
  profileBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
    marginTop: 4,
    marginBottom: theme.spacing.md,
  },
  profileLevelBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radii.full,
  },
  profileLevelBadgeText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.paleIris,
  },
  profileCefrBadge: {
    backgroundColor: theme.colors.abyss,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radii.full,
  },
  profileCefrBadgeText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.fog,
  },
  profileActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  profileInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  profileInfoRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 0,
  },
  profileInfoLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.fog,
  },
  profileInfoValue: {
    flexShrink: 1,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "600",
    color: theme.colors.cloud,
    textAlign: "right",
  },
  retakeAssessmentBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radii.full,
    gap: 6,
  },
  retakeAssessmentBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.paleIris,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
  },
  statBox: {
    flex: 1,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  statNum: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.headingSm,
    fontWeight: "700",
    color: theme.colors.pure,
    marginTop: 6,
    marginBottom: 2,
  },
  statLbl: {
    fontFamily: theme.fonts.mono,
    fontSize: 9,
    color: theme.colors.fog,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  settingsGroupTitle: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ash,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  settingsGroupDesc: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.fog,
    lineHeight: 16,
    marginBottom: 12,
  },
  supportChipsRow: {
    flexDirection: "row",
    gap: 6,
  },
  voiceList: {
    gap: 6,
  },
  voiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  voiceRowActive: {
    borderColor: theme.colors.irisGleam,
    backgroundColor: theme.colors.surfaceElevated,
  },
  voiceRowText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.fog,
  },
  voiceRowTextActive: {
    color: theme.colors.pure,
    fontWeight: "600",
  },
  supportChip: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  supportChipActive: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.irisGleam,
  },
  supportChipText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.fog,
    fontWeight: "700",
  },
  supportChipTextActive: {
    color: theme.colors.pure,
  },
  timeChipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  timeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: theme.colors.abyss,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  timeChipActive: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.irisGleam,
  },
  timeChipText: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    color: theme.colors.ash,
    fontWeight: "600",
  },
  timeChipTextActive: {
    color: theme.colors.pure,
  },
  feedbackBanner: {
    backgroundColor: "rgba(56, 211, 159, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(56, 211, 159, 0.28)",
    borderRadius: theme.radii.sm,
    padding: 10,
    marginBottom: 12,
  },
  feedbackBannerText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.emeraldSuccess,
  },
  notifActionsRow: {
    flexDirection: "row",
  },
  notifActionBtn: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radii.sm,
  },
  notifActionBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.pure,
  },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    height: 44,
    borderRadius: theme.radii.sm,
    gap: 8,
    marginBottom: 10,
  },
  signOutBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "600",
    color: theme.colors.pure,
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 40,
    gap: 6,
  },
  deleteBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.crimsonError,
  },
  bottomTabBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.glassNav,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: theme.spacing.sm,
    zIndex: 100,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
  },
  tabItemActive: {},
  tabItemLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 10,
    fontWeight: "500",
    color: theme.colors.fog,
    marginTop: 3,
  },
  tabItemLabelActive: {
    color: theme.colors.pure,
    fontWeight: "600",
  },
  btnPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
});

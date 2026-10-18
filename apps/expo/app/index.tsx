/**
 * Pravaah — Mobile-First Central Learning Hub & Dashboard
 *
 * Designed for native mobile touch interaction:
 * - Native Mobile App Bar (Top) with user greeting, streak flame pill, and level badge
 * - Fixed Frosted Glass Bottom Navigation Bar (Plan, Lessons, Mistakes, Vocab, Profile)
 * - Thumb-friendly touch targets, fluid card elevations, and safe area handling
 * - 100% Realtime Backend Data sync with zero mock fallbacks
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
import { activityObjective, activityTitle, skillLabel } from "../lib/skills";
import { AppTheme, ThemeColors, theme, useTheme } from "../lib/theme";
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendLocalNotification,
  scheduleDailyPracticeReminder,
} from "../lib/notifications";

type NavTab = "plan" | "lessons" | "mistakes" | "vocabulary" | "profile";

const FOCUS_REASON_LABELS: Record<FocusSkill["reason"], string> = {
  recent_mistakes: "Recent mistakes",
  recent_vocabulary_errors: "Vocabulary to retry",
  failed_repetitions: "Keeps slipping",
  unfinished_lesson: "Unfinished lesson",
  low_mastery: "Needs work",
  developing: "Developing",
  mastered: "Mastered",
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
  const { colors, isDark, mode: themeMode, setMode: setThemeMode, toggleTheme, theme: activeTheme } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark, activeTheme), [colors, isDark, activeTheme]);
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
        <ActivityIndicator size="large" color={colors.irisBlue} />
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
              source={
                isDark
                  ? require("../assets/pravaah_navbar_logo.png")
                  : require("../assets/pravaah_navbar_logo_dark.png")
              }
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
          <View style={styles.streakBadge} accessibilityLabel={`${streakDays} day streak`}>
            <Ionicons name="flame" size={16} color={streakDays > 0 ? colors.amberWarning : colors.fog} />
            <Text style={styles.streakCount}>{streakDays}</Text>
          </View>

          <Pressable
            style={({ pressed }) => [styles.levelBadge, pressed && styles.btnPressed]}
            onPress={() => (userLevel === "unassessed" ? router.push("/assessment") : setActiveTab("profile"))}
          >
            <Text style={styles.levelBadgeText}>
              {userLevel === "unassessed" ? "Take test" : `Level ${userLevel}`}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.themeBtn, pressed && styles.btnPressed]}
            onPress={toggleTheme}
            accessibilityRole="button"
            accessibilityLabel={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={18} color={colors.textSecondary} />
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
                color={activeTab === "profile" ? colors.textOnPrimary : colors.textSecondary}
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
            paddingBottom: theme.mobile.tabBarHeight + Math.max(insets.bottom, 12) + 28,
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.irisBlue}
            colors={[colors.irisBlue]}
          />
        }
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={colors.crimsonError} />
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
              <View style={styles.heroTopRow}>
                <View style={styles.heroEyebrowPill}>
                  <View
                    style={[
                      styles.greenPulse,
                      userLevel === "unassessed" && { backgroundColor: colors.amberWarning },
                    ]}
                  />
                  <Text style={styles.heroEyebrowText}>
                    {userLevel === "unassessed" ? "Level not assessed yet" : `Level ${userLevel} · ${levelName}`}
                  </Text>
                </View>
                {userLevel !== "unassessed" ? (
                  <Text style={styles.heroCefrText}>CEFR {cefrRef}</Text>
                ) : null}
              </View>

              <Text style={styles.heroHeadline}>
                {firstName ? `Welcome back, ${firstName.charAt(0).toUpperCase()}${firstName.slice(1)}` : "Welcome back"}
              </Text>
              <Text style={styles.heroSubhead}>
                {userLevel === "unassessed"
                  ? "Take a 3-minute speaking test so your coach can plan lessons at the right level."
                  : "Speak, get a short correction, then use it again in your own words."}
              </Text>

              {userLevel === "unassessed" ? (
                <Pressable
                  style={({ pressed }) => [styles.primaryHeroBtn, pressed && styles.btnPressed]}
                  onPress={() => router.push("/assessment")}
                >
                  <Ionicons name="mic-outline" size={20} color={colors.textOnPrimary} />
                  <Text style={styles.primaryHeroBtnText}>Start speaking test</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.primaryHeroBtn, pressed && styles.btnPressed]}
                  onPress={handleStartNextActivity}
                  disabled={savingGoal || refreshingPlan}
                >
                  <Ionicons name="mic-outline" size={20} color={colors.textOnPrimary} />
                  <Text style={styles.primaryHeroBtnText} numberOfLines={1}>
                    {nextUnfinishedActivity
                      ? `Continue: ${activityTitle(nextUnfinishedActivity.title).split(":")[0]}`
                      : "Start today's practice"}
                  </Text>
                </Pressable>
              )}
            </View>

            {/* DAILY GOAL & PROGRESS */}
            <View style={styles.cardContainer}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Daily goal</Text>
                <Text style={styles.progressPercentText}>
                  {completedMins} / {currentGoal} min
                </Text>
              </View>

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
                  <ActivityIndicator size="small" color={colors.irisBlue} />
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
              <Text style={styles.sectionTitle}>Today's exercises</Text>
              <Pressable
                style={({ pressed }) => [styles.refreshPlanBtn, pressed && styles.btnPressed]}
                onPress={handleRefreshPlan}
                disabled={refreshingPlan || savingGoal}
              >
                {refreshingPlan ? (
                  <ActivityIndicator size="small" color={colors.irisBlue} />
                ) : (
                  <>
                    <Ionicons name="refresh" size={15} color={colors.irisBlue} />
                    <Text style={styles.refreshPlanText}>Rebuild</Text>
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
                  <Ionicons name="sparkles-outline" size={28} color={colors.irisBlue} />
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
                            <Ionicons name="checkmark" size={18} color={colors.emeraldSuccess} />
                          ) : isCurrent ? (
                            <Ionicons name="play" size={15} color={colors.textOnPrimary} />
                          ) : (
                            <Text style={styles.stepNumText}>{idx + 1}</Text>
                          )}
                        </View>
                      </View>

                      <View style={styles.activityCardBody}>
                        <Text style={styles.activityTitle} numberOfLines={2}>
                          {activityTitle(activity.title)}
                        </Text>
                        <Text style={styles.activityObjective} numberOfLines={2}>
                          {activityObjective(activity.objective)}
                        </Text>
                        <View style={styles.activityBadgeRow}>
                          <Ionicons name={modeIcon as any} size={13} color={colors.textMuted} />
                          <Text style={styles.activityDurationText}>
                            {activity.mode === "free_conversation"
                              ? "Conversation"
                              : activity.mode === "grammar_practice"
                              ? "Grammar"
                              : activity.mode === "roleplay"
                              ? "Roleplay"
                              : activity.mode === "review"
                              ? "Review"
                              : "Vocabulary"}
                            {" · "}
                            {activity.duration_minutes} min
                          </Text>
                          {activity.is_completed ? (
                            <View style={styles.doneBadge}>
                              <Text style={styles.doneBadgeText}>Done</Text>
                            </View>
                          ) : isCurrent ? (
                            <View style={styles.upNextBadge}>
                              <Text style={styles.upNextBadgeText}>Up next</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>

                      <View style={styles.activityCardRight}>
                        <Ionicons
                          name="chevron-forward"
                          size={18}
                          color={isCurrent ? colors.irisBlue : colors.fog}
                        />
                      </View>
                    </Pressable>
                  );
                })
              )}
            </View>

            {/* PRACTICE MODES */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Practice modes</Text>
            </View>

            <View style={styles.categoryGrid}>
              {([
                {
                  key: "grammar",
                  title: "Grammar",
                  desc: "Fix the mistakes you repeat most",
                  icon: "construct-outline",
                  bg: colors.lavenderWash,
                  fg: colors.lavenderText,
                  params: {
                    mode: "grammar_practice",
                    target_skill: profile?.current_focus || "past_simple_auxiliary",
                    activity_title: "Targeted Grammar Practice",
                  },
                },
                {
                  key: "vocabulary",
                  title: "Vocabulary",
                  desc: "Natural phrases and collocations",
                  icon: "book-outline",
                  bg: colors.solarGradient,
                  fg: colors.solarText,
                  params: {
                    mode: "vocabulary_practice",
                    target_skill: "collocations",
                    activity_title: "Collocations & Phrasing",
                  },
                },
                {
                  key: "conversation",
                  title: "Conversation",
                  desc: "Talk freely with gentle corrections",
                  icon: "chatbubbles-outline",
                  bg: colors.aquaGradient,
                  fg: colors.powderText,
                  params: { mode: "free_conversation", activity_title: "Coached Conversation" },
                },
                {
                  key: "roleplay",
                  title: "Roleplay",
                  desc: "Interviews, meetings and daily situations",
                  icon: "people-outline",
                  bg: colors.peachGradient,
                  fg: colors.peachText,
                  params: { mode: "roleplay", activity_title: "Workplace Dialogue Simulation" },
                },
              ] as const).map((item) => (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.categoryTile, pressed && styles.btnPressed]}
                  onPress={() => router.push({ pathname: "/session", params: item.params })}
                >
                  <View style={[styles.categoryIconCircle, { backgroundColor: item.bg }]}>
                    <Ionicons name={item.icon} size={20} color={item.fg} />
                  </View>
                  <Text style={styles.categoryTileHeading}>{item.title}</Text>
                  <Text style={styles.categoryTileDesc} numberOfLines={2}>
                    {item.desc}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: LESSONS & FOCUS */}
        {/* ================================================================= */}
        {activeTab === "lessons" && (
          <View style={styles.tabContent}>
            <View style={styles.tabHeroSection}>
              <Text style={styles.tabHeroHeadline}>Lessons</Text>
              <Text style={styles.tabHeroSubhead}>
                Ordered by what your recent speaking shows you need most.
              </Text>
            </View>

            {/* Recommended Lesson Banner */}
            {profile?.recommended_lesson ? (
              <View style={styles.cardContainer}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.stagePill}>
                    <Text style={styles.stagePillText}>
                      {profile.recommended_lesson.stage
                        ? profile.recommended_lesson.stage.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
                        : "Recommended"}
                    </Text>
                  </View>
                  <Text style={styles.cefrRefText}>
                    {Math.round((profile.recommended_lesson.mastery_score || 0) * 100)}% mastery
                  </Text>
                </View>

                <Text style={styles.lessonTitle}>{profile.recommended_lesson.lesson_title}</Text>
                <Text style={styles.lessonRule}>{profile.recommended_lesson.rule_summary}</Text>

                <View style={styles.goalTipBox}>
                  <Ionicons name="information-circle-outline" size={18} color={colors.irisBlue} />
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
                  <Text style={styles.primaryHeroBtnText}>Start lesson</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Ionicons name="clipboard-outline" size={28} color={colors.irisBlue} />
                <Text style={styles.emptyCardText}>
                  Complete a 3-minute spoken assessment to receive tailored recommendations.
                </Text>
                <Pressable
                  style={[styles.smallActionBtn, { marginTop: 12 }]}
                  onPress={() => router.push("/assessment")}
                >
                  <Text style={styles.smallActionBtnText}>Take the speaking test</Text>
                </Pressable>
              </View>
            )}

            {/* Curriculum Skills Mastery List */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Fix these first</Text>
              <Text style={styles.sectionBadge}>By priority</Text>
            </View>

            {focusSkills.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="trending-up-outline" size={28} color={colors.irisBlue} />
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
                                    ? colors.emeraldSuccess
                                    : skill.mastery > 0.5
                                    ? colors.irisBlue
                                    : colors.amberWarning,
                              },
                            ]}
                          />
                        </View>

                        <View style={styles.focusMetaRow}>
                          <View style={styles.focusReasonPill}>
                            <Text style={styles.focusReasonText}>
                              {FOCUS_REASON_LABELS[skill.reason] || skill.reason.replace(/_/g, " ")}
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
              <Text style={styles.sectionTitle}>Lesson history</Text>
              <Text style={styles.sectionBadge}>{lessons.length}</Text>
            </View>

            <View style={styles.activityList}>
              {lessons.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="time-outline" size={28} color={colors.irisBlue} />
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
                            {done ? "Completed" : (lesson.completion_status || "Recommended").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
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
                            delta > 0 && { color: colors.emeraldSuccess },
                            delta < 0 && { color: colors.crimsonError },
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
              <Text style={styles.tabHeroHeadline}>Mistakes</Text>
              <Text style={styles.tabHeroSubhead}>
                Grouped by grammar point. Tap one to see each correction by day.
              </Text>
            </View>

            {mistakes.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="checkmark-circle-outline" size={32} color={colors.emeraldSuccess} />
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
                          color={colors.fog}
                        />
                      </Pressable>

                      {open ? (
                        <View style={styles.skillGroupBody}>
                          {group.days.map((day) => (
                            <View key={day.key} style={styles.dayBlock}>
                              <Text style={styles.dayBlockLabel}>{day.label}</Text>

                              {day.items.map((m) => (
                                <View key={m.mistake_id} style={styles.mistakeCard}>
                                  <View style={styles.mistakeCardHeader}>
                                    <View style={styles.mistakeTag}>
                                      <Text style={styles.mistakeTagText}>
                                        {(m.category || "Grammar").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                                      </Text>
                                    </View>
                                    <Text style={styles.mistakeSeverityText}>
                                      {(m.severity || "medium").replace(/^\w/, (c) => c.toUpperCase())} priority
                                    </Text>
                                  </View>

                                  <View style={styles.mistakeCompareBox}>
                                    <View style={styles.saidHeader}>
                                      <Ionicons name="close-circle" size={15} color={colors.crimsonError} />
                                      <Text style={styles.saidLabel}>You said</Text>
                                    </View>
                                    <Text style={styles.saidText}>"{m.original}"</Text>
                                  </View>

                                  <View style={styles.recastCompareBox}>
                                    <View style={styles.recastHeader}>
                                      <Ionicons name="checkmark-circle" size={15} color={colors.emeraldSuccess} />
                                      <Text style={styles.recastLabel}>Better</Text>
                                    </View>
                                    <Text style={styles.recastText}>"{m.corrected}"</Text>
                                  </View>

                                  {m.explanation ? (
                                    <Text style={styles.mistakeWhyText}>{m.explanation}</Text>
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
                              Practise {group.title}
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
              <Text style={styles.tabHeroHeadline}>Vocabulary</Text>
              <Text style={styles.tabHeroSubhead}>
                Words and phrases collected from your conversations.
              </Text>
            </View>

            <View style={styles.activityList}>
              {vocabulary.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="book-outline" size={32} color={colors.irisBlue} />
                  <Text style={styles.emptyCardText}>
                    Vocabulary and collocations from your voice sessions will automatically be collected here.
                  </Text>
                </View>
              ) : (
                vocabulary.map((v) => (
                  <View key={v.vocabulary_id} style={styles.vocabCard}>
                    <View style={styles.vocabHeaderRow}>
                      <Text style={styles.vocabTerm}>{v.term || v.word || "Expression"}</Text>
                      <Ionicons name="bookmark" size={18} color={colors.irisBlue} />
                    </View>

                    {v.context || v.example ? (
                      <Text style={styles.vocabContext}>"{v.context || v.example}"</Text>
                    ) : null}

                    {v.natural_usage_tip || v.meaning ? (
                      <View style={styles.vocabTipBox}>
                        <Ionicons name="sparkles" size={15} color={colors.irisBlue} />
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
                  <Ionicons name="person" size={32} color={colors.textOnPrimary} />
                )}
              </View>
              <Text style={styles.profileTitle}>{displayName || "Your profile"}</Text>
              {profile?.email ? (
                <Text style={styles.profileEmail}>{profile.email}</Text>
              ) : null}

              <View style={styles.profileBadgeRow}>
                <View style={styles.profileLevelBadge}>
                  <Ionicons name="ribbon-outline" size={14} color={colors.irisBlue} />
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
                  <Ionicons name="create-outline" size={16} color={colors.textPrimary} />
                  <Text style={styles.editProfileBtnText}>Edit profile</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [styles.retakeAssessmentBtn, pressed && styles.btnPressed]}
                  onPress={() => router.push("/assessment")}
                >
                  <Ionicons name="mic-outline" size={16} color={colors.irisBlue} />
                  <Text style={styles.retakeAssessmentBtnText}>
                    {userLevel === "unassessed" ? "Take speaking test" : "Retake speaking test"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Quick Stats Grid */}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Ionicons name="chatbubbles-outline" size={18} color={colors.irisBlue} />
                <Text style={styles.statNum}>{totalSessions}</Text>
                <Text style={styles.statLbl}>Sessions</Text>
              </View>
              <View style={styles.statBox}>
                <Ionicons name="time-outline" size={18} color={colors.irisBlue} />
                <Text style={styles.statNum}>{totalMinutes}m</Text>
                <Text style={styles.statLbl}>Practised</Text>
              </View>
              <View style={styles.statBox}>
                <Ionicons name="flame-outline" size={18} color={colors.amberWarning} />
                <Text style={styles.statNum}>{streakDays}</Text>
                <Text style={styles.statLbl}>Day streak</Text>
              </View>
            </View>

            {/* Learning snapshot from real recorded evidence */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>Your learning</Text>
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

            {/* Appearance / Theme Mode Selector */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>Appearance</Text>
              <Text style={styles.settingsGroupDesc}>Choose a light or dark interface.</Text>
              <View style={styles.supportChipsRow}>
                {([
                  { value: "light", label: "Light", icon: "sunny-outline" },
                  { value: "dark", label: "Dark", icon: "moon-outline" },
                ] as const).map((opt) => {
                  const active = themeMode === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      style={[styles.supportChip, styles.themeChip, active && styles.supportChipActive]}
                      onPress={() => setThemeMode(opt.value)}
                    >
                      <Ionicons name={opt.icon} size={16} color={active ? colors.irisBlue : colors.textSecondary} />
                      <Text style={[styles.supportChipText, active && styles.supportChipTextActive]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Coach voice */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>Coach voice</Text>
              <Text style={styles.settingsGroupDesc}>
                Choose who you practise with. This applies to your next session.
              </Text>

              <View style={styles.voiceList}>
                {COACH_VOICES.map((voice) => {
                  const active = (profile?.tts_voice || "warm_male") === voice.value;
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
                        color={active ? colors.irisBlue : colors.fog}
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
              <Text style={styles.settingsGroupTitle}>Hindi explanations</Text>
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
                      {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Notifications & Reminders */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>Practice reminders</Text>
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
                    <Text style={styles.notifActionBtnText}>Enable reminders</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.notifActionBtn}
                    onPress={handleTestNotification}
                  >
                    <Text style={styles.notifActionBtnText}>Send test reminder</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {/* Account Actions */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>Account</Text>
              <Pressable
                style={({ pressed }) => [styles.signOutBtn, pressed && styles.btnPressed]}
                onPress={handleSignOut}
              >
                <Ionicons name="log-out-outline" size={18} color={colors.textPrimary} />
                <Text style={styles.signOutBtnText}>Sign out</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.deleteBtn, pressed && styles.btnPressed]}
                onPress={handleDeleteAccount}
              >
                <Ionicons name="trash-outline" size={16} color={colors.crimsonError} />
                <Text style={styles.deleteBtnText}>Delete account and history</Text>
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
        {([
          { key: "plan", label: "Plan", iconOn: "calendar", iconOff: "calendar-outline" },
          { key: "lessons", label: "Lessons", iconOn: "library", iconOff: "library-outline" },
          { key: "mistakes", label: "Mistakes", iconOn: "alert-circle", iconOff: "alert-circle-outline" },
          { key: "vocabulary", label: "Vocab", iconOn: "bookmark", iconOff: "bookmark-outline" },
          { key: "profile", label: "Profile", iconOn: "person", iconOff: "person-outline" },
        ] as const).map((tab) => {
          const active = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={styles.tabItem}
              onPress={() => setActiveTab(tab.key)}
            >
              <View style={[styles.tabIconPill, active && styles.tabIconPillActive]}>
                <Ionicons
                  name={(active ? tab.iconOn : tab.iconOff) as any}
                  size={20}
                  color={active ? colors.irisBlue : colors.fog}
                />
              </View>
              <Text style={[styles.tabItemLabel, active && styles.tabItemLabelActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Edit profile */}
      <Modal visible={editingProfile} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.editSheet, { paddingBottom: Math.max(insets.bottom + 16, 20) }]}>
            <Text style={styles.editSheetTitle}>Edit profile</Text>

            <Text style={styles.inputLabelText}>Display name</Text>
            <TextInput
              style={styles.editInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="How should your coach address you?"
              placeholderTextColor={colors.fog}
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
                  <ActivityIndicator size="small" color={colors.textOnPrimary} />
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

function createStyles(colors: ThemeColors, isDark: boolean, activeTheme: AppTheme) {
  const card = {
    backgroundColor: colors.cardElevated,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    ...activeTheme.shadows.sm,
  };
  const chip = {
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardElevated,
  };
  const chipActive = {
    backgroundColor: colors.primarySoft,
    borderColor: colors.irisBlue,
  };
  const label = {
    fontFamily: theme.fonts.sans,
    fontSize: 13,
    fontWeight: "500" as const,
    color: colors.textSecondary,
  };

  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
    loadingContainer: {
      flex: 1,
      backgroundColor: colors.canvas,
      justifyContent: "center",
      alignItems: "center",
      gap: 12,
    },
    loadingText: label,
    mobileAppBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 10,
      backgroundColor: colors.cardElevated,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      zIndex: 10,
    },
    appBarLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flexShrink: 1,
    },
    appBarGreeting: {
      ...label,
      flexShrink: 1,
    },
    appBarBrand: {
      flexDirection: "row",
      alignItems: "center",
    },
    brandLogoImage: {
      width: 104,
      height: 40,
    },
    appBarRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    streakBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      height: 36,
    },
    streakCount: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    levelBadge: {
      ...chip,
      height: 34,
      paddingHorizontal: 12,
      justifyContent: "center",
    },
    levelBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: colors.irisBlue,
    },
    themeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarBtnActive: {
      backgroundColor: colors.irisBlue,
    },
    avatarInitials: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "600",
      color: colors.powderText,
    },
    avatarLargeInitials: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    profileEmail: {
      ...label,
      marginTop: 2,
    },
    editProfileBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      minHeight: 42,
      paddingHorizontal: 16,
      borderRadius: 12,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
    },
    editProfileBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    editSheet: {
      ...card,
      width: "100%",
      maxWidth: 460,
      alignSelf: "center",
      padding: theme.spacing.xl,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(10, 13, 18, 0.55)",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    editSheetTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 20,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: theme.spacing.lg,
    },
    inputLabelText: {
      ...label,
      color: colors.textPrimary,
      marginBottom: 6,
    },
    editInput: {
      height: 50,
      borderRadius: 12,
      backgroundColor: colors.cardSubtle,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: theme.spacing.md,
      color: colors.textPrimary,
      fontFamily: theme.fonts.sans,
      fontSize: theme.fontSizes.body,
    },
    editHintText: {
      ...label,
      fontSize: 12,
      color: colors.textMuted,
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
      fontSize: 15,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    editSaveBtn: {
      minHeight: 44,
      minWidth: 100,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 20,
      borderRadius: 12,
      backgroundColor: colors.primary,
    },
    editSaveText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    btnDisabledSoft: {
      opacity: 0.45,
    },
    refreshPlanBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      minHeight: 32,
      paddingHorizontal: 4,
    },
    refreshPlanText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.irisBlue,
    },
    planRationaleText: {
      ...label,
      lineHeight: 19,
      marginTop: -10,
    },
    skillGroupCard: {
      ...card,
      overflow: "hidden",
    },
    skillGroupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: theme.spacing.lg,
      minHeight: theme.mobile.minTouchSize,
    },
    skillGroupHeaderText: {
      flex: 1,
    },
    skillGroupTitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    skillGroupMeta: {
      ...label,
      marginTop: 2,
    },
    skillGroupCountPill: {
      minWidth: 28,
      height: 24,
      paddingHorizontal: 8,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radii.full,
      backgroundColor: colors.cardSubtle,
    },
    skillGroupCountText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    skillGroupBody: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.lg,
      gap: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: theme.spacing.md,
    },
    dayBlock: {
      gap: 10,
    },
    dayBlockLabel: {
      ...label,
      fontSize: 12,
      fontWeight: "600",
      color: colors.textMuted,
    },
    focusCardRow: {
      ...card,
      flexDirection: "row",
      gap: 14,
      padding: theme.spacing.lg,
    },
    focusCardRowTop: {
      borderColor: colors.irisBlue,
    },
    focusRankBadge: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardSubtle,
    },
    focusRankText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    focusCardBody: {
      flex: 1,
      gap: 8,
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
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    focusMasteryText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    focusMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
    },
    focusReasonPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: colors.lavenderWash,
    },
    focusReasonText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.lavenderText,
    },
    focusMetaText: {
      ...label,
      fontSize: 12,
    },
    focusRuleText: {
      ...label,
      lineHeight: 19,
    },
    lessonHistoryCard: {
      ...card,
      padding: theme.spacing.lg,
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
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
      textTransform: "capitalize",
    },
    lessonHistoryMetaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    lessonHistoryMeta: {
      ...label,
      fontSize: 12,
      textTransform: "capitalize",
    },
    mainContainer: {
      flex: 1,
    },
    mainScroll: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      width: "100%",
      alignSelf: "center",
    },
    tabContent: {
      gap: theme.spacing.lg,
    },
    errorBanner: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.crimsonWash,
      borderRadius: 12,
      padding: 12,
      gap: 8,
      marginBottom: theme.spacing.sm,
    },
    errorBannerText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.crimsonError,
    },
    heroActionCard: {
      ...card,
      padding: theme.spacing.xl,
    },
    heroTopRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: theme.spacing.md,
    },
    heroEyebrowPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    greenPulse: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.emeraldSuccess,
    },
    heroEyebrowText: label,
    heroCefrText: {
      ...label,
      color: colors.textMuted,
    },
    heroHeadline: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      color: colors.textPrimary,
      lineHeight: 32,
      letterSpacing: -0.5,
      marginBottom: 6,
    },
    heroSubhead: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      color: colors.textSecondary,
      lineHeight: 22,
      marginBottom: theme.spacing.lg,
    },
    primaryHeroBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary,
      height: 52,
      borderRadius: 14,
      paddingHorizontal: 20,
      gap: 8,
    },
    primaryHeroBtnText: {
      flexShrink: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    cardContainer: {
      ...card,
      padding: theme.spacing.xl,
    },
    cardHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: theme.spacing.md,
    },
    cardTitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    progressPercentText: {
      ...label,
      color: colors.textPrimary,
      fontWeight: "600",
    },
    goalChipsRow: {
      flexDirection: "row",
      gap: 4,
      padding: 4,
      borderRadius: 12,
      backgroundColor: colors.cardSubtle,
      marginBottom: theme.spacing.lg,
    },
    goalChip: {
      flex: 1,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 9,
    },
    goalChipActive: {
      backgroundColor: colors.cardElevated,
      ...activeTheme.shadows.sm,
    },
    goalChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    goalChipTextActive: {
      color: colors.textPrimary,
      fontWeight: "600",
    },
    progressBarTrack: {
      height: 8,
      backgroundColor: colors.cardSubtle,
      borderRadius: theme.radii.full,
      overflow: "hidden",
      marginBottom: 10,
    },
    progressBarFill: {
      height: "100%",
      backgroundColor: colors.irisBlue,
      borderRadius: theme.radii.full,
    },
    progressSubtext: {
      ...label,
      fontSize: 12,
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
      marginTop: 8,
    },
    sectionTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 18,
      fontWeight: "600",
      color: colors.textPrimary,
      letterSpacing: -0.2,
    },
    sectionBadge: {
      ...label,
      fontSize: 12,
      color: colors.textMuted,
    },
    activityList: {
      gap: 10,
    },
    emptyCard: {
      ...card,
      padding: theme.spacing.xl,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    emptyCardText: {
      ...label,
      fontSize: 14,
      textAlign: "center",
      lineHeight: 20,
    },
    smallActionBtn: {
      backgroundColor: colors.primary,
      paddingHorizontal: 18,
      paddingVertical: 11,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    smallActionBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    activityCard: {
      ...card,
      flexDirection: "row",
      alignItems: "center",
      padding: 16,
    },
    activityCardCompleted: {
      opacity: 0.7,
    },
    activityCardCurrent: {
      borderColor: colors.irisBlue,
      borderWidth: 1.5,
    },
    activityCardLeft: {
      marginRight: 14,
    },
    stepIconCircle: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.cardSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    stepCircleCompleted: {
      backgroundColor: colors.emeraldWash,
    },
    stepCircleCurrent: {
      backgroundColor: colors.primary,
    },
    stepNumText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    activityCardBody: {
      flex: 1,
      gap: 3,
    },
    activityBadgeRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
      marginTop: 6,
    },
    activityDurationText: {
      ...label,
      fontSize: 12,
      color: colors.textMuted,
    },
    doneBadge: {
      backgroundColor: colors.emeraldWash,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    doneBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.mintText,
    },
    upNextBadge: {
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    upNextBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.powderText,
    },
    activityTitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    activityObjective: {
      ...label,
      fontSize: 14,
      lineHeight: 19,
    },
    activityCardRight: {
      marginLeft: 8,
    },
    categoryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
    },
    categoryTile: {
      ...card,
      flexGrow: 1,
      flexBasis: "46%",
      padding: 16,
      gap: 4,
      ...Platform.select({
        web: { cursor: "pointer" as any },
      }),
    },
    categoryIconCircle: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    categoryTileHeading: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    categoryTileDesc: {
      ...label,
      lineHeight: 18,
    },
    tabHeroSection: {
      gap: 4,
    },
    tabHeroHeadline: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      color: colors.textPrimary,
      letterSpacing: -0.5,
    },
    tabHeroSubhead: {
      ...label,
      fontSize: 15,
      lineHeight: 21,
    },
    stagePill: {
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    stagePillText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.powderText,
    },
    cefrRefText: {
      ...label,
      fontSize: 12,
    },
    lessonTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 20,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 6,
    },
    lessonRule: {
      ...label,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: 12,
    },
    goalTipBox: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.cardSubtle,
      padding: 12,
      borderRadius: 12,
      gap: 8,
    },
    goalTipText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
    },
    skillTrack: {
      height: 6,
      backgroundColor: colors.cardSubtle,
      borderRadius: theme.radii.full,
      overflow: "hidden",
    },
    skillFill: {
      height: "100%",
      borderRadius: theme.radii.full,
    },
    mistakeCard: {
      backgroundColor: colors.cardSubtle,
      borderRadius: 14,
      padding: 14,
      gap: 10,
    },
    mistakeCardHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    mistakeTag: {
      backgroundColor: colors.cardElevated,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    mistakeTagText: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    mistakeSeverityText: {
      ...label,
      fontSize: 12,
      color: colors.textMuted,
    },
    mistakeCompareBox: {
      borderLeftWidth: 3,
      borderLeftColor: colors.crimsonError,
      paddingLeft: 10,
    },
    saidHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginBottom: 2,
    },
    saidLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "600",
      color: colors.crimsonError,
    },
    saidText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      color: colors.textSecondary,
    },
    recastCompareBox: {
      borderLeftWidth: 3,
      borderLeftColor: colors.emeraldSuccess,
      paddingLeft: 10,
    },
    recastHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginBottom: 2,
    },
    recastLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 12,
      fontWeight: "600",
      color: colors.emeraldSuccess,
    },
    recastText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    mistakeWhyText: {
      ...label,
      lineHeight: 19,
    },
    vocabCard: {
      ...card,
      padding: 18,
      gap: 8,
    },
    vocabHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    vocabTerm: {
      fontFamily: theme.fonts.sans,
      fontSize: 17,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    vocabContext: {
      ...label,
      fontSize: 15,
      fontStyle: "italic",
    },
    vocabTipBox: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.cardSubtle,
      padding: 10,
      borderRadius: 10,
      gap: 8,
      marginTop: 4,
    },
    vocabTipText: {
      flex: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textPrimary,
    },
    profileHeroCard: {
      ...card,
      padding: theme.spacing.xl,
      alignItems: "center",
    },
    avatarLargeCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.irisBlue,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.md,
    },
    profileTitle: {
      fontFamily: theme.fonts.display,
      fontSize: 22,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    profileBadgeRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
      marginTop: 10,
      marginBottom: theme.spacing.lg,
    },
    profileLevelBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
    },
    profileLevelBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.powderText,
    },
    profileCefrBadge: {
      backgroundColor: colors.cardSubtle,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
    },
    profileCefrBadgeText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    profileActionsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 10,
    },
    profileInfoRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    profileInfoRowLast: {
      borderBottomWidth: 0,
      paddingBottom: 0,
    },
    profileInfoLabel: {
      ...label,
      fontSize: 14,
    },
    profileInfoValue: {
      flexShrink: 1,
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textPrimary,
      textAlign: "right",
    },
    retakeAssessmentBtn: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 16,
      minHeight: 42,
      borderRadius: 12,
      gap: 6,
    },
    retakeAssessmentBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.powderText,
    },
    statsRow: {
      flexDirection: "row",
      gap: 10,
    },
    statBox: {
      ...card,
      flex: 1,
      padding: 14,
      alignItems: "flex-start",
    },
    statNum: {
      fontFamily: theme.fonts.display,
      fontSize: 22,
      fontWeight: "600",
      color: colors.textPrimary,
      marginTop: 8,
    },
    statLbl: {
      ...label,
      fontSize: 12,
    },
    settingsGroupTitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 4,
    },
    settingsGroupDesc: {
      ...label,
      lineHeight: 19,
      marginBottom: 14,
    },
    supportChipsRow: {
      flexDirection: "row",
      gap: 8,
    },
    voiceList: {
      gap: 8,
    },
    voiceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    voiceRowActive: {
      borderColor: colors.irisBlue,
      backgroundColor: colors.primarySoft,
    },
    voiceRowText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.textSecondary,
    },
    voiceRowTextActive: {
      color: colors.textPrimary,
      fontWeight: "600",
    },
    supportChip: {
      ...chip,
      flex: 1,
      paddingVertical: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    supportChipActive: chipActive,
    themeChip: {
      flexDirection: "row",
      gap: 6,
    },
    supportChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    supportChipTextActive: {
      color: colors.irisBlue,
      fontWeight: "600",
    },
    timeChipsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 14,
    },
    timeChip: {
      ...chip,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    timeChipActive: chipActive,
    timeChipText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.textSecondary,
    },
    timeChipTextActive: {
      color: colors.irisBlue,
      fontWeight: "600",
    },
    feedbackBanner: {
      backgroundColor: colors.emeraldWash,
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
    },
    feedbackBannerText: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.mintText,
    },
    notifActionsRow: {
      flexDirection: "row",
    },
    notifActionBtn: {
      backgroundColor: colors.primary,
      paddingHorizontal: 18,
      paddingVertical: 11,
      borderRadius: 12,
    },
    notifActionBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    signOutBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      height: 48,
      borderRadius: 12,
      gap: 8,
      marginTop: 8,
      marginBottom: 6,
    },
    signOutBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    deleteBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      height: 42,
      gap: 6,
    },
    deleteBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      color: colors.crimsonError,
    },
    bottomTabBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.cardElevated,
      borderTopWidth: 1,
      borderTopColor: colors.border,
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
    tabIconPill: {
      paddingHorizontal: 16,
      paddingVertical: 4,
      borderRadius: theme.radii.full,
    },
    tabIconPillActive: {
      backgroundColor: colors.primarySoft,
    },
    tabItemLabel: {
      fontFamily: theme.fonts.sans,
      fontSize: 11,
      fontWeight: "500",
      color: colors.textMuted,
      marginTop: 2,
    },
    tabItemLabelActive: {
      color: colors.irisBlue,
      fontWeight: "600",
    },
    btnPressed: {
      opacity: 0.85,
    },
  });
}

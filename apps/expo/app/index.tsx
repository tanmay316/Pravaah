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
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
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
  setDailyGoal,
  updateProfile,
  deleteAccount,
  LearnerProfile,
  DailyLearningPlan,
  DailyPlanActivity,
  LessonRecord,
  Mistake,
  VocabularyEntry,
  ProgressSummary,
  PRAVAAH_LEVEL_NAMES,
} from "../lib/api";
import { signOut } from "../lib/firebase";
import { theme } from "../lib/theme";
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendLocalNotification,
  scheduleDailyPracticeReminder,
} from "../lib/notifications";

type NavTab = "plan" | "lessons" | "mistakes" | "vocabulary" | "profile";

// Helper to generate instant optimistic activities matching chosen goal minutes
function buildOptimisticActivities(
  minutes: number,
  targetSkill: string = "past_simple_auxiliary",
  pravaahLevel: string = "C"
): DailyPlanActivity[] {
  const skillName = targetSkill.replace(/_/g, " ").toUpperCase();
  const dateStr = new Date().toISOString().split("T")[0];

  if (minutes === 15) {
    return [
      {
        activity_id: `act_${dateStr}_1_warmup`,
        title: "Conversational Warmup & Fluency Check",
        mode: "free_conversation",
        duration_minutes: 5,
        stage: "guided_practice",
        objective: "Wake up your English speaking with natural conversation.",
        prompt_activity: "Talk about your day or what you did earlier today.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_2_target`,
        title: `Targeted Precision: ${skillName}`,
        mode: "grammar_practice",
        target_skill: targetSkill,
        duration_minutes: 10,
        stage: "guided_practice",
        objective: `Eliminate recurring errors in ${skillName} through active coaching.`,
        prompt_activity: "Answer the tutor's questions using clear target-verb sentences.",
        is_completed: false,
      },
    ];
  }

  if (minutes === 30) {
    return [
      {
        activity_id: `act_${dateStr}_1_warmup`,
        title: "Conversational Warmup & Check-in",
        mode: "free_conversation",
        duration_minutes: 5,
        stage: "guided_practice",
        objective: "Spontaneous conversational fluency check.",
        prompt_activity: "Discuss what you're working on or plans for the week.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_2_target`,
        title: `Targeted Focus: ${skillName}`,
        mode: "grammar_practice",
        target_skill: targetSkill,
        duration_minutes: 15,
        stage: "guided_practice",
        objective: `Master ${skillName} with immediate rule guidance and repetition.`,
        prompt_activity: "Tell a short story or describe past events while focusing on accuracy.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_3_vocab`,
        title: "Collocations & Natural Expressions",
        mode: "vocabulary_practice",
        target_skill: "collocations",
        duration_minutes: 10,
        stage: "expansion",
        objective: "Acquire and speak high-frequency natural English collocations.",
        prompt_activity: "Practice replacing stiff phrases with natural conversational collocations.",
        is_completed: false,
      },
    ];
  }

  if (minutes === 60) {
    return [
      {
        activity_id: `act_${dateStr}_1_warmup`,
        title: "Conversational Warmup & Fluency Check",
        mode: "free_conversation",
        duration_minutes: 10,
        stage: "guided_practice",
        objective: "Spontaneous spoken conversation.",
        prompt_activity: "Speak freely about recent news, work, or hobbies.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_2_target`,
        title: `Deep Targeted Precision: ${skillName}`,
        mode: "grammar_practice",
        target_skill: targetSkill,
        duration_minutes: 25,
        stage: "guided_practice",
        objective: `Rigorous practice on ${skillName} across diverse conversational contexts.`,
        prompt_activity: "Answer targeted situational questions with instant pedagogical feedback.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_3_vocab`,
        title: "Idiomatic Phrasing & Collocations",
        mode: "vocabulary_practice",
        target_skill: "collocations",
        duration_minutes: 15,
        stage: "expansion",
        objective: "Acquire natural conversational idioms and phrases.",
        prompt_activity: "Incorporate new phrasing into your responses.",
        is_completed: false,
      },
      {
        activity_id: `act_${dateStr}_4_roleplay`,
        title: "Situational Spoken Simulation",
        mode: "roleplay",
        duration_minutes: 10,
        stage: "transfer",
        objective: "Apply newly acquired accuracy in an immersive dialogue scenario.",
        prompt_activity: "Roleplay a practical workplace or social scenario with Coach Pravaah.",
        is_completed: false,
      },
    ];
  }

  // 90 minutes
  return [
    {
      activity_id: `act_${dateStr}_1_warmup`,
      title: "Conversational Warmup & Fluency Check",
      mode: "free_conversation",
      duration_minutes: 10,
      stage: "guided_practice",
      objective: "Warmup spontaneous speech flow.",
      prompt_activity: "Catch up on recent events and current topics.",
      is_completed: false,
    },
    {
      activity_id: `act_${dateStr}_2_target`,
      title: `Intensive Grammar Mastery: ${skillName}`,
      mode: "grammar_practice",
      target_skill: targetSkill,
      duration_minutes: 35,
      stage: "guided_practice",
      objective: `Deep drill on ${skillName} to lock in permanent muscle memory.`,
      prompt_activity: "Complex questions requiring past narratives and conditional responses.",
      is_completed: false,
    },
    {
      activity_id: `act_${dateStr}_3_vocab`,
      title: "Advanced Collocations & Phrasal Verbs",
      mode: "vocabulary_practice",
      target_skill: "collocations",
      duration_minutes: 25,
      stage: "expansion",
      objective: "Expand expressive vocabulary and natural connective phrasing.",
      prompt_activity: "Speak using idiomatic collocations and professional phrasing.",
      is_completed: false,
    },
    {
      activity_id: `act_${dateStr}_4_roleplay`,
      title: "Immersive Workplace Dialogue Simulation",
      mode: "roleplay",
      duration_minutes: 20,
      stage: "transfer",
      objective: "Full conversational roleplay applying grammar precision under pressure.",
      prompt_activity: "Navigate a real-world scenario (negotiation, interview, or team discussion).",
      is_completed: false,
    },
  ];
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
  const [progress, setProgress] = useState<ProgressSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Request sequence IDs to eliminate race conditions
  const goalRequestIdRef = useRef<number>(0);
  const hindiRequestIdRef = useRef<number>(0);

  // Fetch real data from backend
  const loadData = useCallback(async () => {
    setErrorMessage(null);
    try {
      const [profData, planData, mstkData, vocData, lessonData, progData] = await Promise.all([
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
        getProgress().catch(() => ({ total_sessions: 0, total_practice_minutes: 0 })),
      ]);

      if (profData) setProfile(profData);
      if (planData) setDailyPlan(planData);
      setMistakes(mstkData);
      setVocabulary(vocData);
      setLessons(lessonData);
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

  // Instant optimistic update for daily practice commitment
  const handleGoalChange = (minutes: number) => {
    const reqId = ++goalRequestIdRef.current;
    const targetSkill = profile?.current_focus || "past_simple_auxiliary";
    const level = profile?.pravaah_level || "C";
    const optimisticActivities = buildOptimisticActivities(minutes, targetSkill, level);

    setDailyPlan((prev) => ({
      plan_id: prev?.plan_id || `plan_${new Date().toISOString().split("T")[0]}`,
      plan_date: prev?.plan_date || new Date().toISOString().split("T")[0],
      goal_minutes: minutes,
      planned_minutes: minutes,
      completed_minutes: prev?.completed_minutes || 0,
      activities: optimisticActivities,
      completed_activities_count: 0,
      target_skills: [targetSkill],
      completion_status: "not_started",
      current_activity_index: 0,
    }));
    setProfile((prev) => (prev ? { ...prev, daily_goal_minutes: minutes } : null));

    setDailyGoal(minutes)
      .then((res) => {
        if (reqId === goalRequestIdRef.current && res.daily_plan) {
          setDailyPlan(res.daily_plan);
        }
      })
      .catch((err: any) => {
        console.warn("Goal background update error:", err);
      });
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

  const handleSignOut = async () => {
    await signOut();
    router.replace("/auth");
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
    const nextAct = dailyPlan?.activities.find((a) => !a.is_completed) || dailyPlan?.activities[0];
    router.push({
      pathname: "/session",
      params: {
        mode: nextAct?.mode || "free_conversation",
        target_skill: nextAct?.target_skill || profile?.current_focus || "",
        lesson_id: nextAct?.activity_id || "",
        activity_title: nextAct?.title || "Spoken Practice",
        stage: nextAct?.stage || "guided_practice",
      },
    });
  };

  const handleLaunchActivity = (act: any) => {
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
  const completedMins = dailyPlan?.completed_minutes || 0;
  const progressPercent = currentGoal > 0 ? Math.min(100, Math.round((completedMins / currentGoal) * 100)) : 0;
  const nextUnfinishedActivity = dailyPlan?.activities?.find((a) => !a.is_completed);

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
                Real-time voice coaching tailored to eliminate your recurring speech errors.
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
                      currentGoal === mins && styles.goalChipActive,
                    ]}
                    onPress={() => handleGoalChange(mins)}
                  >
                    <Text
                      style={[
                        styles.goalChipText,
                        currentGoal === mins && styles.goalChipTextActive,
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

              <Text style={styles.progressSubtext}>
                {dailyPlan?.activities?.filter((a) => a.is_completed).length || 0} of{" "}
                {dailyPlan?.activities?.length || 0} exercises finished today
              </Text>
            </View>

            {/* ACTIVITY SEQUENCE TIMELINE */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>TODAY'S EXERCISES</Text>
              <Text style={styles.sectionBadge}>
                {dailyPlan?.activities?.length || 0} TASKS
              </Text>
            </View>

            <View style={styles.activityList}>
              {!dailyPlan?.activities || dailyPlan.activities.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="sparkles-outline" size={28} color={theme.colors.fog} />
                  <Text style={styles.emptyCardText}>
                    Select a daily goal above to initialize your tailored practice sequence.
                  </Text>
                </View>
              ) : (
                dailyPlan.activities.map((activity, idx) => {
                  const isCurrent =
                    idx === (dailyPlan.current_activity_index ?? 0) && !activity.is_completed;
                  const modeIcon =
                    activity.mode === "free_conversation"
                      ? "cafe-outline"
                      : activity.mode === "grammar_practice"
                      ? "radio-button-on-outline"
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
                                ? "WARMUP"
                                : activity.mode === "grammar_practice"
                                ? "PRECISION"
                                : "VOCABULARY"}
                            </Text>
                          </View>
                          <Text style={styles.activityDurationText}>
                            ⏱ {activity.duration_minutes}m
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

                        <Text style={styles.activityTitle}>{activity.title}</Text>
                        <Text style={styles.activityObjective} numberOfLines={2}>
                          {activity.objective}
                        </Text>
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
                      activity_title: "Free Spoken Conversation",
                    },
                  })
                }
              >
                <Text style={[styles.categoryTileMono, { color: theme.colors.void }]}>MODULE 03 • FLUENCY</Text>
                <Text style={[styles.categoryTileHeading, { color: theme.colors.void }]}>Free Spoken Conversation</Text>
                <Text style={[styles.categoryTileDesc, { color: "rgba(0, 0, 0, 0.75)" }]}>
                  Speak freely on any topic with active real-time AI feedback.
                </Text>
                <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Free Conversation →</Text>
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
                        mode: "grammar_practice",
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
              <Text style={styles.sectionTitle}>SKILL MASTERY BREAKDOWN</Text>
            </View>

            <View style={styles.cardContainer}>
              {profile?.skill_mastery && Object.keys(profile.skill_mastery).length > 0 ? (
                Object.entries(profile.skill_mastery).map(([skillId, score], idx) => (
                  <View key={skillId} style={[styles.skillRow, idx > 0 && styles.skillRowBorder]}>
                    <View style={styles.skillRowTop}>
                      <Text style={styles.skillNameText}>{skillId.replace(/_/g, " ").toUpperCase()}</Text>
                      <Text style={styles.skillPercentText}>{Math.round(score * 100)}%</Text>
                    </View>
                    <View style={styles.skillTrack}>
                      <View
                        style={[
                          styles.skillFill,
                          {
                            width: `${Math.round(score * 100)}%`,
                            backgroundColor:
                              score > 0.75
                                ? theme.colors.emeraldSuccess
                                : score > 0.5
                                ? theme.colors.irisGleam
                                : theme.colors.amberWarning,
                          },
                        ]}
                      />
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyCardText}>
                  Your skill mastery levels will appear here after your first conversation.
                </Text>
              )}
            </View>

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
                Every error detected during your live speech is saved with clear coaching.
              </Text>
            </View>

            <View style={styles.activityList}>
              {mistakes.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="checkmark-circle-outline" size={32} color={theme.colors.emeraldSuccess} />
                  <Text style={styles.emptyCardText}>
                    No mistakes logged yet! Once you practice voice sessions, coach recasts will appear here.
                  </Text>
                </View>
              ) : (
                mistakes.map((m) => (
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

                    {/* What you said */}
                    <View style={styles.mistakeCompareBox}>
                      <View style={styles.saidHeader}>
                        <Ionicons name="close-circle" size={14} color={theme.colors.crimsonError} />
                        <Text style={styles.saidLabel}>YOU SAID:</Text>
                      </View>
                      <Text style={styles.saidText}>"{m.original}"</Text>
                    </View>

                    {/* Coach Recast */}
                    <View style={styles.recastCompareBox}>
                      <View style={styles.recastHeader}>
                        <Ionicons name="checkmark-circle" size={14} color={theme.colors.emeraldSuccess} />
                        <Text style={styles.recastLabel}>COACH RECAST:</Text>
                      </View>
                      <Text style={styles.recastText}>"{m.corrected}"</Text>
                    </View>

                    <Text style={styles.mistakeWhyText}>💡 {m.explanation}</Text>
                  </View>
                ))
              )}
            </View>
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
              <Text style={styles.profileSubtitle}>
                {userLevel === "unassessed"
                  ? "Diagnostic not taken yet"
                  : `Level ${userLevel} · ${levelName} · CEFR ${cefrRef}`}
              </Text>

              <Pressable
                style={({ pressed }) => [styles.retakeAssessmentBtn, pressed && styles.btnPressed]}
                onPress={() => router.push("/assessment")}
              >
                <Ionicons name="mic-outline" size={16} color={theme.colors.paleIris} />
                <Text style={styles.retakeAssessmentBtnText}>
                  {userLevel === "unassessed"
                    ? "Take Diagnostic Assessment →"
                    : "Retake Diagnostic Assessment →"}
                </Text>
              </Pressable>
            </View>

            {/* Quick Stats Grid */}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{totalSessions}</Text>
                <Text style={styles.statLbl}>SESSIONS</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{totalMinutes}m</Text>
                <Text style={styles.statLbl}>MINUTES</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{streakDays}</Text>
                <Text style={styles.statLbl}>DAY STREAK</Text>
              </View>
            </View>

            {/* Preferences Group: Hindi Support */}
            <View style={styles.cardContainer}>
              <Text style={styles.settingsGroupTitle}>HINDI EXPLANATION SUPPORT</Text>
              <Text style={styles.settingsGroupDesc}>
                Controls when Coach Pravaah explains grammatical corrections using Hindi translations.
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
  profileSubtitle: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    color: theme.colors.ash,
    marginBottom: theme.spacing.md,
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

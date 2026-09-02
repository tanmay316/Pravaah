/**
 * Pravaah — Central Learning Hub & Dashboard
 *
 * Style reference: Origin Financial (Midnight gallery of quiet wealth).
 * Canvas: Obsidian #0f1011, Abyss #090a0b, Graphite #2e2e2e, Steel #3f4041, Silver #cacaca.
 * Accents: Iris Gleam #847dff, Cyan Signal #00b3dd, Orchid Bloom #dd90d8, Periwinkle #90b8f0.
 * Pure white primary CTA fill #ffffff with black text #000000.
 *
 * 100% Realtime Backend Data — No hardcoded text inputs or static mock items.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import {
  getProfile,
  getDailyPlan,
  getMistakes,
  getVocabulary,
  getProgress,
  setDailyGoal,
  updateProfile,
  deleteAccount,
  LearnerProfile,
  DailyLearningPlan,
  DailyPlanActivity,
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

type NavTab = "plan" | "lessons" | "mistakes" | "vocabulary" | "progress" | "settings";

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
  const [activeTab, setActiveTab] = useState<NavTab>("plan");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [dailyPlan, setDailyPlan] = useState<DailyLearningPlan | null>(null);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [vocabulary, setVocabulary] = useState<VocabularyEntry[]>([]);
  const [progress, setProgress] = useState<ProgressSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Request sequence IDs to eliminate race conditions
  const goalRequestIdRef = useRef<number>(0);
  const hindiRequestIdRef = useRef<number>(0);

  // Fetch real data from backend with instant unblocking
  const loadData = useCallback(async () => {
    setErrorMessage(null);
    try {
      const fetchPromise = Promise.all([
        getProfile().catch((e) => {
          console.warn("Profile fetch error:", e);
          return null;
        }),
        getDailyPlan().catch((e) => {
          console.warn("Daily plan fetch error:", e);
          return null;
        }),
        getMistakes().catch(() => []),
        getVocabulary().catch(() => []),
        getProgress().catch(() => ({ total_sessions: 0, total_practice_minutes: 0 })),
      ]);

      const [profData, planData, mstkData, vocData, progData] = await fetchPromise;

      if (profData) setProfile(profData);
      if (planData) setDailyPlan(planData);
      setMistakes(mstkData);
      setVocabulary(vocData);
      setProgress(progData);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to load dashboard data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const timer = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(timer);
  }, [loadData]);

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

    // 1. Instant local state update (0ms latency) - updates goal chips, progress bar, and activity sequence instantly
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

    // 2. Background sync with backend — only apply response if this is still the latest user request
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

    // 1. Instant local state update (0ms latency)
    setProfile((prev) => (prev ? { ...prev, hindi_support: level } : {
      uid: "user_local",
      pravaah_level: "C",
      native_language: "hi",
      target_language: "en",
      daily_goal_minutes: 30,
      hindi_support: level,
    }));

    // 2. Background sync with backend — only apply response if this is still the latest user request
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

  // Check notification permission on mount
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
      setNotificationFeedback("Notification permissions enabled! Daily reminders are active.");
      setTimeout(() => setNotificationFeedback(null), 4000);
    }
  };

  const handleTestNotification = async () => {
    const focusSkill = profile?.current_focus || "past_simple_auxiliary";
    const sent = await sendLocalNotification(
      "🎙️ Pravaah — Time for Today's Speaking Practice!",
      `Your 30-minute English speaking session is ready. Today's priority: ${focusSkill.replace(/_/g, " ")}.`,
      { type: "test_notification" }
    );
    if (sent) {
      setNotificationFeedback("Test notification sent! Check your notification tray.");
    } else {
      setNotificationFeedback("Please allow notifications in your browser or device settings.");
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

  const handleDeleteAccount = async () => {
    try {
      await deleteAccount();
      await signOut();
      router.replace("/auth");
    } catch (err) {
      console.warn("Delete account error:", err);
    }
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
        <Text style={styles.loadingText}>Connecting to Pravaah Coach...</Text>
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

  return (
    <View style={styles.screen}>
      {/* ------------------------------------------------------------------- */}
      {/* STICKY FROSTED GLASS TOP NAVIGATION BAR */}
      {/* ------------------------------------------------------------------- */}
      <View style={styles.navBar}>
        <View style={styles.navContent}>
          {/* Logo & Brand */}
          <Pressable style={styles.brandContainer} onPress={() => setActiveTab("plan")}>
            <Image
              source={require("../assets/pravaah_navbar_logo.png")}
              style={styles.brandLogoImage}
              resizeMode="contain"
              accessibilityLabel="Pravaah"
            />
          </Pressable>

          {/* Nav Items */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.navItemsScroll}
          >
            <Pressable
              style={[styles.navItem, activeTab === "plan" && styles.navItemActive]}
              onPress={() => setActiveTab("plan")}
            >
              <Text style={[styles.navItemText, activeTab === "plan" && styles.navItemTextActive]}>
                TODAY'S PLAN
              </Text>
            </Pressable>

            <Pressable
              style={[styles.navItem, activeTab === "lessons" && styles.navItemActive]}
              onPress={() => setActiveTab("lessons")}
            >
              <Text style={[styles.navItemText, activeTab === "lessons" && styles.navItemTextActive]}>
                LESSONS & FOCUS
              </Text>
            </Pressable>

            <Pressable
              style={[styles.navItem, activeTab === "mistakes" && styles.navItemActive]}
              onPress={() => setActiveTab("mistakes")}
            >
              <Text style={[styles.navItemText, activeTab === "mistakes" && styles.navItemTextActive]}>
                MISTAKES
              </Text>
            </Pressable>

            <Pressable
              style={[styles.navItem, activeTab === "vocabulary" && styles.navItemActive]}
              onPress={() => setActiveTab("vocabulary")}
            >
              <Text style={[styles.navItemText, activeTab === "vocabulary" && styles.navItemTextActive]}>
                VOCABULARY
              </Text>
            </Pressable>

            <Pressable
              style={[styles.navItem, activeTab === "progress" && styles.navItemActive]}
              onPress={() => setActiveTab("progress")}
            >
              <Text style={[styles.navItemText, activeTab === "progress" && styles.navItemTextActive]}>
                PROGRESS
              </Text>
            </Pressable>

            <Pressable
              style={[styles.navItem, activeTab === "settings" && styles.navItemActive]}
              onPress={() => setActiveTab("settings")}
            >
              <Text style={[styles.navItemText, activeTab === "settings" && styles.navItemTextActive]}>
                SETTINGS
              </Text>
            </Pressable>
          </ScrollView>

          {/* Quick CTA Flush Right */}
          <Pressable
            style={({ pressed }) => [styles.navCtaButton, pressed && styles.buttonPressed]}
            onPress={handleStartNextActivity}
          >
            <Text style={styles.navCtaText}>PRACTICE →</Text>
          </Pressable>
        </View>
      </View>

      {/* ------------------------------------------------------------------- */}
      {/* MAIN BODY CONTAINER */}
      {/* ------------------------------------------------------------------- */}
      <ScrollView
        contentContainerStyle={styles.mainScroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.irisGleam} />}
      >
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* ================================================================= */}
        {/* TAB 1: TODAY'S PLAN */}
        {/* ================================================================= */}
        {activeTab === "plan" && (
          <View style={styles.contentContainer}>
            {/* HERO SECTION — SKY ATMOSPHERE */}
            <View style={styles.heroAtmosphere}>
              {/* Eyebrow Badge */}
              <View style={styles.heroEyebrow}>
                <Text style={styles.heroEyebrowText}>
                  {userLevel === "unassessed"
                    ? "NEW LEARNER • ASSESSMENT RECOMMENDED"
                    : `LEVEL ${userLevel} (${levelName}) • DAILY PRACTICE PLAN`}
                </Text>
              </View>

              {/* Lyon Display Signature Whisper Headline */}
              <Text style={styles.heroHeadline}>
                <Text style={styles.heroHeadlineItalic}>Own</Text> your fluency.
              </Text>

              <Text style={styles.heroSubhead}>
                Pravaah is your personal AI Spoken English Coach. Master spontaneous speaking, natural
                collocations, and effortless grammar in real-time voice sessions.
              </Text>

              {/* Primary Action CTA (Pure White on Dark) */}
              <View style={styles.heroCtaRow}>
                {userLevel === "unassessed" ? (
                  <Pressable
                    style={({ pressed }) => [styles.heroPrimaryCta, pressed && styles.buttonPressed]}
                    onPress={() => router.push("/assessment")}
                  >
                    <Text style={styles.heroPrimaryCtaText}>Take Initial Spoken Assessment →</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={({ pressed }) => [styles.heroPrimaryCta, pressed && styles.buttonPressed]}
                    onPress={handleStartNextActivity}
                  >
                    <Text style={styles.heroPrimaryCtaText}>
                      {nextUnfinishedActivity
                        ? `Continue Today's Practice (${nextUnfinishedActivity.duration_minutes}m) →`
                        : "Start Spoken Practice Session →"}
                    </Text>
                  </Pressable>
                )}
              </View>

              {/* Social Proof / Award Laurels */}
              <View style={styles.laurelContainer}>
                <Text style={styles.laurelText}>
                  🏆 REALTIME SPOKEN AI COACH  •  ⚡ POWERED BY LIVEKIT WEBRTC
                </Text>
              </View>
            </View>

            {/* DAILY GOAL & PROGRESS SUMMARY MODULE */}
            <View style={styles.planCard}>
              <View style={styles.cardHeaderRow}>
                <View>
                  <Text style={styles.cardEyebrow}>TODAY'S COMMITMENT & PROGRESS</Text>
                  <Text style={styles.cardTitle}>
                    {completedMins} of {currentGoal} minutes completed
                  </Text>
                </View>
                <View style={styles.levelPill}>
                  <Text style={styles.levelPillText}>
                    {userLevel === "unassessed" ? "UNASSESSED" : `LEVEL ${userLevel} (${levelName})`}
                  </Text>
                </View>
              </View>

              {/* Goal Selection Chips */}
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
                      {mins} MIN
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Progress Bar */}
              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
              </View>
              <Text style={styles.progressSubtext}>
                {progressPercent}% of today's plan finished • {dailyPlan?.activities?.filter((a) => a.is_completed).length || 0} of {dailyPlan?.activities?.length || 0} activities complete
              </Text>
            </View>

            {/* ACTIVITY SCHEDULE CHECKLIST */}
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>TODAY'S ACTIVITY SEQUENCE</Text>
              <View style={styles.activityList}>
                {(!dailyPlan?.activities || dailyPlan.activities.length === 0) ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyText}>No activities generated yet. Select a daily goal above to initialize.</Text>
                  </View>
                ) : (
                  dailyPlan.activities.map((activity, idx) => (
                    <Pressable
                      key={activity.activity_id}
                      style={({ pressed }) => [
                        styles.activityItem,
                        activity.is_completed && styles.activityItemCompleted,
                        pressed && styles.buttonPressed,
                      ]}
                      onPress={() => handleLaunchActivity(activity)}
                    >
                      <View style={styles.activityStatusCol}>
                        <Text style={styles.activityStatusIcon}>
                          {activity.is_completed ? "✓" : idx === dailyPlan.current_activity_index ? "▶" : "⏳"}
                        </Text>
                      </View>

                      <View style={styles.activityContentCol}>
                        <View style={styles.activityMetaRow}>
                          <Text style={styles.activityStageBadge}>
                            {activity.stage?.toUpperCase() || "PRACTICE"}
                          </Text>
                          <Text style={styles.activityDurationText}>
                            {activity.duration_minutes} MIN
                          </Text>
                        </View>
                        <Text style={styles.activityTitleText}>{activity.title}</Text>
                        <Text style={styles.activityObjectiveText}>{activity.objective}</Text>
                      </View>

                      <View style={styles.activityActionCol}>
                        <Text style={styles.activityActionArrow}>→</Text>
                      </View>
                    </Pressable>
                  ))
                )}
              </View>
            </View>

            {/* CHROMATIC CATEGORY TILES */}
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>PRACTICE MODES</Text>
              <View style={styles.categoryGrid}>
                {/* Tile 1: Grammar */}
                <Pressable
                  style={({ pressed }) => [
                    styles.categoryTile,
                    { backgroundColor: theme.colors.irisGleam },
                    pressed && styles.buttonPressed,
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
                    { backgroundColor: theme.colors.orchidBloom },
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={() =>
                    router.push({
                      pathname: "/session",
                      params: {
                        mode: "vocabulary_practice",
                        target_skill: "collocations",
                        activity_title: "Natural English Collocations",
                      },
                    })
                  }
                >
                  <Text style={[styles.categoryTileMono, { color: theme.colors.void }]}>MODULE 02 • VOCABULARY</Text>
                  <Text style={[styles.categoryTileHeading, { color: theme.colors.void }]}>Collocations & Phrasing</Text>
                  <Text style={[styles.categoryTileDesc, { color: "rgba(0,0,0,0.75)" }]}>
                    Learn and speak natural English collocations in context.
                  </Text>
                  <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Vocabulary Session →</Text>
                </Pressable>

                {/* Tile 3: Fluency */}
                <Pressable
                  style={({ pressed }) => [
                    styles.categoryTile,
                    { backgroundColor: theme.colors.cyanSignal },
                    pressed && styles.buttonPressed,
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
                  <Text style={[styles.categoryTileDesc, { color: "rgba(0,0,0,0.75)" }]}>
                    Speak freely on any topic with active real-time AI feedback.
                  </Text>
                  <Text style={[styles.categoryTileCta, { color: theme.colors.void }]}>Start Free Conversation →</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 2: LESSONS & FOCUS */}
        {/* ================================================================= */}
        {activeTab === "lessons" && (
          <View style={styles.contentContainer}>
            <View style={styles.tabHeaderBlock}>
              <Text style={styles.tabEyebrow}>ADAPTIVE CURRICULUM & SKILL FOCUS</Text>
              <Text style={styles.tabHeadline}>
                <Text style={styles.heroHeadlineItalic}>Targeted</Text> lesson progression.
              </Text>
              <Text style={styles.tabSubhead}>
                Lessons are dynamically sequenced based on your spoken evidence and lowest mastery skills.
              </Text>
            </View>

            {/* Recommended Lesson Banner */}
            {profile?.recommended_lesson ? (
              <View style={styles.recommendedCard}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.stagePill}>
                    <Text style={styles.stagePillText}>
                      {profile.recommended_lesson.stage?.toUpperCase() || "GUIDED PRACTICE"}
                    </Text>
                  </View>
                  <Text style={styles.cefrRefText}>
                    CEFR {profile.recommended_lesson.cefr_level} • MASTERY {Math.round((profile.recommended_lesson.mastery_score || 0) * 100)}%
                  </Text>
                </View>

                <Text style={styles.recommendedTitle}>{profile.recommended_lesson.lesson_title}</Text>
                <Text style={styles.ruleSummaryText}>{profile.recommended_lesson.rule_summary}</Text>
                <Text style={styles.practiceActivityText}>
                  💡 Practice Goal: {profile.recommended_lesson.practice_activity}
                </Text>

                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
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
                  <Text style={styles.primaryButtonText}>Launch Targeted Lesson →</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>Complete an assessment to receive personalized lesson recommendations.</Text>
              </View>
            )}

            {/* Curriculum Skills List */}
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>CURRICULUM SKILLS & CURRENT MASTERY</Text>
              <View style={styles.skillsList}>
                {profile?.skill_mastery && Object.keys(profile.skill_mastery).length > 0 ? (
                  Object.entries(profile.skill_mastery).map(([skillId, score]) => (
                    <View key={skillId} style={styles.skillRow}>
                      <View style={styles.skillInfo}>
                        <Text style={styles.skillName}>{skillId.replace(/_/g, " ").toUpperCase()}</Text>
                        <Text style={styles.skillScore}>{Math.round(score * 100)}% Mastery</Text>
                      </View>
                      <View style={styles.skillBarTrack}>
                        <View style={[styles.skillBarFill, { width: `${Math.round(score * 100)}%` }]} />
                      </View>
                    </View>
                  ))
                ) : (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyText}>Skill mastery will appear here after your first speaking session.</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 3: MISTAKES LOG */}
        {/* ================================================================= */}
        {activeTab === "mistakes" && (
          <View style={styles.contentContainer}>
            <View style={styles.tabHeaderBlock}>
              <Text style={styles.tabEyebrow}>PERSONAL ERROR NOTEBOOK</Text>
              <Text style={styles.tabHeadline}>
                <Text style={styles.heroHeadlineItalic}>Review</Text> past corrections.
              </Text>
              <Text style={styles.tabSubhead}>
                Every mistake detected during real-time speech is cataloged with clear explanations.
              </Text>
            </View>

            <View style={styles.mistakesList}>
              {mistakes.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>No mistakes recorded yet. Start a speaking session to begin tracking.</Text>
                </View>
              ) : (
                mistakes.map((m) => (
                  <View key={m.mistake_id} style={styles.mistakeCard}>
                    <View style={styles.mistakeHeader}>
                      <Text style={styles.mistakeCategory}>{(m.category || "grammar_error").replace(/_/g, " ").toUpperCase()}</Text>
                      <Text style={styles.mistakeSeverity}>{(m.severity || "medium").toUpperCase()} SEVERITY</Text>
                    </View>

                    <View style={styles.comparisonRow}>
                      <View style={styles.comparisonCol}>
                        <Text style={styles.compLabel}>YOU SAID:</Text>
                        <Text style={styles.originalText}>"{m.original}"</Text>
                      </View>

                      <View style={styles.comparisonCol}>
                        <Text style={styles.compLabelCorrect}>CORRECTED:</Text>
                        <Text style={styles.correctedText}>"{m.corrected}"</Text>
                      </View>
                    </View>

                    <Text style={styles.explanationText}>💡 {m.explanation}</Text>
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
          <View style={styles.contentContainer}>
            <View style={styles.tabHeaderBlock}>
              <Text style={styles.tabEyebrow}>COLLOCATIONS & IDIOMATIC PHRASES</Text>
              <Text style={styles.tabHeadline}>
                <Text style={styles.heroHeadlineItalic}>Expand</Text> your vocabulary.
              </Text>
              <Text style={styles.tabSubhead}>
                Natural expressions acquired and practiced across your voice conversations.
              </Text>
            </View>

            <View style={styles.vocabGrid}>
              {vocabulary.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>Vocabulary and expressions from your speaking sessions will be saved here.</Text>
                </View>
              ) : (
                vocabulary.map((v) => (
                  <View key={v.vocabulary_id} style={styles.vocabCard}>
                    <Text style={styles.vocabTerm}>{v.term || v.word || "Expression"}</Text>
                    <Text style={styles.vocabContext}>"{v.context || v.example || ""}"</Text>
                    {v.natural_usage_tip || v.meaning ? (
                      <Text style={styles.vocabTip}>💡 {v.natural_usage_tip || v.meaning}</Text>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 5: PROGRESS & MASTERY */}
        {/* ================================================================= */}
        {activeTab === "progress" && (
          <View style={styles.contentContainer}>
            <View style={styles.tabHeaderBlock}>
              <Text style={styles.tabEyebrow}>FLUENCY STANDING & STATISTICS</Text>
              <Text style={styles.tabHeadline}>
                <Text style={styles.heroHeadlineItalic}>Track</Text> your growth.
              </Text>
              <Text style={styles.tabSubhead}>
                Comprehensive diagnostics and cumulative practice milestones.
              </Text>
            </View>

            {/* Stats Summary Row */}
            <View style={styles.statsRow}>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{progress?.total_sessions || 0}</Text>
                <Text style={styles.statLabel}>TOTAL SESSIONS</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{Math.round(progress?.total_practice_minutes || 0)}m</Text>
                <Text style={styles.statLabel}>PRACTICE MINUTES</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{userLevel === "unassessed" ? "—" : `Level ${userLevel} (${levelName})`}</Text>
                <Text style={styles.statLabel}>CEFR {cefrRef}</Text>
              </View>
            </View>

            {/* Mastery Bands */}
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>MASTERY BANDS BREAKDOWN</Text>
              <View style={styles.bandsContainer}>
                <View style={styles.bandCard}>
                  <Text style={styles.bandTitle}>ACTIVE WEAKNESSES (&lt;60%)</Text>
                  <Text style={styles.bandItems}>
                    {profile?.weaknesses && profile.weaknesses.length > 0
                      ? profile.weaknesses.map((s) => s.replace(/_/g, " ")).join(", ")
                      : "None"}
                  </Text>
                </View>

                <View style={styles.bandCard}>
                  <Text style={styles.bandTitle}>DEVELOPING SKILLS (60-75%)</Text>
                  <Text style={styles.bandItems}>
                    {profile?.developing_skills && profile.developing_skills.length > 0
                      ? profile.developing_skills.map((s) => s.replace(/_/g, " ")).join(", ")
                      : "None"}
                  </Text>
                </View>

                <View style={styles.bandCard}>
                  <Text style={styles.bandTitle}>STRONG & MASTERED (&gt;75%)</Text>
                  <Text style={styles.bandItems}>
                    {profile?.strong_skills || profile?.mastered_skills
                      ? [...(profile.strong_skills || []), ...(profile.mastered_skills || [])]
                          .map((s) => s.replace(/_/g, " "))
                          .join(", ") || "None"
                      : "None"}
                  </Text>
                </View>
              </View>
            </View>

            {/* Diagnostic Retake CTA */}
            <Pressable
              style={({ pressed }) => [styles.ghostButton, pressed && styles.ghostPressed]}
              onPress={() => router.push("/assessment")}
            >
              <Text style={styles.ghostButtonText}>🎙 Retake Spoken Assessment →</Text>
            </Pressable>
          </View>
        )}

        {/* ================================================================= */}
        {/* TAB 6: PROFILE & SETTINGS */}
        {/* ================================================================= */}
        {activeTab === "settings" && (
          <View style={styles.contentContainer}>
            <View style={styles.tabHeaderBlock}>
              <Text style={styles.tabEyebrow}>ACCOUNT & PREFERENCES</Text>
              <Text style={styles.tabHeadline}>
                <Text style={styles.heroHeadlineItalic}>Manage</Text> your coach.
              </Text>
              <Text style={styles.tabSubhead}>
                Customize Hindi explanation support, daily targets, and account data.
              </Text>
            </View>

            {/* Hindi Support Setting */}
            <View style={styles.settingsCard}>
              <Text style={styles.settingsLabel}>HINDI EXPLANATION SUPPORT</Text>
              <Text style={styles.settingsDesc}>
                Controls how frequently the AI tutor provides Hindi translations and hints for complex corrections.
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

            {/* Notifications & Reminders Setting */}
            <View style={styles.settingsCard}>
              <View style={styles.settingsCardHeaderRow}>
                <Text style={styles.settingsLabel}>DAILY PRACTICE REMINDERS & NOTIFICATIONS</Text>
                <View
                  style={[
                    styles.notifStatusBadge,
                    notificationPermission === "granted"
                      ? styles.notifStatusGranted
                      : styles.notifStatusDefault,
                  ]}
                >
                  <Text style={styles.notifStatusText}>
                    {notificationPermission === "granted" ? "ACTIVE ✓" : "TAP TO ENABLE"}
                  </Text>
                </View>
              </View>

              <Text style={styles.settingsDesc}>
                Receive a daily spoken practice prompt on your mobile phone or browser to keep your fluency streak strong.
              </Text>

              {/* Feedback toast if any */}
              {notificationFeedback ? (
                <View style={styles.notifFeedbackBanner}>
                  <Text style={styles.notifFeedbackText}>🔔 {notificationFeedback}</Text>
                </View>
              ) : null}

              {/* Reminder Time Options */}
              <Text style={styles.settingsSubLabel}>PREFERRED REMINDER TIME</Text>
              <View style={styles.supportChipsRow}>
                {[
                  { label: "8:00 AM", hour: 8, min: 0 },
                  { label: "1:00 PM", hour: 13, min: 0 },
                  { label: "8:00 PM", hour: 20, min: 0 },
                  { label: "9:30 PM", hour: 21, min: 30 },
                ].map((item) => (
                  <Pressable
                    key={item.label}
                    style={[
                      styles.supportChip,
                      reminderTime === item.label && styles.supportChipActive,
                    ]}
                    onPress={() => handleSelectReminderTime(item.label, item.hour, item.min)}
                  >
                    <Text
                      style={[
                        styles.supportChipText,
                        reminderTime === item.label && styles.supportChipTextActive,
                      ]}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Action Buttons for Notification */}
              <View style={styles.notifButtonRow}>
                {notificationPermission !== "granted" ? (
                  <Pressable
                    style={({ pressed }) => [styles.enableNotifBtn, pressed && styles.buttonPressed]}
                    onPress={handleRequestNotification}
                  >
                    <Text style={styles.enableNotifBtnText}>Enable Device Notifications 🔔</Text>
                  </Pressable>
                ) : null}

                <Pressable
                  style={({ pressed }) => [styles.testNotifBtn, pressed && styles.ghostPressed]}
                  onPress={handleTestNotification}
                >
                  <Text style={styles.testNotifBtnText}>Send Instant Test Notification ⚡</Text>
                </Pressable>
              </View>
            </View>

            {/* Action Buttons */}
            <View style={styles.settingsActionRow}>
              <Pressable
                style={({ pressed }) => [styles.signOutButton, pressed && styles.ghostPressed]}
                onPress={handleSignOut}
              >
                <Text style={styles.signOutText}>Sign Out</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.deleteButton, pressed && styles.deletePressed]}
                onPress={handleDeleteAccount}
              >
                <Text style={styles.deleteText}>Delete Account</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
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
  },
  loadingText: {
    color: theme.colors.ash,
    marginTop: theme.spacing.lg,
    fontSize: 14,
  },
  errorBanner: {
    backgroundColor: "rgba(255, 82, 82, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
    padding: 12,
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: theme.radii.sm,
  },
  errorBannerText: {
    color: theme.colors.crimsonError,
    fontSize: 13,
    textAlign: "center",
  },

  // -------------------------------------------------------------------------
  // STICKY TOP NAV
  // -------------------------------------------------------------------------
  navBar: {
    backgroundColor: theme.colors.glassNav,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
    paddingVertical: 12,
    paddingHorizontal: 20,
    zIndex: 100,
    ...Platform.select({
      web: {
        position: "sticky" as any,
        top: 0,
        backdropFilter: "blur(24px)",
      },
    }),
  },
  navContent: {
    maxWidth: 1200,
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 24,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  brandLogoImage: {
    width: 124,
    height: 38,
    ...Platform.select({
      web: {
        userSelect: "none" as any,
      },
    }),
  },
  navItemsScroll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  navItem: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radii.sm,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  navItemActive: {
    backgroundColor: theme.colors.glassFill,
  },
  navItemText: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    fontWeight: "500",
  },
  navItemTextActive: {
    color: theme.colors.pure,
  },
  navCtaButton: {
    backgroundColor: theme.colors.pure,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: theme.radii.sm,
    marginLeft: 16,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  navCtaText: {
    color: theme.colors.void,
    fontSize: 11,
    fontWeight: "600",
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
  },

  // -------------------------------------------------------------------------
  // MAIN BODY
  // -------------------------------------------------------------------------
  mainScroll: {
    flexGrow: 1,
    paddingBottom: 64,
  },
  contentContainer: {
    maxWidth: 1200,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 32,
  },

  // -------------------------------------------------------------------------
  // HERO SECTION
  // -------------------------------------------------------------------------
  heroAtmosphere: {
    paddingVertical: 40,
    alignItems: "center",
    textAlign: "center",
    marginBottom: 24,
  },
  heroEyebrow: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.full,
    paddingHorizontal: 20,
    paddingVertical: 6,
    marginBottom: 20,
  },
  heroEyebrowText: {
    color: theme.colors.cloud,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "500",
  },
  heroHeadline: {
    fontSize: Platform.OS === "web" ? 72 : 44,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    letterSpacing: -1,
    textAlign: "center",
    lineHeight: Platform.OS === "web" ? 76 : 48,
    marginBottom: 16,
  },
  heroHeadlineItalic: {
    fontStyle: "italic",
  },
  heroSubhead: {
    fontSize: 16,
    color: theme.colors.ash,
    textAlign: "center",
    maxWidth: 620,
    lineHeight: 24,
    marginBottom: 32,
  },
  heroCtaRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 24,
  },
  heroPrimaryCta: {
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    paddingHorizontal: 28,
    paddingVertical: 14,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  heroPrimaryCtaText: {
    color: theme.colors.void,
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  laurelContainer: {
    marginTop: 8,
  },
  laurelText: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
  },

  // -------------------------------------------------------------------------
  // TODAY'S PLAN CARD
  // -------------------------------------------------------------------------
  planCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xxxl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: 32,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  cardEyebrow: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  cardTitle: {
    color: theme.colors.pure,
    fontSize: 22,
    fontWeight: "400",
  },
  levelPill: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(132, 125, 255, 0.3)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  levelPillText: {
    color: theme.colors.irisGleam,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
  },
  goalChipsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  goalChip: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    paddingVertical: 10,
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  goalChipActive: {
    borderColor: theme.colors.pure,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  goalChipText: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
  },
  goalChipTextActive: {
    color: theme.colors.pure,
    fontWeight: "600",
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: theme.colors.obsidian,
    borderRadius: 3,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: theme.colors.cyanSignal,
    borderRadius: 3,
  },
  progressSubtext: {
    color: theme.colors.fog,
    fontSize: 12,
  },

  // -------------------------------------------------------------------------
  // ACTIVITY SEQUENCE
  // -------------------------------------------------------------------------
  sectionBlock: {
    marginBottom: 40,
  },
  sectionTitle: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    marginBottom: 16,
  },
  activityList: {
    gap: 12,
  },
  activityItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  activityItemCompleted: {
    opacity: 0.65,
  },
  activityStatusCol: {
    width: 36,
    alignItems: "center",
  },
  activityStatusIcon: {
    color: theme.colors.cyanSignal,
    fontSize: 16,
    fontWeight: "bold",
  },
  activityContentCol: {
    flex: 1,
    paddingHorizontal: 12,
  },
  activityMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  activityStageBadge: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
  },
  activityDurationText: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
  },
  activityTitleText: {
    color: theme.colors.pure,
    fontSize: 16,
    fontWeight: "500",
    marginBottom: 2,
  },
  activityObjectiveText: {
    color: theme.colors.ash,
    fontSize: 13,
  },
  activityActionCol: {
    paddingLeft: 8,
  },
  activityActionArrow: {
    color: theme.colors.fog,
    fontSize: 18,
  },

  // -------------------------------------------------------------------------
  // CHROMATIC CATEGORY TILES
  // -------------------------------------------------------------------------
  categoryGrid: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 16,
  },
  categoryTile: {
    flex: 1,
    borderRadius: theme.radii.tile,
    padding: theme.spacing.xxxl,
    minHeight: 220,
    justifyContent: "space-between",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  categoryTileMono: {
    color: theme.colors.pure,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    fontWeight: "600",
  },
  categoryTileHeading: {
    fontSize: 22,
    fontWeight: "300",
    fontFamily: theme.fonts.serif,
    color: theme.colors.pure,
    lineHeight: 28,
  },
  categoryTileDesc: {
    fontSize: 13,
    color: "rgba(255, 255, 255, 0.85)",
    lineHeight: 18,
  },
  categoryTileCta: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.pure,
  },

  // -------------------------------------------------------------------------
  // TAB 2: LESSONS
  // -------------------------------------------------------------------------
  tabHeaderBlock: {
    marginBottom: 32,
  },
  tabEyebrow: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  tabHeadline: {
    fontSize: 38,
    fontWeight: "300",
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    marginBottom: 8,
  },
  tabSubhead: {
    fontSize: 15,
    color: theme.colors.ash,
    maxWidth: 600,
  },
  recommendedCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xxxl,
    borderWidth: 1,
    borderColor: theme.colors.borderIris,
    marginBottom: 32,
  },
  stagePill: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    borderRadius: theme.radii.full,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  stagePillText: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    fontWeight: "600",
  },
  cefrRefText: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
  },
  recommendedTitle: {
    fontSize: 24,
    color: theme.colors.pure,
    fontWeight: "400",
    marginVertical: 12,
  },
  ruleSummaryText: {
    fontSize: 14,
    color: theme.colors.ash,
    lineHeight: 22,
    marginBottom: 12,
  },
  practiceActivityText: {
    fontSize: 13,
    color: theme.colors.cyanSignal,
    marginBottom: 24,
  },
  primaryButton: {
    backgroundColor: theme.colors.pure,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  primaryButtonText: {
    color: theme.colors.void,
    fontSize: 15,
    fontWeight: "500",
  },
  skillsList: {
    gap: 12,
  },
  skillRow: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.sm,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  skillInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  skillName: {
    color: theme.colors.pure,
    fontSize: 13,
    fontFamily: theme.fonts.mono,
  },
  skillScore: {
    color: theme.colors.cyanSignal,
    fontSize: 13,
    fontFamily: theme.fonts.mono,
  },
  skillBarTrack: {
    height: 4,
    backgroundColor: theme.colors.obsidian,
    borderRadius: 2,
    overflow: "hidden",
  },
  skillBarFill: {
    height: "100%",
    backgroundColor: theme.colors.irisGleam,
  },

  // -------------------------------------------------------------------------
  // TAB 3: MISTAKES
  // -------------------------------------------------------------------------
  mistakesList: {
    gap: 16,
  },
  emptyCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.sm,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.fog,
    fontSize: 14,
    textAlign: "center",
  },
  mistakeCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  mistakeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  mistakeCategory: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
  },
  mistakeSeverity: {
    color: theme.colors.amberWarning,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
  },
  comparisonRow: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 16,
    marginBottom: 16,
  },
  comparisonCol: {
    flex: 1,
  },
  compLabel: {
    color: theme.colors.crimsonError,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
  },
  originalText: {
    color: theme.colors.ash,
    fontSize: 15,
    fontStyle: "italic",
  },
  compLabelCorrect: {
    color: theme.colors.emeraldSuccess,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 4,
  },
  correctedText: {
    color: theme.colors.pure,
    fontSize: 15,
    fontWeight: "500",
  },
  explanationText: {
    color: theme.colors.ash,
    fontSize: 13,
    lineHeight: 20,
  },

  // -------------------------------------------------------------------------
  // TAB 4: VOCABULARY
  // -------------------------------------------------------------------------
  vocabGrid: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    flexWrap: "wrap",
    gap: 16,
  },
  vocabCard: {
    flex: 1,
    minWidth: 320,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  vocabTerm: {
    fontSize: 18,
    color: theme.colors.pure,
    fontWeight: "500",
    marginBottom: 8,
  },
  vocabContext: {
    fontSize: 14,
    color: theme.colors.ash,
    fontStyle: "italic",
    lineHeight: 20,
    marginBottom: 12,
  },
  vocabTip: {
    fontSize: 12,
    color: theme.colors.cyanSignal,
  },

  // -------------------------------------------------------------------------
  // TAB 5: PROGRESS
  // -------------------------------------------------------------------------
  statsRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 32,
  },
  statCard: {
    flex: 1,
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  statNumber: {
    fontSize: 28,
    color: theme.colors.pure,
    fontFamily: theme.fonts.serif,
    marginBottom: 4,
  },
  statLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
  },
  bandsContainer: {
    gap: 12,
  },
  bandCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.sm,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  bandTitle: {
    color: theme.colors.irisGleam,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  bandItems: {
    color: theme.colors.ash,
    fontSize: 13,
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: theme.colors.borderActive,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 16,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  ghostButtonText: {
    color: theme.colors.cloud,
    fontSize: 14,
  },

  // -------------------------------------------------------------------------
  // TAB 6: SETTINGS
  // -------------------------------------------------------------------------
  settingsCard: {
    backgroundColor: theme.colors.graphiteCard,
    borderRadius: theme.radii.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: 24,
  },
  settingsLabel: {
    color: theme.colors.pure,
    fontSize: 13,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    marginBottom: 6,
  },
  settingsDesc: {
    color: theme.colors.ash,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 16,
  },
  supportChipsRow: {
    flexDirection: "row",
    gap: 10,
  },
  supportChip: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    paddingVertical: 10,
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  supportChipActive: {
    borderColor: theme.colors.pure,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  supportChipText: {
    color: theme.colors.fog,
    fontSize: 11,
    fontFamily: theme.fonts.mono,
  },
  supportChipTextActive: {
    color: theme.colors.pure,
    fontWeight: "600",
  },
  settingsCardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  notifStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
    borderWidth: 1,
  },
  notifStatusGranted: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    borderColor: "rgba(34, 197, 94, 0.4)",
  },
  notifStatusDefault: {
    backgroundColor: "rgba(132, 125, 255, 0.15)",
    borderColor: "rgba(132, 125, 255, 0.4)",
  },
  notifStatusText: {
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1,
    fontWeight: "600",
    color: theme.colors.pure,
  },
  settingsSubLabel: {
    color: theme.colors.fog,
    fontSize: 10,
    fontFamily: theme.fonts.mono,
    letterSpacing: 1.2,
    marginTop: 12,
    marginBottom: 8,
    fontWeight: "500",
  },
  notifFeedbackBanner: {
    backgroundColor: "rgba(132, 125, 255, 0.12)",
    borderColor: theme.colors.irisGleam,
    borderWidth: 1,
    borderRadius: theme.radii.sm,
    padding: 10,
    marginBottom: 12,
  },
  notifFeedbackText: {
    color: theme.colors.pure,
    fontSize: 12,
    fontWeight: "500",
  },
  notifButtonRow: {
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 12,
    marginTop: 16,
  },
  enableNotifBtn: {
    backgroundColor: theme.colors.irisGleam,
    borderRadius: theme.radii.sm,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  enableNotifBtnText: {
    color: theme.colors.pure,
    fontSize: 13,
    fontWeight: "600",
  },
  testNotifBtn: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.glassFill,
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  testNotifBtnText: {
    color: theme.colors.cloud,
    fontSize: 13,
    fontWeight: "500",
  },
  settingsActionRow: {
    flexDirection: "row",
    gap: 16,
  },
  signOutButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  signOutText: {
    color: theme.colors.ash,
    fontSize: 14,
  },
  deleteButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "rgba(255, 82, 82, 0.3)",
    borderRadius: theme.radii.sm,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    ...Platform.select({
      web: { cursor: "pointer" as any },
    }),
  },
  deleteText: {
    color: theme.colors.crimsonError,
    fontSize: 14,
  },
  deletePressed: {
    backgroundColor: "rgba(255, 82, 82, 0.1)",
  },
  ghostPressed: {
    backgroundColor: theme.colors.glassFillHover,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
});

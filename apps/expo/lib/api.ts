/**
 * Pravaah — API Client (Live FastAPI Backend)
 *
 * All methods communicate directly with the real FastAPI backend on port 8000.
 * Authenticated via Firebase ID token Bearer header.
 */

import { Platform } from "react-native";
import { getIdToken } from "./firebase";

// Dynamic API base resolution
const getApiBase = (): string => {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  // Only fall back to a dev server when we are actually on a dev origin. On a
  // deployed HTTPS origin an http://host:8000 guess is blocked as mixed content.
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const { hostname, protocol } = window.location;
    const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1" || protocol === "http:";
    if (isLocalDev) {
      return `http://${hostname}:8000`;
    }
    console.error(
      "EXPO_PUBLIC_API_URL is not set. Set it to your backend URL (e.g. https://pravaah-backend.onrender.com) before building."
    );
    return "";
  }
  return "http://localhost:8000";
};

const API_BASE = getApiBase();

// ---------------------------------------------------------------------------
// Types & Models
// ---------------------------------------------------------------------------

export const PRAVAAH_LEVEL_NAMES: Record<string, string> = {
  E: "Beginner",
  D: "Basic",
  C: "Elementary",
  B: "Intermediate",
  A: "Advanced",
  S: "Mastery",
  unassessed: "Unassessed",
};

export interface CreateSessionResponse {
  session_id: string;
  livekit_token: string;
  room_name: string;
}

export interface RefreshTokenResponse {
  livekit_token: string;
  expires_at: string;
}

export interface LearnerProfile {
  uid: string;
  display_name?: string | null;
  email?: string | null;
  photo_url?: string | null;
  pravaah_level: "unassessed" | "E" | "D" | "C" | "B" | "A" | "S";
  cefr_reference?: string;
  native_language: string;
  target_language: string;
  daily_goal_minutes: number;
  hindi_support: string;
  strengths?: string[];
  weaknesses?: string[];
  developing_skills?: string[];
  strong_skills?: string[];
  mastered_skills?: string[];
  current_focus?: string | null;
  skill_mastery?: Record<string, number>;
  recommended_lesson?: PersonalizedLesson | null;
  streak_days?: number;
  total_sessions?: number;
  total_practice_minutes?: number;
  last_practice_date?: string | null;
  last_assessed_at?: string | null;
}

export interface PersonalizedLesson {
  lesson_id?: string;
  target_skill_id: string;
  lesson_title: string;
  category?: string;
  cefr_level: string;
  stage?: string;
  mastery_score: number;
  rule_summary: string;
  practice_activity: string;
  selection_reason?: string;
}

export interface LessonRecord {
  lesson_id: string;
  source_skill_id: string;
  lesson_title?: string;
  session_id?: string;
  stage?: string;
  start_time?: string;
  end_time?: string;
  duration_seconds: number;
  attempts: number;
  correction_attempts: number;
  successful_repetitions: number;
  failed_repetitions: number;
  mastery_before: number;
  mastery_after: number;
  completion_status: "recommended" | "in_progress" | "completed" | "abandoned";
  selection_reason?: string;
}

export interface AssessmentTaskEvidence {
  task_id: string;
  task_title?: string;
  prompt: string;
  transcript: string;
  duration_ms?: number;
  word_count?: number;
  pause_count?: number;
  long_pause_count?: number;
  restart_count?: number;
  response_latency_ms?: number;
  turn_count?: number;
}

export interface AssessmentObservationInput {
  session_id?: string;
  goal_minutes?: number;
  tasks?: AssessmentTaskEvidence[];
  notes?: string;
  pravaah_level?: "E" | "D" | "C" | "B" | "A" | "S";
  grammar_rating?: string;
  vocabulary_rating?: string;
  fluency_rating?: string;
  comprehension_rating?: string;
  speaking_complexity?: string;
  conversation_ability?: string;
  pronunciation_rating?: string;
  transcripts?: { question: string; response: string }[];
}

export interface AssessmentObservations {
  grammar?: string;
  vocabulary?: string;
  fluency?: string;
  comprehension?: string;
  speaking_complexity?: string;
  conversation_ability?: string;
  pronunciation?: string;
}

export interface GrammaticalBreakdown {
  error: string;
  correction: string;
  explanation: string;
}

export interface ProficiencyAssessmentRecord {
  assessment_id: string;
  user_id: string;
  pravaah_level: "E" | "D" | "C" | "B" | "A" | "S";
  cefr_reference: string;
  name: string;
  criteria: string;
  grammar_rating?: string;
  vocabulary_rating?: string;
  fluency_rating?: string;
  comprehension_rating?: string;
  speaking_complexity?: string;
  conversation_ability?: string;
  pronunciation_rating?: string;
  pronunciation?: string;
  assessment_observations?: AssessmentObservations;
  strengths: string[];
  weaknesses: string[];
  filler_words_detected?: string[];
  restarts_and_false_starts?: string[];
  grammatical_breakdowns?: GrammaticalBreakdown[];
  initial_focus: string;
  current_focus?: string;
  assessed_at: string;
  notes?: string;
  tasks_evidence?: AssessmentTaskEvidence[];
}

export interface DailyPlanActivity {
  activity_id: string;
  title: string;
  mode: string;
  target_skill?: string | null;
  duration_minutes: number;
  stage: string;
  objective: string;
  prompt_activity: string;
  is_completed: boolean;
  session_id?: string | null;
  completed_at?: string | null;
  learner_speaking_time_seconds?: number | null;
  idle_time_seconds?: number | null;
}

export interface DailyLearningPlan {
  plan_id: string;
  plan_date: string;
  goal_minutes: number;
  planned_minutes: number;
  completed_minutes: number;
  activities: DailyPlanActivity[];
  completed_activities_count: number;
  target_skills: string[];
  completion_status: "not_started" | "in_progress" | "completed";
  current_activity_index: number;
  total_learner_speaking_seconds?: number | null;
  total_idle_seconds?: number | null;
}

export interface Mistake {
  mistake_id: string;
  session_id: string;
  message_id?: string;
  category: string;
  curriculum_skill_id?: string;
  original: string;
  corrected: string;
  explanation: string;
  severity: "low" | "medium" | "high";
  confidence?: number;
  created_at?: string;
  timestamp?: string;
  repeated_correctly?: boolean;
}

/** One curriculum skill, scored by how urgently the learner needs to practise it. */
export interface FocusSkill {
  skill_id: string;
  title: string;
  category: string;
  cefr_level: string;
  rule_summary: string;
  memory_hook?: string;
  practice_activity?: string;
  mastery: number;
  mistake_count: number;
  failed_repetitions: number;
  attempts: number;
  stage: string;
  priority_score: number;
  reason:
    | "recent_mistakes"
    | "failed_repetitions"
    | "low_mastery"
    | "developing"
    | "mastered";
  last_mistake_at?: string | null;
  recent_examples?: { original: string; corrected: string }[];
}

export interface VocabularyEntry {
  vocabulary_id: string;
  session_id?: string;
  term?: string;
  word?: string;
  meaning?: string;
  context?: string;
  example?: string;
  alternative?: string;
  natural_usage_tip?: string;
  last_seen?: string;
}

export interface ProgressSummary {
  total_sessions: number;
  total_practice_minutes: number;
}

export interface SessionSummary {
  session_id: string;
  mode: string;
  start_time: string;
  end_time?: string | null;
  target_skill?: string | null;
  lesson_id?: string | null;
  duration_seconds?: number;
  metrics?: Record<string, any>;
  summary?: string | null;
  state?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken();
  if (!token) {
    throw new Error("NOT_AUTHENTICATED");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch<T>(path: string, options: RequestInit = {}, timeoutMs: number = 60000): Promise<T> {
  const headers = await authHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.error?.message || `API Error (${response.status}): ${response.statusText}`;
      throw new Error(message);
    }

    return response.json();
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("Cloud server response timed out. The server may be waking up. Please retry.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Real API Methods
// ---------------------------------------------------------------------------

export async function getProfile(): Promise<LearnerProfile> {
  return apiFetch<LearnerProfile>("/api/me/profile", { method: "GET" });
}

export async function updateProfile(updates: Partial<LearnerProfile>): Promise<LearnerProfile> {
  return apiFetch<LearnerProfile>("/api/me/profile", {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function getDailyPlan(): Promise<DailyLearningPlan> {
  return apiFetch<DailyLearningPlan>("/api/me/daily-plan", { method: "GET" });
}

export async function setDailyGoal(
  goalMinutes: number
): Promise<{ status: string; daily_goal_minutes: number; daily_plan: DailyLearningPlan }> {
  return apiFetch<{ status: string; daily_goal_minutes: number; daily_plan: DailyLearningPlan }>(
    "/api/me/daily-plan/goal",
    {
      method: "POST",
      body: JSON.stringify({ goal_minutes: goalMinutes }),
    }
  );
}

export async function completeDailyActivity(
  activityId: string,
  sessionId?: string,
  durationMinutes?: number
): Promise<DailyLearningPlan> {
  return apiFetch<DailyLearningPlan>(
    `/api/me/daily-plan/activities/${activityId}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, duration_minutes: durationMinutes }),
    }
  );
}

export async function submitProficiencyAssessment(
  observation: AssessmentObservationInput
): Promise<{ status: string; request_id: string; assessment: any }> {
  return apiFetch<{ status: string; request_id: string; assessment: any }>(
    "/api/assessment",
    {
      method: "POST",
      body: JSON.stringify(observation),
    },
    60000 // 60s headroom for structured AI linguistic analysis
  );
}

export async function getMistakes(): Promise<Mistake[]> {
  return apiFetch<Mistake[]>("/api/me/mistakes", { method: "GET" });
}

export async function getFocusSkills(): Promise<FocusSkill[]> {
  const res = await apiFetch<{ skills: FocusSkill[] }>("/api/me/focus", { method: "GET" });
  return res.skills || [];
}

export async function refreshDailyPlan(): Promise<DailyLearningPlan> {
  return apiFetch<DailyLearningPlan>("/api/me/daily-plan/refresh", { method: "POST" });
}

export async function getVocabulary(): Promise<VocabularyEntry[]> {
  return apiFetch<VocabularyEntry[]>("/api/me/vocabulary", { method: "GET" });
}

export async function getProgress(): Promise<ProgressSummary> {
  return apiFetch<ProgressSummary>("/api/me/progress", { method: "GET" });
}

export async function getLessons(): Promise<LessonRecord[]> {
  return apiFetch<LessonRecord[]>("/api/me/lessons", { method: "GET" });
}

export async function getSessions(): Promise<SessionSummary[]> {
  return apiFetch<SessionSummary[]>("/api/me/sessions", { method: "GET" });
}

export type ConversationGoal =
  | "intro"
  | "grammar"
  | "vocabulary"
  | "roleplay"
  | "fluency"
  | "assessment";

export interface CreateSessionOptions {
  mode?: string;
  targetSkill?: string;
  lessonId?: string;
  topic?: string;
  conversationGoal?: ConversationGoal;
  roleplayScenario?: string;
}

export async function createSession(
  options: CreateSessionOptions = {}
): Promise<CreateSessionResponse> {
  return apiFetch<CreateSessionResponse>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: options.mode || "free_conversation",
      target_skill: options.targetSkill || null,
      lesson_id: options.lessonId || null,
      topic: options.topic?.trim() || null,
      conversation_goal: options.conversationGoal || null,
      roleplay_scenario: options.roleplayScenario?.trim() || null,
    }),
  });
}

export async function refreshSessionToken(sessionId: string): Promise<RefreshTokenResponse> {
  return apiFetch<RefreshTokenResponse>(`/api/sessions/${sessionId}/token/refresh`, {
    method: "POST",
  });
}

export async function completeSession(
  sessionId: string,
  durationSeconds: number,
  lessonId?: string,
  targetSkill?: string,
  messages?: any[]
): Promise<{ status: string; session_id: string; duration_minutes: number }> {
  return apiFetch<{ status: string; session_id: string; duration_minutes: number }>(
    `/api/sessions/${sessionId}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        duration_seconds: durationSeconds,
        lesson_id: lessonId,
        target_skill: targetSkill,
        messages,
      }),
    }
  );
}

export async function deleteAccount(): Promise<{ message: string; deleted: boolean }> {
  return apiFetch<{ message: string; deleted: boolean }>("/api/me/account", {
    method: "DELETE",
  });
}

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

/** Render's free tier sleeps when idle (~30s to wake); start waking it while the user signs in. */
export function wakeBackend(): void {
  if (!API_BASE) return;
  fetch(`${API_BASE}/health`).catch(() => {});
}

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

export type TtsVoice =
  | "warm_male"
  | "casual_male"
  | "british_male"
  | "indian_male"
  | "indian_female"
  | "british_female"
  | "us_female";

/** Must stay in sync with VOICE_CHOICES in services/voice-agent/coaching.py. */
export const COACH_VOICES: { value: TtsVoice; name: string; description: string }[] = [
  { value: "warm_male", name: "Arjun", description: "Warm, steady · American accent" },
  { value: "casual_male", name: "Neil", description: "Relaxed, friendly · American accent" },
  { value: "british_male", name: "Oliver", description: "Clear, calm · British accent" },
  { value: "indian_male", name: "Prabhat", description: "Easy to follow · Indian accent" },
  { value: "indian_female", name: "Ananya", description: "Gentle, clear · Indian accent" },
  { value: "british_female", name: "Sophie", description: "Bright, precise · British accent" },
  { value: "us_female", name: "Ava", description: "Upbeat, natural · American accent" },
];

export interface CreateSessionResponse {
  session_id: string;
  livekit_token: string;
  room_name: string;
  max_duration_seconds?: number | null;
}

export interface Entitlements {
  plan: "free" | "premium";
  is_premium: boolean;
  premium_until?: string | null;
  demo_available: boolean;
  demo_seconds: number;
  assessment_available: boolean;
  next_assessment_at?: string | null;
  is_admin?: boolean;
  discount_code?: string | null;
  discount_percent?: number;
}

export interface PracticeProgress {
  xp_total: number;
  xp_today: number;
  daily_xp_goal: number;
  lessons_today: number;
  cards_reviewed_today: number;
  today: string;
  week_xp: { date: string; xp: number }[];
  lessons: Record<string, { stars: number; best_accuracy: number; completed_count: number }>;
  cards: Record<string, { box: number; due: string; seen: number; correct: number }>;
  streak_days: number;
}

/** Thrown by API calls; `code` carries the server error code, e.g. PREMIUM_REQUIRED. */
export class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
  }
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
  tts_voice?: TtsVoice;
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
  priority_reason?: string | null;
  source_examples?: { original: string; corrected: string; explanation?: string | null }[];
  priority_rank?: number | null;
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
    | "recent_vocabulary_errors"
    | "failed_repetitions"
    | "unfinished_lesson"
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
      const detail = errorBody?.detail;
      const validation = Array.isArray(detail) && detail[0]?.msg
        ? String(detail[0].msg).replace(/^Value error, /, "")
        : null;
      const message = errorBody?.error?.message || detail?.error?.message ||
        (typeof detail === "string" ? detail : null) || validation ||
        `API Error (${response.status}): ${response.statusText}`;
      if (response.status >= 500) {
        reportClientError({ kind: "api", message: `${response.status} ${options.method || "GET"} ${path}: ${message}` });
      }
      throw new ApiError(message, errorBody?.error?.code || detail?.error?.code, response.status);
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

export const APP_VERSION = "1.0.0";

export interface ClientErrorInput {
  message: string;
  stack?: string;
  screen?: string;
  kind?: "crash" | "error" | "api";
}

let recentReports: number[] = [];

/** Fire-and-forget error report for the admin error log. Never throws and never recurses. */
export function reportClientError(input: ClientErrorInput): void {
  if (!API_BASE) return;
  const now = Date.now();
  recentReports = recentReports.filter((t) => now - t < 60_000);
  if (recentReports.length >= 5) return;
  recentReports.push(now);
  authHeaders()
    .catch(() => ({ "Content-Type": "application/json" }) as Record<string, string>)
    .then((headers) =>
      fetch(`${API_BASE}/api/telemetry/errors`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: (input.message || "Unknown error").slice(0, 1000),
          stack: (input.stack || "").slice(0, 4000),
          screen: (input.screen || "").slice(0, 120),
          platform: Platform.OS,
          app_version: APP_VERSION,
          kind: input.kind || "error",
        }),
      })
    )
    .catch(() => {});
}

export async function reportBug(description: string, screen = ""): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/me/bug-reports", {
    method: "POST",
    body: JSON.stringify({ description, screen, platform: Platform.OS, app_version: APP_VERSION }),
  });
}

export interface CouponRedemption {
  kind: "pro" | "discount";
  message: string;
  premium_until?: string | null;
  percent_off?: number;
}

export async function redeemCoupon(code: string): Promise<CouponRedemption> {
  return apiFetch<CouponRedemption>("/api/me/coupons/redeem", {
    method: "POST",
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });
}

export interface AiUsage {
  sessions_today: number;
  sessions_per_day: number;
  minutes_today: number;
  minutes_per_day: number;
  minutes_this_month: number;
  minutes_per_month: number;
  max_session_minutes: number;
  ai_enabled: boolean;
}

export async function getAiUsage(): Promise<AiUsage> {
  return apiFetch<AiUsage>("/api/me/ai-usage", { method: "GET" });
}

export interface PublicPlan {
  id: "monthly" | "yearly";
  product_id: string;
  title: string;
  period: string;
  price_inr: number;
  sale_price_inr: number | null;
  effective_price_inr: number;
  sale_percent_off: number;
  sale_label: string;
  sale_ends_at: string | null;
  save_vs_monthly_percent?: number;
}

/** Prices are public so the paywall can show them before sign-in. */
export async function getPricing(): Promise<PublicPlan[]> {
  const response = await fetch(`${API_BASE}/api/pricing`);
  if (!response.ok) throw new ApiError(`Pricing unavailable (${response.status})`, undefined, response.status);
  return (await response.json()).plans;
}

export interface PlanPrice {
  price_inr: number;
  sale_price_inr: number | null;
  sale_label: string;
  sale_ends_at: string | null;
}

export interface PricingConfig {
  monthly: PlanPrice;
  yearly: PlanPrice;
}

export interface AiLimits {
  ai_enabled: boolean;
  premium_sessions_per_day: number;
  premium_minutes_per_day: number;
  premium_minutes_per_month: number;
  max_session_minutes: number;
  global_minutes_per_day: number;
  assessments_per_day: number;
  plan_refreshes_per_day: number;
  analysis_attempts_per_session: number;
}

// --- Admin console -------------------------------------------------------

export interface AdminOverview {
  generated_at: string;
  days: number;
  kpis: Record<string, number>;
  money: {
    spend_usd: number;
    spend_inr: number;
    breakdown_usd: Record<"llm" | "stt" | "tts" | "livekit", number>;
    month_spend_usd: number;
    monthly_budget_usd: number;
    budget_used_percent: number;
    cost_per_session_usd: number;
    cost_per_minute_usd: number;
    cost_per_active_user_usd: number;
    cost_per_premium_user_usd: number;
    mrr_inr: number;
    premium_by_source: Record<string, number>;
    usd_to_inr: number;
  };
  rate_limits: { label: string; used: number; limit: number; unit: string; percent: number }[];
  series: { date: string; signups: number; sessions: number; cost_usd: number }[];
  top_users: { uid: string; email: string; sessions: number; minutes: number; cost_usd: number }[];
  models: {
    model: string;
    kind: string;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    audio_seconds: number;
    characters: number;
  }[];
  errors_by_source: Record<string, number>;
}

export interface AdminUserRow {
  uid: string;
  email: string;
  name: string;
  role: string;
  plan: "free" | "premium";
  premium_until?: string | null;
  premium_source?: string | null;
  created_at?: string | null;
  last_practice_date?: string | null;
  streak_days: number;
  level: string;
  demo_used: boolean;
  suspended?: boolean;
  ai_sessions_90d: number;
  ai_minutes_90d: number;
  cost_usd_90d: number;
}

export interface Coupon {
  code: string;
  kind: "pro" | "discount";
  pro_days?: number | null;
  percent_off?: number | null;
  max_redemptions: number;
  redemptions: number;
  active: boolean;
  expires_at?: string | null;
  note: string;
  batch_id?: string | null;
  created_at?: string | null;
  created_by?: string;
}

export interface CreateCouponInput {
  kind: "pro" | "discount";
  code?: string;
  count?: number;
  prefix?: string;
  pro_days?: number;
  percent_off?: number;
  max_redemptions?: number;
  expires_at?: string | null;
  note?: string;
}

export interface ErrorGroup {
  fingerprint: string;
  message: string;
  source: string;
  count: number;
  users: number;
  last_seen?: string;
  screen: string;
  platform: string;
}

export interface ErrorEvent {
  id: string;
  fingerprint?: string;
  message: string;
  source: string;
  kind?: string;
  screen?: string;
  platform?: string;
  email?: string;
  stack?: string;
  app_version?: string;
  created_at?: string;
}

export interface BugReport {
  id: string;
  description: string;
  email: string;
  uid: string;
  screen: string;
  platform: string;
  app_version: string;
  status: "open" | "in_progress" | "resolved";
  created_at?: string;
}

export interface CostSettings {
  llm_input_per_million: number;
  llm_output_per_million: number;
  stt_per_hour: number;
  tts_per_million_chars: number;
  livekit_per_agent_minute: number;
  monthly_budget_usd: number;
  usd_to_inr: number;
  llm_requests_per_day: number;
  llm_tokens_per_day: number;
  stt_requests_per_day: number;
  stt_audio_seconds_per_day: number;
  livekit_agent_minutes_per_month: number;
}

export const adminApi = {
  overview: (days: number) => apiFetch<AdminOverview>(`/api/admin/overview?days=${days}`, { method: "GET" }, 90000),
  users: (q: string) =>
    apiFetch<AdminUserRow[]>(`/api/admin/users?q=${encodeURIComponent(q)}&limit=200`, { method: "GET" }, 90000),
  setPremium: (uid: string, days: number | null, revoke = false) =>
    apiFetch<{ plan: string }>(
      `/api/admin/users/${encodeURIComponent(uid)}/premium?${revoke ? "revoke=true" : days ? `days=${days}` : ""}`,
      { method: "POST" }
    ),
  resetDemo: (uid: string) =>
    apiFetch<{ demo_available: boolean }>(`/api/admin/users/${encodeURIComponent(uid)}/reset-demo`, { method: "POST" }),
  coupons: () => apiFetch<Coupon[]>("/api/admin/coupons", { method: "GET" }),
  createCoupons: (input: CreateCouponInput) =>
    apiFetch<Coupon[]>("/api/admin/coupons", { method: "POST", body: JSON.stringify(input) }),
  updateCoupon: (code: string, changes: Partial<Pick<Coupon, "active" | "max_redemptions" | "note">>) =>
    apiFetch<Coupon>(`/api/admin/coupons/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  redemptions: (code: string) =>
    apiFetch<{ uid: string; email: string; redeemed_at: string }[]>(
      `/api/admin/coupons/${encodeURIComponent(code)}/redemptions`,
      { method: "GET" }
    ),
  errors: (days: number) =>
    apiFetch<{ groups: ErrorGroup[]; events: ErrorEvent[] }>(`/api/admin/errors?days=${days}`, { method: "GET" }),
  bugs: (status: string) => apiFetch<BugReport[]>(`/api/admin/bugs?status=${status}`, { method: "GET" }),
  updateBug: (id: string, status: BugReport["status"]) =>
    apiFetch<{ status: string }>(`/api/admin/bugs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  costSettings: () => apiFetch<CostSettings>("/api/admin/settings/costs", { method: "GET" }),
  saveCostSettings: (settings: CostSettings) =>
    apiFetch<CostSettings>("/api/admin/settings/costs", { method: "PUT", body: JSON.stringify(settings) }),
  limits: () => apiFetch<AiLimits>("/api/admin/settings/limits", { method: "GET" }),
  saveLimits: (limits: AiLimits) =>
    apiFetch<AiLimits>("/api/admin/settings/limits", { method: "PUT", body: JSON.stringify(limits) }),
  pricing: () => apiFetch<PricingConfig>("/api/admin/pricing", { method: "GET" }),
  savePricing: (pricing: PricingConfig) =>
    apiFetch<PricingConfig>("/api/admin/pricing", { method: "PUT", body: JSON.stringify(pricing) }),
  suspend: (uid: string, restore = false) =>
    apiFetch<{ suspended: boolean }>(
      `/api/admin/users/${encodeURIComponent(uid)}/suspend${restore ? "?restore=true" : ""}`,
      { method: "POST" }
    ),
};

export async function getProfile(): Promise<LearnerProfile> {
  return apiFetch<LearnerProfile>("/api/me/profile", { method: "GET" });
}

export async function getEntitlements(): Promise<Entitlements> {
  return apiFetch<Entitlements>("/api/me/entitlements", { method: "GET" });
}

export async function getPractice(): Promise<PracticeProgress> {
  return apiFetch<PracticeProgress>("/api/me/practice", { method: "GET" });
}

export async function completePracticeLesson(
  lessonId: string,
  correct: number,
  total: number
): Promise<PracticeProgress> {
  return apiFetch<PracticeProgress>(`/api/me/practice/lessons/${encodeURIComponent(lessonId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ correct, total }),
  });
}

export async function submitCardReview(
  results: { card_id: string; correct: boolean }[]
): Promise<PracticeProgress> {
  return apiFetch<PracticeProgress>("/api/me/practice/review", {
    method: "POST",
    body: JSON.stringify({ results }),
  });
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

export type SpeechLanguage = "auto" | "hi" | "en";
export interface CreateSessionOptions {
  mode?: string;
  targetSkill?: string;
  lessonId?: string;
  topic?: string;
  conversationGoal?: ConversationGoal;
  roleplayScenario?: string;
  speechLanguage?: SpeechLanguage;
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
      speech_language: options.speechLanguage || "en",
    }),
  });
}

export async function refreshSessionToken(sessionId: string): Promise<RefreshTokenResponse> {
  return apiFetch<RefreshTokenResponse>(`/api/sessions/${sessionId}/token/refresh`, {
    method: "POST",
  });
}

export interface CompleteSessionResponse {
  status: string;
  session_id: string;
  duration_minutes: number;
  analysis_status?: "completed" | "pending" | "failed" | "not_needed";
  retryable?: boolean;
}

export async function completeSession(
  sessionId: string,
  durationSeconds: number,
  lessonId?: string,
  targetSkill?: string,
  messages?: any[]
): Promise<CompleteSessionResponse> {
  return apiFetch<CompleteSessionResponse>(
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

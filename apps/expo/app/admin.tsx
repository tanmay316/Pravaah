/**
 * Admin console: KPIs, costs and rate limits, users, coupons, error log and bug reports.
 * The server enforces admin access on every endpoint; this screen only hides itself.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  adminApi,
  getEntitlements,
  type AdminOverview,
  type AdminUserRow,
  type AiLimits,
  type BugReport,
  type Coupon,
  type CostSettings,
  type ErrorEvent,
  type ErrorGroup,
  type PlanPrice,
  type PricingConfig,
} from "../lib/api";
import { theme, useTheme, type ThemeColors } from "../lib/theme";

type Tab = "overview" | "costs" | "users" | "pricing" | "limits" | "coupons" | "errors" | "bugs" | "settings";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "grid-outline" },
  { key: "costs", label: "Costs & limits", icon: "wallet-outline" },
  { key: "users", label: "Users", icon: "people-outline" },
  { key: "pricing", label: "Pricing", icon: "cash-outline" },
  { key: "limits", label: "AI limits", icon: "speedometer-outline" },
  { key: "coupons", label: "Coupons", icon: "pricetag-outline" },
  { key: "errors", label: "Errors", icon: "warning-outline" },
  { key: "bugs", label: "Bug reports", icon: "bug-outline" },
  { key: "settings", label: "Cost rates", icon: "settings-outline" },
];

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const num = (n: number) => Math.round(n).toLocaleString("en-IN");

function shortDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function dateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Confirm", style: "destructive", onPress: onConfirm },
  ]);
}

export default function AdminScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    getEntitlements()
      .then((e) => setAllowed(!!e.is_admin))
      .catch(() => setAllowed(false));
  }, []);

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 12) }]}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={close} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Admin console</Text>
          <Text style={styles.headerSub}>Pravaah operations</Text>
        </View>
      </View>

      {allowed === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.irisBlue} />
        </View>
      ) : !allowed ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={28} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Admin access required</Text>
          <Text style={styles.emptyText}>This area is only available to Pravaah administrators.</Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabs}
            style={styles.tabsWrap}
          >
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <Pressable
                  key={t.key}
                  style={[styles.tab, active && styles.tabActive]}
                  onPress={() => setTab(t.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                >
                  <Ionicons name={t.icon as any} size={15} color={active ? colors.irisBlue : colors.textSecondary} />
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={{ flex: 1 }}>
            {tab === "overview" || tab === "costs" ? <OverviewPanel mode={tab} styles={styles} colors={colors} /> : null}
            {tab === "users" ? <UsersPanel styles={styles} colors={colors} /> : null}
            {tab === "pricing" ? <PricingPanel styles={styles} colors={colors} /> : null}
            {tab === "limits" ? <LimitsPanel styles={styles} colors={colors} /> : null}
            {tab === "coupons" ? <CouponsPanel styles={styles} colors={colors} /> : null}
            {tab === "errors" ? <ErrorsPanel styles={styles} colors={colors} /> : null}
            {tab === "bugs" ? <BugsPanel styles={styles} colors={colors} /> : null}
            {tab === "settings" ? <SettingsPanel styles={styles} colors={colors} /> : null}
          </View>
        </>
      )}
    </View>
  );
}

type PanelProps = { styles: ReturnType<typeof createStyles>; colors: ThemeColors };

function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await load());
    } catch (err: any) {
      setError(err?.message || "Could not load data.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

function PanelScroll({ children, loading, reload, styles, colors }: PanelProps & {
  children: React.ReactNode;
  loading: boolean;
  reload: () => void;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.panel}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={colors.irisBlue} />}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

function ErrorBox({ message, styles, colors }: PanelProps & { message: string }) {
  return (
    <View style={styles.errorBox}>
      <Ionicons name="alert-circle-outline" size={18} color={colors.crimsonError} />
      <Text style={styles.errorBoxText}>{message}</Text>
    </View>
  );
}

function Segmented<T extends string | number>({ options, value, onChange, styles }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  styles: PanelProps["styles"];
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={String(o.value)}
          style={[styles.segment, value === o.value && styles.segmentActive]}
          onPress={() => onChange(o.value)}
        >
          <Text style={[styles.segmentText, value === o.value && styles.segmentTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Kpi({ label, value, hint, styles }: { label: string; value: string; hint?: string; styles: PanelProps["styles"] }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
    </View>
  );
}

function BarChart({ values, labels, color, format, styles }: {
  values: number[];
  labels: string[];
  color: string;
  format: (n: number) => string;
  styles: PanelProps["styles"];
}) {
  const max = Math.max(...values, 0);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <View>
      <View style={styles.chart}>
        {values.map((v, i) => (
          <View key={i} style={styles.chartCol}>
            <View
              style={[
                styles.chartBar,
                { height: max ? Math.max(2, (v / max) * 96) : 2, backgroundColor: v ? color : "transparent" },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.chartFooter}>
        <Text style={styles.chartAxis}>{labels[0]}</Text>
        <Text style={styles.chartAxis}>
          Total {format(total)} · peak {format(max)}
        </Text>
        <Text style={styles.chartAxis}>{labels[labels.length - 1]}</Text>
      </View>
    </View>
  );
}

function Meter({ percent, colors, styles }: { percent: number; colors: ThemeColors; styles: PanelProps["styles"] }) {
  const tone = percent >= 90 ? colors.crimsonError : percent >= 70 ? colors.amberWarning : colors.emeraldSuccess;
  return (
    <View style={styles.meterTrack}>
      <View style={[styles.meterFill, { width: `${Math.min(100, Math.max(percent, percent > 0 ? 2 : 0))}%`, backgroundColor: tone }]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Overview and costs
// ---------------------------------------------------------------------------

function OverviewPanel({ mode, styles, colors }: PanelProps & { mode: "overview" | "costs" }) {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useLoader<AdminOverview>(() => adminApi.overview(days), [days]);
  const k = data?.kpis || {};
  const m = data?.money;
  const labels = (data?.series || []).map((s) => shortDate(s.date));

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>{mode === "overview" ? "Key metrics" : "Spend and unit costs"}</Text>
        <Segmented
          options={[
            { value: 7, label: "7d" },
            { value: 30, label: "30d" },
            { value: 90, label: "90d" },
          ]}
          value={days}
          onChange={setDays}
          styles={styles}
        />
      </View>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {!data && loading ? <ActivityIndicator color={colors.irisBlue} style={{ marginTop: 24 }} /> : null}

      {data && mode === "overview" ? (
        <>
          <Text style={styles.groupLabel}>Users</Text>
          <View style={styles.kpiGrid}>
            <Kpi label="Total users" value={num(k.total_users)} hint={`+${num(k.new_users)} in ${days}d`} styles={styles} />
            <Kpi label="Daily active" value={num(k.dau)} hint={`${k.stickiness}% of monthly`} styles={styles} />
            <Kpi label="Weekly active" value={num(k.wau)} styles={styles} />
            <Kpi label="Monthly active" value={num(k.mau)} styles={styles} />
          </View>
          <Text style={styles.groupLabel}>Revenue</Text>
          <View style={styles.kpiGrid}>
            <Kpi label="Premium users" value={num(k.premium_users)} hint={`${k.conversion_rate}% conversion`} styles={styles} />
            <Kpi label="Est. MRR (billing)" value={inr(data.money.mrr_inr)} styles={styles} />
            <Kpi label="Tried the demo" value={num(k.demo_users)} styles={styles} />
            <Kpi label={`Spend (${days}d)`} value={usd(data.money.spend_usd)} hint={inr(data.money.spend_inr)} styles={styles} />
          </View>
          <Text style={styles.groupLabel}>Learning</Text>
          <View style={styles.kpiGrid}>
            <Kpi label="AI sessions" value={num(k.ai_sessions)} hint={`${num(k.demo_sessions)} demos`} styles={styles} />
            <Kpi label="AI minutes" value={num(k.ai_minutes)} styles={styles} />
            <Kpi label="Lessons completed" value={num(k.lessons_completed)} styles={styles} />
            <Kpi label="Words reviewed" value={num(k.cards_reviewed)} styles={styles} />
            <Kpi label="Speaking tests" value={num(k.assessments)} styles={styles} />
            <Kpi label="XP earned" value={num(k.xp_earned)} styles={styles} />
          </View>
          <Text style={styles.groupLabel}>Quality</Text>
          <View style={styles.kpiGrid}>
            <Kpi label="Errors logged" value={num(k.errors)} styles={styles} />
            <Kpi label="Open bug reports" value={num(k.open_bugs)} styles={styles} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign-ups per day</Text>
            <BarChart values={data.series.map((s) => s.signups)} labels={labels} color={colors.irisBlue} format={num} styles={styles} />
          </View>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>AI sessions per day</Text>
            <BarChart values={data.series.map((s) => s.sessions)} labels={labels} color={colors.skyBlue} format={num} styles={styles} />
          </View>
          {Object.keys(data.money.premium_by_source).length ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Premium by source</Text>
              {Object.entries(data.money.premium_by_source).map(([source, count]) => (
                <View key={source} style={styles.listRow}>
                  <Text style={styles.listLabel}>{source}</Text>
                  <Text style={styles.listValue}>{count}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {data && m && mode === "costs" ? (
        <>
          <View style={styles.kpiGrid}>
            <Kpi label={`Spend (${days}d)`} value={usd(m.spend_usd)} hint={inr(m.spend_inr)} styles={styles} />
            <Kpi label="This month" value={usd(m.month_spend_usd)} hint={`of ${usd(m.monthly_budget_usd)} budget`} styles={styles} />
            <Kpi label="Cost per session" value={usd(m.cost_per_session_usd)} styles={styles} />
            <Kpi label="Cost per minute" value={usd(m.cost_per_minute_usd)} styles={styles} />
            <Kpi label="Per active user" value={usd(m.cost_per_active_user_usd)} hint="monthly actives" styles={styles} />
            <Kpi label="Per premium user" value={usd(m.cost_per_premium_user_usd)} styles={styles} />
          </View>

          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Monthly budget</Text>
              <Text style={styles.cardMeta}>{m.budget_used_percent}% used</Text>
            </View>
            <Meter percent={m.budget_used_percent} colors={colors} styles={styles} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Where the money goes</Text>
            {(["llm", "stt", "tts", "livekit"] as const).map((part) => {
              const value = m.breakdown_usd[part];
              const share = m.spend_usd ? (100 * value) / m.spend_usd : 0;
              const name = { llm: "Language model", stt: "Speech to text", tts: "Text to speech", livekit: "LiveKit agent time" }[part];
              return (
                <View key={part} style={{ marginBottom: 10 }}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.listLabel}>{name}</Text>
                    <Text style={styles.listValue}>
                      {usd(value)} · {share.toFixed(0)}%
                    </Text>
                  </View>
                  <View style={styles.meterTrack}>
                    <View style={[styles.meterFill, { width: `${share}%`, backgroundColor: colors.irisBlue }]} />
                  </View>
                </View>
              );
            })}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Spend per day (USD)</Text>
            <BarChart values={data.series.map((s) => s.cost_usd)} labels={labels} color={colors.amberWarning} format={usd} styles={styles} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Rate limits and credits</Text>
            <Text style={styles.cardHint}>Usage against the limits set in Settings.</Text>
            {data.rate_limits.map((g) => (
              <View key={g.label} style={{ marginTop: 12 }}>
                <View style={styles.rowBetween}>
                  <Text style={styles.listLabel}>{g.label}</Text>
                  <Text style={styles.listValue}>
                    {num(g.used)} / {num(g.limit)} {g.unit}
                  </Text>
                </View>
                <Meter percent={g.percent} colors={colors} styles={styles} />
              </View>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Model usage</Text>
            {data.models.length === 0 ? (
              <Text style={styles.cardHint}>No usage reported yet. It appears after AI sessions end.</Text>
            ) : (
              data.models.map((model) => (
                <View key={`${model.kind}-${model.model}`} style={styles.listRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listLabel} numberOfLines={1}>
                      {model.model}
                    </Text>
                    <Text style={styles.listSub}>
                      {model.kind.toUpperCase()} ·{" "}
                      {model.kind === "llm"
                        ? `${num(model.prompt_tokens)} in / ${num(model.completion_tokens)} out tokens`
                        : model.kind === "stt"
                        ? `${num(model.audio_seconds / 60)} audio min`
                        : `${num(model.characters)} characters`}
                    </Text>
                  </View>
                  <Text style={styles.listValue}>{num(model.requests)} req</Text>
                </View>
              ))
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Most expensive users</Text>
            {data.top_users.length === 0 ? (
              <Text style={styles.cardHint}>No AI sessions in this period.</Text>
            ) : (
              data.top_users.map((u) => (
                <View key={u.uid} style={styles.listRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listLabel} numberOfLines={1}>
                      {u.email || u.uid}
                    </Text>
                    <Text style={styles.listSub}>
                      {u.sessions} sessions · {u.minutes} min
                    </Text>
                  </View>
                  <Text style={styles.listValue}>{usd(u.cost_usd)}</Text>
                </View>
              ))
            )}
          </View>
        </>
      ) : null}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersPanel({ styles, colors }: PanelProps) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoader<AdminUserRow[]>(() => adminApi.users(submitted), [submitted]);

  const run = async (uid: string, action: () => Promise<unknown>) => {
    setBusyUid(uid);
    try {
      await action();
      await reload();
    } catch (err: any) {
      Alert.alert("Action failed", err?.message || "Please try again.");
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search by email, name or user ID"
          placeholderTextColor={colors.fog}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => setSubmitted(query)}
        />
      </View>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      <Text style={styles.cardHint}>Sorted by AI cost over the last 90 days. Pull down to refresh.</Text>
      {(data || []).map((u) => (
        <View key={u.uid} style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={styles.listLabel} numberOfLines={1}>
                {u.email || u.name || u.uid}
              </Text>
              <Text style={styles.listSub} numberOfLines={1}>
                {u.name ? `${u.name} · ` : ""}Level {u.level} · joined {shortDate(u.created_at)}
              </Text>
            </View>
            <View style={[styles.pill, u.suspended ? styles.pillWarn : u.plan === "premium" ? styles.pillPremium : null]}>
              <Text style={[styles.pillText, u.suspended ? styles.pillTextWarn : u.plan === "premium" ? styles.pillTextPremium : null]}>
                {u.suspended ? "Suspended" : u.role === "admin" ? "Admin" : u.plan === "premium" ? "Premium" : "Free"}
              </Text>
            </View>
          </View>
          <View style={styles.statLine}>
            <Text style={styles.statItem}>Active {u.last_practice_date ? shortDate(u.last_practice_date) : "never"}</Text>
            <Text style={styles.statItem}>{u.streak_days}-day streak</Text>
            <Text style={styles.statItem}>{u.ai_sessions_90d} sessions</Text>
            <Text style={styles.statItem}>{u.ai_minutes_90d} min</Text>
            <Text style={styles.statItem}>{usd(u.cost_usd_90d)}</Text>
          </View>
          {u.plan === "premium" ? (
            <Text style={styles.listSub}>
              Premium {u.premium_until ? `until ${shortDate(u.premium_until)}` : "with no end date"}
              {u.premium_source ? ` · via ${u.premium_source}` : ""}
            </Text>
          ) : null}
          <View style={styles.actionRow}>
            {busyUid === u.uid ? (
              <ActivityIndicator color={colors.irisBlue} />
            ) : (
              <>
                <SmallButton label="+30 days Premium" styles={styles} onPress={() => run(u.uid, () => adminApi.setPremium(u.uid, 30))} />
                <SmallButton
                  label="Lifetime"
                  styles={styles}
                  onPress={() =>
                    confirmAction("Give lifetime Premium?", u.email || u.uid, () =>
                      run(u.uid, () => adminApi.setPremium(u.uid, null))
                    )
                  }
                />
                {u.plan === "premium" ? (
                  <SmallButton
                    label="Revoke"
                    danger
                    styles={styles}
                    onPress={() =>
                      confirmAction("Revoke Premium?", u.email || u.uid, () =>
                        run(u.uid, () => adminApi.setPremium(u.uid, null, true))
                      )
                    }
                  />
                ) : null}
                {u.demo_used ? (
                  <SmallButton label="Reset demo" styles={styles} onPress={() => run(u.uid, () => adminApi.resetDemo(u.uid))} />
                ) : null}
                {u.role !== "admin" ? (
                  u.suspended ? (
                    <SmallButton label="Restore account" styles={styles} onPress={() => run(u.uid, () => adminApi.suspend(u.uid, true))} />
                  ) : (
                    <SmallButton
                      label="Suspend"
                      danger
                      styles={styles}
                      onPress={() =>
                        confirmAction(
                          "Suspend this account?",
                          `${u.email || u.uid} will be signed out and blocked from the app and the AI coach.`,
                          () => run(u.uid, () => adminApi.suspend(u.uid))
                        )
                      }
                    />
                  )
                ) : null}
              </>
            )}
          </View>
        </View>
      ))}
      {data && data.length === 0 ? <Text style={styles.cardHint}>No users match.</Text> : null}
    </PanelScroll>
  );
}

function SmallButton({ label, onPress, danger, styles }: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  styles: PanelProps["styles"];
}) {
  return (
    <Pressable style={({ pressed }) => [styles.smallBtn, danger && styles.smallBtnDanger, pressed && { opacity: 0.8 }]} onPress={onPress}>
      <Text style={[styles.smallBtnText, danger && styles.smallBtnTextDanger]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

function Field({ label, children, styles }: { label: string; children: React.ReactNode; styles: PanelProps["styles"] }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function CouponsPanel({ styles, colors }: PanelProps) {
  const { data, error, loading, reload } = useLoader<Coupon[]>(() => adminApi.coupons(), []);
  const [kind, setKind] = useState<"pro" | "discount">("pro");
  const [naming, setNaming] = useState<"custom" | "random">("custom");
  const [code, setCode] = useState("");
  const [count, setCount] = useState("10");
  const [prefix, setPrefix] = useState("PRAVAAH");
  const [days, setDays] = useState("30");
  const [percent, setPercent] = useState("20");
  const [maxUses, setMaxUses] = useState("1");
  const [expiryDays, setExpiryDays] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Coupon[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Record<string, { email: string; redeemed_at: string; uid: string }[]>>({});

  const create = async () => {
    setFormError(null);
    const n = (s: string) => parseInt(s, 10);
    if (naming === "custom" && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
      setFormError("Codes use 3–32 capital letters, numbers, - or _.");
      return;
    }
    setCreating(true);
    try {
      const expires = n(expiryDays) > 0 ? new Date(Date.now() + n(expiryDays) * 86400000).toISOString() : null;
      const result = await adminApi.createCoupons({
        kind,
        code: naming === "custom" ? code : undefined,
        count: naming === "random" ? Math.min(200, Math.max(1, n(count) || 1)) : 1,
        prefix: naming === "random" ? prefix : undefined,
        pro_days: kind === "pro" ? n(days) || 30 : undefined,
        percent_off: kind === "discount" ? n(percent) || 10 : undefined,
        max_redemptions: n(maxUses) || 1,
        expires_at: expires,
        note,
      });
      setCreated(result);
      setCode("");
      await reload();
    } catch (err: any) {
      setFormError(err?.message || "Could not create the coupon.");
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (coupon: Coupon) => {
    try {
      await adminApi.updateCoupon(coupon.code, { active: !coupon.active });
      await reload();
    } catch (err: any) {
      Alert.alert("Could not update coupon", err?.message || "Please try again.");
    }
  };

  const showRedemptions = async (couponCode: string) => {
    if (expanded === couponCode) {
      setExpanded(null);
      return;
    }
    setExpanded(couponCode);
    if (!redemptions[couponCode]) {
      const rows = await adminApi.redemptions(couponCode).catch(() => []);
      setRedemptions((prev) => ({ ...prev, [couponCode]: rows }));
    }
  };

  const copyCodes = () => {
    const text = created.map((c) => c.code).join("\n");
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Create coupon</Text>
        <Field label="Type" styles={styles}>
          <Segmented
            options={[
              { value: "pro", label: "Free Premium" },
              { value: "discount", label: "Discount" },
            ]}
            value={kind}
            onChange={setKind}
            styles={styles}
          />
        </Field>
        <Field label="Code" styles={styles}>
          <Segmented
            options={[
              { value: "custom", label: "Name it myself" },
              { value: "random", label: "Random codes" },
            ]}
            value={naming}
            onChange={setNaming}
            styles={styles}
          />
        </Field>
        {naming === "custom" ? (
          <Field label="Coupon name" styles={styles}>
            <TextInput
              style={[styles.input, styles.mono]}
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
              placeholder="DIWALI50"
              placeholderTextColor={colors.fog}
              autoCapitalize="characters"
              maxLength={32}
            />
          </Field>
        ) : (
          <View style={styles.fieldRow}>
            <Field label="How many" styles={styles}>
              <TextInput style={styles.input} value={count} onChangeText={setCount} keyboardType="number-pad" maxLength={3} />
            </Field>
            <Field label="Prefix" styles={styles}>
              <TextInput
                style={[styles.input, styles.mono]}
                value={prefix}
                onChangeText={(t) => setPrefix(t.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                maxLength={12}
              />
            </Field>
          </View>
        )}
        <View style={styles.fieldRow}>
          {kind === "pro" ? (
            <Field label="Premium days" styles={styles}>
              <TextInput style={styles.input} value={days} onChangeText={setDays} keyboardType="number-pad" maxLength={4} />
            </Field>
          ) : (
            <Field label="Percent off" styles={styles}>
              <TextInput style={styles.input} value={percent} onChangeText={setPercent} keyboardType="number-pad" maxLength={3} />
            </Field>
          )}
          <Field label={naming === "random" ? "Uses per code" : "Total uses"} styles={styles}>
            <TextInput style={styles.input} value={maxUses} onChangeText={setMaxUses} keyboardType="number-pad" maxLength={6} />
          </Field>
          <Field label="Expires in (days)" styles={styles}>
            <TextInput
              style={styles.input}
              value={expiryDays}
              onChangeText={setExpiryDays}
              keyboardType="number-pad"
              placeholder="Never"
              placeholderTextColor={colors.fog}
              maxLength={4}
            />
          </Field>
        </View>
        <Field label="Note (only you see this)" styles={styles}>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="e.g. Instagram giveaway"
            placeholderTextColor={colors.fog}
            maxLength={200}
          />
        </Field>
        {formError ? <ErrorBox message={formError} styles={styles} colors={colors} /> : null}
        <Pressable style={({ pressed }) => [styles.primaryBtn, (pressed || creating) && { opacity: 0.85 }]} onPress={create} disabled={creating}>
          {creating ? (
            <ActivityIndicator color={colors.textOnPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>{naming === "random" ? `Generate ${count || 1} codes` : "Create coupon"}</Text>
          )}
        </Pressable>
      </View>

      {created.length ? (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>Created ({created.length})</Text>
            {Platform.OS === "web" ? <SmallButton label="Copy all" styles={styles} onPress={copyCodes} /> : null}
          </View>
          <Text selectable style={[styles.mono, styles.codeBlock]}>
            {created.map((c) => c.code).join("\n")}
          </Text>
        </View>
      ) : null}

      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      <Text style={styles.sectionTitle}>All coupons</Text>
      {(data || []).map((c) => {
        const expired = c.expires_at ? new Date(c.expires_at).getTime() < Date.now() : false;
        const used = c.redemptions >= c.max_redemptions;
        const status = !c.active ? "Disabled" : expired ? "Expired" : used ? "Used up" : "Active";
        return (
          <View key={c.code} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text selectable style={[styles.listLabel, styles.mono]}>
                {c.code}
              </Text>
              <View style={[styles.pill, status === "Active" ? styles.pillPremium : null]}>
                <Text style={[styles.pillText, status === "Active" ? styles.pillTextPremium : null]}>{status}</Text>
              </View>
            </View>
            <Text style={styles.listSub}>
              {c.kind === "pro" ? `${c.pro_days} days free Premium` : `${c.percent_off}% off Premium`} · used {c.redemptions}/
              {c.max_redemptions}
              {c.expires_at ? ` · expires ${shortDate(c.expires_at)}` : ""}
            </Text>
            {c.note ? <Text style={styles.listSub}>{c.note}</Text> : null}
            <View style={styles.actionRow}>
              <SmallButton label={c.active ? "Disable" : "Enable"} danger={c.active} styles={styles} onPress={() => toggle(c)} />
              {c.redemptions > 0 ? (
                <SmallButton label={expanded === c.code ? "Hide users" : "Who used it"} styles={styles} onPress={() => showRedemptions(c.code)} />
              ) : null}
            </View>
            {expanded === c.code
              ? (redemptions[c.code] || []).map((r) => (
                  <View key={r.uid} style={styles.listRow}>
                    <Text style={styles.listLabel} numberOfLines={1}>
                      {r.email || r.uid}
                    </Text>
                    <Text style={styles.listSub}>{dateTime(r.redeemed_at)}</Text>
                  </View>
                ))
              : null}
          </View>
        );
      })}
      {data && data.length === 0 ? <Text style={styles.cardHint}>No coupons yet.</Text> : null}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function ErrorsPanel({ styles, colors }: PanelProps) {
  const [days, setDays] = useState(7);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoader<{ groups: ErrorGroup[]; events: ErrorEvent[] }>(
    () => adminApi.errors(days),
    [days]
  );
  const sourceLabel: Record<string, string> = { app: "App", api: "Server", agent: "Voice agent" };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Grouped errors</Text>
        <Segmented
          options={[
            { value: 1, label: "24h" },
            { value: 7, label: "7d" },
            { value: 30, label: "30d" },
          ]}
          value={days}
          onChange={setDays}
          styles={styles}
        />
      </View>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {data && data.groups.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="checkmark-circle-outline" size={24} color={colors.emeraldSuccess} />
          <Text style={styles.cardHint}>No errors recorded in this period.</Text>
        </View>
      ) : null}
      {(data?.groups || []).map((g) => {
        const events = (data?.events || []).filter((e) => e.fingerprint === g.fingerprint);
        return (
          <Pressable key={g.fingerprint} style={styles.card} onPress={() => setOpen(open === g.fingerprint ? null : g.fingerprint)}>
            <View style={styles.rowBetween}>
              <View style={[styles.pill, g.source === "app" ? null : styles.pillWarn]}>
                <Text style={[styles.pillText, g.source === "app" ? null : styles.pillTextWarn]}>{sourceLabel[g.source] || g.source}</Text>
              </View>
              <Text style={styles.cardMeta}>
                {g.count}× · {g.users} {g.users === 1 ? "user" : "users"}
              </Text>
            </View>
            <Text style={styles.errorMessage} numberOfLines={open === g.fingerprint ? undefined : 3}>
              {g.message}
            </Text>
            <Text style={styles.listSub}>
              Last seen {dateTime(g.last_seen)}
              {g.screen ? ` · ${g.screen}` : ""}
              {g.platform ? ` · ${g.platform}` : ""}
            </Text>
            {open === g.fingerprint
              ? events.slice(0, 10).map((e) => (
                  <View key={e.id} style={styles.eventRow}>
                    <Text style={styles.listSub}>
                      {dateTime(e.created_at)} · {e.email || "signed out"} · {e.platform || "—"} {e.app_version || ""}
                    </Text>
                    {e.stack ? (
                      <Text selectable style={[styles.mono, styles.stack]} numberOfLines={8}>
                        {e.stack}
                      </Text>
                    ) : null}
                  </View>
                ))
              : null}
          </Pressable>
        );
      })}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// Bug reports
// ---------------------------------------------------------------------------

function BugsPanel({ styles, colors }: PanelProps) {
  const [status, setStatus] = useState<"open" | "in_progress" | "resolved" | "all">("open");
  const { data, setData, error, loading, reload } = useLoader<BugReport[]>(() => adminApi.bugs(status), [status]);

  const update = async (bug: BugReport, next: BugReport["status"]) => {
    try {
      await adminApi.updateBug(bug.id, next);
      setData((prev) =>
        (prev || [])
          .map((b) => (b.id === bug.id ? { ...b, status: next } : b))
          .filter((b) => status === "all" || b.status === status)
      );
    } catch (err: any) {
      Alert.alert("Could not update", err?.message || "Please try again.");
    }
  };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <Segmented
        options={[
          { value: "open", label: "Open" },
          { value: "in_progress", label: "In progress" },
          { value: "resolved", label: "Resolved" },
          { value: "all", label: "All" },
        ]}
        value={status}
        onChange={setStatus}
        styles={styles}
      />
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {data && data.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="checkmark-circle-outline" size={24} color={colors.emeraldSuccess} />
          <Text style={styles.cardHint}>Nothing here.</Text>
        </View>
      ) : null}
      {(data || []).map((b) => (
        <View key={b.id} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.listLabel} numberOfLines={1}>
              {b.email || b.uid}
            </Text>
            <Text style={styles.cardMeta}>{dateTime(b.created_at)}</Text>
          </View>
          <Text selectable style={styles.bugText}>
            {b.description}
          </Text>
          <Text style={styles.listSub}>
            {b.screen ? `${b.screen} · ` : ""}
            {b.platform || "—"} {b.app_version || ""}
          </Text>
          <View style={styles.actionRow}>
            {b.status !== "in_progress" ? <SmallButton label="Mark in progress" styles={styles} onPress={() => update(b, "in_progress")} /> : null}
            {b.status !== "resolved" ? <SmallButton label="Resolve" styles={styles} onPress={() => update(b, "resolved")} /> : null}
            {b.status !== "open" ? <SmallButton label="Reopen" styles={styles} onPress={() => update(b, "open")} /> : null}
          </View>
        </View>
      ))}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

type PriceDraft = { price: string; sale: string; label: string; endsInDays: string; endsAt: string | null };

function toDraft(p: PlanPrice): PriceDraft {
  return {
    price: String(p.price_inr),
    sale: p.sale_price_inr != null ? String(p.sale_price_inr) : "",
    label: p.sale_label || "",
    endsInDays: "",
    endsAt: p.sale_ends_at,
  };
}

function fromDraft(d: PriceDraft): PlanPrice {
  const days = parseInt(d.endsInDays, 10);
  const hasSale = d.sale.trim() !== "";
  return {
    price_inr: parseInt(d.price, 10) || 0,
    sale_price_inr: hasSale ? parseInt(d.sale, 10) : null,
    sale_label: hasSale ? d.label.trim() : "",
    sale_ends_at: !hasSale ? null : days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : d.endsAt,
  };
}

function PricingPanel({ styles, colors }: PanelProps) {
  const { data, error, loading, reload } = useLoader<PricingConfig>(() => adminApi.pricing(), []);
  const [drafts, setDrafts] = useState<Record<"monthly" | "yearly", PriceDraft> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (data) setDrafts({ monthly: toDraft(data.monthly), yearly: toDraft(data.yearly) });
  }, [data]);

  const update = (plan: "monthly" | "yearly", patch: Partial<PriceDraft>) =>
    setDrafts((prev) => (prev ? { ...prev, [plan]: { ...prev[plan], ...patch } } : prev));

  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    setMessage(null);
    try {
      await adminApi.savePricing({ monthly: fromDraft(drafts.monthly), yearly: fromDraft(drafts.yearly) });
      setMessage({ ok: true, text: "Prices updated. Everyone sees them on the Premium screen right away." });
      await reload();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || "Check the prices and try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <Text style={styles.cardHint}>
        Raise or lower prices, or run a sale that shows the regular price crossed out. Google Play charges the price
        set in Play Console, so update the subscription there to match before changing it here.
      </Text>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {drafts
        ? (["monthly", "yearly"] as const).map((plan) => {
            const d = drafts[plan];
            const preview = fromDraft(d);
            const onSale = preview.sale_price_inr != null && preview.sale_price_inr < preview.price_inr;
            const period = plan === "monthly" ? "per month" : "per year";
            return (
              <View key={plan} style={styles.card}>
                <Text style={styles.cardTitle}>{plan === "monthly" ? "Monthly plan" : "Yearly plan"}</Text>
                <View style={styles.fieldRow}>
                  <Field label="Regular price (₹)" styles={styles}>
                    <TextInput
                      style={styles.input}
                      value={d.price}
                      onChangeText={(t) => update(plan, { price: t.replace(/[^0-9]/g, "") })}
                      keyboardType="number-pad"
                      maxLength={7}
                    />
                  </Field>
                  <Field label="Sale price (₹)" styles={styles}>
                    <TextInput
                      style={styles.input}
                      value={d.sale}
                      onChangeText={(t) => update(plan, { sale: t.replace(/[^0-9]/g, "") })}
                      keyboardType="number-pad"
                      placeholder="No sale"
                      placeholderTextColor={colors.fog}
                      maxLength={7}
                    />
                  </Field>
                </View>
                {d.sale ? (
                  <View style={styles.fieldRow}>
                    <Field label="Sale label" styles={styles}>
                      <TextInput
                        style={styles.input}
                        value={d.label}
                        onChangeText={(t) => update(plan, { label: t })}
                        placeholder="e.g. Diwali offer"
                        placeholderTextColor={colors.fog}
                        maxLength={40}
                      />
                    </Field>
                    <Field label="Sale ends in (days)" styles={styles}>
                      <TextInput
                        style={styles.input}
                        value={d.endsInDays}
                        onChangeText={(t) => update(plan, { endsInDays: t.replace(/[^0-9]/g, "") })}
                        keyboardType="number-pad"
                        placeholder={d.endsAt ? `Ends ${shortDate(d.endsAt)}` : "No end date"}
                        placeholderTextColor={colors.fog}
                        maxLength={4}
                      />
                    </Field>
                  </View>
                ) : null}
                <View style={styles.pricePreview}>
                  <Text style={styles.listSub}>Customers see</Text>
                  <View style={styles.priceLine}>
                    {onSale ? <Text style={styles.priceStruck}>{inr(preview.price_inr)}</Text> : null}
                    <Text style={styles.priceNow}>
                      {inr(onSale ? (preview.sale_price_inr as number) : preview.price_inr)} {period}
                    </Text>
                    {onSale ? (
                      <View style={[styles.pill, styles.pillPremium]}>
                        <Text style={[styles.pillText, styles.pillTextPremium]}>
                          {Math.round(100 * (1 - (preview.sale_price_inr as number) / preview.price_inr))}% off
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  {onSale && preview.sale_label ? <Text style={styles.listSub}>{preview.sale_label}</Text> : null}
                </View>
                {d.sale ? (
                  <SmallButton label="End sale" styles={styles} onPress={() => update(plan, { sale: "", label: "", endsInDays: "", endsAt: null })} />
                ) : null}
              </View>
            );
          })
        : null}
      {message ? (
        message.ok ? (
          <Text style={[styles.cardHint, { color: colors.emeraldSuccess }]}>{message.text}</Text>
        ) : (
          <ErrorBox message={message.text} styles={styles} colors={colors} />
        )
      ) : null}
      {drafts ? (
        <Pressable style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]} onPress={save} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.textOnPrimary} /> : <Text style={styles.primaryBtnText}>Save prices</Text>}
        </Pressable>
      ) : null}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// AI limits
// ---------------------------------------------------------------------------

const LIMIT_FIELDS: { key: Exclude<keyof AiLimits, "ai_enabled">; label: string; hint: string }[] = [
  { key: "max_session_minutes", label: "Longest session (minutes)", hint: "The call ends automatically after this." },
  { key: "premium_minutes_per_day", label: "Premium minutes per day", hint: "Per learner, resets at midnight IST." },
  { key: "premium_sessions_per_day", label: "Premium sessions per day", hint: "Per learner." },
  { key: "premium_minutes_per_month", label: "Premium minutes per month", hint: "Per learner, resets on the 1st." },
  { key: "global_minutes_per_day", label: "All users, minutes per day", hint: "Protects your budget from spikes." },
  { key: "assessments_per_day", label: "Speaking test results per day", hint: "Per learner; each is an AI evaluation." },
  { key: "plan_refreshes_per_day", label: "Plan rebuilds per day", hint: "Per learner." },
  { key: "analysis_attempts_per_session", label: "Analysis retries per session", hint: "Stops paying for a failing analysis." },
];

function LimitsPanel({ styles, colors }: PanelProps) {
  const { data, error, loading, reload } = useLoader<AiLimits>(() => adminApi.limits(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.ai_enabled);
    setDraft(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(data[f.key])])));
  }, [data]);

  const save = async (overrideEnabled?: boolean) => {
    setSaving(true);
    setMessage(null);
    try {
      const next = {
        ai_enabled: overrideEnabled ?? enabled,
        ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, parseInt(draft[f.key], 10) || 0])),
      } as AiLimits;
      await adminApi.saveLimits(next);
      setMessage({ ok: true, text: "Limits saved. They apply to the next session anyone starts." });
      await reload();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || "Check the values and try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {data ? (
        <>
          <View style={[styles.card, !enabled && { borderColor: colors.crimsonError }]}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>AI coach {enabled ? "is on" : "is paused"}</Text>
                <Text style={styles.cardHint}>
                  Emergency switch. Pausing stops every new AI voice session for everyone except admins. Lessons and
                  word review keep working.
                </Text>
              </View>
              <Switch
                value={enabled}
                onValueChange={(v) =>
                  v
                    ? (setEnabled(true), save(true))
                    : confirmAction("Pause the AI coach?", "No one can start an AI session until you turn it back on.", () => {
                        setEnabled(false);
                        save(false);
                      })
                }
                trackColor={{ false: colors.crimsonError, true: colors.emeraldSuccess }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Usage caps</Text>
            <Text style={styles.cardHint}>
              Every AI session is time-boxed by these caps on the server, so no one can run up your bill.
            </Text>
            {LIMIT_FIELDS.map((f) => (
              <View key={f.key} style={styles.settingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>{f.label}</Text>
                  <Text style={styles.listSub}>{f.hint}</Text>
                </View>
                <TextInput
                  style={[styles.input, styles.settingInput]}
                  value={draft[f.key] ?? ""}
                  onChangeText={(t) => setDraft((prev) => ({ ...prev, [f.key]: t.replace(/[^0-9]/g, "") }))}
                  keyboardType="number-pad"
                  maxLength={7}
                />
              </View>
            ))}
          </View>

          {message ? (
            message.ok ? (
              <Text style={[styles.cardHint, { color: colors.emeraldSuccess }]}>{message.text}</Text>
            ) : (
              <ErrorBox message={message.text} styles={styles} colors={colors} />
            )
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]}
            onPress={() => save()}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color={colors.textOnPrimary} /> : <Text style={styles.primaryBtnText}>Save limits</Text>}
          </Pressable>
        </>
      ) : null}
    </PanelScroll>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTING_FIELDS: { key: keyof CostSettings; label: string; group: string }[] = [
  { key: "llm_input_per_million", label: "LLM input, USD per 1M tokens", group: "Provider rates" },
  { key: "llm_output_per_million", label: "LLM output, USD per 1M tokens", group: "Provider rates" },
  { key: "stt_per_hour", label: "Speech to text, USD per audio hour", group: "Provider rates" },
  { key: "tts_per_million_chars", label: "Text to speech, USD per 1M characters", group: "Provider rates" },
  { key: "livekit_per_agent_minute", label: "LiveKit, USD per agent minute", group: "Provider rates" },
  { key: "monthly_budget_usd", label: "Monthly budget, USD", group: "Business" },
  { key: "usd_to_inr", label: "USD to INR rate", group: "Business" },
  { key: "llm_requests_per_day", label: "LLM requests per day", group: "Daily limits" },
  { key: "llm_tokens_per_day", label: "LLM tokens per day", group: "Daily limits" },
  { key: "stt_requests_per_day", label: "Speech to text requests per day", group: "Daily limits" },
  { key: "stt_audio_seconds_per_day", label: "Speech to text audio seconds per day", group: "Daily limits" },
  { key: "livekit_agent_minutes_per_month", label: "LiveKit agent minutes per month", group: "Daily limits" },
];

function SettingsPanel({ styles, colors }: PanelProps) {
  const { data, error, loading, reload } = useLoader<CostSettings>(() => adminApi.costSettings(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])));
  }, [data]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const parsed = Object.fromEntries(
        SETTING_FIELDS.map((f) => [f.key, Number(draft[f.key] ?? (data as any)?.[f.key] ?? 0)])
      ) as unknown as CostSettings;
      await adminApi.saveCostSettings(parsed);
      setSaved(true);
      await reload();
    } catch (err: any) {
      Alert.alert("Could not save", err?.message || "Check the values and try again.");
    } finally {
      setSaving(false);
    }
  };

  const groups = Array.from(new Set(SETTING_FIELDS.map((f) => f.group)));
  return (
    <PanelScroll loading={loading} reload={reload} styles={styles} colors={colors}>
      <Text style={styles.cardHint}>
        These rates turn reported usage into estimated spend. Update them to match your provider invoices.
      </Text>
      {error ? <ErrorBox message={error} styles={styles} colors={colors} /> : null}
      {data
        ? groups.map((group) => (
            <View key={group} style={styles.card}>
              <Text style={styles.cardTitle}>{group}</Text>
              {SETTING_FIELDS.filter((f) => f.group === group).map((f) => (
                <View key={f.key} style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{f.label}</Text>
                  <TextInput
                    style={[styles.input, styles.settingInput]}
                    value={draft[f.key] ?? ""}
                    onChangeText={(t) => setDraft((prev) => ({ ...prev, [f.key]: t.replace(/[^0-9.]/g, "") }))}
                    keyboardType="decimal-pad"
                  />
                </View>
              ))}
            </View>
          ))
        : null}
      {data ? (
        <Pressable style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]} onPress={save} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.textOnPrimary} /> : <Text style={styles.primaryBtnText}>{saved ? "Saved" : "Save settings"}</Text>}
        </Pressable>
      ) : null}
    </PanelScroll>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.canvas },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingBottom: 8,
      maxWidth: 960,
      width: "100%",
      alignSelf: "center",
    },
    iconBtn: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    headerTitle: { fontFamily: theme.fonts.display, fontSize: 20, fontWeight: "600", color: colors.textPrimary },
    headerSub: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
    emptyTitle: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    emptyText: { fontFamily: theme.fonts.sans, fontSize: 14, color: colors.textSecondary, textAlign: "center" },
    tabsWrap: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
    tabs: { paddingHorizontal: 12, gap: 6, paddingBottom: 10 },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
    },
    tabActive: { backgroundColor: colors.primarySoft },
    tabText: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "500", color: colors.textSecondary },
    tabTextActive: { color: colors.irisBlue, fontWeight: "600" },
    panel: { padding: 16, gap: 12, paddingBottom: 48, maxWidth: 960, width: "100%", alignSelf: "center" },
    rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    sectionTitle: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    groupLabel: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textSecondary, marginTop: 4 },
    segmented: { flexDirection: "row", backgroundColor: colors.cardSubtle, borderRadius: 10, padding: 3, alignSelf: "flex-start", flexWrap: "wrap" },
    segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    segmentActive: { backgroundColor: colors.cardElevated },
    segmentText: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textSecondary },
    segmentTextActive: { color: colors.textPrimary, fontWeight: "600" },
    kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    kpi: {
      flexGrow: 1,
      flexBasis: "45%",
      minWidth: 140,
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 14,
    },
    kpiLabel: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary },
    kpiValue: { fontFamily: theme.fonts.display, fontSize: 24, fontWeight: "600", color: colors.textPrimary, marginTop: 4 },
    kpiHint: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textMuted, marginTop: 2 },
    card: {
      backgroundColor: colors.cardElevated,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 6,
    },
    emptyCard: {
      alignItems: "center",
      gap: 6,
      padding: 24,
      borderRadius: 16,
      backgroundColor: colors.cardSubtle,
    },
    cardTitle: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textPrimary, marginBottom: 6 },
    cardMeta: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textMuted },
    cardHint: { fontFamily: theme.fonts.sans, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    chart: { flexDirection: "row", alignItems: "flex-end", height: 100, gap: 2 },
    chartCol: { flex: 1, height: "100%", justifyContent: "flex-end" },
    chartBar: { borderTopLeftRadius: 3, borderTopRightRadius: 3 },
    chartFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
    chartAxis: { fontFamily: theme.fonts.sans, fontSize: 11, color: colors.textMuted },
    meterTrack: { height: 8, borderRadius: 4, backgroundColor: colors.cardSubtle, overflow: "hidden", marginTop: 6 },
    meterFill: { height: "100%", borderRadius: 4 },
    listRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    listLabel: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "500", color: colors.textPrimary, flexShrink: 1 },
    listSub: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textSecondary, marginTop: 1 },
    listValue: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "600", color: colors.textPrimary },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 12,
      backgroundColor: colors.cardElevated,
    },
    searchInput: { flex: 1, height: 44, fontFamily: theme.fonts.sans, fontSize: 15, color: colors.textPrimary },
    pill: { backgroundColor: colors.cardSubtle, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    pillText: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "600", color: colors.textSecondary },
    pillPremium: { backgroundColor: colors.primarySoft },
    pillTextPremium: { color: colors.irisBlue },
    pillWarn: { backgroundColor: colors.crimsonWash },
    pillTextWarn: { color: colors.crimsonError },
    statLine: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 4 },
    statItem: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textSecondary },
    actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
    smallBtn: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
    },
    smallBtnDanger: { borderColor: colors.crimsonError },
    smallBtnText: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textPrimary },
    smallBtnTextDanger: { color: colors.crimsonError },
    field: { flex: 1, minWidth: 120, gap: 6, marginBottom: 6 },
    fieldRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    fieldLabel: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textSecondary },
    input: {
      height: 44,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      color: colors.textPrimary,
      backgroundColor: colors.canvas,
    },
    mono: { fontFamily: theme.fonts.mono, letterSpacing: 0.4 },
    codeBlock: {
      fontSize: 14,
      lineHeight: 22,
      color: colors.textPrimary,
      backgroundColor: colors.cardSubtle,
      borderRadius: 10,
      padding: 12,
    },
    primaryBtn: {
      height: 48,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },
    primaryBtnText: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textOnPrimary },
    errorBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.crimsonWash,
      borderRadius: 10,
      padding: 10,
    },
    errorBoxText: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 13, color: colors.crimsonError },
    errorMessage: { fontFamily: theme.fonts.mono, fontSize: 13, lineHeight: 19, color: colors.textPrimary, marginTop: 4 },
    eventRow: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 6, gap: 4 },
    stack: { fontSize: 11, lineHeight: 15, color: colors.textSecondary, backgroundColor: colors.cardSubtle, padding: 8, borderRadius: 8 },
    bugText: { fontFamily: theme.fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textPrimary, marginTop: 4 },
    settingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
    settingLabel: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 14, color: colors.textPrimary },
    settingInput: { width: 120, textAlign: "right" },
    pricePreview: { backgroundColor: colors.cardSubtle, borderRadius: 12, padding: 12, gap: 4, marginTop: 4 },
    priceLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
    priceStruck: { fontFamily: theme.fonts.sans, fontSize: 14, color: colors.textMuted, textDecorationLine: "line-through" },
    priceNow: { fontFamily: theme.fonts.display, fontSize: 18, fontWeight: "600", color: colors.textPrimary },
  });
}

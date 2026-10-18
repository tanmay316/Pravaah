/**
 * Premium upgrade screen. Reached from the Coach tab, the free demo ending, or Profile.
 */

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { getEntitlements, getPricing, redeemCoupon, type Entitlements, type PublicPlan } from "../lib/api";
import {
  PLAN_COMPARISON,
  PREMIUM_FEATURES,
  PREMIUM_PLANS,
  formatInr,
  purchasePremium,
  type PremiumPlan,
} from "../lib/premium";
import { theme, useTheme, type ThemeColors } from "../lib/theme";

export default function PremiumScreen() {
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [plan, setPlan] = useState<PremiumPlan>(PREMIUM_PLANS[0]);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponResult, setCouponResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [livePlans, setLivePlans] = useState<PublicPlan[] | null>(null);

  const refreshEntitlements = () => getEntitlements().then(setEntitlements).catch(() => {});

  useEffect(() => {
    refreshEntitlements();
    getPricing().then(setLivePlans).catch(() => {});
  }, []);

  const applyCoupon = async () => {
    if (couponCode.trim().length < 3 || couponBusy) return;
    setCouponBusy(true);
    setCouponResult(null);
    try {
      const result = await redeemCoupon(couponCode);
      setCouponResult({ ok: true, text: result.message });
      setCouponCode("");
      await refreshEntitlements();
    } catch (err: any) {
      setCouponResult({ ok: false, text: err?.message || "This coupon code is not valid." });
    } finally {
      setCouponBusy(false);
    }
  };

  const discount = entitlements?.discount_percent || 0;

  // Live prices come from the server (admins set them); the bundled ones are only a fallback.
  const priceFor = (option: PremiumPlan) => {
    const live = livePlans?.find((p) => p.id === option.id);
    const regular = live?.price_inr ?? option.amountInr;
    const base = live?.effective_price_inr ?? option.amountInr;
    const final = Math.round(discount > 0 ? base * (1 - discount / 100) : base);
    const save = live?.save_vs_monthly_percent;
    return {
      regular,
      final,
      saleLabel: live?.sale_label || "",
      saleEnds: live?.sale_ends_at || null,
      badge: live
        ? live.sale_percent_off
          ? `${live.sale_percent_off}% off`
          : save
          ? `Save ${save}%`
          : ""
        : option.note || "",
    };
  };

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const subscribe = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await purchasePremium(plan);
    } catch (err: any) {
      setMessage(err?.message || "Could not start the purchase. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const headline =
    reason === "demo_used"
      ? "Your free demo is over"
      : reason === "demo_ended"
      ? "Enjoyed talking with your coach?"
      : reason === "test_used"
      ? "You've taken this week's free speaking test"
      : "Speak English with confidence";

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
      <View style={styles.topBar}>
        <Pressable style={styles.iconBtn} onPress={close} accessibilityLabel="Close">
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.badge}>
          <Ionicons name="diamond-outline" size={14} color={colors.irisBlue} />
          <Text style={styles.badgeText}>Pravaah Premium</Text>
        </View>
        <Text style={styles.title}>{headline}</Text>
        <Text style={styles.subtitle}>
          Practise real conversations with your AI coach and get every mistake corrected as you speak.
        </Text>

        {entitlements?.is_premium ? (
          <View style={styles.activeCard}>
            <Ionicons name="checkmark-circle" size={22} color={colors.emeraldSuccess} />
            <Text style={styles.activeText}>You're on Premium. Enjoy daily practice with your coach.</Text>
          </View>
        ) : null}

        <View style={styles.featureList}>
          {PREMIUM_FEATURES.map((feature) => (
            <View key={feature.title} style={styles.featureRow}>
              <View style={styles.featureIcon}>
                <Ionicons name={feature.icon as any} size={20} color={colors.irisBlue} />
              </View>
              <View style={styles.featureText}>
                <Text style={styles.featureTitle}>{feature.title}</Text>
                <Text style={styles.featureDetail}>{feature.detail}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.table}>
          <View style={[styles.tableRow, styles.tableHead]}>
            <Text style={[styles.tableCell, styles.tableFeature, styles.tableHeadText]}> </Text>
            <Text style={[styles.tableCell, styles.tableHeadText]}>Free</Text>
            <Text style={[styles.tableCell, styles.tableHeadText, styles.tablePremium]}>Premium</Text>
          </View>
          {PLAN_COMPARISON.map((row, i) => (
            <View key={row.feature} style={[styles.tableRow, i === PLAN_COMPARISON.length - 1 && styles.tableRowLast]}>
              <Text style={[styles.tableCell, styles.tableFeature]}>{row.feature}</Text>
              <Text style={[styles.tableCell, styles.tableValue]}>{row.free}</Text>
              <Text style={[styles.tableCell, styles.tableValue, styles.tablePremium]}>{row.premium}</Text>
            </View>
          ))}
        </View>

        {!entitlements?.is_premium ? (
          <View style={styles.plans}>
            {PREMIUM_PLANS.map((option) => {
              const price = priceFor(option);
              const active = option.id === plan.id;
              return (
                <Pressable
                  key={option.id}
                  style={[styles.planCard, active && styles.planCardActive]}
                  onPress={() => setPlan(option)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Ionicons
                    name={active ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={active ? colors.irisBlue : colors.fog}
                  />
                  <View style={styles.planText}>
                    <View style={styles.planTitleRow}>
                      <Text style={styles.planTitle}>{option.title}</Text>
                      {price.badge ? (
                        <View style={styles.saveBadge}>
                          <Text style={styles.saveBadgeText}>{price.badge}</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.priceRow}>
                      {price.final < price.regular ? (
                        <Text style={styles.priceStruck}>{formatInr(price.regular)}</Text>
                      ) : null}
                      <Text style={[styles.planPeriod, price.final < price.regular && styles.priceSale]}>
                        {formatInr(price.final)} {option.period}
                      </Text>
                    </View>
                    {price.saleLabel ? (
                      <Text style={styles.saleLabel}>
                        {price.saleLabel}
                        {price.saleEnds ? ` · ends ${new Date(price.saleEnds).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {discount > 0 ? (
              <View style={styles.discountNote}>
                <Ionicons name="pricetag-outline" size={16} color={colors.emeraldSuccess} />
                <Text style={styles.discountNoteText}>
                  {discount}% off applied with {entitlements?.discount_code}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.couponBox}>
          {couponOpen ? (
            <>
              <Text style={styles.couponLabel}>Coupon code</Text>
              <View style={styles.couponRow}>
                <TextInput
                  style={styles.couponInput}
                  value={couponCode}
                  onChangeText={(text) => setCouponCode(text.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                  placeholder="e.g. PRAVAAH-AB12-CD34"
                  placeholderTextColor={colors.fog}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={32}
                  onSubmitEditing={applyCoupon}
                  returnKeyType="done"
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.couponBtn,
                    (pressed || couponBusy || couponCode.trim().length < 3) && styles.pressed,
                  ]}
                  onPress={applyCoupon}
                  disabled={couponBusy || couponCode.trim().length < 3}
                >
                  {couponBusy ? (
                    <ActivityIndicator size="small" color={colors.textOnPrimary} />
                  ) : (
                    <Text style={styles.couponBtnText}>Apply</Text>
                  )}
                </Pressable>
              </View>
              {couponResult ? (
                <View style={styles.couponResult}>
                  <Ionicons
                    name={couponResult.ok ? "checkmark-circle" : "alert-circle-outline"}
                    size={16}
                    color={couponResult.ok ? colors.emeraldSuccess : colors.crimsonError}
                  />
                  <Text style={[styles.couponResultText, { color: couponResult.ok ? colors.emeraldSuccess : colors.crimsonError }]}>
                    {couponResult.text}
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <Pressable onPress={() => setCouponOpen(true)} hitSlop={8} style={styles.couponLink}>
              <Ionicons name="pricetag-outline" size={16} color={colors.irisBlue} />
              <Text style={styles.couponLinkText}>Have a coupon code?</Text>
            </Pressable>
          )}
        </View>

        {message ? (
          <View style={styles.messageBox}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.messageText}>{message}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
        {entitlements?.is_premium ? (
          <Pressable style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]} onPress={close}>
            <Text style={styles.primaryBtnText}>Back to practice</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, (pressed || busy) && styles.pressed]}
              onPress={subscribe}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.textOnPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Get Premium</Text>
              )}
            </Pressable>
            <Text style={styles.finePrint}>Cancel anytime from Google Play. Lessons and word review stay free.</Text>
          </>
        )}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.canvas },
    topBar: {
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingHorizontal: 16,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    iconBtn: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    content: {
      paddingHorizontal: 20,
      paddingBottom: 24,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: colors.primarySoft,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      marginBottom: 12,
    },
    badgeText: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "600", color: colors.irisBlue },
    title: {
      fontFamily: theme.fonts.display,
      fontSize: 28,
      lineHeight: 34,
      fontWeight: "600",
      letterSpacing: -0.6,
      color: colors.textPrimary,
      marginBottom: 8,
    },
    subtitle: { fontFamily: theme.fonts.sans, fontSize: 15, lineHeight: 22, color: colors.textSecondary, marginBottom: 20 },
    activeCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.emeraldWash,
      borderRadius: 14,
      padding: 14,
      marginBottom: 20,
    },
    activeText: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textPrimary },
    featureList: { gap: 14, marginBottom: 24 },
    featureRow: { flexDirection: "row", alignItems: "center", gap: 14 },
    featureIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    featureText: { flex: 1 },
    featureTitle: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textPrimary },
    featureDetail: { fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary, marginTop: 1 },
    table: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: "hidden",
      marginBottom: 24,
      backgroundColor: colors.cardElevated,
    },
    tableRow: {
      flexDirection: "row",
      alignItems: "center",
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: 11,
      paddingHorizontal: 14,
    },
    tableRowLast: { borderBottomWidth: 0 },
    tableHead: { backgroundColor: colors.cardSubtle },
    tableHeadText: { fontWeight: "600", color: colors.textPrimary },
    tableCell: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 13, color: colors.textSecondary },
    tableFeature: { flex: 1.4, color: colors.textPrimary, fontWeight: "500" },
    tableValue: { textAlign: "center" },
    tablePremium: { textAlign: "center", color: colors.irisBlue, fontWeight: "600" },
    plans: { gap: 10, marginBottom: 12 },
    planCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      borderRadius: 16,
      padding: 16,
    },
    planCardActive: { borderColor: colors.irisBlue, backgroundColor: colors.primarySoft },
    planText: { flex: 1 },
    planTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    planTitle: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    planPeriod: { fontFamily: theme.fonts.sans, fontSize: 14, color: colors.textSecondary, marginTop: 2 },
    priceRow: { flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
    priceSale: { color: colors.textPrimary, fontWeight: "600" },
    saleLabel: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "500", color: colors.emeraldSuccess, marginTop: 2 },
    priceStruck: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textMuted,
      textDecorationLine: "line-through",
    },
    discountNote: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
    discountNoteText: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.emeraldSuccess },
    couponBox: { marginBottom: 16 },
    couponLink: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 6 },
    couponLinkText: { fontFamily: theme.fonts.sans, fontSize: 14, fontWeight: "600", color: colors.irisBlue },
    couponLabel: { fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500", color: colors.textSecondary, marginBottom: 6 },
    couponRow: { flexDirection: "row", gap: 8 },
    couponInput: {
      flex: 1,
      height: 46,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      paddingHorizontal: 14,
      fontFamily: theme.fonts.mono,
      fontSize: 15,
      letterSpacing: 0.5,
      color: colors.textPrimary,
    },
    couponBtn: {
      height: 46,
      paddingHorizontal: 18,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    couponBtnText: { fontFamily: theme.fonts.sans, fontSize: 15, fontWeight: "600", color: colors.textOnPrimary },
    couponResult: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
    couponResultText: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 13, fontWeight: "500" },
    saveBadge: { backgroundColor: colors.emeraldWash, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    saveBadgeText: { fontFamily: theme.fonts.sans, fontSize: 12, fontWeight: "600", color: colors.emeraldSuccess },
    messageBox: {
      flexDirection: "row",
      gap: 8,
      backgroundColor: colors.cardSubtle,
      borderRadius: 12,
      padding: 12,
      marginTop: 4,
    },
    messageText: { flex: 1, fontFamily: theme.fonts.sans, fontSize: 13, lineHeight: 19, color: colors.textPrimary },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
      gap: 8,
    },
    primaryBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnText: { fontFamily: theme.fonts.sans, fontSize: 16, fontWeight: "600", color: colors.textOnPrimary },
    pressed: { opacity: 0.85 },
    finePrint: { fontFamily: theme.fonts.sans, fontSize: 12, color: colors.textMuted, textAlign: "center" },
  });
}

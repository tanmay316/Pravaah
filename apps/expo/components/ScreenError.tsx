/**
 * Full-screen fallback for Expo Router error boundaries, so a render or module-load failure
 * shows what went wrong and a way out instead of a blank screen.
 */

import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname, type ErrorBoundaryProps } from "expo-router";
import { reportClientError } from "../lib/api";
import { theme, useTheme } from "../lib/theme";

export default function ScreenError({ error, retry }: ErrorBoundaryProps) {
  const { colors } = useTheme();
  const pathname = usePathname();
  useEffect(() => {
    reportClientError({ kind: "crash", message: error?.message || String(error), stack: error?.stack, screen: pathname });
  }, [error, pathname]);
  return (
    <View style={[styles.screen, { backgroundColor: colors.canvas }]}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.cardElevated,
            borderColor: colors.border,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.textPrimary }]}>Something went wrong</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          This screen could not be displayed. Try again, or go back to the dashboard.
        </Text>
        <Text style={[styles.detail, { color: colors.textMuted, backgroundColor: colors.cardSubtle }]} numberOfLines={4}>
          {error?.message || String(error)}
        </Text>
        <Pressable
          style={[
            styles.primaryBtn,
            { backgroundColor: colors.primary },
          ]}
          onPress={() => retry()}
        >
          <Text style={[styles.primaryBtnText, { color: colors.textOnPrimary }]}>Try again</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={() => router.replace("/")}>
          <Text style={[styles.secondaryBtnText, { color: colors.irisBlue }]}>Back to dashboard</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    borderRadius: 20,
    padding: theme.spacing.xl,
    borderWidth: 1,
    alignItems: "center",
  },
  title: {
    fontFamily: theme.fonts.display,
    fontSize: theme.fontSizes.headingSm,
    fontWeight: "600",
    marginBottom: theme.spacing.sm,
    textAlign: "center",
  },
  body: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    textAlign: "center",
    marginBottom: theme.spacing.md,
    lineHeight: 22,
  },
  detail: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.xs2,
    textAlign: "center",
    marginBottom: theme.spacing.xl,
    padding: 12,
    borderRadius: theme.radii.md,
    width: "100%",
  },
  primaryBtn: {
    width: "100%",
    minHeight: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.sm,
  },
  primaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "600",
  },
  secondaryBtn: {
    minWidth: 220,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.bodySm,
    fontWeight: "600",
  },
});

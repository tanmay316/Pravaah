/**
 * Full-screen fallback for Expo Router error boundaries, so a render or module-load failure
 * shows what went wrong and a way out instead of a blank screen.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, type ErrorBoundaryProps } from "expo-router";
import { theme } from "../lib/theme";

export default function ScreenError({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.body}>
        This screen could not be displayed. Try again, or go back to the dashboard.
      </Text>
      <Text style={styles.detail} numberOfLines={4}>
        {error?.message || String(error)}
      </Text>
      <Pressable style={styles.primaryBtn} onPress={() => retry()}>
        <Text style={styles.primaryBtnText}>Try again</Text>
      </Pressable>
      <Pressable style={styles.secondaryBtn} onPress={() => router.replace("/")}>
        <Text style={styles.secondaryBtnText}>Back to dashboard</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.abyss,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xxl,
  },
  title: {
    fontFamily: theme.fonts.serif,
    fontSize: theme.fontSizes.headingMd,
    color: theme.colors.cloud,
    marginBottom: theme.spacing.sm,
    textAlign: "center",
  },
  body: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    color: theme.colors.ash,
    textAlign: "center",
    marginBottom: theme.spacing.md,
    maxWidth: 420,
  },
  detail: {
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.monoLabel,
    color: theme.colors.fog,
    textAlign: "center",
    marginBottom: theme.spacing.xl,
    maxWidth: 420,
  },
  primaryBtn: {
    minWidth: 220,
    minHeight: theme.mobile.minTouchSize,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.pure,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.sm,
  },
  primaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    fontWeight: "700",
    color: theme.colors.void,
  },
  secondaryBtn: {
    minWidth: 220,
    minHeight: theme.mobile.minTouchSize,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.body,
    color: theme.colors.paleIris,
  },
});

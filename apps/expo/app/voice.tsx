/**
 * First-run step: pick the coach voice after hearing each one.
 */

import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import VoicePicker from "../components/VoicePicker";
import { updateProfile, type TtsVoice } from "../lib/api";
import { theme, useTheme, type ThemeColors } from "../lib/theme";

export default function VoiceOnboarding() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [voice, setVoice] = useState<TtsVoice>("warm_male");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (choice: TtsVoice) => {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ tts_voice: choice });
      router.replace("/");
    } catch (err: any) {
      setError(err?.message || "Could not save your choice. Please try again.");
      setSaving(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 16) }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.step}>Getting started</Text>
        <Text style={styles.title}>Choose your coach's voice</Text>
        <Text style={styles.subtitle}>
          Tap a voice to hear a short sample. You can change it any time in Profile.
        </Text>

        <VoicePicker value={voice} onChange={setVoice} />

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && styles.pressed]}
          onPress={() => save(voice)}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={colors.textOnPrimary} size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Continue</Text>
          )}
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={() => save("warm_male")} disabled={saving}>
          <Text style={styles.skipBtnText}>Skip for now</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.canvas,
    },
    content: {
      paddingHorizontal: theme.spacing.lg,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    step: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      fontWeight: "500",
      color: colors.irisBlue,
      marginTop: 8,
      marginBottom: 6,
    },
    title: {
      fontFamily: theme.fonts.display,
      fontSize: 26,
      fontWeight: "600",
      letterSpacing: -0.5,
      lineHeight: 32,
      color: colors.textPrimary,
      marginBottom: 6,
    },
    subtitle: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      lineHeight: 22,
      color: colors.textSecondary,
      marginBottom: 20,
    },
    error: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.crimsonError,
      marginTop: 12,
    },
    footer: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.canvas,
      maxWidth: theme.mobile.maxContentWidth,
      width: "100%",
      alignSelf: "center",
    },
    primaryBtn: {
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textOnPrimary,
    },
    pressed: {
      opacity: 0.85,
    },
    skipBtn: {
      alignItems: "center",
      paddingVertical: 12,
    },
    skipBtnText: {
      fontFamily: theme.fonts.sans,
      fontSize: 14,
      fontWeight: "500",
      color: colors.textSecondary,
    },
  });
}

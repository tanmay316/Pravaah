import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COACH_VOICES, type TtsVoice } from "../lib/api";
import { theme, useTheme, type ThemeColors } from "../lib/theme";
import { useVoicePreview } from "../lib/voicePreview";

interface Props {
  value: TtsVoice | null;
  onChange: (voice: TtsVoice) => void;
}

/** Voice cards: tapping a card selects it and plays its sample; the button replays or stops it. */
export default function VoicePicker({ value, onChange }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { playing, play, toggle } = useVoicePreview();

  return (
    <View style={styles.list}>
      {COACH_VOICES.map((voice) => {
        const selected = value === voice.value;
        const isPlaying = playing === voice.value;
        return (
          <Pressable
            key={voice.value}
            style={({ pressed }) => [styles.card, selected && styles.cardSelected, pressed && styles.pressed]}
            onPress={() => {
              onChange(voice.value);
              play(voice.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${voice.name}, ${voice.description}`}
          >
            <View style={[styles.avatar, selected && styles.avatarSelected]}>
              <Text style={[styles.avatarText, selected && styles.avatarTextSelected]}>
                {voice.name.charAt(0)}
              </Text>
            </View>

            <View style={styles.body}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{voice.name}</Text>
                {selected ? <Ionicons name="checkmark-circle" size={16} color={colors.irisBlue} /> : null}
              </View>
              <Text style={styles.description} numberOfLines={2}>
                {isPlaying ? "Playing sample…" : voice.description}
              </Text>
            </View>

            <Pressable
              style={({ pressed }) => [styles.playBtn, isPlaying && styles.playBtnActive, pressed && styles.pressed]}
              onPress={() => toggle(voice.value)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? `Stop ${voice.name} sample` : `Play ${voice.name} sample`}
            >
              <Ionicons
                name={isPlaying ? "stop" : "play"}
                size={15}
                color={isPlaying ? "#ffffff" : colors.irisBlue}
                style={isPlaying ? undefined : styles.playIconNudge}
              />
            </Pressable>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: {
      gap: 10,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 14,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
    },
    cardSelected: {
      borderColor: colors.irisBlue,
      backgroundColor: colors.primarySoft,
    },
    pressed: {
      opacity: 0.85,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardSubtle,
    },
    avatarSelected: {
      backgroundColor: colors.irisBlue,
    },
    avatarText: {
      fontFamily: theme.fonts.display,
      fontSize: 16,
      fontWeight: "600",
      color: colors.textSecondary,
    },
    avatarTextSelected: {
      color: "#ffffff",
    },
    body: {
      flex: 1,
      minWidth: 0,
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    name: {
      fontFamily: theme.fonts.sans,
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    description: {
      fontFamily: theme.fonts.sans,
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 2,
    },
    playBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.cardElevated,
      alignItems: "center",
      justifyContent: "center",
    },
    playBtnActive: {
      backgroundColor: colors.irisBlue,
      borderColor: colors.irisBlue,
    },
    playIconNudge: {
      marginLeft: 2,
    },
  });
}

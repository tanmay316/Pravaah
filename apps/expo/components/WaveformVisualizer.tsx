import React, { useEffect, useRef } from "react";
import { StyleSheet, View, Animated, Easing } from "react-native";
import { theme } from "../lib/theme";

interface WaveformVisualizerProps {
  state:
    | "IDLE"
    | "CREATING"
    | "CONNECTING"
    | "CONNECTED"
    | "LISTENING"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "RECONNECTING"
    | "ERROR"
    | "ENDED";
  audioLevel?: number; // 0.0 to 1.0
}

const NUM_BARS = 15;

export function WaveformVisualizer({
  state,
  audioLevel = 0,
}: WaveformVisualizerProps) {
  const animatedValues = useRef<Animated.Value[]>(
    Array.from({ length: NUM_BARS }, () => new Animated.Value(0.15))
  ).current;

  const animLoops = useRef<Animated.CompositeAnimation[]>([]);

  useEffect(() => {
    animLoops.current.forEach((a) => a.stop());
    animLoops.current = [];

    const isSpeaking = state === "USER_SPEAKING" || state === "AI_SPEAKING";
    const isThinking =
      state === "PROCESSING" ||
      state === "CONNECTING" ||
      state === "CREATING";
    const isListening = state === "LISTENING";

    animatedValues.forEach((val, i) => {
      const distFromCenter = Math.abs(i - (NUM_BARS - 1) / 2);
      const centerFactor = 1 - (distFromCenter / (NUM_BARS / 2)) * 0.45;

      let minHeight = 0.12;
      let maxHeight = 0.35;
      let speed = 600;

      if (isSpeaking) {
        const boost = Math.max(0.3, Math.min(1.0, audioLevel * 3 + 0.4));
        minHeight = 0.2 * centerFactor;
        maxHeight = Math.min(
          1.0,
          (0.55 + Math.random() * 0.45) * centerFactor * boost
        );
        speed = 120 + Math.random() * 140;
      } else if (isThinking) {
        minHeight = 0.15;
        maxHeight = 0.55 * centerFactor;
        speed = 300 + i * 45;
      } else if (isListening) {
        minHeight = 0.12 * centerFactor;
        maxHeight = 0.38 * centerFactor;
        speed = 750 + distFromCenter * 80;
      } else {
        minHeight = 0.08;
        maxHeight = 0.15;
        speed = 1200;
      }

      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(val, {
            toValue: maxHeight,
            duration: speed,
            easing: isSpeaking
              ? Easing.elastic(1.2)
              : Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(val, {
            toValue: minHeight,
            duration: speed * 0.9,
            easing: isSpeaking ? Easing.linear : Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ])
      );

      animLoops.current.push(loop);
      loop.start();
    });

    return () => {
      animLoops.current.forEach((a) => a.stop());
    };
  }, [state, audioLevel]);

  const getColors = () => {
    switch (state) {
      case "USER_SPEAKING":
        return {
          barColor: theme.colors.emeraldSuccess,
          glowColor: "rgba(56, 211, 159, 0.4)",
          bgBorder: "rgba(56, 211, 159, 0.2)",
        };
      case "AI_SPEAKING":
        return {
          barColor: theme.colors.irisGleam,
          glowColor: "rgba(132, 125, 255, 0.5)",
          bgBorder: "rgba(132, 125, 255, 0.3)",
        };
      case "PROCESSING":
        return {
          barColor: theme.colors.cyanSignal,
          glowColor: "rgba(0, 179, 221, 0.4)",
          bgBorder: "rgba(0, 179, 221, 0.2)",
        };
      case "LISTENING":
        return {
          barColor: theme.colors.paleIris,
          glowColor: "rgba(209, 201, 255, 0.3)",
          bgBorder: "rgba(209, 201, 255, 0.15)",
        };
      default:
        return {
          barColor: theme.colors.steel,
          glowColor: "transparent",
          bgBorder: theme.colors.borderMuted,
        };
    }
  };

  const { barColor, glowColor, bgBorder } = getColors();

  return (
    <View style={[styles.container, { borderColor: bgBorder }]}>
      <View style={styles.waveformRow}>
        {animatedValues.map((anim, idx) => {
          const heightInterpolation = anim.interpolate({
            inputRange: [0, 1],
            outputRange: [6, 64],
          });

          return (
            <Animated.View
              key={idx}
              style={[
                styles.bar,
                {
                  height: heightInterpolation,
                  backgroundColor: barColor,
                  shadowColor: glowColor,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.85,
                  shadowRadius: 8,
                },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 96,
    borderRadius: theme.radii.lg,
    backgroundColor: theme.colors.obsidian,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginVertical: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
  },
  waveformRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 64,
  },
  bar: {
    width: 4,
    borderRadius: theme.radii.full,
  },
});

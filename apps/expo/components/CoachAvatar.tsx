/**
 * Coach Pravaah — animated tutor avatar.
 *
 * Pure react-native-svg so it renders identically on web, Android and iOS with no model
 * downloads. Lip-sync follows the coach's real audio level when available (web analyser),
 * otherwise a syllable-rate envelope while LiveKit reports the coach is speaking.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { theme } from "../lib/theme";

export type CoachAvatarState = "connecting" | "listening" | "thinking" | "speaking" | "muted";

/** `live`: value is the actual voice amplitude; otherwise it is only a loudness envelope. */
export type AgentLevel = { value: number; live: boolean };

interface Props {
  state: CoachAvatarState;
  learnerSpeaking?: boolean;
  getLevel?: () => AgentLevel;
  caption?: string;
  hint?: string;
  size?: number;
}

const STATE_META: Record<CoachAvatarState, { label: string; color: string }> = {
  connecting: { label: "Joining", color: theme.colors.amberWarning },
  listening: { label: "Listening", color: theme.colors.cyanSignal },
  thinking: { label: "Thinking", color: theme.colors.paleIris },
  speaking: { label: "Speaking", color: theme.colors.emeraldSuccess },
  muted: { label: "You're muted", color: theme.colors.fog },
};

const SKIN = { light: "#d9a27c", base: "#c18660", shadow: "#9c6544" };
const NATIVE_DRIVER = Platform.OS !== "web";
const HAIR = "#1d1716";
const LIP = "#9a4d43";

interface Frame {
  open: number;
  blink: number;
  gazeX: number;
  gazeY: number;
  tilt: number;
  bob: number;
  brow: number;
  voice: number;
  t: number;
}

const REST: Frame = { open: 0, blink: 1, gazeX: 0, gazeY: 0.5, tilt: 0, bob: 0, brow: 0, voice: 0, t: 0 };

function useFace(state: CoachAvatarState, learnerSpeaking: boolean, getLevel?: () => AgentLevel): Frame {
  const [frame, setFrame] = useState<Frame>(REST);
  const live = useRef({ state, learnerSpeaking, getLevel });
  live.current = { state, learnerSpeaking, getLevel };

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const start = Date.now();
    let open = 0;
    let voice = 0;
    let nextBlink = 1200;
    let blinkStart = -1;
    let saccade = { x: 0, y: 0, at: 0 };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const ms = Date.now() - start;
      // ~30 fps is plenty for a face and keeps the JS thread free for audio/UI.
      if (ms - last < 33) return;
      last = ms;
      const t = ms / 1000;
      const { state: s, learnerSpeaking: hearing, getLevel: level } = live.current;
      const speaking = s === "speaking";

      let target = 0;
      if (speaking) {
        const reading = level?.() ?? { value: 0, live: false };
        const syllables = 0.3 + 0.7 * Math.abs(Math.sin(t * 9.1)) * Math.abs(Math.sin(t * 3.3 + 1.2));
        target = reading.live
          ? Math.min(1, reading.value * 1.4)
          : syllables * (reading.value > 0 ? 0.55 + Math.min(reading.value, 1) * 0.45 : 0.75);
      }
      open += (target - open) * (target > open ? 0.55 : 0.3);
      voice += (target - voice) * 0.2;

      if (blinkStart < 0 && ms > nextBlink) blinkStart = ms;
      let blink = 1;
      if (blinkStart >= 0) {
        const p = (ms - blinkStart) / 150;
        if (p >= 1) {
          blinkStart = -1;
          nextBlink = ms + 2200 + Math.random() * 3200;
        } else {
          blink = 1 - Math.sin(Math.PI * p);
        }
      }

      if (ms - saccade.at > 1400 + Math.random() * 900) {
        saccade = { x: (Math.random() - 0.5) * 1.6, y: (Math.random() - 0.5) * 0.8, at: ms };
      }
      let gazeX = saccade.x * 0.5;
      let gazeY = 0.4 + saccade.y * 0.5;
      let tilt = Math.sin(t * 0.6) * 1.2;
      let brow = 0;
      let bob = Math.sin(t * 1.4) * 0.6;

      if (speaking) {
        gazeX = saccade.x;
        gazeY = saccade.y;
        tilt = Math.sin(t * 1.7) * 2.2 + open * 1.5;
        brow = open * 2.2;
        bob += open * 0.8;
      } else if (s === "thinking") {
        gazeX = 1.8;
        gazeY = -1.4;
        tilt = -3;
        brow = 2.2;
      } else if (s === "listening") {
        tilt = 3 + Math.sin(t * 0.8) * 0.8;
        if (hearing) {
          brow = 1;
          bob += Math.max(0, Math.sin(t * 2.6)) * 1.6;
        }
      }

      setFrame({ open, blink, gazeX, gazeY, tilt, bob, brow, voice, t });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return frame;
}

function Eye({ cx, cy, f, id }: { cx: number; cy: number; f: Frame; id: string }) {
  const ry = 4.4 * Math.max(f.blink, 0.06);
  if (f.blink < 0.2) {
    return <Path d={`M ${cx - 6} ${cy} Q ${cx} ${cy + 2} ${cx + 6} ${cy}`} stroke={HAIR} strokeWidth={1.6} fill="none" strokeLinecap="round" />;
  }
  const ix = cx + f.gazeX;
  const iy = cy + f.gazeY;
  return (
    <G>
      <Defs>
        <ClipPath id={id}>
          <Ellipse cx={cx} cy={cy} rx={6.2} ry={ry} />
        </ClipPath>
      </Defs>
      <Ellipse cx={cx} cy={cy} rx={6.2} ry={ry} fill="#fbf8f4" />
      <G clipPath={`url(#${id})`}>
        <Circle cx={ix} cy={iy} r={3.3} fill="#4a2c1a" />
        <Circle cx={ix} cy={iy} r={1.6} fill="#120a07" />
        <Circle cx={ix + 1.1} cy={iy - 1.1} r={0.9} fill="#ffffff" />
      </G>
      <Path d={`M ${cx - 6.4} ${cy - ry * 0.7} Q ${cx} ${cy - ry - 1.6} ${cx + 6.4} ${cy - ry * 0.7}`} stroke={HAIR} strokeWidth={1.3} fill="none" strokeLinecap="round" />
    </G>
  );
}

function Mouth({ f }: { f: Frame }) {
  const o = f.open;
  const cy = 119;
  const w = 9 + o * 1.5 + Math.sin(f.t * 13) * o * 0.8;
  if (o < 0.06) {
    return (
      <Path d={`M ${100 - w} ${cy - 1} Q 100 ${cy + 4.5} ${100 + w} ${cy - 1}`} stroke={LIP} strokeWidth={2.4} fill="none" strokeLinecap="round" />
    );
  }
  const drop = 2 + o * 11;
  const top = cy - 1 - o * 1.2;
  const inner = `M ${100 - w} ${cy} Q 100 ${top} ${100 + w} ${cy} Q 100 ${cy + drop} ${100 - w} ${cy} Z`;
  const teeth = Math.min(3.2, o * 5);
  return (
    <G>
      <Path d={inner} fill="#3b1513" />
      {o > 0.12 ? (
        <Path
          d={`M ${100 - w * 0.72} ${cy - 0.2} Q 100 ${top + 0.6} ${100 + w * 0.72} ${cy - 0.2} L ${100 + w * 0.66} ${cy + teeth} Q 100 ${cy + teeth + 0.8} ${100 - w * 0.66} ${cy + teeth} Z`}
          fill="#f5f2ec"
        />
      ) : null}
      {o > 0.35 ? <Ellipse cx={100} cy={cy + drop * 0.62} rx={w * 0.48} ry={o * 2.6} fill="#b85c58" /> : null}
      <Path d={`M ${100 - w - 0.8} ${cy} Q 100 ${top - 1.2} ${100 + w + 0.8} ${cy}`} stroke={LIP} strokeWidth={2.2} fill="none" strokeLinecap="round" />
      <Path d={`M ${100 - w} ${cy + 0.4} Q 100 ${cy + drop + 2} ${100 + w} ${cy + 0.4}`} stroke={LIP} strokeWidth={2.6} fill="none" strokeLinecap="round" />
    </G>
  );
}

function Portrait({ f, size }: { f: Frame; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="16 26 168 168">
      <Defs>
        <RadialGradient id="bg" cx="50%" cy="35%" r="70%">
          <Stop offset="0" stopColor="#2b2a5e" />
          <Stop offset="0.6" stopColor="#16173a" />
          <Stop offset="1" stopColor="#0b0c18" />
        </RadialGradient>
        <LinearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={SKIN.light} />
          <Stop offset="1" stopColor={SKIN.base} />
        </LinearGradient>
        <LinearGradient id="blazer" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#2c3360" />
          <Stop offset="1" stopColor="#161a36" />
        </LinearGradient>
        <LinearGradient id="hair" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#3a2c28" />
          <Stop offset="1" stopColor={HAIR} />
        </LinearGradient>
        <ClipPath id="frame">
          <Circle cx={100} cy={100} r={100} />
        </ClipPath>
      </Defs>

      <G clipPath="url(#frame)">
        <Rect x={0} y={0} width={200} height={200} fill="url(#bg)" />
        <Circle cx={100} cy={86} r={70} fill="#847dff" opacity={0.08 + f.voice * 0.12} />

        {/* Shoulders and blazer breathe slightly behind the head. */}
        <G transform={`translate(0 ${f.bob * 0.4})`}>
          <Path d="M 6 200 C 10 170 38 156 72 150 L 100 170 L 128 150 C 162 156 190 170 194 200 Z" fill="url(#blazer)" />
          <Path d="M 80 148 L 100 178 L 120 148 Z" fill="#eef1f8" />
          <Path d="M 82 146 L 100 163 L 93 172 Z" fill="#ffffff" stroke="#cfd5e3" strokeWidth={0.8} />
          <Path d="M 118 146 L 100 163 L 107 172 Z" fill="#ffffff" stroke="#cfd5e3" strokeWidth={0.8} />
          <Path d="M 72 150 L 94 192 L 86 162 Z" fill="#1d2246" />
          <Path d="M 128 150 L 106 192 L 114 162 Z" fill="#1d2246" />
          <Circle cx={133} cy={170} r={3.2} fill="#847dff" />
          <Path d="M 87 126 L 113 126 L 115 150 Q 100 160 85 150 Z" fill={SKIN.shadow} />
        </G>

        <G transform={`rotate(${f.tilt} 100 140) translate(0 ${f.bob})`}>
          <Ellipse cx={66} cy={97} rx={6} ry={10} fill={SKIN.base} />
          <Ellipse cx={134} cy={97} rx={6} ry={10} fill={SKIN.base} />
          <Ellipse cx={100} cy={93} rx={34} ry={41} fill="url(#skin)" />
          <Path d="M 70 112 Q 100 142 130 112 Q 122 134 100 135 Q 78 134 70 112 Z" fill={SKIN.shadow} opacity={0.25} />
          <Path
            d="M 64 94 C 58 56 84 40 104 42 C 130 42 144 60 137 94 C 135 78 129 67 117 62 C 104 71 86 71 74 66 C 68 74 66 83 64 94 Z"
            fill="url(#hair)"
          />
          <Path d="M 96 46 C 110 46 124 52 130 64" stroke="#5a4640" strokeWidth={1.2} fill="none" opacity={0.6} />

          <Ellipse cx={82} cy={108} rx={6} ry={3.5} fill="#e07a63" opacity={0.14} />
          <Ellipse cx={118} cy={108} rx={6} ry={3.5} fill="#e07a63" opacity={0.14} />

          <G transform={`translate(0 ${-f.brow})`}>
            <Path d="M 79 81 Q 88 75.5 96 79.5" stroke={HAIR} strokeWidth={3} fill="none" strokeLinecap="round" />
            <Path d="M 104 79.5 Q 112 75.5 121 81" stroke={HAIR} strokeWidth={3} fill="none" strokeLinecap="round" />
          </G>

          <Eye cx={88} cy={92} f={f} id="eyeL" />
          <Eye cx={112} cy={92} f={f} id="eyeR" />

          {/* Slim modern frames: the "teacher" cue. */}
          <G stroke="#2a2f3d" strokeWidth={1.6} fill="rgba(255,255,255,0.05)">
            <Rect x={77} y={84.5} width={22} height={15.5} rx={6} />
            <Rect x={101} y={84.5} width={22} height={15.5} rx={6} />
          </G>
          <Path d="M 99 90.5 Q 100 88.8 101 90.5 M 77 90 L 67 92 M 123 90 L 133 92" stroke="#2a2f3d" strokeWidth={1.5} fill="none" />

          <Path d="M 100 97 Q 96.5 107 99 109 Q 101 110 104 108" stroke={SKIN.shadow} strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <Mouth f={f} />
        </G>
      </G>
    </Svg>
  );
}

function Halo({ color, delay, fast }: { color: string; delay: number; fast: boolean }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    anim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, {
          toValue: 1,
          duration: fast ? 1300 : 2600,
          easing: Easing.out(Easing.quad),
          useNativeDriver: NATIVE_DRIVER,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [fast, delay, anim]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        styles.halo,
        {
          pointerEvents: "none",
          borderColor: color,
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] }) }],
        },
      ]}
    />
  );
}

function ThinkingDots({ color }: { color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: NATIVE_DRIVER })
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <View style={styles.thinkBubble}>
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={[
            styles.thinkDot,
            {
              backgroundColor: color,
              transform: [
                {
                  translateY: anim.interpolate({
                    inputRange: [0, 0.2 + i * 0.15, 0.4 + i * 0.15, 1],
                    outputRange: [0, -4, 0, 0],
                  }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

export default function CoachAvatar({
  state,
  learnerSpeaking = false,
  getLevel,
  caption,
  hint,
  size = 188,
}: Props) {
  const f = useFace(state, learnerSpeaking, getLevel);
  const meta = STATE_META[state];
  const ringColor = state === "listening" && learnerSpeaking ? theme.colors.irisGleam : meta.color;

  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: NATIVE_DRIVER })
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const captionFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    captionFade.setValue(0);
    Animated.timing(captionFade, { toValue: 1, duration: 320, useNativeDriver: NATIVE_DRIVER }).start();
  }, [caption, captionFade]);

  const ring = size + 22;
  const showHalos = state === "speaking" || (state === "listening" && learnerSpeaking) || state === "connecting";

  return (
    <View style={styles.wrap} accessibilityRole="image" accessibilityLabel={`Coach Pravaah, ${meta.label.toLowerCase()}`}>
      <View style={{ width: ring, height: ring, alignItems: "center", justifyContent: "center" }}>
        {showHalos ? (
          <>
            <Halo color={ringColor} delay={0} fast={state === "speaking"} />
            <Halo color={ringColor} delay={state === "speaking" ? 650 : 1300} fast={state === "speaking"} />
          </>
        ) : null}

        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { pointerEvents: "none", transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] },
          ]}
        >
          <Svg width={ring} height={ring} viewBox="0 0 100 100">
            <Defs>
              <LinearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={ringColor} stopOpacity={1} />
                <Stop offset="0.5" stopColor={theme.colors.irisGleam} stopOpacity={0.35} />
                <Stop offset="1" stopColor={ringColor} stopOpacity={0.05} />
              </LinearGradient>
            </Defs>
            <Circle cx={50} cy={50} r={48.5} stroke="url(#ringGrad)" strokeWidth={1.6} fill="none" />
          </Svg>
        </Animated.View>

        <View
          style={[
            styles.portrait,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: ringColor,
              transform: [{ scale: 1 + f.voice * 0.025 }],
            },
          ]}
        >
          <Portrait f={f} size={size} />
        </View>

        {state === "thinking" ? <ThinkingDots color={meta.color} /> : null}

        <View style={[styles.statusPill, { borderColor: ringColor }]}>
          <View style={[styles.statusDot, { backgroundColor: ringColor }]} />
          <Text style={[styles.statusLabel, { color: ringColor }]}>
            {state === "listening" && learnerSpeaking ? "Hearing you" : meta.label}
          </Text>
        </View>
      </View>

      <Text style={styles.name}>Coach Pravaah</Text>
      <Text style={styles.role}>Your English coach</Text>

      {caption ? (
        <Animated.View style={[styles.caption, { opacity: captionFade }]}>
          <Text style={styles.captionText} numberOfLines={3}>
            {caption}
          </Text>
        </Animated.View>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    marginTop: 4,
    marginBottom: 10,
  },
  halo: {
    borderRadius: 999,
    borderWidth: 2,
  },
  portrait: {
    overflow: "hidden",
    borderWidth: 2,
    backgroundColor: "#0b0c18",
    ...theme.shadows.card,
  },
  thinkBubble: {
    position: "absolute",
    top: 6,
    right: 2,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.glassCard,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  thinkDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPill: {
    position: "absolute",
    bottom: -6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: theme.colors.glassNav,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusLabel: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  name: {
    marginTop: 16,
    fontFamily: theme.fonts.serif,
    fontSize: 20,
    color: theme.colors.pure,
  },
  role: {
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.ash,
    marginTop: 2,
  },
  caption: {
    marginTop: 12,
    maxWidth: 520,
    alignSelf: "stretch",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radii.lg,
    backgroundColor: theme.colors.glassFill,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  captionText: {
    fontFamily: theme.fonts.sans,
    fontSize: 15,
    lineHeight: 21,
    color: theme.colors.cloud,
    textAlign: "center",
  },
  hint: {
    marginTop: 12,
    fontFamily: theme.fonts.sans,
    fontSize: 12,
    color: theme.colors.ash,
    textAlign: "center",
  },
});

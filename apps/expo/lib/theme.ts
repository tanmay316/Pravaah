/**
 * Pravaah — Daylight & Midnight Design System (Geniestudio tokens + Duolingo-inspired tactile mobile UX)
 *
 * Light palette: Sky Tint (#ebf5ff) canvas, Bone White (#fafdff) & Paper White (#ffffff) cards,
 * Ink (#0a0d12) & Charcoal (#181d27) typography/anchors, Iris Blue (#0069e0) & Sky Blue (#0099ff) accents,
 * and pastel category washes (Lavender #f1e6ff, Mint #d3f6e3, Powder #cce7ff, Solar #fff2be,
 * Violet #e4ccff, Aqua #c2e9ff, Peach #ffd1b8).
 *
 * Dark palette: Deep Ink (#0a0d12) & Charcoal (#181d27) surfaces with luminous Sky/Iris accents
 * and rich tinted category washes.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, Platform } from "react-native";

export type ThemeMode = "light" | "dark";

export const rawPalette = {
  skyTint: "#ebf5ff",
  paperWhite: "#ffffff",
  boneWhite: "#fafdff",
  mistGray: "#f6f7f8",
  ink: "#0a0d12",
  charcoal: "#181d27",
  graphite: "#535862",
  fog: "#93979f",
  slateShadow: "#3b3d41",
  irisBlue: "#0069e0",
  skyBlue: "#0099ff",
  lavenderWash: "#f1e6ff",
  mintWash: "#d3f6e3",
  powderBlue: "#cce7ff",
  solarGradient: "#fff2be",
  violetGradient: "#e4ccff",
  aquaGradient: "#c2e9ff",
  peachGradient: "#ffd1b8",
} as const;

export interface ThemeColors {
  isDark: boolean;

  // Canonical Geniestudio tokens
  skyTint: string;
  paperWhite: string;
  boneWhite: string;
  mistGray: string;
  ink: string;
  charcoal: string;
  graphite: string;
  fog: string;
  slateShadow: string;
  irisBlue: string;
  skyBlue: string;
  lavenderWash: string;
  mintWash: string;
  powderBlue: string;
  solarGradient: string;
  violetGradient: string;
  aquaGradient: string;
  peachGradient: string;

  // Semantic surfaces & text
  canvas: string;
  canvasSecondary: string;
  card: string;
  cardElevated: string;
  cardSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnPrimary: string;
  textOnDark: string;

  // Tactile Duolingo-inspired borders & 3D ledges
  border: string;
  borderLedge: string;
  borderStrong: string;
  borderAccent: string;
  primary: string;
  primaryLedge: string;
  primarySoft: string;
  charcoalBtn: string;
  charcoalLedge: string;

  // Pastel washes & matching borders/text for category cards & chips
  lavenderBorder: string;
  lavenderText: string;
  mintBorder: string;
  mintText: string;
  powderBorder: string;
  powderText: string;
  solarBorder: string;
  solarText: string;
  violetBorder: string;
  peachBorder: string;
  peachText: string;
  aquaBorder: string;

  // Status & feedback
  emeraldSuccess: string;
  emeraldLedge: string;
  emeraldWash: string;
  crimsonError: string;
  crimsonLedge: string;
  crimsonWash: string;
  amberWarning: string;
  amberLedge: string;
  amberWash: string;

  // Legacy aliases so existing components remain type-safe
  irisGleam: string;
  cyanSignal: string;
  paleIris: string;
  deepIris: string;
  orchidBloom: string;
  periwinkle: string;
  obsidian: string;
  abyss: string;
  graphiteCard: string;
  surfaceElevated: string;
  surfaceSubtle: string;
  steel: string;
  silver: string;
  ash: string;
  cloud: string;
  pure: string;
  void: string;
  glassNav: string;
  glassCard: string;
  glassFill: string;
  glassFillHover: string;
  borderMuted: string;
  borderLight: string;
  borderActive: string;
  borderIris: string;
  borderCyan: string;
  glowIris: string;
  glowEmerald: string;
  glowCyan: string;
}

export const lightColors: ThemeColors = {
  isDark: false,

  skyTint: "#ebf5ff",
  paperWhite: "#ffffff",
  boneWhite: "#fafdff",
  mistGray: "#f6f7f8",
  ink: "#0a0d12",
  charcoal: "#181d27",
  graphite: "#535862",
  fog: "#93979f",
  slateShadow: "#3b3d41",
  irisBlue: "#0069e0",
  skyBlue: "#0099ff",
  lavenderWash: "#f1e6ff",
  mintWash: "#d3f6e3",
  powderBlue: "#cce7ff",
  solarGradient: "#fff2be",
  violetGradient: "#e4ccff",
  aquaGradient: "#c2e9ff",
  peachGradient: "#ffd1b8",

  canvas: "#ebf5ff",
  canvasSecondary: "#f6f7f8",
  card: "#fafdff",
  cardElevated: "#ffffff",
  cardSubtle: "#f6f7f8",
  textPrimary: "#0a0d12",
  textSecondary: "#535862",
  textMuted: "#93979f",
  textOnPrimary: "#ffffff",
  textOnDark: "#ffffff",

  border: "#d5e6f7",
  borderLedge: "#b8d4f0",
  borderStrong: "#94c2f0",
  borderAccent: "#0069e0",
  primary: "#0069e0",
  primaryLedge: "#004da6",
  primarySoft: "#cce7ff",
  charcoalBtn: "#181d27",
  charcoalLedge: "#0a0d12",

  lavenderBorder: "#cfb0fc",
  lavenderText: "#5b21b6",
  mintBorder: "#7fdba8",
  mintText: "#0d6839",
  powderBorder: "#8ec5fc",
  powderText: "#0051ad",
  solarBorder: "#f5cf5b",
  solarText: "#7a5200",
  violetBorder: "#c49bff",
  peachBorder: "#f7a97e",
  peachText: "#8a3408",
  aquaBorder: "#82d1fc",

  emeraldSuccess: "#12965b",
  emeraldLedge: "#0b6e41",
  emeraldWash: "#d3f6e3",
  crimsonError: "#d92d20",
  crimsonLedge: "#a61b11",
  crimsonWash: "#ffe4e2",
  amberWarning: "#d97706",
  amberLedge: "#a15503",
  amberWash: "#fff2be",

  // Legacy aliases mapped cleanly onto the daylight palette
  irisGleam: "#0069e0",
  cyanSignal: "#0099ff",
  paleIris: "#0069e0",
  deepIris: "#004da6",
  orchidBloom: "#e4ccff",
  periwinkle: "#c2e9ff",
  obsidian: "#ebf5ff",
  abyss: "#f6f7f8",
  graphiteCard: "#fafdff",
  surfaceElevated: "#ffffff",
  surfaceSubtle: "#f6f7f8",
  steel: "#93979f",
  silver: "#535862",
  ash: "#535862",
  cloud: "#0a0d12",
  pure: "#0a0d12",
  void: "#ffffff",
  glassNav: "rgba(250, 253, 255, 0.94)",
  glassCard: "rgba(255, 255, 255, 0.95)",
  glassFill: "rgba(0, 105, 224, 0.06)",
  glassFillHover: "rgba(0, 105, 224, 0.12)",
  borderMuted: "#d5e6f7",
  borderLight: "#b8d4f0",
  borderActive: "#0069e0",
  borderIris: "rgba(0, 105, 224, 0.35)",
  borderCyan: "rgba(0, 153, 255, 0.35)",
  glowIris: "rgba(0, 105, 224, 0.12)",
  glowEmerald: "rgba(18, 150, 91, 0.16)",
  glowCyan: "rgba(0, 153, 255, 0.16)",
};

export const darkColors: ThemeColors = {
  isDark: true,

  skyTint: "#0a0d12",
  paperWhite: "#181d27",
  boneWhite: "#131822",
  mistGray: "#1d2432",
  ink: "#fafdff",
  charcoal: "#242c3d",
  graphite: "#b0b8c5",
  fog: "#7f8794",
  slateShadow: "#05070a",
  irisBlue: "#2b8fff",
  skyBlue: "#38b6ff",
  lavenderWash: "#231b36",
  mintWash: "#122b22",
  powderBlue: "#132740",
  solarGradient: "#302711",
  violetGradient: "#271b3d",
  aquaGradient: "#11283b",
  peachGradient: "#331e16",

  canvas: "#0a0d12",
  canvasSecondary: "#10151f",
  card: "#141923",
  cardElevated: "#1c2331",
  cardSubtle: "#181d27",
  textPrimary: "#fafdff",
  textSecondary: "#b0b8c5",
  textMuted: "#7f8794",
  textOnPrimary: "#ffffff",
  textOnDark: "#ffffff",

  border: "#232c3d",
  borderLedge: "#18202e",
  borderStrong: "#303d54",
  borderAccent: "#2b8fff",
  primary: "#0069e0",
  primaryLedge: "#004899",
  primarySoft: "#132740",
  charcoalBtn: "#242c3d",
  charcoalLedge: "#121722",

  lavenderBorder: "#483370",
  lavenderText: "#e4ccff",
  mintBorder: "#1f573f",
  mintText: "#9ef0c4",
  powderBorder: "#234a78",
  powderText: "#cce7ff",
  solarBorder: "#665017",
  solarText: "#fff2be",
  violetBorder: "#523880",
  peachBorder: "#693924",
  peachText: "#ffd1b8",
  aquaBorder: "#1e4d6e",

  emeraldSuccess: "#2dd48f",
  emeraldLedge: "#158052",
  emeraldWash: "#122b22",
  crimsonError: "#ff6b6b",
  crimsonLedge: "#b82e2e",
  crimsonWash: "#30171a",
  amberWarning: "#fbbf24",
  amberLedge: "#b47808",
  amberWash: "#302711",

  irisGleam: "#2b8fff",
  cyanSignal: "#38b6ff",
  paleIris: "#8ec5fc",
  deepIris: "#0069e0",
  orchidBloom: "#271b3d",
  periwinkle: "#11283b",
  obsidian: "#0a0d12",
  abyss: "#10151f",
  graphiteCard: "#141923",
  surfaceElevated: "#1c2331",
  surfaceSubtle: "#181d27",
  steel: "#636b78",
  silver: "#b0b8c5",
  ash: "#b0b8c5",
  cloud: "#fafdff",
  pure: "#ffffff",
  void: "#0a0d12",
  glassNav: "rgba(19, 24, 34, 0.94)",
  glassCard: "rgba(20, 25, 35, 0.95)",
  glassFill: "rgba(43, 143, 255, 0.08)",
  glassFillHover: "rgba(43, 143, 255, 0.15)",
  borderMuted: "#232c3d",
  borderLight: "#303d54",
  borderActive: "#2b8fff",
  borderIris: "rgba(43, 143, 255, 0.42)",
  borderCyan: "rgba(56, 182, 255, 0.42)",
  glowIris: "rgba(43, 143, 255, 0.18)",
  glowEmerald: "rgba(45, 212, 143, 0.20)",
  glowCyan: "rgba(56, 182, 255, 0.20)",
};

const sharedTypographyAndLayout = {
  fonts: {
    // Display & heading face (--font-aeonik)
    display: Platform.select({
      web: "'Aeonik', 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ios: "System",
      default: "sans-serif-medium",
    }),
    // Legacy alias mapped to Aeonik display stack
    serif: Platform.select({
      web: "'Aeonik', 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ios: "System",
      default: "sans-serif-medium",
    }),
    // UI & body face (--font-geist)
    sans: Platform.select({
      web: "'Geist', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ios: "System",
      default: "sans-serif",
    }),
    mono: Platform.select({
      web: "'Geist', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ios: "System",
      default: "sans-serif-medium",
    }),
  },

  fontSizes: {
    caption: 10,
    micro: 10,
    xs2: 12,
    monoLabel: 12,
    bodySm: 14,
    body: 16,
    bodyLg: 18,
    subheading: 20,
    headingSm: 24,
    headingMd: 28,
    heading: 32,
    headingLg: 32,
    displaySm: 40,
    display: 48,
  },

  spacing: {
    unit: 8,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 40,
    huge: 48,
    massive: 64,
  },

  radii: {
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
    tile: 32,
    pill: 90,
    full: 9999,
  },

  mobile: {
    headerHeight: 60,
    tabBarHeight: 68,
    minTouchSize: 48,
    maxContentWidth: 640,
  },
};

function buildShadows(isDark: boolean) {
  return {
    sm: {
      shadowColor: isDark ? "#000000" : "#044590",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isDark ? 0.35 : 0.07,
      shadowRadius: 10,
      elevation: 2,
    },
    card: {
      shadowColor: isDark ? "#000000" : "#044590",
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: isDark ? 0.45 : 0.08,
      shadowRadius: 20,
      elevation: 4,
    },
    lg: {
      shadowColor: isDark ? "#000000" : "#044590",
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: isDark ? 0.55 : 0.1,
      shadowRadius: 24,
      elevation: 8,
    },
    glowIris: {
      shadowColor: "#0069e0",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: isDark ? 0.42 : 0.22,
      shadowRadius: 16,
      elevation: 6,
    },
  };
}

export function getTheme(mode: ThemeMode) {
  const isDark = mode === "dark";
  return {
    mode,
    isDark,
    colors: isDark ? darkColors : lightColors,
    ...sharedTypographyAndLayout,
    shadows: buildShadows(isDark),
  };
}

export type AppTheme = ReturnType<typeof getTheme>;

// Default export for static references defaults to the Sky-Tint Daylight theme.
export const theme: AppTheme = getTheme("light");

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  theme: AppTheme;
  colors: ThemeColors;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "pravaah_theme_mode";

function readInitialThemeMode(): ThemeMode {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      const saved = window.localStorage?.getItem(STORAGE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
  }
  return "light";
}

let currentGlobalMode: ThemeMode = "light";
const modeListeners = new Set<(m: ThemeMode) => void>();

export function setGlobalThemeMode(next: ThemeMode) {
  currentGlobalMode = next;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
      document.body.style.backgroundColor = next === "dark" ? darkColors.canvas : lightColors.canvas;
    } catch {}
  }
  modeListeners.forEach((fn) => fn(next));
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  isDark: false,
  theme,
  colors: lightColors,
  setMode: setGlobalThemeMode,
  toggleTheme: () => setGlobalThemeMode(currentGlobalMode === "dark" ? "light" : "dark"),
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const initial = readInitialThemeMode();
    currentGlobalMode = initial;
    return initial;
  });

  useEffect(() => {
    const listener = (next: ThemeMode) => setModeState(next);
    modeListeners.add(listener);
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      if (Platform.OS !== "web" && (colorScheme === "light" || colorScheme === "dark")) {
        // Respect OS changes only if user hasn't manually toggled in this session
      }
    });
    return () => {
      modeListeners.delete(listener);
      sub.remove();
    };
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const activeTheme = getTheme(mode);
    return {
      mode,
      isDark: mode === "dark",
      theme: activeTheme,
      colors: activeTheme.colors,
      setMode: setGlobalThemeMode,
      toggleTheme: () => setGlobalThemeMode(mode === "dark" ? "light" : "dark"),
    };
  }, [mode]);

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

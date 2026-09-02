/**
 * Pravaah — Origin Financial Design System Tokens & Utilities
 *
 * Style reference: Origin Financial (Midnight gallery of quiet wealth).
 * Canvas: Obsidian #0f1011, Abyss #090a0b, Graphite #2e2e2e, Steel #3f4041, Silver #cacaca.
 * Accents: Iris Gleam #847dff, Cyan Signal #00b3dd, Pale Iris #d1c9ff, Deep Iris #4b49aa, Orchid Bloom #dd90d8, Periwinkle #90b8f0.
 * Typography: Lyon Display / DM Serif Display (Weight 300), Suisse Int'l / Inter (300/400), Roboto Mono (400/500).
 */

import { Platform } from "react-native";

export const theme = {
  colors: {
    // Brand & Chromatic Accents
    irisGleam: "#847dff",
    cyanSignal: "#00b3dd",
    paleIris: "#d1c9ff",
    deepIris: "#4b49aa",
    orchidBloom: "#dd90d8",
    periwinkle: "#90b8f0",

    // Neutrals & Surfaces
    obsidian: "#0f1011",
    abyss: "#090a0b",
    graphite: "#2e2e2e",
    graphiteCard: "#18191b",
    steel: "#3f4041",
    silver: "#cacaca",
    fog: "#6a6b6b",
    ash: "#9f9fa0",
    cloud: "#f5f5f7",
    pure: "#ffffff",
    void: "#000000",

    // Feedback & Indicators
    emeraldSuccess: "#38d39f",
    crimsonError: "#ff5252",
    amberWarning: "#ffb74d",

    // Translucent Fills & Borders
    glassNav: "rgba(15, 16, 17, 0.75)",
    glassCard: "rgba(24, 25, 27, 0.85)",
    glassFill: "rgba(255, 255, 255, 0.08)",
    glassFillHover: "rgba(255, 255, 255, 0.14)",
    borderMuted: "rgba(255, 255, 255, 0.08)",
    borderActive: "rgba(255, 255, 255, 0.20)",
    borderIris: "rgba(132, 125, 255, 0.35)",
    borderCyan: "rgba(0, 179, 221, 0.35)",
  },

  fonts: {
    serif: Platform.select({
      web: "'DM Serif Display', 'Playfair Display', 'Lyon Display', Georgia, serif",
      ios: "Georgia",
      default: "serif",
    }),
    sans: Platform.select({
      web: "'Inter', 'Geist Sans', 'Suisse Int\\'l', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ios: "System",
      default: "sans-serif",
    }),
    mono: Platform.select({
      web: "'Roboto Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
      ios: "Menlo",
      default: "monospace",
    }),
  },

  fontSizes: {
    monoLabel: 12,
    bodySm: 14,
    body: 16,
    subheading: 18,
    headingSm: 24,
    headingLg: 38,
    displaySm: 64,
    display: 84,
  },

  spacing: {
    unit: 4,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
    huge: 48,
    massive: 64,
  },

  radii: {
    xs: 4,
    sm: 8, // Inputs, Buttons, Nav items
    md: 12,
    lg: 16, // Cards, Stat blocks
    xl: 24,
    tile: 30, // Feature category tiles
    full: 9999, // Pill buttons, chip labels
  },

  shadows: {
    lg: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.2,
      shadowRadius: 20,
      elevation: 8,
    },
  },
};

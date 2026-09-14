/**
 * Pravaah — Mobile-First Design System Tokens & Utilities
 *
 * Aesthetic: Midnight Luxury / Obsidian Glassmorphism (Fluid Mobile Experience)
 * Canvas: Obsidian #0f1011, Abyss #090a0b, Graphite Card #18191b, Surface Elevated #1e1f23.
 * Accents: Iris Gleam #847dff, Cyan Signal #00b3dd, Pale Iris #d1c9ff, Orchid Bloom #dd90d8, Periwinkle #90b8f0.
 * Pure White CTA #ffffff on deep rich dark surfaces.
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
    graphite: "#242528",
    graphiteCard: "#16171a",
    surfaceElevated: "#1e1f24",
    surfaceSubtle: "rgba(255, 255, 255, 0.04)",
    steel: "#36383b",
    silver: "#cacaca",
    fog: "#78797c",
    ash: "#a5a6a8",
    cloud: "#f5f5f7",
    pure: "#ffffff",
    void: "#000000",

    // Feedback & Indicators
    emeraldSuccess: "#38d39f",
    crimsonError: "#ff5252",
    amberWarning: "#ffb74d",

    // Translucent Fills & Borders
    glassNav: "rgba(15, 16, 17, 0.88)",
    glassCard: "rgba(22, 23, 26, 0.90)",
    glassFill: "rgba(255, 255, 255, 0.06)",
    glassFillHover: "rgba(255, 255, 255, 0.12)",
    borderMuted: "rgba(255, 255, 255, 0.08)",
    borderLight: "rgba(255, 255, 255, 0.14)",
    borderActive: "rgba(255, 255, 255, 0.24)",
    borderIris: "rgba(132, 125, 255, 0.40)",
    borderCyan: "rgba(0, 179, 221, 0.40)",

    // Glows
    glowIris: "rgba(132, 125, 255, 0.28)",
    glowEmerald: "rgba(56, 211, 159, 0.25)",
    glowCyan: "rgba(0, 179, 221, 0.25)",
  },

  fonts: {
    serif: Platform.select({
      web: "'DM Serif Display', 'Playfair Display', Georgia, serif",
      ios: "Georgia",
      default: "serif",
    }),
    sans: Platform.select({
      web: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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
    micro: 10,
    monoLabel: 12,
    bodySm: 13,
    body: 15,
    subheading: 17,
    headingSm: 20,
    headingMd: 24,
    headingLg: 30,
    displaySm: 36,
    display: 44,
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
    huge: 40,
    massive: 56,
  },

  radii: {
    xs: 6,
    sm: 10, // Inputs, smaller buttons
    md: 14, // Secondary cards, chips
    lg: 20, // Primary cards, modals
    xl: 26, // Floating sheets, big tiles
    tile: 28, // Feature category tiles
    full: 9999, // Pill buttons, circular badges
  },

  mobile: {
    headerHeight: 56,
    tabBarHeight: 64,
    minTouchSize: 48,
    maxContentWidth: 600,
  },

  shadows: {
    sm: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 3,
    },
    card: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 6,
    },
    lg: {
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 16 },
      shadowOpacity: 0.45,
      shadowRadius: 28,
      elevation: 10,
    },
    glowIris: {
      shadowColor: "#847dff",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.45,
      shadowRadius: 18,
      elevation: 8,
    },
  },
};

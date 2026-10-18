/**
 * Pravaah — Mobile-First Root Layout
 *
 * Configures SafeAreaProvider, Expo Router, obsidian dark theme styling, status bar, and auth gating.
 */

import "../lib/polyfills";
import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Font from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../lib/firebase";
import { wakeBackend } from "../lib/api";
import { ThemeProvider, useTheme } from "../lib/theme";
import { PRAVAAH_FAVICON_DATA_URI, PRAVAAH_APP_TITLE } from "../lib/brand";

export { default as ErrorBoundary } from "../components/ScreenError";

// Large OS font settings otherwise make fixed-height buttons clip or wrap their labels.
if (Platform.OS !== "web") {
  for (const C of [Text, TextInput] as any[]) {
    C.defaultProps = { ...(C.defaultProps || {}), maxFontSizeMultiplier: 1.2 };
  }
}

// @expo/vector-icons relies on fontfaceobserver on web, which tests latin glyphs (BESbswy).
// Icon fonts only contain private-use unicode glyphs, causing fontfaceobserver to timeout
// and reject, leaving createIconSet in a permanent unmounted/blank state.
// Patch Font.isLoaded on web so icon fonts are treated as loaded immediately.
if (Platform.OS === "web") {
  const iconFamilies = new Set([
    "ionicons",
    "Ionicons",
    "feather",
    "Feather",
    "material-community",
    "MaterialCommunityIcons",
    "MaterialIcons",
    "Material Icons",
    "fontawesome",
    "FontAwesome",
  ]);
  const origIsLoaded = Font.isLoaded;
  (Font as any).isLoaded = (name: string) => {
    if (iconFamilies.has(name)) return true;
    return origIsLoaded ? origIsLoaded(name) : true;
  };
}

// Directly require the icon font TTF so Metro exports the asset URL
// @ts-ignore
const ioniconsTtf = require("@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf");

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootLayoutNav />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function RootLayoutNav() {
  const { user, loading } = useAuth();
  const { colors, isDark } = useTheme();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    wakeBackend();
  }, []);

  // Inject Mobile Web meta tags, Design System CSS variables, Fonts, Favicon, and PWA setup
  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.title = PRAVAAH_APP_TITLE;

      // Ensure mobile viewport with viewport-fit=cover
      let viewportMeta = document.querySelector("meta[name='viewport']") as HTMLMetaElement;
      if (!viewportMeta) {
        viewportMeta = document.createElement("meta");
        viewportMeta.name = "viewport";
        document.head.appendChild(viewportMeta);
      }
      viewportMeta.content =
        "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

      // PWA Manifest and Theme Color
      let manifestLink = document.querySelector("link[rel='manifest']") as HTMLLinkElement;
      if (!manifestLink) {
        manifestLink = document.createElement("link");
        manifestLink.rel = "manifest";
        manifestLink.href = "/manifest.json";
        document.head.appendChild(manifestLink);
      }

      let themeMeta = document.querySelector("meta[name='theme-color']") as HTMLMetaElement;
      if (!themeMeta) {
        themeMeta = document.createElement("meta");
        themeMeta.name = "theme-color";
        document.head.appendChild(themeMeta);
      }
      themeMeta.content = colors.canvas;

      // Register PWA Service Worker
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch((err) => {
          console.log("Service Worker registration notice:", err);
        });
      }

      // Update Favicon
      const setFavicon = () => {
        let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
        if (!link) {
          link = document.createElement("link");
          link.rel = "icon";
          document.head.appendChild(link);
        }
        link.type = "image/png";
        link.href = PRAVAAH_FAVICON_DATA_URI;

        let appleLink = document.querySelector("link[rel='apple-touch-icon']") as HTMLLinkElement;
        if (!appleLink) {
          appleLink = document.createElement("link");
          appleLink.rel = "apple-touch-icon";
          document.head.appendChild(appleLink);
        }
        appleLink.href = PRAVAAH_FAVICON_DATA_URI;
      };
      setFavicon();

      const fontId = "pravaah-mobile-fonts";
      if (!document.getElementById(fontId)) {
        const link = document.createElement("link");
        link.id = fontId;
        link.rel = "stylesheet";
        link.href =
          "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap";
        document.head.appendChild(link);

        // Mobile touch & design token CSS variables
        const style = document.createElement("style");
        style.id = "pravaah-global-theme-css";
        style.innerHTML = `
          :root {
            --color-sky-tint: #ebf5ff;
            --color-paper-white: #ffffff;
            --color-bone-white: #fafdff;
            --color-mist-gray: #f6f7f8;
            --color-ink: #0a0d12;
            --color-charcoal: #181d27;
            --color-graphite: #535862;
            --color-fog: #93979f;
            --color-slate-shadow: #3b3d41;
            --color-iris-blue: #0069e0;
            --color-sky-blue: #0099ff;
            --color-lavender-wash: #f1e6ff;
            --color-mint-wash: #d3f6e3;
            --color-powder-blue: #cce7ff;
            --color-solar-gradient: #fff2be;
            --color-violet-gradient: #e4ccff;
            --color-aqua-gradient: #c2e9ff;
            --color-peach-gradient: #ffd1b8;
            --font-aeonik: 'Aeonik', 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            --font-geist: 'Geist', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          }
          * {
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
          }
          body, html, #root {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow-x: hidden;
            font-family: var(--font-geist);
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            overscroll-behavior-y: none;
            transition: background-color 0.2s ease;
          }
          ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
          }
          ::-webkit-scrollbar-track {
            background: transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: rgba(83, 88, 98, 0.28);
            border-radius: 9999px;
          }
        `;
        document.head.appendChild(style);
      }
      document.body.style.backgroundColor = colors.canvas;

      // Inject @font-face rules for vector icons so browser text glyphs render immediately
      const iconFontId = "pravaah-vector-icons-stylesheet";
      if (!document.getElementById(iconFontId)) {
        const iconStyle = document.createElement("style");
        iconStyle.id = iconFontId;
        iconStyle.textContent = `
          @font-face {
            font-family: 'ionicons';
            src: url('${ioniconsTtf}') format('truetype');
            font-display: swap;
          }
          @font-face {
            font-family: 'Ionicons';
            src: url('${ioniconsTtf}') format('truetype');
            font-display: swap;
          }
        `;
        document.head.appendChild(iconStyle);

        if (typeof FontFace !== "undefined" && (document as any).fonts) {
          const f1 = new FontFace("ionicons", `url('${ioniconsTtf}')`);
          const f2 = new FontFace("Ionicons", `url('${ioniconsTtf}')`);
          f1.load().then((loaded) => (document as any).fonts.add(loaded)).catch(() => {});
          f2.load().then((loaded) => (document as any).fonts.add(loaded)).catch(() => {});
        }
      }

      // Automatically clean internal Expo Router key from the browser address bar
      if (window.location.search && window.location.search.includes("__EXPO_ROUTER_key")) {
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("__EXPO_ROUTER_key");
          window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
        } catch {}
      }
    }
  }, [segments, colors.canvas]);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "auth";

    if (!user && !inAuthGroup) {
      router.replace("/auth");
    } else if (user && inAuthGroup) {
      router.replace("/");
    }
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <>
        <StatusBar style={isDark ? "light" : "dark"} backgroundColor={colors.canvas} />
        <View style={[styles.loadingContainer, { backgroundColor: colors.canvas }]}>
          <ActivityIndicator size="large" color={colors.irisBlue} />
        </View>
      </>
    );
  }

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} backgroundColor={colors.canvas} translucent={false} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: Platform.OS === "ios" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: colors.canvas },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="assessment" />
        <Stack.Screen name="session" />
        <Stack.Screen name="voice" />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
});

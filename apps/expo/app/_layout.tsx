/**
 * Pravaah — Mobile-First Root Layout
 *
 * Configures SafeAreaProvider, Expo Router, obsidian dark theme styling, status bar, and auth gating.
 */

import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Font from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../lib/firebase";
import { theme } from "../lib/theme";
import { PRAVAAH_FAVICON_DATA_URI, PRAVAAH_APP_TITLE } from "../lib/brand";

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
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Inject Mobile Web meta tags, Google Fonts, Favicon, and PWA setup
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
      themeMeta.content = "#0f1011";

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
          "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600;700&family=Roboto+Mono:wght@400;500&display=swap";
        document.head.appendChild(link);

        // Mobile touch & styling resets
        const style = document.createElement("style");
        style.innerHTML = `
          * {
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
          }
          body, html, #root {
            background-color: #0f1011 !important;
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow-x: hidden;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            overscroll-behavior-y: none;
          }
          /* Custom mobile scrollbar */
          ::-webkit-scrollbar {
            width: 4px;
            height: 4px;
          }
          ::-webkit-scrollbar-track {
            background: #090a0b;
          }
          ::-webkit-scrollbar-thumb {
            background: #28292c;
            border-radius: 4px;
          }
        `;
        document.head.appendChild(style);
      }

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
  }, [segments]);

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
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={theme.colors.obsidian} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.irisGleam} />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={theme.colors.obsidian} translucent={false} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: Platform.OS === "ios" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: theme.colors.obsidian },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="assessment" />
        <Stack.Screen name="session" />
      </Stack>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
    justifyContent: "center",
    alignItems: "center",
  },
});

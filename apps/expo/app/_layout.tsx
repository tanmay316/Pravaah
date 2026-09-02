/**
 * Pravaah — Root Layout
 *
 * Configures Expo Router, global Obsidian theme styling, Google Fonts web injection, and auth gating.
 */

import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useAuth } from "../lib/firebase";
import { theme } from "../lib/theme";
import { PRAVAAH_FAVICON_DATA_URI, PRAVAAH_APP_TITLE } from "../lib/brand";

export default function RootLayout() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

    // Inject Google Fonts, Page Title, Pravaah Favicon, and PWA Service Worker for web
  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.title = PRAVAAH_APP_TITLE;

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
        themeMeta.content = "#0f1011";
        document.head.appendChild(themeMeta);
      }

      // Register PWA Service Worker for offline support and push notifications
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch((err) => {
          console.log("Service Worker registration notice:", err);
        });
      }

      // Update or inject Favicon with custom Pravaah emblem
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

      const fontId = "pravaah-origin-fonts";
      if (!document.getElementById(fontId)) {
        const link = document.createElement("link");
        link.id = fontId;
        link.rel = "stylesheet";
        link.href =
          "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&family=Roboto+Mono:wght@400;500&display=swap";
        document.head.appendChild(link);

        // Global base css overrides for web
        const style = document.createElement("style");
        style.innerHTML = `
          * { box-sizing: border-box; }
          body, html, #root {
            background-color: #0f1011 !important;
            margin: 0;
            padding: 0;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }
          /* Custom scrollbar for origin look */
          ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }
          ::-webkit-scrollbar-track {
            background: #090a0b;
          }
          ::-webkit-scrollbar-thumb {
            background: #28292c;
            border-radius: 4px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: #3f4041;
          }
        `;
        document.head.appendChild(style);
      }
    }
  }, []);

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
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.irisGleam} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.obsidian },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="assessment" />
        <Stack.Screen name="session" />
      </Stack>
    </>
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

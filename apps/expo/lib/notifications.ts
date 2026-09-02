/**
 * Pravaah — Universal Cross-Platform Notification Engine (Mobile & PWA/Web)
 *
 * Supports:
 *   1. Web / PWA Push & In-Browser Notifications (Web Notification API + Service Worker)
 *   2. Android / iOS Native Notifications (Expo Notifications)
 *   3. Scheduled Daily Practice Reminders
 *   4. Instant Test Notifications
 */

import { Platform } from "react-native";
import { PRAVAAH_FAVICON_DATA_URI } from "./brand";

export type NotificationPermissionStatus = "granted" | "denied" | "default" | "unsupported";

export interface ScheduledReminderConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  timeLabel: string;
}

// ---------------------------------------------------------------------------
// Native Notifications Setup (Mobile)
// ---------------------------------------------------------------------------
let ExpoNotifications: any = null;

if (Platform.OS !== "web") {
  try {
    ExpoNotifications = require("expo-notifications");
    if (ExpoNotifications && ExpoNotifications.setNotificationHandler) {
      ExpoNotifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
        }),
      });
    }
  } catch (err) {
    console.warn("ExpoNotifications module not available:", err);
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  if (Platform.OS === "web") {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    return window.Notification.permission as NotificationPermissionStatus;
  }

  if (ExpoNotifications) {
    try {
      const settings: any = await ExpoNotifications.getPermissionsAsync();
      if (settings?.status === "granted" || settings?.granted) return "granted";
      if (settings?.canAskAgain) return "default";
      return "denied";
    } catch {
      return "default";
    }
  }

  return "unsupported";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "web") {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }
    try {
      const permission = await window.Notification.requestPermission();
      return permission === "granted";
    } catch (err) {
      console.warn("Web Notification permission request error:", err);
      return false;
    }
  }

  if (ExpoNotifications) {
    try {
      const settings: any = await ExpoNotifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
      return settings?.status === "granted" || settings?.granted === true;
    } catch (err) {
      console.warn("Native Notification permission request error:", err);
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Send Immediate Notification
// ---------------------------------------------------------------------------

export async function sendLocalNotification(
  title: string,
  body: string,
  data: Record<string, any> = {}
): Promise<boolean> {
  // 1. Web / PWA Notification
  if (Platform.OS === "web") {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }

    if (window.Notification.permission !== "granted") {
      const granted = await requestNotificationPermission();
      if (!granted) return false;
    }

    try {
      // Try service worker notification first for PWA consistency
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, {
          body,
          icon: "/assets/favicon-192.png",
          badge: "/assets/favicon.png",
          tag: "pravaah-notification",
          data: { url: "/", ...data },
        });
        return true;
      }

      // Standard desktop/mobile browser fallback
      const notification = new window.Notification(title, {
        body,
        icon: PRAVAAH_FAVICON_DATA_URI,
        tag: "pravaah-notification",
        data: { url: "/", ...data },
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      return true;
    } catch (err) {
      console.warn("Web notification trigger error:", err);
      return false;
    }
  }

  // 2. Native Mobile Notification
  if (ExpoNotifications) {
    try {
      await ExpoNotifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data,
          sound: "default",
        },
        trigger: null, // Send immediately
      });
      return true;
    } catch (err) {
      console.warn("Native notification trigger error:", err);
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Schedule Daily Practice Reminder
// ---------------------------------------------------------------------------

export async function scheduleDailyPracticeReminder(
  hour: number,
  minute: number,
  focusSkill?: string
): Promise<boolean> {
  const title = "🎙️ Pravaah — Time for Today's Speaking Practice!";
  const focusText = focusSkill ? `Today's priority: ${focusSkill.replace(/_/g, " ")}.` : "Keep your English fluency streak alive!";
  const body = `Your daily practice session is ready. ${focusText}`;

  // Save preference in localStorage for Web/PWA
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(
        "pravaah_reminder_config",
        JSON.stringify({ enabled: true, hour, minute, focusSkill })
      );
    } catch {}
  }

  // On Native Mobile, schedule via ExpoNotifications daily trigger
  if (ExpoNotifications && Platform.OS !== "web") {
    try {
      // Cancel previous scheduled reminders first
      await ExpoNotifications.cancelAllScheduledNotificationsAsync();

      await ExpoNotifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: "default",
          data: { type: "daily_practice", focusSkill },
        },
        trigger: {
          type: ExpoNotifications.SchedulableTriggerInputTypes.DAILY,
          hour,
          minute,
        } as any,
      });
      return true;
    } catch (err) {
      console.warn("Schedule native notification error:", err);
      return false;
    }
  }

  return true;
}

export async function cancelDailyPracticeReminders(): Promise<void> {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem("pravaah_reminder_config");
    } catch {}
  }

  if (ExpoNotifications && Platform.OS !== "web") {
    try {
      await ExpoNotifications.cancelAllScheduledNotificationsAsync();
    } catch (err) {
      console.warn("Cancel notifications error:", err);
    }
  }
}

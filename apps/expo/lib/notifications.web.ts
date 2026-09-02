/**
 * Pravaah — Universal Notification Engine (Web & PWA Platform Implementation)
 *
 * Fully decoupled from native modules to guarantee clean web bundling in Metro.
 * Supports:
 *   1. Standard Web Notification API
 *   2. PWA Service Worker Notifications (Background & Foreground)
 *   3. LocalStorage Reminder Configuration Persistence
 */

import { PRAVAAH_FAVICON_DATA_URI } from "./brand";

export type NotificationPermissionStatus = "granted" | "denied" | "default" | "unsupported";

export interface ScheduledReminderConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  timeLabel: string;
  focusSkill?: string;
}

/**
 * Check if the browser supports notifications and return current permission status.
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return window.Notification.permission as NotificationPermissionStatus;
}

/**
 * Request notification permission from the user in browser.
 */
export async function requestNotificationPermission(): Promise<boolean> {
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

/**
 * Send an immediate notification in the browser / PWA.
 */
export async function sendLocalNotification(
  title: string,
  body: string,
  data: Record<string, any> = {}
): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (window.Notification.permission !== "granted") {
    const granted = await requestNotificationPermission();
    if (!granted) return false;
  }

  try {
    // 1. Try Service Worker Notification (Best for PWA)
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body,
        icon: "/favicon-192.png",
        badge: "/favicon.png",
        tag: "pravaah-notification",
        data: { url: "/", ...data },
      });
      return true;
    }

    // 2. Standard Web Notification Fallback
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

/**
 * Save daily practice reminder preferences in localStorage for Web / PWA.
 */
export async function scheduleDailyPracticeReminder(
  hour: number,
  minute: number,
  focusSkill?: string
): Promise<boolean> {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const pad = (n: number) => n.toString().padStart(2, "0");
      const period = hour >= 12 ? "PM" : "AM";
      const displayHour = hour % 12 || 12;
      const timeLabel = `${displayHour}:${pad(minute)} ${period}`;

      const config: ScheduledReminderConfig = {
        enabled: true,
        hour,
        minute,
        timeLabel,
        focusSkill,
      };

      window.localStorage.setItem("pravaah_reminder_config", JSON.stringify(config));
      return true;
    } catch (err) {
      console.warn("Failed to persist reminder config in localStorage:", err);
      return false;
    }
  }
  return true;
}

/**
 * Remove scheduled reminder preferences from localStorage.
 */
export async function cancelDailyPracticeReminders(): Promise<void> {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem("pravaah_reminder_config");
    } catch (err) {
      console.warn("Failed to remove reminder config:", err);
    }
  }
}

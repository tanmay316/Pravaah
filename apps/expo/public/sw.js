/**
 * Pravaah — PWA Service Worker for Offline Caching & Push Notifications
 */

const CACHE_NAME = "pravaah-cache-v1";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/favicon.png",
  "/favicon-192.png",
  "/favicon-512.png",
  "/pravaah_navbar_logo.png"
];

// Install: Cache core static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn("PWA Cache addAll notice:", err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: Network first with cache fallback
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

// Push Notification Event
self.addEventListener("push", (event) => {
  let data = {
    title: "Pravaah — Daily Practice Reminder",
    body: "Your 30-minute English speaking session is ready for today!",
    icon: "/favicon-192.png",
    badge: "/favicon.png",
    tag: "pravaah-daily-reminder",
    data: { url: "/" }
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: data.data
    })
  );
});

// Notification Click Event
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

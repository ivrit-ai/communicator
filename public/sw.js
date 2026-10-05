importScripts("/client/store.js", "/client/push.js");

const SHELL = "shell-v11";
const SHELL_FILES = [
  "/",
  "/app.js",
  "/i18n.js",
  "/client/store.js",
  "/client/communicator.js",
  "/client/push.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/fonts/fonts.css",
  "/fonts/frank-ruhl-libre-hebrew.woff2",
  "/fonts/frank-ruhl-libre-latin.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-400.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-400.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-500.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-500.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-600.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-600.woff2",
  "/fonts/ibm-plex-mono-latin-500.woff2",
  "/icons/mark.svg",
  "/icons/icon-192.png",
  "/icons/badge-72.png",
];

// The few strings the worker itself shows, when no window is open to ask.
const STRINGS = {
  en: { new: (n) => `${n} new messages`, open: "Open Communicator to read them." },
  he: { new: (n) => `${n} הודעות חדשות`, open: "פתחו את Communicator כדי לקרוא." },
};

// Take over immediately rather than waiting for every tab to close. A stale
// service worker keeps handling pushes with old logic long after a deploy.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Shell and source logos only. API responses are never cached: the device's
// copy of messages lives in IndexedDB, and /api/config must always be live or
// a rotated VAPID key would go unnoticed.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const icon = /^\/api\/sources\/[^/]+\/icon\.png$/.test(url.pathname);
  if (!icon && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))) return;
  // Caching the worker itself is how a bad deploy becomes permanent.
  if (url.pathname === "/sw.js" || url.pathname.startsWith("/xhost-auth/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(event.request, { ignoreSearch: !icon });
      // Stale-while-revalidate: the shell paints instantly offline, and the
      // next open has the new build.
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? fresh;
    })()
  );
});

// Showing, storing, acking and opening pushed messages: the shared
// Communicator client, the same code other ivrit.ai apps run.
self.installCommunicatorPush({ appName: "Communicator", strings: STRINGS });

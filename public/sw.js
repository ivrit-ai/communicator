const SHELL = "shell-v1";
const SHELL_FILES = ["/", "/app.js", "/styles.css", "/manifest.webmanifest", "/icons/icon-192.png"];

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

// Shell only. API responses are never cached — a stale notification list read
// from disk is worse than an error, and /api/config must always be live or a
// rotated VAPID key would go unnoticed.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  // Caching the worker itself is how a bad deploy becomes permanent.
  if (url.pathname === "/sw.js") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(event.request, { ignoreSearch: true });
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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Fall through to the placeholder below rather than dropping the push.
  }

  // The source is prefixed rather than tucked into the body: on a locked phone
  // the title is often all that is visible, and "which service is this from" is
  // the first thing you need to know.
  const title = data.s ? `${data.s} — ${data.t}` : data.t || "Notification";
  const options = {
    body: data.b || "",
    data: { url: data.u || "/", id: data.i },
    timestamp: data.ts || Date.now(),
    // A shared tag is a *replacement* key: five alerts under one tag show only
    // the fifth and silently discard the rest.
    tag: data.i ? `n-${data.i}` : undefined,
  };

  // The ack races the notification rather than following it: showNotification
  // is what the user sees, so it must not wait on a network round trip.
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options).then(coalesce),
      ack(data),
      notifyOpenTabs(),
    ])
  );
});

// A 7-day TTL means a device offline for days reconnects to a flood — FCM
// queues around 100 per device. Past a handful, individual banners are noise,
// so they collapse into one line the user can actually act on.
const COALESCE_AT = 4;

async function coalesce() {
  const shown = await self.registration.getNotifications();
  const individual = shown.filter((n) => n.tag !== "summary");
  if (individual.length < COALESCE_AT) return;
  for (const notification of individual) notification.close();
  await self.registration.showNotification(`${individual.length} new notifications`, {
    body: "Open Notifier to read them.",
    tag: "summary",
    renotify: true,
    data: { url: "/" },
  });
}

async function notifyOpenTabs() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "push" });
}

// Best-effort by design. A failed ack only costs one redundant retry from the
// sender, so it must never reject and take the notification down with it.
function ack(data) {
  if (!data.i || !data.k || !data.d) return Promise.resolve();
  return fetch("/api/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ i: data.i, d: data.d, k: data.k }),
  }).catch(() => {});
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open window rather than stacking another one: on a phone the
      // second window is indistinguishable from the first and the back button
      // stops behaving.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if (url !== "/" && "navigate" in client) await client.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

// Firefox and Safari only — Chrome has never shipped this event, which is why
// the client also re-upserts its subscription on every open.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
      if (!applicationServerKey) return;
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      await fetch("/api/devices/rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          old_endpoint: event.oldSubscription?.endpoint,
          subscription: fresh.toJSON(),
        }),
      });
    })()
  );
});

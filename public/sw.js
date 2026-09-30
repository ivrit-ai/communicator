importScripts("/store.js");

const store = self.NotifierStore;
const SHELL = "shell-v6";
const SHELL_FILES = [
  "/",
  "/app.js",
  "/i18n.js",
  "/store.js",
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

async function context() {
  const [locale, catalog] = await Promise.all([
    store.getMeta("locale").catch(() => null),
    store.getMeta("catalog").catch(() => null),
  ]);
  return { locale: locale === "he" ? "he" : "en", sources: catalog?.sources ?? [] };
}

function displayName(data, ctx) {
  const source = ctx.sources.find((s) => s.id === data.sid);
  return (ctx.locale === "he" && source?.name_he) || source?.name || data.s || "Communicator";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Fall through to the placeholder below rather than dropping the push.
  }
  event.waitUntil(handlePush(data));
});

async function handlePush(data) {
  const ctx = await context();
  const name = displayName(data, ctx);
  const message = data.i
    ? {
        id: data.i,
        created_at: data.ts || Date.now(),
        source: data.s,
        source_id: data.sid,
        title: data.t,
        subtitle: data.st,
        body: data.b,
        url: data.u,
        lang: data.l,
        partial: Boolean(data.x),
      }
    : null;

  // The source leads the title: on a locked phone the title is often all
  // that is visible, and "who is this from" is the first thing to know.
  const title = data.t ? `${name} · ${data.t}` : name;
  const options = {
    body: data.b || "",
    icon: data.sid ? `/api/sources/${encodeURIComponent(data.sid)}/icon.png` : "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    dir: "auto",
    lang: data.l || "",
    timestamp: data.ts || Date.now(),
    data: { id: data.i, group: data.sid || data.s || "", name },
    // A shared tag is a *replacement* key: five alerts under one tag show only
    // the fifth and silently discard the rest.
    tag: data.i ? `n-${data.i}` : undefined,
  };

  // Storing and showing do not wait on the network; the full text follows
  // with the ack and replaces the preview.
  await Promise.all([
    message ? store.put([message]).catch(() => {}) : null,
    self.registration.showNotification(title, options).then(() => coalesce(ctx)),
  ]);
  await ackAndFetch(data);
  await store.updateBadge().catch(() => {});
  await notifyOpenTabs();
}

// A device offline for days reconnects to a flood. Past a handful from one
// source, individual banners are noise, so they collapse into one line.
const COALESCE_AT = 4;

async function coalesce(ctx) {
  const shown = await self.registration.getNotifications();
  const groups = new Map();
  for (const n of shown) {
    if (!n.data?.id) continue;
    const key = n.data.group;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const strings = STRINGS[ctx.locale];
  for (const [group, list] of groups) {
    if (list.length < COALESCE_AT) continue;
    for (const n of list) n.close();
    const previous = shown.find((n) => n.tag === `summary:${group}`);
    const count = list.length + (previous?.data?.count ?? 0);
    await self.registration.showNotification(list[0].data.name, {
      body: `${strings.new(count)} · ${strings.open}`,
      tag: `summary:${group}`,
      renotify: true,
      icon: list[0].icon || "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      data: { count, group },
    });
  }
}

async function notifyOpenTabs(extra = {}) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "push", ...extra });
}

// The ack settles the delivery and, being signed for this device, is also
// the credential to read the message in full. Best-effort: a failed ack only
// costs one redundant retry from the sender, and the app's next sync fetches
// the full text.
async function ackAndFetch(data) {
  if (!data.i || !data.k || !data.d) return;
  try {
    const res = await fetch("/api/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ i: data.i, d: data.d, k: data.k }),
    });
    const body = await res.json();
    if (body.notification) await store.put([body.notification]);
  } catch {}
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  const url = id ? `/#m/${encodeURIComponent(id)}` : "/";
  event.waitUntil(
    (async () => {
      if (id) await store.markRead([id]).catch(() => {});
      await store.updateBadge().catch(() => {});
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open window rather than stacking another one: on a phone the
      // second window is indistinguishable from the first.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if (id) client.postMessage({ type: "open", id });
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
      const fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await fetch("/api/devices/rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ old_endpoint: event.oldSubscription?.endpoint, subscription: fresh.toJSON() }),
      });
    })()
  );
});

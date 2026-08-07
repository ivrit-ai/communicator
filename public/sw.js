// Take over immediately rather than waiting for every tab to close. A stale
// service worker keeps handling pushes with old logic long after a deploy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), ack(data)]));
});

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
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
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

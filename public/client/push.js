// The service-worker half of the Communicator client: showing a pushed
// message, storing it on the device, acking it (which also fetches the full
// text), and opening it when tapped. A classic script, loaded with
// importScripts after store.js, because not every browser runs module
// workers yet. The host worker calls installCommunicatorPush() once.
(function (global) {
  // A device offline for days reconnects to a flood. Past a handful from one
  // source, individual banners are noise, so they collapse into one line.
  const COALESCE_AT = 4;

  global.installCommunicatorPush = function installCommunicatorPush({
    apiBase = "",
    appName,
    strings,
    icon = "/icons/icon-192.png",
    badge = "/icons/badge-72.png",
    openUrl = (id) => (id ? `/#m/${encodeURIComponent(id)}` : "/"),
  }) {
    const store = global.NotifierStore;

    async function context() {
      const [locale, catalog] = await Promise.all([
        store.getMeta("locale").catch(() => null),
        store.getMeta("catalog").catch(() => null),
      ]);
      return { locale: locale === "he" ? "he" : "en", sources: catalog?.sources ?? [] };
    }

    function displayName(data, ctx) {
      const source = ctx.sources.find((s) => s.id === data.sid);
      return (ctx.locale === "he" && source?.name_he) || source?.name || data.s || appName;
    }

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
        icon: data.sid ? `${apiBase}/api/sources/${encodeURIComponent(data.sid)}/icon.png` : icon,
        badge,
        dir: "auto",
        lang: data.l || "",
        timestamp: data.ts || Date.now(),
        data: { id: data.i, group: data.sid || data.s || "", name },
        // A shared tag is a *replacement* key: five alerts under one tag show
        // only the fifth and silently discard the rest.
        tag: data.i ? `n-${data.i}` : undefined,
      };

      // Storing and showing do not wait on the network; the full text follows
      // with the ack and replaces the preview.
      await Promise.all([
        message ? store.put([message]).catch(() => {}) : null,
        global.registration.showNotification(title, options).then(() => coalesce(ctx)),
      ]);
      await ackAndFetch(data);
      await store.updateBadge().catch(() => {});
      await notifyOpenTabs();
    }

    async function coalesce(ctx) {
      const shown = await global.registration.getNotifications();
      const groups = new Map();
      for (const n of shown) {
        if (!n.data?.id) continue;
        const key = n.data.group;
        groups.set(key, [...(groups.get(key) ?? []), n]);
      }
      const text = strings[ctx.locale] ?? strings.en;
      for (const [group, list] of groups) {
        if (list.length < COALESCE_AT) continue;
        for (const n of list) n.close();
        const previous = shown.find((n) => n.tag === `summary:${group}`);
        const count = list.length + (previous?.data?.count ?? 0);
        await global.registration.showNotification(list[0].data.name, {
          body: `${text.new(count)} · ${text.open}`,
          tag: `summary:${group}`,
          renotify: true,
          icon: list[0].icon || icon,
          badge,
          data: { count, group },
        });
      }
    }

    async function notifyOpenTabs() {
      const clients = await global.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "push" });
    }

    // The ack settles the delivery and, being signed for this device, is also
    // the credential to read the message in full. Best-effort: a failed ack
    // only costs one redundant retry from the sender, and the next sync
    // fetches the full text.
    async function ackAndFetch(data) {
      if (!data.i || !data.k || !data.d) return;
      try {
        const res = await fetch(`${apiBase}/api/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ i: data.i, d: data.d, k: data.k }),
        });
        const body = await res.json();
        if (body.notification) await store.put([body.notification]);
      } catch {}
    }

    global.addEventListener("push", (event) => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        // Fall through to the placeholder rather than dropping the push.
      }
      event.waitUntil(handlePush(data));
    });

    global.addEventListener("notificationclick", (event) => {
      event.notification.close();
      const id = event.notification.data?.id;
      event.waitUntil(
        (async () => {
          if (id) await store.markRead([id]).catch(() => {});
          await store.updateBadge().catch(() => {});
          const clients = await global.clients.matchAll({ type: "window", includeUncontrolled: true });
          // Reuse an open window rather than stacking another one: on a phone
          // the second window is indistinguishable from the first.
          for (const client of clients) {
            if ("focus" in client) {
              await client.focus();
              if (id) client.postMessage({ type: "open", id });
              return;
            }
          }
          await global.clients.openWindow(openUrl(id));
        })()
      );
    });

    // Firefox and Safari only — Chrome has never shipped this event, which is
    // why the page also re-registers its subscription on open.
    global.addEventListener("pushsubscriptionchange", (event) => {
      event.waitUntil(
        (async () => {
          const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
          if (!applicationServerKey) return;
          const fresh = await global.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
          await fetch(`${apiBase}/api/devices/rotate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ old_endpoint: event.oldSubscription?.endpoint, subscription: fresh.toJSON() }),
          });
        })()
      );
    });
  };
})(self);

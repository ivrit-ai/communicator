const $ = (id) => document.getElementById(id);
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const state = { me: null, items: [], cursor: null, tokens: [] };

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

let toastTimer;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...options.headers } : options.headers,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

// --- push registration -------------------------------------------------

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;

async function currentSubscription(reg, vapidPublicKey) {
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    // A subscription bound to a different VAPID key fails every send with
    // 403 VapidPkHashMismatch — silently, and forever. Rebuild instead.
    const bound = existing.options?.applicationServerKey;
    const wanted = urlBase64ToUint8Array(vapidPublicKey);
    if (bound && new Uint8Array(bound).every((b, i) => b === wanted[i])) return existing;
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

async function registerThisDevice() {
  const { vapidPublicKey } = await api("/api/config");
  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await currentSubscription(reg, vapidPublicKey);
  await post("/api/devices", { ...sub.toJSON(), label: deviceLabel() });
  return sub;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : "Linux";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}

// The safety net that actually works everywhere: Chrome has never shipped
// pushsubscriptionchange, so re-upserting on open is what keeps endpoints fresh.
async function reconcile() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const last = Number(localStorage.getItem("reconciled_at") ?? 0);
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
  try {
    await registerThisDevice();
    localStorage.setItem("reconciled_at", String(Date.now()));
  } catch {
    // Best effort — the next open tries again.
  }
}

// --- feed --------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayNames = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function dayLabel(date) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (date.getTime() >= midnight) return "Today";
  if (date.getTime() >= midnight - DAY_MS) return "Yesterday";
  return dayNames.format(date);
}

function relativeTime(date) {
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return clock.format(date);
}

function renderFeed() {
  const feed = $("feed");
  feed.replaceChildren();

  if (!state.items.length) {
    feed.append(
      el("p", { className: "empty", textContent: "Nothing yet. Create a token and send something." })
    );
    return;
  }

  let currentDay = null;
  for (const item of state.items) {
    const at = new Date(item.created_at);
    const label = dayLabel(at);
    if (label !== currentDay) {
      currentDay = label;
      feed.append(el("div", { className: "day", textContent: label }));
    }

    const meta = el("div", { className: "meta" }, [
      el("span", { className: "source", textContent: item.source }),
      el("span", { textContent: relativeTime(at) }),
    ]);
    const card = el(
      item.url ? "a" : "div",
      {
        className: `item${item.read_at ? "" : " unread"}`,
        ...(item.url ? { href: item.url, target: "_blank", rel: "noopener noreferrer" } : {}),
      },
      [
        meta,
        el("div", { className: "title", textContent: item.title }),
        item.body ? el("div", { className: "body", textContent: item.body }) : null,
      ]
    );
    card.addEventListener("click", () => markRead([item.id]));
    feed.append(card);
  }
}

function updateBadge() {
  const unread = state.items.filter((n) => !n.read_at).length;
  if (!("setAppBadge" in navigator)) return;
  if (unread) navigator.setAppBadge(unread).catch(() => {});
  else navigator.clearAppBadge().catch(() => {});
}

async function loadFeed({ append = false } = {}) {
  const query = append && state.cursor ? `?before=${encodeURIComponent(state.cursor)}` : "";
  const page = await api(`/api/notifications${query}`);
  state.items = append ? state.items.concat(page.notifications) : page.notifications;
  state.cursor = page.next;
  // A full last page still hands back a cursor; the empty page that follows is
  // what actually ends the list.
  $("more").hidden = !page.next || page.notifications.length === 0;
  renderFeed();
  updateBadge();
}

async function markRead(ids) {
  const unread = ids.filter((id) => !state.items.find((n) => n.id === id)?.read_at);
  if (!unread.length) return;
  const at = new Date().toISOString();
  for (const item of state.items) {
    if (unread.includes(item.id)) item.read_at = at;
  }
  renderFeed();
  updateBadge();
  await post("/api/notifications/read", { ids: unread }).catch(() => {});
}

// --- tokens ------------------------------------------------------------

function curlExample(token) {
  return [
    `curl -X POST ${location.origin}/api/notify \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"title":"Deploy failed","body":"3 tests failed","dedupe_key":"build-4213"}'`,
  ].join("\n");
}

function revealToken(name, token) {
  const box = $("token-reveal");
  const copy = el("button", { className: "ghost", textContent: "Copy token" });
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(token);
    toast("Token copied.");
  });

  box.replaceChildren(
    el("p", {
      innerHTML:
        "<strong>Copy this now.</strong> It is shown once and never stored in a form we can read back.",
    }),
    el("pre", { className: "token", textContent: token }),
    el("div", { className: "row" }, [copy]),
    el("p", { className: "lede", textContent: `Send from ${name}:` }),
    el("pre", { textContent: curlExample(token) })
  );
  box.hidden = false;
}

function renderTokens() {
  const list = $("tokens");
  if (!state.tokens.length) {
    list.replaceChildren(el("p", { className: "empty", textContent: "No tokens yet." }));
    return;
  }
  list.replaceChildren(
    ...state.tokens.map((token) => {
      const revoke = el("button", { className: "ghost danger", textContent: "Revoke" });
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke "${token.name}"? Anything using it stops working immediately.`)) return;
        await api(`/api/tokens/${token.token_id}`, { method: "DELETE" });
        await loadTokens();
        toast("Token revoked.");
      });
      const used = token.last_used_at
        ? `last used ${relativeTime(new Date(token.last_used_at))}`
        : "never used";
      return el("div", { className: "card" }, [
        el("div", { className: "row" }, [
          el("div", {}, [
            el("div", { textContent: token.name }),
            el("div", { className: "lede", textContent: `${token.token_id} · ${used}` }),
          ]),
          revoke,
        ]),
      ]);
    })
  );
}

async function loadTokens() {
  state.tokens = (await api("/api/tokens")).tokens;
  renderTokens();
}

// --- settings ----------------------------------------------------------

async function renderDevices() {
  const { devices } = await api("/api/devices");
  const list = $("devices");
  if (!devices.length) {
    list.replaceChildren(
      el("p", { className: "empty", textContent: "No devices registered yet." })
    );
    return;
  }
  list.replaceChildren(
    ...devices.map((device) => {
      const remove = el("button", { className: "ghost danger", textContent: "Remove" });
      remove.addEventListener("click", async () => {
        await api(`/api/devices/${device.id}`, { method: "DELETE" });
        await renderDevices();
      });
      return el("div", { className: "card" }, [
        el("div", { className: "row" }, [
          el("div", {}, [
            el("div", { textContent: device.label ?? "Unnamed device" }),
            el("div", {
              className: "lede",
              textContent: `added ${new Date(device.created_at).toLocaleDateString()}`,
            }),
          ]),
          remove,
        ]),
      ]);
    })
  );
}

function renderPermission() {
  const permission = pushSupported() ? Notification.permission : "unsupported";
  const copy = {
    unsupported: "This browser does not support Web Push.",
    default: "Notifications are not enabled on this device yet.",
    granted: "Notifications are enabled on this device.",
    denied:
      "Notifications are blocked. Browsers give no way to ask again — re-allow them in site settings.",
  };
  $("permission").textContent = copy[permission];
  $("enable").hidden = permission !== "default";
  $("test").hidden = permission !== "granted";
}

async function renderDiagnostics() {
  const rows = [
    ["Permission", pushSupported() ? Notification.permission : "unsupported"],
    ["Installed", matchMedia("(display-mode: standalone)").matches ? "yes" : "no (browser tab)"],
    ["Service worker", "serviceWorker" in navigator ? "supported" : "missing"],
  ];
  if (pushSupported()) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    rows.push(["Registration", reg ? "active" : "none"]);
    rows.push(["Push service", sub ? new URL(sub.endpoint).host : "not subscribed"]);
  }
  $("diagnostics").replaceChildren(
    ...rows.flatMap(([term, value]) => [
      el("dt", { textContent: term }),
      el("dd", { textContent: value }),
    ])
  );
}

// --- wiring ------------------------------------------------------------

function showView(name) {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.view === name);
  }
  for (const view of ["feed", "tokens", "settings"]) {
    $(`view-${view}`).hidden = view !== name;
  }
  if (name === "tokens") loadTokens().catch((err) => toast(err.message));
  if (name === "settings") {
    renderPermission();
    renderDevices().catch(() => {});
    renderDiagnostics();
  }
}

document.querySelectorAll("#tabs button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

$("more").addEventListener("click", async () => {
  $("more").disabled = true;
  try {
    await loadFeed({ append: true });
  } finally {
    $("more").disabled = false;
  }
});

$("mark-all").addEventListener("click", () => markRead(state.items.map((n) => n.id)));

$("new-token").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("token-name").value.trim();
  if (!name) return;
  try {
    const created = await post("/api/tokens", { name });
    $("token-name").value = "";
    revealToken(created.name, created.token);
    await loadTokens();
  } catch (err) {
    toast(`Could not create token: ${err.message}`);
  }
});

$("enable").addEventListener("click", async () => {
  const dialog = $("preprompt");
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "yes") return;

  try {
    // Safari ignores requestPermission outside a user gesture, and a denial is
    // permanent, so this only ever runs from a deliberate click.
    const permission = await Notification.requestPermission();
    renderPermission();
    if (permission !== "granted") return toast(`Notifications ${permission}.`);
    await registerThisDevice();
    localStorage.setItem("reconciled_at", String(Date.now()));
    await renderDevices();
    await renderDiagnostics();
    toast("This device is registered.");
  } catch (err) {
    toast(`Could not enable notifications: ${err.message}`);
  }
});

$("test").addEventListener("click", async () => {
  try {
    const { devices } = await post("/api/test");
    toast(devices ? `Sent to ${devices} device(s).` : "No devices registered yet.");
  } catch (err) {
    toast(`Could not send: ${err.message}`);
  }
});

$("signout").addEventListener("click", async () => {
  await post("/api/logout");
  location.reload();
});

// A push that arrives while the app is open should show up in the list too.
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "push") loadFeed().catch(() => {});
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.me) return;
  reconcile();
  loadFeed().catch(() => {});
});

function showIosHint() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("ios-hint").hidden = !isIos || standalone;
}

async function start() {
  showIosHint();
  try {
    state.me = await api("/api/me");
  } catch {
    $("landing").hidden = false;
    return;
  }

  $("who").textContent = state.me.email;
  $("tabs").hidden = false;
  showView("feed");
  await loadFeed();
  await reconcile();
  if (pushSupported()) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

start();

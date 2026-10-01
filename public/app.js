import { detectLocale, localized, locale, setLocale, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const store = self.NotifierStore;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_ULID = "0".repeat(26);
const RETENTION_MS = 3 * 86_400_000;

const state = {
  me: null,
  view: "inbox",
  messages: [],
  filter: "all",
  query: "",
  expanded: new Set(),
  catalog: { sources: [], subscriptions: [] },
  tokens: [],
};

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(message, action) {
  const box = $("toast");
  $("toast-text").textContent = message;
  const button = $("toast-action");
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      box.hidden = true;
      action.run();
    };
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), action ? 6000 : 3500);
}

function ask(message, { ok = t("continue"), danger = false } = {}) {
  const dialog = $("confirm");
  $("confirm-text").textContent = message;
  const button = $("confirm-ok");
  button.textContent = ok;
  button.className = `btn ${danger ? "danger" : "primary"}`;
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true })
  );
}

class ApiError extends Error {
  constructor(status, detail) {
    super(detail.error ?? String(status));
    this.status = status;
    this.detail = detail;
  }
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  return res.status === 204 ? null : res.json();
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });
const del = (path) => api(path, { method: "DELETE" });

// Stable per-name colour for sources without a logo.
function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function sourceOf(message) {
  return state.catalog.sources.find((s) => s.id === message.source_id) ?? null;
}

function sourceName(message) {
  const source = sourceOf(message);
  return source ? localized(source, "name") : message.source;
}

function avatar({ icon: src, name }, big = false) {
  const cls = `avatar${big ? " big" : ""}`;
  if (src) return el("img", { class: cls, src, alt: "", loading: "lazy" });
  const letter = [...(name || "?").trim()][0]?.toUpperCase() ?? "?";
  return el("span", { class: `${cls} mono`, style: `--hue:${hue(name || "?")}`, text: letter });
}

function messageAvatar(message) {
  const source = sourceOf(message);
  return avatar({ icon: source?.icon, name: sourceName(message) });
}

const DAY_MS = 86_400_000;

function formatters() {
  const tag = locale() === "he" ? "he-IL" : undefined;
  return {
    day: new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long" }),
    dayYear: new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric" }),
    clock: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
    date: new Intl.DateTimeFormat(tag, { dateStyle: "medium" }),
  };
}

function dayLabel(ms) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (ms >= midnight) return t("today");
  if (ms >= midnight - DAY_MS) return t("yesterday");
  const f = formatters();
  return new Date(ms).getFullYear() === new Date().getFullYear() ? f.day.format(ms) : f.dayYear.format(ms);
}

function relativeTime(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return t("justNow");
  if (seconds < 3600) return t("minutesAgo", Math.floor(seconds / 60));
  if (seconds < 6 * 3600) return t("hoursAgo", Math.floor(seconds / 3600));
  return formatters().clock.format(ms);
}

function whenever(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Date.now() - ms < DAY_MS ? relativeTime(ms) : formatters().date.format(ms);
}

// ---------------------------------------------------------------- push

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

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
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
}

async function registerThisDevice() {
  const { vapidPublicKey } = await api("/api/config");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = await currentSubscription(reg, vapidPublicKey);
  const { id } = await post("/api/devices", { ...sub.toJSON(), label: deviceLabel() });
  localStorage.setItem("device_id", id);
  localStorage.setItem("reconciled_at", String(Date.now()));
  return id;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} · ${os}`;
}

// The safety net that works everywhere: Chrome has never shipped
// pushsubscriptionchange, so re-upserting on open keeps endpoints fresh.
async function reconcile() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const last = Number(localStorage.getItem("reconciled_at") ?? 0);
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
  try {
    await registerThisDevice();
    state.pushFailed = false;
  } catch {
    state.pushFailed = true;
  }
  renderNotifyBanner();
}

// Soft prompt, then the real one. Resolves to what happened: "granted" once
// this device is registered, "dismissed" when the user said not now, or the
// trouble that stopped it (see notificationTrouble).
async function enableNotifications() {
  if (!pushSupported()) return troubleWithoutPush();
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") {
    const dialog = $("preprompt");
    dialog.showModal();
    await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
    if (dialog.returnValue !== "yes") return "dismissed";
    // Safari ignores requestPermission outside a user gesture, and a denial is
    // permanent, so this only ever runs from a deliberate click.
    const permission = await Notification.requestPermission();
    // Still "default" means the browser answered for the user without asking:
    // Chrome's quiet prompt, or a request dismissed too often before.
    if (permission !== "granted") return permission === "denied" ? "denied" : "hidden";
  }
  try {
    await registerThisDevice();
    state.pushFailed = false;
    toast(t("registered"));
    return "granted";
  } catch {
    // Allowed, yet the browser could not subscribe: Brave with Google push
    // messaging off, some private windows, a push service that is down.
    state.pushFailed = true;
    return "failed";
  }
}

// ---------------------------------------------------------------- notification trouble

function platform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = ios ? "ios" : /Android/.test(ua) ? "android" : /Mac OS X/.test(ua) ? "mac" : "desktop";
  const browser = navigator.brave
    ? "brave"
    : /SamsungBrowser/.test(ua)
      ? "samsung"
      : /Edg\//.test(ua)
        ? "edge"
        : /Firefox\/|FxiOS/.test(ua)
          ? "firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "chrome"
            : /Safari\//.test(ua)
              ? "safari"
              : "other";
  return { os, browser };
}

function troubleWithoutPush() {
  return platform().os === "ios" && !installed() ? "ios-install" : "unsupported";
}

// Why notifications cannot reach this device, or null when nothing is known to
// be wrong. "default" (never asked) is not trouble: it is a question to ask.
function notificationTrouble() {
  if (!pushSupported()) return troubleWithoutPush();
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && state.pushFailed) return "failed";
  return null;
}

function helpSteps(trouble) {
  const { os, browser } = platform();
  const host = location.host;
  if (trouble === "ios-install") return t("helpIos-install");
  if (trouble === "hidden") return t("helpHidden");
  if (trouble === "failed") return browser === "brave" ? t("helpBrave") : t("helpFailed");
  if (trouble === "unsupported") return t("helpFailed");
  if (os === "ios") return t("helpIos");
  if (os === "android") return browser === "samsung" ? t("helpSamsung", host) : t("helpAndroid", host);
  if (browser === "firefox") return t("helpFirefox", host);
  if (browser === "safari") return t("helpSafari", host);
  if (["chrome", "edge", "brave"].includes(browser)) return t("helpChromium", host);
  return t("helpGeneric");
}

// Steps for this browser and device, and what to do once they are done.
function helpPanel(trouble, { retry, skip } = {}) {
  const actions = [];
  if (retry && trouble !== "unsupported" && trouble !== "ios-install") {
    actions.push(el("button", { class: "btn primary", type: "button", text: t("helpRetry"), onclick: retry }));
  }
  if (skip) actions.push(el("button", { class: "btn quiet", type: "button", text: t("linkAnyway"), onclick: skip }));
  return el("div", { class: "help" }, [
    el("h3", { text: t(`helpTitle_${trouble}`) }),
    el("p", { class: "muted", text: t("helpLead") }),
    el("ol", {}, helpSteps(trouble).map((step) => el("li", { text: step }))),
    trouble === "denied" || trouble === "hidden" ? el("p", { class: "hint", text: t("helpSystem") }) : null,
    actions.length ? el("div", { class: "row" }, actions) : null,
  ]);
}

// "I've allowed them": look again, and carry on if they were.
async function recheckNotifications() {
  if (pushSupported() && Notification.permission === "default") return enableNotifications();
  const trouble = notificationTrouble();
  if (trouble === "denied") {
    toast(t("stillBlocked"));
    return trouble;
  }
  return enableNotifications();
}

// Permission changes (the user fixing it in site settings) re-render whatever
// is showing, where the browser reports them.
navigator.permissions
  ?.query({ name: "notifications" })
  .then((status) => {
    status.onchange = () => {
      if (!state.me) return;
      renderNotifyBanner();
      if (state.view === "settings") renderPermission();
    };
  })
  .catch(() => {});

function renderNotifyBanner() {
  const box = $("notify-banner");
  const trouble = notificationTrouble();
  const ask = !trouble && pushSupported() && Notification.permission === "default";
  let dismissed = 0;
  try {
    dismissed = Number(localStorage.getItem("notify_banner_dismissed") ?? 0);
  } catch {}
  if ((!trouble && !ask) || Date.now() - dismissed < 7 * DAY_MS) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(
    icon("bell"),
    el("span", { class: "grow", text: ask ? t("bannerAsk") : t("bannerOff") }),
    el("button", {
      class: "btn small primary",
      type: "button",
      text: ask ? t("bannerTurnOn") : t("bannerFix"),
      onclick: async () => {
        if (!ask) return showView("settings");
        await enableNotifications();
        renderNotifyBanner();
      },
    }),
    el("button", {
      class: "icon-btn",
      type: "button",
      "aria-label": t("dismiss"),
      onclick: () => {
        try {
          localStorage.setItem("notify_banner_dismissed", String(Date.now()));
        } catch {}
        box.hidden = true;
      },
    }, [icon("close")])
  );
  box.hidden = false;
}

// ---------------------------------------------------------------- sync

// Pull everything newer than the last message this device synced. The
// server keeps three days; whatever arrives lands in the local store and
// stays there.
async function sync() {
  let cursor = (await store.getMeta("cursor")) ?? FIRST_ULID;
  for (let pages = 0; pages < 50; pages++) {
    const page = await api(`/api/notifications?after=${cursor}&limit=100`);
    if (page.notifications.length) {
      await store.put(page.notifications);
      cursor = page.notifications.at(-1).id;
      await store.setMeta("cursor", cursor);
    }
    if (!page.next) break;
  }
  // Messages that arrived by push while the full-text fetch failed.
  for (const m of await store.all()) {
    if (!m.partial || Date.now() - m.created_at > RETENTION_MS) continue;
    const full = await api(`/api/notifications/${m.id}`).catch(() => null);
    if (full) await store.put([full]);
  }
}

async function refreshCatalog() {
  try {
    state.catalog = await api("/api/sources");
    await store.setMeta("catalog", state.catalog);
  } catch {
    state.catalog = (await store.getMeta("catalog")) ?? state.catalog;
  }
}

async function loadMessages() {
  state.messages = await store.all();
  const unread = state.messages.filter((m) => !m.read).length;
  $("unread-badge").hidden = !unread;
  $("unread-badge").textContent = unread > 99 ? "99+" : String(unread);
  store.updateBadge().catch(() => {});
}

async function refreshInbox({ fromServer = true } = {}) {
  if (fromServer) {
    try {
      await sync();
    } catch (err) {
      if (err instanceof TypeError) toast(t("offline"));
    }
  }
  await loadMessages();
  if (state.view === "inbox") renderInbox();
}

// ---------------------------------------------------------------- inbox

function filterKey(m) {
  return m.source_id ? `s:${m.source_id}` : `p:${m.source}`;
}

function renderChips() {
  const seen = new Map();
  for (const m of state.messages) if (!seen.has(filterKey(m))) seen.set(filterKey(m), m);
  const box = $("chips");
  if (seen.size < 2) {
    box.replaceChildren();
    state.filter = "all";
    return;
  }
  const chip = (key, label, lead) =>
    el(
      "button",
      {
        class: "chip",
        type: "button",
        role: "tab",
        "aria-selected": String(state.filter === key),
        onclick: () => {
          state.filter = key;
          renderInbox();
        },
      },
      [lead, el("span", { text: label })]
    );
  box.replaceChildren(
    chip("all", t("all")),
    ...[...seen].map(([key, m]) => chip(key, sourceName(m), messageAvatar(m)))
  );
}

function visibleMessages() {
  const q = state.query.trim().toLowerCase();
  return state.messages.filter((m) => {
    if (state.filter !== "all" && filterKey(m) !== state.filter) return false;
    if (!q) return true;
    return [m.title, m.body, m.subtitle, sourceName(m)].some((v) => v?.toLowerCase().includes(q));
  });
}

function messageText(m) {
  return [m.title, m.body].filter(Boolean).join("\n\n");
}

function renderMessage(m, index) {
  const expanded = state.expanded.has(m.id);
  const body = m.body
    ? el("div", {
        class: `msg-body${expanded ? "" : " clamp"}`,
        dir: "auto",
        lang: m.lang ?? undefined,
        text: m.body,
        onclick: () => toggle(m),
      })
    : null;
  const more = el("button", { class: "act more", type: "button", hidden: true, text: expanded ? t("showLess") : t("showMore"), onclick: () => toggle(m) });

  const actions = el("div", { class: "msg-actions" }, [
    more,
    el("span", { class: "spacer" }),
    m.url
      ? el("a", { class: "act", href: m.url, target: "_blank", rel: "noopener noreferrer", onclick: () => read([m.id]) }, [icon("external"), el("span", { text: t("openLink") })])
      : null,
    el("button", { class: "act", type: "button", "aria-label": t("copy"), onclick: () => copy(m) }, [icon("copy"), el("span", { text: t("copy") })]),
    navigator.share
      ? el("button", { class: "act", type: "button", "aria-label": t("share"), onclick: () => share(m) }, [icon("share")])
      : null,
    el("button", { class: "act", type: "button", "aria-label": t("delete"), onclick: () => remove(m) }, [icon("trash")]),
  ]);

  const node = el("article", { class: `msg${m.read ? "" : " unread"}`, id: `m-${m.id}`, style: `--i:${Math.min(index, 12)}` }, [
    messageAvatar(m),
    el("div", { class: "msg-main" }, [
      el("div", { class: "msg-head" }, [
        el("span", { class: "msg-source", text: sourceName(m) }),
        m.subtitle ? el("span", { dir: "auto", text: m.subtitle }) : null,
        el("time", { datetime: new Date(m.created_at).toISOString(), title: new Date(m.created_at).toLocaleString(), text: relativeTime(m.created_at) }),
      ]),
      m.title ? el("h3", { class: "msg-title", dir: "auto", text: m.title }) : null,
      body,
      m.partial ? el("div", { class: "partial-note", text: t("loadingFull") }) : null,
      actions,
    ]),
  ]);

  // Only offer "show more" when the clamp actually hid something.
  if (body) {
    requestAnimationFrame(() => {
      more.hidden = !expanded && body.scrollHeight <= body.clientHeight + 2;
    });
  }
  return node;
}

function renderInbox() {
  renderChips();
  const feed = $("feed");
  const list = visibleMessages();
  $("mark-all").hidden = !state.messages.some((m) => !m.read);

  if (!state.messages.length) {
    feed.replaceChildren(
      el("div", { class: "empty" }, [
        el("div", { class: "empty-art" }, [el("span"), el("span")]),
        el("h3", { text: t("emptyTitle") }),
        el("p", { text: t("emptyBody") }),
        el("button", { class: "btn primary", type: "button", onclick: () => showView("sources") }, [icon("sources"), el("span", { text: t("emptyAction") })]),
      ])
    );
    return;
  }
  if (!list.length) {
    feed.replaceChildren(el("p", { class: "empty muted", text: t("noMatches") }));
    return;
  }

  const nodes = [];
  let day = null;
  list.forEach((m, i) => {
    const label = dayLabel(m.created_at);
    if (label !== day) {
      day = label;
      nodes.push(el("div", { class: "day", text: label }));
    }
    nodes.push(renderMessage(m, i));
  });
  feed.replaceChildren(...nodes);
}

async function read(ids) {
  const unread = ids.filter((id) => state.messages.find((m) => m.id === id && !m.read));
  if (!unread.length) return;
  await store.markRead(unread);
  for (const m of state.messages) if (unread.includes(m.id)) m.read = true;
  await loadMessages();
  for (const id of unread) $(`m-${id}`)?.classList.remove("unread");
  $("mark-all").hidden = !state.messages.some((m) => !m.read);
}

function toggle(m) {
  if (state.expanded.has(m.id)) state.expanded.delete(m.id);
  else state.expanded.add(m.id);
  read([m.id]);
  const node = $(`m-${m.id}`);
  node?.replaceWith(renderMessage({ ...m, read: true }, 0));
}

async function copy(m) {
  try {
    await navigator.clipboard.writeText(messageText(m));
    toast(t("copied"));
    read([m.id]);
  } catch (err) {
    toast(t("error", err.message));
  }
}

async function share(m) {
  try {
    await navigator.share({ title: sourceName(m), text: messageText(m) });
    read([m.id]);
  } catch {
    // Dismissing the share sheet is not an error worth reporting.
  }
}

async function remove(m) {
  const node = $(`m-${m.id}`);
  node?.remove();
  await store.remove([m.id]);
  await loadMessages();
  renderInbox();
  toast(t("deleted"), {
    label: t("undo"),
    run: async () => {
      await store.restore(m);
      await loadMessages();
      renderInbox();
    },
  });
}

// #m/<id>: opened from a notification.
async function openFromHash() {
  const match = /^#m\/(.+)$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, "", location.pathname);
  const id = decodeURIComponent(match[1]);
  showView("inbox");
  if (!state.messages.some((m) => m.id === id)) await refreshInbox();
  state.filter = "all";
  state.query = "";
  $("search").value = "";
  state.expanded.add(id);
  renderInbox();
  read([id]);
  const node = $(`m-${id}`);
  if (node) {
    node.scrollIntoView({ block: "start", behavior: "smooth" });
    node.classList.add("flash");
  }
}

// ---------------------------------------------------------------- sources

function subscriptionsOf(sourceId) {
  return state.catalog.subscriptions.filter((s) => s.source_id === sourceId);
}

function renderSources() {
  const box = $("sources");
  if (!state.catalog.sources.length) {
    box.replaceChildren(el("p", { class: "muted", text: t("noSources") }));
    return;
  }
  box.replaceChildren(
    ...state.catalog.sources.map((source) => {
      const subs = subscriptionsOf(source.id);
      const name = localized(source, "name");
      return el("div", { class: "card source-card" }, [
        el("div", { class: "source-top" }, [
          avatar({ icon: source.icon, name }, true),
          el("div", { class: "grow" }, [
            el("h3", {}, [
              el("span", { text: name }),
              subs.length ? el("span", { class: "tag ok" }, [icon("check"), el("span", { text: t("linked") })]) : null,
            ]),
            el("p", { text: localized(source, "description") }),
          ]),
        ]),
        subs.length
          ? el(
              "div",
              { class: "subs" },
              subs.map((sub) =>
                el("div", { class: "list-row" }, [
                  el("div", { class: "grow" }, [
                    el("div", { dir: "auto", text: sub.label || name }),
                    el("div", { class: "sub", text: sub.last_message_at ? t("lastMessage", whenever(sub.last_message_at)) : t("noMessagesYet") }),
                  ]),
                  el("button", { class: "btn quiet small", type: "button", text: t("unlink"), onclick: () => unlink(source, sub) }),
                ])
              )
            )
          : null,
        el("div", { class: "row" }, [
          el("button", { class: `btn ${subs.length ? "" : "primary"}`, type: "button", onclick: () => openLinkSheet(source) }, [
            icon(subs.length ? "plus" : "sources"),
            el("span", { text: subs.length ? t("linkAnother") : t("link") }),
          ]),
        ]),
      ]);
    })
  );
}

async function unlink(source, sub) {
  if (!(await ask(t("unlinkConfirm", localized(source, "name")), { ok: t("unlink"), danger: true }))) return;
  try {
    await del(`/api/subscriptions/${encodeURIComponent(sub.id)}`);
    toast(t("unlinked"));
    await refreshCatalog();
    renderSources();
  } catch (err) {
    toast(t("error", err.message));
  }
}

// ---------------------------------------------------------------- link sheet

let sheetTimers = [];

function clearSheetTimers() {
  for (const timer of sheetTimers) clearTimeout(timer), clearInterval(timer);
  sheetTimers = [];
}

async function openLinkSheet(source) {
  const dialog = $("sheet");
  const name = localized(source, "name");
  $("sheet-title").textContent = t("sheetTitle", name);
  $("sheet-avatar").replaceChildren(avatar({ icon: source.icon, name }));
  dialog.showModal();
  const trouble = notificationTrouble();
  if (trouble) return renderHelpStep(source, trouble);
  if (pushSupported() && Notification.permission === "default") return renderNotifyStep(source);
  // Allowed, but this device may never have subscribed (or lost it): make
  // sure before the user links, since a link with no device reaches no one.
  if (pushSupported() && !localStorage.getItem("device_id")) {
    const result = await enableNotifications();
    if (result !== "granted") return renderHelpStep(source, result);
  }
  mintCode(source);
}

function closeSheet() {
  clearSheetTimers();
  if ($("sheet").open) $("sheet").close();
}

function renderNotifyStep(source) {
  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: t("stepNotify") }),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn primary",
        type: "button",
        onclick: async () => {
          const result = await enableNotifications();
          if (result === "granted" || result === "dismissed") mintCode(source);
          else renderHelpStep(source, result);
        },
      }, [icon("bell"), el("span", { text: t("enableHere") })]),
      el("button", { class: "btn quiet", type: "button", text: t("notNow"), onclick: () => mintCode(source) }),
    ])
  );
}

// Linking still works without notifications (messages wait in the app), so
// the user can always go on; but they should know why nothing will pop up.
function renderHelpStep(source, trouble) {
  $("sheet-body").replaceChildren(
    helpPanel(trouble, {
      retry: async () => {
        const result = await recheckNotifications();
        if (result === "granted") mintCode(source);
        else if (result !== "denied") renderHelpStep(source, result === "dismissed" ? trouble : result);
      },
      skip: () => mintCode(source),
    })
  );
}

async function mintCode(source) {
  clearSheetTimers();
  let link;
  try {
    link = await post("/api/links", { source_id: source.id });
  } catch (err) {
    $("sheet-body").replaceChildren(
      el("p", { class: "step-label", text: err.detail?.error === "too_many_subscriptions" ? t("tooManyLinks") : t("error", err.message) })
    );
    return;
  }
  const name = localized(source, "name");
  const methodLabel = (m) => (locale() === "he" && m.label_he) || m.label;
  const primaryText = link.methods.find((m) => m.text)?.text;
  const countdown = el("small");
  const status = el("div", { class: "status" }, [el("span", { class: "pulse" }), el("div", {}, [el("span", { text: t("waiting") }), countdown])]);

  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: `${t("stepSend")} ${name}:` }),
    el("div", { class: "code-box" }, [
      el("span", { class: "code", text: link.code }),
      el("button", {
        class: "icon-btn",
        type: "button",
        "aria-label": t("copy"),
        onclick: async () => {
          await navigator.clipboard.writeText(link.code).catch(() => {});
          toast(t("copied"));
        },
      }, [icon("copy")]),
    ]),
    el(
      "div",
      { class: "methods" },
      link.methods
        .filter((m) => m.url)
        .map((m, i) =>
          el("a", { class: `btn ${i === 0 ? "primary" : ""}`, href: m.url, target: "_blank", rel: "noopener" }, [
            el("span", { text: methodLabel(m) }),
            icon("chevron"),
          ])
        )
    ),
    primaryText
      ? el("div", {}, [
          el("p", { class: "hint", text: t("orSendText") }),
          el("div", { class: "literal" }, [
            el("span", { text: primaryText }),
            el("button", {
              class: "icon-btn",
              type: "button",
              "aria-label": t("copy"),
              onclick: async () => {
                await navigator.clipboard.writeText(primaryText).catch(() => {});
                toast(t("copied"));
              },
            }, [icon("copy")]),
          ]),
        ])
      : null,
    status
  );

  const expires = Date.parse(link.expires_at);
  const tick = () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    countdown.textContent = t("expiresIn", `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`);
  };
  tick();
  sheetTimers.push(setInterval(tick, 1000));

  const poll = async () => {
    if (!$("sheet").open) return;
    let result = null;
    if (document.visibilityState === "visible") result = await api(`/api/links/${link.link_id}`).catch(() => null);
    if (result?.state === "linked") return renderLinked(source, result.subscription);
    if (result && result.state !== "pending") return renderExpired(source, result.state);
    sheetTimers.push(setTimeout(poll, 2000));
  };
  sheetTimers.push(setTimeout(poll, 2000));
}

async function renderLinked(source, subscription) {
  clearSheetTimers();
  $("sheet-body").replaceChildren(
    el("div", { class: "success" }, [
      el("div", { class: "tick" }, [icon("check")]),
      el("h3", { dir: "auto", text: t("linkedAs", subscription?.label) }),
      el("p", { text: t("linkedBody") }),
      el("button", { class: "btn primary", type: "button", text: t("done"), onclick: closeSheet }),
    ])
  );
  await refreshCatalog();
  renderSources();
  // The source's welcome message is on its way; pick it up.
  setTimeout(() => refreshInbox(), 2500);
}

function renderExpired(source, state_) {
  clearSheetTimers();
  $("sheet-body").replaceChildren(
    el("p", { class: "step-label", text: state_ === "expired_attempt" ? t("codeTriedExpired") : t("codeExpired") }),
    el("button", { class: "btn primary", type: "button", text: t("newCode"), onclick: () => mintCode(source) })
  );
}

// ---------------------------------------------------------------- tokens

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
  box.replaceChildren(
    el("p", {}, [el("strong", { text: t("tokenOnce") })]),
    el("pre", { text: token }),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn small",
        type: "button",
        onclick: async () => {
          await navigator.clipboard.writeText(token);
          toast(t("copied"));
        },
      }, [icon("copy"), el("span", { text: t("copyToken") })]),
    ]),
    el("p", { class: "hint", text: t("sendFrom", name), style: "margin-top:14px" }),
    el("pre", { text: curlExample(token) })
  );
  box.hidden = false;
}

function renderTokens() {
  const list = $("tokens");
  if (!state.tokens.length) {
    list.replaceChildren(el("p", { class: "muted", text: t("noTokens") }));
    return;
  }
  list.replaceChildren(
    el(
      "div",
      { class: "card list" },
      state.tokens.map((token) =>
        el("div", { class: "list-row" }, [
          avatar({ name: token.name }),
          el("div", { class: "grow" }, [
            el("div", { text: token.name }),
            el("div", { class: "sub" }, [
              el("code", { text: token.token_id }),
              ` · ${token.last_used_at ? t("usedAgo", whenever(token.last_used_at)) : t("neverUsed")}`,
            ]),
          ]),
          el("button", {
            class: "btn quiet small",
            type: "button",
            text: t("revoke"),
            onclick: async () => {
              if (!(await ask(t("revokeConfirm", token.name), { ok: t("revoke"), danger: true }))) return;
              await del(`/api/tokens/${token.token_id}`);
              await loadTokens();
              toast(t("revoked"));
            },
          }),
        ])
      )
    )
  );
}

async function loadTokens() {
  state.tokens = (await api("/api/tokens")).tokens;
  renderTokens();
}

// ---------------------------------------------------------------- settings

function renderAccount() {
  const me = state.me;
  const box = $("account");
  if (me.kind === "anonymous") {
    box.className = "panel warn";
    box.replaceChildren(
      el("h3", { text: t("anonymousTitle") }),
      el("p", { class: "muted", text: t("anonymousBody") }),
      el("a", { class: "btn primary", href: "/xhost-auth/login?return_to=%2Fauth%2Fcomplete" }, el("span", { text: t("upgrade") }))
    );
    return;
  }
  box.className = "panel";
  box.replaceChildren(
    el("div", { class: "account-head" }, [
      avatar({ name: me.name || me.email }, true),
      el("div", {}, [el("h3", { text: me.name || t("accountTitle") }), el("p", { text: t("signedInAs", me.email) })]),
    ])
  );
}

function renderLocaleSwitches() {
  for (const button of document.querySelectorAll("[data-locale]")) {
    button.setAttribute("aria-pressed", String(button.dataset.locale === locale()));
  }
}

async function changeLocale(next) {
  if (next === locale()) return;
  setLocale(next);
  renderLocaleSwitches();
  await store.setMeta("locale", next).catch(() => {});
  if (state.me) patch("/api/me", { locale: next }).catch(() => {});
  rerender();
}

function renderPermission() {
  const permission = pushSupported() ? Notification.permission : "unsupported";
  const trouble = notificationTrouble();
  const copy = { unsupported: "permUnsupported", default: "permDefault", granted: "permGranted", denied: "permDenied" };
  $("permission").textContent = t(copy[permission]);
  $("permission").hidden = Boolean(trouble);
  $("permission-help").replaceChildren(
    trouble
      ? helpPanel(trouble, {
          retry: async () => {
            await recheckNotifications();
            renderPermission();
            renderNotifyBanner();
            renderDevices().catch(() => {});
          },
        })
      : ""
  );
  $("enable").hidden = permission !== "default";
  $("test").hidden = permission !== "granted" || Boolean(trouble);
}

async function renderDevices() {
  const { devices } = await api("/api/devices");
  const mine = localStorage.getItem("device_id");
  const list = $("devices");
  if (!devices.length) {
    list.replaceChildren(el("p", { class: "muted", text: t("noDevices") }));
    return;
  }
  const f = formatters();
  list.replaceChildren(
    ...devices.map((device) =>
      el("div", { class: "list-row" }, [
        el("div", { class: "grow" }, [
          el("div", {}, [
            el("span", { text: device.label ?? "—" }),
            String(device.id) === mine ? el("span", { class: "tag accent", style: "margin-inline-start:8px", text: t("thisDevice") }) : null,
          ]),
          el("div", { class: "sub", text: t("added", f.date.format(Date.parse(device.created_at))) }),
        ]),
        el("button", {
          class: "btn quiet small",
          type: "button",
          text: t("remove"),
          onclick: async () => {
            await del(`/api/devices/${device.id}`);
            if (String(device.id) === mine) localStorage.removeItem("device_id");
            await renderDevices();
          },
        }),
      ])
    )
  );
}

async function renderStorage() {
  $("storage").textContent = t("storageBody", await store.count());
}

async function renderDiagnostics() {
  const rows = [
    [t("permission"), pushSupported() ? Notification.permission : "unsupported"],
    [t("installed"), installed() ? t("yes") : t("noTab")],
    [t("serviceWorker"), "serviceWorker" in navigator ? "supported" : "missing"],
  ];
  if (pushSupported()) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    rows.push([t("pushService"), sub ? new URL(sub.endpoint).host : t("notSubscribed")]);
  }
  $("diagnostics").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })]));
}

// Signing out must also stop this device receiving the account's pushes, and
// must not leave the account's messages behind for the next person.
async function forgetThisDevice() {
  const id = localStorage.getItem("device_id");
  if (id) await del(`/api/devices/${id}`).catch(() => {});
  localStorage.removeItem("device_id");
  localStorage.removeItem("reconciled_at");
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
  await store.clear();
  await store.updateBadge().catch(() => {});
}

// ---------------------------------------------------------------- admin

const EMPTY_METHOD = { label: "", label_he: "", url_template: "", text_template: "" };

function input(value, props = {}) {
  return el("input", { value: value ?? "", ...props });
}

function field(label, control) {
  return el("label", { class: "field" }, [el("span", { text: label }), control]);
}

// Draw whatever the admin picked onto a square canvas, covering it, and hand
// back a PNG: the server only ever stores and serves that.
async function rasterize(file, size = 192) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("unreadable image"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const scale = Math.max(size / w, size / h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function revealKey(key) {
  const box = $("admin-reveal");
  box.replaceChildren(
    el("p", {}, [el("strong", { text: t("keyOnce") })]),
    el("pre", { text: key }),
    el("button", {
      class: "btn small",
      type: "button",
      onclick: async () => {
        await navigator.clipboard.writeText(key);
        toast(t("copied"));
      },
    }, [icon("copy"), el("span", { text: t("copy") })])
  );
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function sourceEditor(source, { isNew = false } = {}) {
  const methods = (source.link_methods?.length ? source.link_methods : [EMPTY_METHOD]).map((m) => ({ ...m }));
  const id = input(source.id, { required: true, pattern: "[a-z0-9-]+", disabled: !isNew, dir: "ltr" });
  const name = input(source.name, { required: true });
  const nameHe = input(source.name_he, { dir: "rtl" });
  const description = input(source.description);
  const descriptionHe = input(source.description_he, { dir: "rtl" });
  const accent = input(source.accent ?? "#d9481c", { type: "color" });
  const rate = input(source.rate_per_minute ?? 600, { type: "number", min: 1, max: 10000 });
  const enabled = el("input", { type: "checkbox", checked: source.enabled ?? true });
  const methodsBox = el("div", { class: "stack" });

  const renderMethods = () =>
    methodsBox.replaceChildren(
      ...methods.map((m, i) =>
        el("div", { class: "method" }, [
          el("div", { class: "method-head" }, [
            el("span", { text: `#${i + 1}` }),
            el("button", { class: "icon-btn", type: "button", "aria-label": t("remove"), onclick: () => (methods.splice(i, 1), renderMethods()) }, [icon("close")]),
          ]),
          el("div", { class: "grid-2" }, [
            field(t("methodLabel"), input(m.label, { oninput: (e) => (m.label = e.target.value) })),
            field(t("methodLabelHe"), input(m.label_he, { dir: "rtl", oninput: (e) => (m.label_he = e.target.value) })),
          ]),
          field(t("methodUrl"), input(m.url_template, { dir: "ltr", placeholder: "https://wa.me/972…?text=link%20{code}", oninput: (e) => (m.url_template = e.target.value) })),
          field(t("methodText"), input(m.text_template, { dir: "ltr", placeholder: "link {code}", oninput: (e) => (m.text_template = e.target.value) })),
        ])
      )
    );
  renderMethods();

  const iconInput = el("input", { type: "file", accept: "image/*", hidden: true });
  const preview = el("div", { class: "notif-preview" }, [
    avatar({ icon: source.icon_etag ? `/api/sources/${source.id}/icon.png?v=${source.icon_etag}` : null, name: source.name || "?" }),
    el("div", {}, [el("b", { text: source.name_he || source.name || "—" }), el("span", { dir: "rtl", text: t("previewBody") })]),
  ]);
  iconInput.addEventListener("change", async () => {
    const file = iconInput.files[0];
    if (!file) return;
    try {
      const png = await rasterize(file);
      await api(`/api/admin/sources/${source.id}/icon`, { method: "PUT", body: png, headers: { "content-type": "image/png" } });
      toast(t("iconUpdated"));
      await renderAdmin();
    } catch (err) {
      toast(t("error", err.message));
    }
  });

  const collect = () => {
    const body = {
      name: name.value.trim(),
      name_he: nameHe.value.trim() || null,
      description: description.value.trim() || null,
      description_he: descriptionHe.value.trim() || null,
      accent: accent.value,
      rate_per_minute: Number(rate.value),
      enabled: enabled.checked,
      link_methods: methods
        .filter((m) => m.label || m.text_template || m.url_template)
        .map((m) => ({ label: m.label.trim(), label_he: m.label_he?.trim() || null, url_template: m.url_template?.trim() || null, text_template: m.text_template.trim() })),
    };
    if (isNew) body.id = id.value.trim();
    return body;
  };

  const save = async (event) => {
    event.preventDefault();
    try {
      if (isNew) {
        const created = await post("/api/admin/sources", collect());
        revealKey(created.key);
      } else {
        await patch(`/api/admin/sources/${source.id}`, collect());
        toast(t("saved"));
      }
      await renderAdmin();
    } catch (err) {
      toast(t("error", `${err.detail?.field ?? ""} ${err.message}`.trim()));
    }
  };

  const form = el("form", { class: "stack", onsubmit: save }, [
    el("div", { class: "grid-2" }, [field(t("fieldId"), id), field(t("fieldName"), name), field(t("fieldNameHe"), nameHe), field(t("fieldAccent"), accent)]),
    el("div", { class: "grid-2" }, [field(t("fieldDescription"), description), field(t("fieldDescriptionHe"), descriptionHe)]),
    el("div", { class: "grid-2" }, [field(t("fieldRate"), rate), el("label", { class: "check" }, [enabled, el("span", { text: t("fieldEnabled") })])]),
    el("h4", { class: "field", text: t("methodsTitle") }),
    el("p", { class: "hint", text: t("methodsHint") }),
    methodsBox,
    el("div", { class: "row" }, [
      el("button", { class: "btn small", type: "button", onclick: () => (methods.push({ ...EMPTY_METHOD }), renderMethods()) }, [icon("plus"), el("span", { text: t("addMethod") })]),
    ]),
    isNew
      ? null
      : el("div", { class: "stack" }, [
          el("h4", { class: "field", text: t("preview") }),
          preview,
          el("div", { class: "row" }, [
            iconInput,
            el("button", { class: "btn small", type: "button", text: t("uploadIcon"), onclick: () => iconInput.click() }),
            el("button", {
              class: "btn small",
              type: "button",
              text: t("rotateKey"),
              onclick: async () => {
                if (!(await ask(t("rotateConfirm"), { ok: t("rotateKey"), danger: true }))) return;
                const { key } = await post(`/api/admin/sources/${source.id}/key`);
                revealKey(key);
                await renderAdmin();
              },
            }),
            el("button", {
              class: "btn danger small",
              type: "button",
              text: t("deleteSource"),
              onclick: async () => {
                if (!(await ask(t("deleteSourceConfirm", source.name), { ok: t("delete"), danger: true }))) return;
                await del(`/api/admin/sources/${source.id}`);
                await renderAdmin();
              },
            }),
          ]),
        ]),
    el("div", { class: "row end" }, [el("button", { class: "btn primary", type: "submit", text: isNew ? t("create") : t("save") })]),
  ]);
  return form;
}

async function renderAdmin() {
  const { sources } = await api("/api/admin/sources");
  const box = $("admin-sources");
  box.replaceChildren(
    ...sources.map((source) => {
      const details = el("details", { class: "card" }, [
        el("summary", { class: "source-top", style: "cursor:pointer;list-style:none" }, [
          avatar({ icon: source.icon_etag ? `/api/sources/${source.id}/icon.png?v=${source.icon_etag}` : null, name: source.name }, true),
          el("div", { class: "grow" }, [
            el("h3", {}, [el("span", { text: source.name }), source.enabled ? null : el("span", { class: "tag", text: t("disabled") })]),
            el("p", {}, [el("code", { text: source.id }), ` · ${t("subscribers", source.subscriptions)} · ${t("keyPrefix", source.key_prefix)}`]),
            source.link_stats
              ? el("p", {
                  class: "hint",
                  text: t("codeStats", source.link_stats, formatters().date.format(Date.parse(source.link_stats.since))),
                })
              : null,
          ]),
        ]),
        el("div", { style: "margin-top:16px" }, [sourceEditor(source)]),
      ]);
      return details;
    })
  );
}

$("new-source").addEventListener("click", () => {
  const box = $("admin-sources");
  if (box.querySelector(".new-source")) return;
  box.prepend(el("div", { class: "card new-source" }, [el("h3", { class: "field", text: t("newSource") }), sourceEditor({}, { isNew: true })]));
});

// ---------------------------------------------------------------- views

function showView(name) {
  if (name === "admin" && !state.me?.is_admin) name = "inbox";
  state.view = name;
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.view === name);
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const view of ["inbox", "sources", "settings", "admin"]) $(`view-${view}`).hidden = view !== name;
  window.scrollTo({ top: 0 });
  rerender();
}

function rerender() {
  if (!state.me) return;
  if (state.view === "inbox") renderInbox();
  if (state.view === "sources") {
    renderSources();
    loadTokens().catch((err) => toast(t("error", err.message)));
    refreshCatalog().then(renderSources);
  }
  if (state.view === "settings") {
    renderAccount();
    renderLocaleSwitches();
    renderPermission();
    renderDevices().catch(() => {});
    renderStorage();
    renderDiagnostics();
  }
  if (state.view === "admin") renderAdmin().catch((err) => toast(t("error", err.message)));
}

// ---------------------------------------------------------------- wiring

for (const button of document.querySelectorAll("#tabs button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

for (const button of document.querySelectorAll("[data-locale]")) {
  button.addEventListener("click", () => changeLocale(button.dataset.locale));
}

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderInbox();
});

$("mark-all").addEventListener("click", () => read(state.messages.filter((m) => !m.read).map((m) => m.id)));

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
    toast(t("error", err.message));
  }
});

$("enable").addEventListener("click", async () => {
  await enableNotifications();
  renderPermission();
  renderNotifyBanner();
  renderDevices().catch(() => {});
  renderDiagnostics();
});

$("test").addEventListener("click", async () => {
  try {
    const { devices } = await post("/api/test");
    toast(t("testSent", devices));
  } catch (err) {
    toast(t("error", err.message));
  }
});

$("clear-history").addEventListener("click", async () => {
  if (!(await ask(t("clearConfirm"), { ok: t("delete"), danger: true }))) return;
  const ids = (await store.all()).map((m) => m.id);
  await store.remove(ids);
  await loadMessages();
  renderStorage();
  toast(t("cleared"));
});

$("signout").addEventListener("click", async () => {
  const anonymous = state.me.kind === "anonymous";
  if (!(await ask(anonymous ? t("signOutAnonConfirm") : t("signOutConfirm"), { ok: t("signOut"), danger: anonymous }))) return;
  await forgetThisDevice();
  // An anonymous account is unreachable once signed out, so it is deleted
  // rather than left behind.
  if (anonymous) await del("/api/me").catch(() => {});
  else await post("/api/logout").catch(() => {});
  location.replace("/");
});

$("delete-account").addEventListener("click", async () => {
  if (!(await ask(t("deleteConfirm"), { ok: t("deleteAccount"), danger: true }))) return;
  await forgetThisDevice();
  await del("/api/me").catch(() => {});
  location.replace("/");
});

$("anon").addEventListener("click", async () => {
  $("anon").disabled = true;
  try {
    await post("/auth/anonymous", { locale: locale() });
    await start();
  } catch (err) {
    toast(t("error", err.message));
    $("anon").disabled = false;
  }
});

$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("close", clearSheetTimers);
$("sheet").addEventListener("click", (event) => {
  // A tap on the backdrop closes the sheet, as on every phone.
  if (event.target === $("sheet")) closeSheet();
});

addEventListener("scroll", () => document.querySelector(".bar").classList.toggle("scrolled", scrollY > 4), { passive: true });

// A push that arrives while the app is open lands in the store via the
// service worker; this only has to show it.
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (!state.me) return;
  if (event.data?.type === "push") refreshInbox({ fromServer: false });
  if (event.data?.type === "open") {
    location.hash = `#m/${encodeURIComponent(event.data.id)}`;
  }
});

addEventListener("hashchange", openFromHash);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.me) return;
  reconcile();
  refreshInbox();
});

function installed() {
  return navigator.standalone || matchMedia("(display-mode: standalone)").matches;
}

function showIosHint() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $("ios-hint").hidden = !isIos || installed();
}

// Chrome and friends fire this instead of offering an install affordance of
// their own, and the event is only honoured if replayed from a real gesture —
// so it has to be captured here and spent inside the click handler.
let installPrompt = null;

addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("install-hint").hidden = installed();
});

addEventListener("appinstalled", () => {
  installPrompt = null;
  $("install-hint").hidden = true;
});

$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  // Single use: a spent event cannot be replayed.
  installPrompt = null;
  $("install-hint").hidden = true;
  if (outcome === "dismissed") toast(t("installLater"));
});

// A different account on this browser must never see the previous one's
// messages.
async function claimStore(sub) {
  const owner = await store.getMeta("owner");
  if (owner && owner !== sub) await store.clear();
  if (owner !== sub) await store.setMeta("owner", sub);
}

async function start() {
  setLocale(detectLocale());
  renderLocaleSwitches();
  showIosHint();
  try {
    state.me = await api("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      $("landing").hidden = false;
      return;
    }
    // Offline with a session we cannot check: show what is on the device.
    const owner = await store.getMeta("owner").catch(() => null);
    if (!owner) {
      $("landing").hidden = false;
      return;
    }
    state.me = { sub: owner, kind: "unknown", offline: true };
    toast(t("offline"));
  }

  setLocale(detectLocale(state.me.locale));
  renderLocaleSwitches();
  await store.setMeta("locale", locale()).catch(() => {});
  await claimStore(state.me.sub);
  store.pruneTombstones().catch(() => {});
  navigator.storage?.persist?.().catch(() => {});

  document.body.classList.add("app");
  $("landing").hidden = true;
  $("tabs").hidden = false;
  document.querySelector('#tabs [data-view="admin"]').hidden = !state.me.is_admin;

  state.catalog = (await store.getMeta("catalog")) ?? state.catalog;
  await loadMessages();
  showView("inbox");
  renderNotifyBanner();

  if (location.hash === "#upgraded") {
    history.replaceState(null, "", location.pathname);
    toast(t("upgraded"));
  }
  if (state.me.offline) return;

  if (pushSupported()) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await refreshCatalog();
  await refreshInbox();
  await openFromHash();
  reconcile();
}

start();

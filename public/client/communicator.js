// The Communicator client: talking to Communicator's API, registering this
// device for push, and syncing messages into the device's own store. Used by
// Communicator's own pages and, vendored, by other apps on ivrit.ai (the
// ivrit.ai app), which call the same API from their own origin.
//
// `base` is "" on communicator.ivrit.ai itself and the API's origin
// elsewhere; cookies then travel with every request (same site: *.ivrit.ai).
// `client` tells the server which app a device belongs to ("web" or "app").

const FIRST_ULID = "0".repeat(26);
const RETENTION_MS = 3 * 86_400_000;

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail.error ?? String(status));
    this.status = status;
    this.detail = detail;
  }
}

export function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} · ${os}`;
}

export function createCommunicator({ base = "", client = "web", store, serviceWorker = "/sw.js" } = {}) {
  const credentials = base ? "include" : "same-origin";

  async function api(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { credentials, ...options, headers });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res.status === 204 ? null : res.json();
  }

  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
  const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });
  const del = (path) => api(path, { method: "DELETE" });

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

  // Subscribes this browser (with Communicator's VAPID key, wherever the page
  // is served from) and registers it as one of the user's devices.
  async function registerDevice() {
    const { vapidPublicKey } = await api("/api/config");
    const reg = await navigator.serviceWorker.register(serviceWorker);
    await navigator.serviceWorker.ready;
    const sub = await currentSubscription(reg, vapidPublicKey);
    const { id } = await post("/api/devices", { ...sub.toJSON(), label: deviceLabel(), client });
    localStorage.setItem("device_id", id);
    localStorage.setItem("reconciled_at", String(Date.now()));
    return id;
  }

  // The ivrit.ai app's native shells register a push token of their own
  // (Firebase on Android) with the AES key messages are sealed with, instead
  // of a web push subscription.
  async function registerNativeDevice({ transport, token, key, oldToken, label }) {
    const { id } = await post("/api/devices", { transport, token, key, old_token: oldToken, label, client });
    localStorage.setItem("device_id", id);
    localStorage.setItem("reconciled_at", String(Date.now()));
    return id;
  }

  // Signing in from an app's web view, where Google refuses to: the browser
  // signs in and hands the app a one-time code for `target`, redeemable only
  // with the verifier whose S256 hash is `challenge`.
  function handoffLoginUrl(target, challenge) {
    const complete = `/auth/complete?handoff=${encodeURIComponent(target)}&challenge=${challenge}`;
    return `${base}/xhost-auth/login?return_to=${encodeURIComponent(complete)}`;
  }

  const redeemHandoff = (code, verifier) => post("/auth/handoff", { code, verifier });

  // Stops this browser receiving the account's pushes.
  async function forgetDevice() {
    const id = localStorage.getItem("device_id");
    if (id) await del(`/api/devices/${id}`).catch(() => {});
    localStorage.removeItem("device_id");
    localStorage.removeItem("reconciled_at");
    const reg = await navigator.serviceWorker?.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {});
  }

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

  // Where to send someone to sign in with Google, coming back to `next`.
  function loginUrl(next = "/") {
    const complete = `/auth/complete?next=${encodeURIComponent(next)}`;
    return `${base}/xhost-auth/login?return_to=${encodeURIComponent(complete)}`;
  }

  return {
    api,
    post,
    patch,
    del,
    registerDevice,
    registerNativeDevice,
    forgetDevice,
    sync,
    loginUrl,
    handoffLoginUrl,
    redeemHandoff,
    base,
    client,
  };
}

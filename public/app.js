const who = document.getElementById("who");
const signin = document.getElementById("signin");
const signout = document.getElementById("signout");
const enable = document.getElementById("enable");
const devices = document.getElementById("devices");
const status = document.getElementById("status");

const say = (msg) => {
  status.textContent = msg;
};

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.register("/sw.js");
}

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

async function upsertDevice(sub) {
  const res = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) throw new Error(`device upsert failed: ${res.status}`);
}

async function renderDevices() {
  const res = await fetch("/api/devices");
  if (!res.ok) return;
  const { devices: list } = await res.json();
  devices.textContent = list.length
    ? `${list.length} device(s) registered.`
    : "No devices registered yet.";
}

enable.addEventListener("click", async () => {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return say("This browser does not support Web Push.");
    }
    // Must be called from a user gesture: Safari ignores it otherwise, and a
    // denial is permanent with no API to ask again.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return say(`Notifications ${permission}.`);

    const { vapidPublicKey } = await (await fetch("/api/config")).json();
    const reg = await registration();
    const sub = await currentSubscription(reg, vapidPublicKey);
    await upsertDevice(sub);
    say("This device is registered for push.");
    await renderDevices();
  } catch (err) {
    say(`Could not enable notifications: ${err.message}`);
  }
});

// The safety net that actually works everywhere: Chrome has never shipped
// pushsubscriptionchange, so re-upserting on open is what keeps endpoints fresh.
async function reconcile() {
  if (Notification.permission !== "granted") return;
  try {
    const { vapidPublicKey } = await (await fetch("/api/config")).json();
    const reg = await registration();
    const sub = await currentSubscription(reg, vapidPublicKey);
    await upsertDevice(sub);
  } catch {
    // Best effort — the next open tries again.
  }
}

async function render() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    who.textContent = "Not signed in.";
    signin.hidden = false;
    signout.hidden = true;
    enable.hidden = true;
    return;
  }
  const me = await res.json();
  who.textContent = `Signed in as ${me.name ?? me.email} (${me.email})`;
  signin.hidden = true;
  signout.hidden = false;
  enable.hidden = false;
  await renderDevices();
  await reconcile();
}

signout.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  await render();
});

render();

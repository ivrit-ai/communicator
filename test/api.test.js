import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL,
  createDevice,
  createUser,
  decrypt,
  freshDatabase,
  openFcm,
  startApp,
  startFcmService,
  startGoogleService,
  startPushService,
  stopDatabase,
  waitFor,
} from "./harness.js";
import { adoptAnonymous } from "../src/accounts.js";
import { dropExpiredPartitions, ensurePartitions } from "../src/migrate.js";
import { sweep } from "../src/maintenance.js";

const APP_ORIGIN = "https://app.example.test";
const APP_HANDOFF = "ai.example.app://auth";
const GOOGLE_CLIENT = "test-client.apps.googleusercontent.com";

let pool;
let push;
let fcm;
let google;
let app;
let admin;

const ELIEZER = {
  id: "eliezer",
  name: "Eliezer",
  name_he: "אליעזר",
  description: "Voice note transcripts",
  accent: "#1f6feb",
  link_methods: [
    {
      label: "WhatsApp",
      label_he: "וואטסאפ",
      url_template: "https://wa.me/972500000000?text=link%20{code}",
      text_template: "link {code}",
    },
    { label: "Telegram", url_template: "https://t.me/BenYehudaBot?start=link-{code}", text_template: "/link {code}" },
  ],
};

before(async () => {
  pool = await freshDatabase();
  push = await startPushService();
  fcm = await startFcmService();
  google = await startGoogleService();
  app = await startApp({
    APP_GOOGLE_CLIENT_IDS: GOOGLE_CLIENT,
    GOOGLE_JWKS_URL: google.jwksUrl,
    APP_TOKEN_ISSUER: APP_ORIGIN,
    APP_TOKEN_JWKS_URL: google.jwksUrl,
    APP_ORIGINS: APP_ORIGIN,
    APP_HANDOFF_URLS: APP_HANDOFF,
    FCM_SERVICE_ACCOUNT: JSON.stringify(fcm.account),
    FCM_API_BASE: fcm.origin,
  });
  admin = await createUser(pool, { email: ADMIN_EMAIL });
});

after(async () => {
  await app?.stop();
  await push?.close();
  await fcm?.close();
  await google?.close();
  await pool?.end();
  stopDatabase();
});

async function createSource(source = ELIEZER) {
  const res = await app.call("POST", "/api/admin/sources", { cookie: admin.cookie, body: source });
  assert.equal(res.status, 201, res.text);
  return res.json.key;
}

async function link(user, key, { subject = "972501234567", label = "WhatsApp +972…567" } = {}) {
  const minted = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
  assert.equal(minted.status, 201, minted.text);
  const redeemed = await app.call("POST", "/api/source/v1/links", {
    bearer: key,
    origin: null,
    body: { code: minted.json.code, subject, label },
  });
  return { minted: minted.json, redeemed };
}

describe("accounts", () => {
  it("creates an anonymous account with a session cookie", async () => {
    const res = await app.call("POST", "/auth/anonymous", { body: { locale: "he" } });
    assert.equal(res.status, 201);
    const cookie = /__Host-notifier_sess=([^;]+)/.exec(res.headers.get("set-cookie"))[1];
    const me = await app.call("GET", "/api/me", { cookie });
    assert.equal(me.json.kind, "anonymous");
    assert.equal(me.json.locale, "he");
    assert.equal(me.json.email, null);
    assert.equal(me.json.is_admin, false);
  });

  it("refuses anonymous sign-up without a same-origin Origin", async () => {
    const res = await app.call("POST", "/auth/anonymous", { origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });

  it("updates the locale and rejects unknown ones", async () => {
    const user = await createUser(pool);
    assert.equal((await app.call("PATCH", "/api/me", { cookie: user.cookie, body: { locale: "he" } })).status, 200);
    assert.equal((await app.call("PATCH", "/api/me", { cookie: user.cookie, body: { locale: "fr" } })).status, 400);
    assert.equal((await app.call("GET", "/api/me", { cookie: user.cookie })).json.locale, "he");
  });

  it("moves everything an anonymous account owns into the Google account", async () => {
    const anon = await createUser(pool, { kind: "anonymous", locale: "he" });
    const google = await createUser(pool, { email: "someone@example.com" });
    const device = await createDevice(pool, anon.sub, push);
    await pool.query(
      `INSERT INTO ingest_tokens (token_id, secret_hash, user_sub, name) VALUES ('tok123456789', '\\x00', $1, 'ci')`,
      [anon.sub]
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await adoptAnonymous(client, anon.sub, google.sub);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { rows: devices } = await pool.query("SELECT user_sub FROM devices WHERE id = $1", [device.id]);
    assert.equal(devices[0].user_sub, google.sub);
    const { rows: tokens } = await pool.query("SELECT user_sub FROM ingest_tokens WHERE token_id = 'tok123456789'");
    assert.equal(tokens[0].user_sub, google.sub);
    const { rows: users } = await pool.query("SELECT sub, locale FROM users WHERE sub = ANY($1)", [[anon.sub, google.sub]]);
    assert.deepEqual(users, [{ sub: google.sub, locale: "he" }]);
  });

  it("deletes an account and everything in it", async () => {
    const user = await createUser(pool);
    await createDevice(pool, user.sub, push);
    const res = await app.call("DELETE", "/api/me", { cookie: user.cookie });
    assert.equal(res.status, 200);
    const { rowCount } = await pool.query("SELECT 1 FROM users WHERE sub = $1", [user.sub]);
    assert.equal(rowCount, 0);
    assert.equal((await app.call("GET", "/api/me", { cookie: user.cookie })).status, 401);
  });
});

describe("admin", () => {
  it("is closed to non-admins, including anonymous ones", async () => {
    const user = await createUser(pool, { email: "user@example.com" });
    const anon = await createUser(pool, { kind: "anonymous", email: ADMIN_EMAIL });
    assert.equal((await app.call("GET", "/api/admin/sources", { cookie: user.cookie })).status, 403);
    assert.equal((await app.call("GET", "/api/admin/sources", { cookie: anon.cookie })).status, 403);
    assert.equal((await app.call("GET", "/api/admin/sources")).status, 401);
  });

  it("creates a source, shows its key once, and rejects bad link methods", async () => {
    const key = await createSource();
    assert.match(key, /^nsrc_eliezer_[A-Za-z0-9_-]{43}$/);
    const list = await app.call("GET", "/api/admin/sources", { cookie: admin.cookie });
    assert.equal(list.json.sources[0].id, "eliezer");
    assert.equal(list.json.sources[0].key_hash, undefined);
    assert.ok(key.startsWith(list.json.sources[0].key_prefix));

    const bad = await app.call("POST", "/api/admin/sources", {
      cookie: admin.cookie,
      body: { id: "other", name: "Other", link_methods: [{ label: "X", text_template: "no code here" }] },
    });
    assert.equal(bad.status, 400);
    const dup = await app.call("POST", "/api/admin/sources", { cookie: admin.cookie, body: { id: "eliezer", name: "x" } });
    assert.equal(dup.status, 409);
  });

  it("accepts a PNG icon and serves it publicly with an ETag", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const up = await app.call("PUT", "/api/admin/sources/eliezer/icon", {
      cookie: admin.cookie,
      raw: png,
      type: "image/png",
    });
    assert.equal(up.status, 200, up.text);
    const notPng = await app.call("PUT", "/api/admin/sources/eliezer/icon", {
      cookie: admin.cookie,
      raw: Buffer.from("<svg/>"),
      type: "image/png",
    });
    assert.equal(notPng.status, 400);
    const icon = await app.call("GET", "/api/sources/eliezer/icon.png", { origin: null });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.ok(icon.headers.get("etag"));
  });

  it("rotating the key stops the old one immediately", async () => {
    const oldKey = await createSource({ id: "rotor", name: "Rotor" });
    const message = { subscription_id: "nope", body: "x" };
    // 410: authenticated, but there is no such subscription.
    assert.equal((await app.call("POST", "/api/source/v1/messages", { bearer: oldKey, origin: null, body: message })).status, 410);
    const rotated = await app.call("POST", "/api/admin/sources/rotor/key", { cookie: admin.cookie });
    assert.equal(rotated.status, 200);
    assert.equal((await app.call("POST", "/api/source/v1/messages", { bearer: oldKey, origin: null, body: message })).status, 401);
    assert.equal((await app.call("POST", "/api/source/v1/messages", { bearer: rotated.json.key, origin: null, body: message })).status, 410);
  });
});

describe("linking", () => {
  let key;
  before(async () => {
    const res = await app.call("POST", "/api/admin/sources/eliezer/key", { cookie: admin.cookie });
    key = res.json.key;
  });

  it("mints a code with filled-in link methods, and lists the catalogue", async () => {
    const user = await createUser(pool);
    const res = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
    assert.equal(res.status, 201);
    assert.match(res.json.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.equal(res.json.methods[0].url, `https://wa.me/972500000000?text=link%20${res.json.code}`);
    assert.equal(res.json.methods[0].text, `link ${res.json.code}`);
    const catalogue = await app.call("GET", "/api/sources", { cookie: user.cookie });
    assert.equal(catalogue.json.sources[0].name_he, "אליעזר");
    assert.ok(catalogue.json.sources[0].icon.startsWith("/api/sources/eliezer/icon.png"));
    assert.equal(catalogue.json.sources[0].methods[0].url_template, undefined);
  });

  it("redeems once, reports linked to the polling page, and is idempotent for the same subject", async () => {
    const user = await createUser(pool);
    const { minted, redeemed } = await link(user, key);
    assert.equal(redeemed.status, 201, redeemed.text);
    const poll = await app.call("GET", `/api/links/${minted.link_id}`, { cookie: user.cookie });
    assert.equal(poll.json.state, "linked");
    assert.equal(poll.json.subscription.label, "WhatsApp +972…567");

    const again = await app.call("POST", "/api/source/v1/links", {
      bearer: key,
      origin: null,
      body: { code: minted.code.toLowerCase().replace("-", " "), subject: "972501234567" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.subscription_id, redeemed.json.subscription_id);

    const stolen = await app.call("POST", "/api/source/v1/links", {
      bearer: key,
      origin: null,
      body: { code: minted.code, subject: "someone-else" },
    });
    assert.equal(stolen.status, 409);
  });

  it("relinking the same subject reuses the live subscription", async () => {
    const user = await createUser(pool);
    const first = await link(user, key, { subject: "same" });
    const second = await link(user, key, { subject: "same" });
    assert.equal(second.redeemed.json.subscription_id, first.redeemed.json.subscription_id);
  });

  it("tells the page when an expired code was tried", async () => {
    const user = await createUser(pool);
    const minted = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
    await pool.query("UPDATE link_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      minted.json.link_id,
    ]);
    const polledBefore = await app.call("GET", `/api/links/${minted.json.link_id}`, { cookie: user.cookie });
    assert.equal(polledBefore.json.state, "expired");
    const redeemed = await app.call("POST", "/api/source/v1/links", {
      bearer: key,
      origin: null,
      body: { code: minted.json.code, subject: "x" },
    });
    assert.equal(redeemed.status, 410);
    const polled = await app.call("GET", `/api/links/${minted.json.link_id}`, { cookie: user.cookie });
    assert.equal(polled.json.state, "expired_attempt");
  });

  it("treats unknown codes, and codes for another source, as unknown", async () => {
    const user = await createUser(pool);
    const other = await app.call("POST", "/api/admin/sources/rotor/key", { cookie: admin.cookie });
    const minted = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
    const wrongSource = await app.call("POST", "/api/source/v1/links", {
      bearer: other.json.key,
      origin: null,
      body: { code: minted.json.code, subject: "x" },
    });
    assert.equal(wrongSource.status, 404);
    const unknown = await app.call("POST", "/api/source/v1/links", {
      bearer: key,
      origin: null,
      body: { code: "00000-00000", subject: "x" },
    });
    assert.equal(unknown.status, 404);
  });

  it("a newer code replaces the pending one", async () => {
    const user = await createUser(pool);
    const first = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
    await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "eliezer" } });
    const redeemed = await app.call("POST", "/api/source/v1/links", {
      bearer: key,
      origin: null,
      body: { code: first.json.code, subject: "x" },
    });
    assert.equal(redeemed.status, 404);
  });
});

describe("source messages", () => {
  let key;
  before(async () => {
    const res = await app.call("POST", "/api/admin/sources/eliezer/key", { cookie: admin.cookie });
    key = res.json.key;
  });

  it("fans out to every device, with a preview in the push and the full text on ack", async () => {
    const user = await createUser(pool);
    const phone = await createDevice(pool, user.sub, push);
    const laptop = await createDevice(pool, user.sub, push);
    const { redeemed } = await link(user, key);
    const transcript = "שלום עולם. ".repeat(1200); // ~13 KB of UTF-8, far past one push

    const sent = await app.call("POST", "/api/source/v1/messages", {
      bearer: key,
      origin: null,
      body: {
        subscription_id: redeemed.json.subscription_id,
        body: transcript,
        subtitle: "תמלול הקלטה · 0:42",
        kind: "transcript",
        lang: "he",
        dedupe_key: "outbox:1:0",
      },
    });
    assert.equal(sent.status, 202, sent.text);
    assert.equal(sent.json.devices, 2);

    const pushes = await waitFor(
      () => {
        const mine = push.received.filter((p) => [phone.endpoint, laptop.endpoint].some((e) => e.endsWith(p.path)));
        return mine.length === 2 && mine;
      },
      { what: "two pushes" }
    );
    const forPhone = pushes.find((p) => phone.endpoint.endsWith(p.path));
    const payload = decrypt(forPhone, phone);
    assert.equal(payload.sid, "eliezer");
    assert.equal(payload.s, "Eliezer");
    assert.equal(payload.st, "תמלול הקלטה · 0:42");
    assert.equal(payload.l, "he");
    assert.equal(payload.x, 1);
    assert.ok(payload.b.endsWith("…"));
    assert.ok(!payload.b.includes("�"), "preview must not split a character");
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 3800);

    const acked = await app.call("POST", "/api/ack", {
      origin: null,
      body: { i: payload.i, d: payload.d, k: payload.k },
    });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.first, true);
    assert.equal(acked.json.notification.body, transcript);
    assert.equal(acked.json.notification.source_id, "eliezer");

    const forged = await app.call("POST", "/api/ack", {
      origin: null,
      body: { i: payload.i, d: laptop.id, k: payload.k },
    });
    assert.equal(forged.status, 403);
  });

  it("deduplicates retries by dedupe_key", async () => {
    const user = await createUser(pool);
    const { redeemed } = await link(user, key);
    const body = { subscription_id: redeemed.json.subscription_id, body: "once", dedupe_key: "outbox:7:0" };
    const first = await app.call("POST", "/api/source/v1/messages", { bearer: key, origin: null, body });
    const second = await app.call("POST", "/api/source/v1/messages", { bearer: key, origin: null, body });
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.id, first.json.id);
  });

  it("answers 410 once the user unlinks, so the source can unbind", async () => {
    const user = await createUser(pool);
    const { redeemed } = await link(user, key);
    const id = redeemed.json.subscription_id;
    const sources = await app.call("GET", "/api/sources", { cookie: user.cookie });
    assert.equal(sources.json.subscriptions[0].id, id);
    assert.equal((await app.call("DELETE", `/api/subscriptions/${id}`, { cookie: user.cookie })).status, 200);
    const res = await app.call("POST", "/api/source/v1/messages", {
      bearer: key,
      origin: null,
      body: { subscription_id: id, body: "hello?" },
    });
    assert.equal(res.status, 410);
  });

  it("lets the source unlink", async () => {
    const user = await createUser(pool);
    const { redeemed } = await link(user, key, { subject: "leaver" });
    const id = redeemed.json.subscription_id;
    assert.equal((await app.call("DELETE", `/api/source/v1/subscriptions/${id}`, { bearer: key, origin: null })).status, 200);
    const sources = await app.call("GET", "/api/sources", { cookie: user.cookie });
    assert.equal(sources.json.subscriptions.length, 0);
  });

  it("limits each subscription to 30 a minute", async () => {
    const user = await createUser(pool);
    const { redeemed } = await link(user, key, { subject: "chatty" });
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.call("POST", "/api/source/v1/messages", {
        bearer: key,
        origin: null,
        body: { subscription_id: redeemed.json.subscription_id, body: `n${i}` },
      });
      statuses.push(res.status);
      if (res.status === 429) assert.ok(Number(res.headers.get("retry-after")) > 0);
    }
    assert.equal(statuses.filter((s) => s === 202).length, 30);
    assert.equal(statuses.at(-1), 429);
  });

  it("syncs newer messages oldest first with ?after=", async () => {
    const user = await createUser(pool);
    const { redeemed } = await link(user, key, { subject: "sync" });
    const ids = [];
    for (const text of ["one", "two", "three"]) {
      const res = await app.call("POST", "/api/source/v1/messages", {
        bearer: key,
        origin: null,
        body: { subscription_id: redeemed.json.subscription_id, body: text },
      });
      ids.push(res.json.id);
    }
    const page = await app.call("GET", `/api/notifications?after=${ids[0]}`, { cookie: user.cookie });
    assert.deepEqual(
      page.json.notifications.map((n) => n.body),
      ["two", "three"]
    );
    assert.equal(page.json.notifications[0].source_id, "eliezer");
    const latest = await app.call("GET", "/api/notifications", { cookie: user.cookie });
    assert.equal(latest.json.notifications[0].body, "three");
  });
});

describe("the API as a service for other ivrit.ai apps", () => {
  it("answers preflights and credentialed requests from an allowed app origin only", async () => {
    const user = await createUser(pool);
    const pre = await fetch(`${app.origin}/api/devices`, {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), APP_ORIGIN);
    assert.equal(pre.headers.get("access-control-allow-credentials"), "true");

    const me = await app.call("GET", "/api/me", { cookie: user.cookie, origin: APP_ORIGIN });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("access-control-allow-origin"), APP_ORIGIN);
    const other = await app.call("GET", "/api/me", { cookie: user.cookie, origin: "https://evil.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("lets the app act for the signed-in user, and nobody else", async () => {
    const user = await createUser(pool);
    const fromApp = await app.call("POST", "/api/tokens", { cookie: user.cookie, origin: APP_ORIGIN, body: { name: "from-app" } });
    assert.equal(fromApp.status, 201);
    const fromElsewhere = await app.call("POST", "/api/tokens", {
      cookie: user.cookie,
      origin: "https://evil.example",
      body: { name: "nope" },
    });
    assert.equal(fromElsewhere.status, 403);
  });

  it("records which app a device belongs to", async () => {
    const user = await createUser(pool);
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/app-device-1",
      keys: { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", auth: "tBHItJI5svbpez7KI4CCXg" },
      label: "Chrome · Android",
    };
    const res = await app.call("POST", "/api/devices", { cookie: user.cookie, origin: APP_ORIGIN, body: { ...subscription, client: "app" } });
    assert.equal(res.status, 201, res.text);
    const list = await app.call("GET", "/api/devices", { cookie: user.cookie });
    assert.equal(list.json.devices[0].client, "app");
    const web = await app.call("POST", "/api/devices", {
      cookie: user.cookie,
      body: { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/web-device-1", client: "anything-else" },
    });
    assert.equal(web.status, 201);
    const both = await app.call("GET", "/api/devices", { cookie: user.cookie });
    assert.deepEqual(both.json.devices.map((d) => d.client).sort(), ["app", "web"]);
  });

  it("sends sign-ins back only to this site or an allowed app", async () => {
    process.env.APP_ORIGINS = APP_ORIGIN;
    const { safeNext } = await import("../src/routes/auth.js");
    assert.equal(safeNext("/settings"), "/settings");
    assert.equal(safeNext(`${APP_ORIGIN}/inbox?x=1#m/2`), `${APP_ORIGIN}/inbox?x=1#m/2`);
    for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "", null]) {
      assert.equal(safeNext(bad), null, String(bad));
    }
    const res = await app.call("GET", `/auth/complete?next=${encodeURIComponent(`${APP_ORIGIN}/`)}`);
    // No platform identity here, so it bounces to login, keeping the destination.
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.get("location")).includes(`next=${encodeURIComponent(`${APP_ORIGIN}/`)}`));
  });
});

describe("the app on Android, through Firebase", () => {
  const register = (user, body) =>
    app.call("POST", "/api/devices", { cookie: user.cookie, origin: APP_ORIGIN, body: { transport: "fcm", ...body } });
  const fcmToken = () => `fcm-${randomBytes(24).toString("base64url")}`;

  it("sends sealed messages that only the device's own key opens", async () => {
    const user = await createUser(pool);
    const key = randomBytes(32);
    const token = fcmToken();
    const res = await register(user, { token, key: key.toString("base64url"), label: "ivrit.ai · Android" });
    assert.equal(res.status, 201, res.text);
    const list = await app.call("GET", "/api/devices", { cookie: user.cookie });
    assert.deepEqual(
      list.json.devices.map((d) => [d.client, d.transport]),
      [["app", "fcm"]]
    );

    const before = fcm.received.length;
    await app.call("POST", "/api/test", { cookie: user.cookie });
    const message = await waitFor(() => fcm.received.slice(before).find((m) => m.token === token), { what: "fcm send" });
    assert.equal(message.authorization, "Bearer test-access-token");
    assert.equal(message.android.priority, "HIGH");
    assert.deepEqual(Object.keys(message.data), ["p"]);
    const payload = openFcm(message, key);
    assert.ok(payload.t && !JSON.stringify(message).includes(payload.t), "nothing readable on the way");
    assert.equal(payload.d, res.json.id);

    // The ack works exactly as from a browser, and returns the full message.
    const ack = await app.call("POST", "/api/ack", { origin: null, body: { i: payload.i, d: payload.d, k: payload.k } });
    assert.equal(ack.json.first, true);
    assert.equal(ack.json.notification.id, payload.i);
  });

  it("keeps long messages within Firebase's limit, and forgets unregistered tokens", async () => {
    const user = await createUser(pool);
    const key = randomBytes(32);
    const token = fcmToken();
    await register(user, { token, key: key.toString("base64url") });
    const source = await createSource({ ...ELIEZER, id: "long", name: "Long" });
    const minted = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "long" } });
    const linked = await app.call("POST", "/api/source/v1/links", {
      bearer: source, origin: null, body: { code: minted.json.code, subject: "long-subject" },
    });
    const before = fcm.received.length;
    await app.call("POST", "/api/source/v1/messages", {
      bearer: source, origin: null, body: { subscription_id: linked.json.subscription_id, body: "תמלול ארוך. ".repeat(800) },
    });
    const message = await waitFor(() => fcm.received.slice(before).find((m) => m.token === token), { what: "long send" });
    assert.ok(Buffer.byteLength(JSON.stringify(message.data)) <= 4096);
    assert.equal(openFcm(message, key).x, 1);

    fcm.respondWith((m) =>
      m.token === token
        ? { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } }
        : { status: 200, body: {} }
    );
    try {
      await app.call("POST", "/api/test", { cookie: user.cookie });
      await waitFor(async () => !(await pool.query("SELECT 1 FROM devices WHERE user_sub = $1", [user.sub])).rowCount, {
        what: "device pruned",
      });
    } finally {
      fcm.respondWith(() => ({ status: 200, body: {} }));
    }
  });

  it("replaces a refreshed token, and refuses malformed registrations", async () => {
    const user = await createUser(pool);
    const key = randomBytes(32).toString("base64url");
    const first = fcmToken();
    await register(user, { token: first, key });
    const second = fcmToken();
    assert.equal((await register(user, { token: second, key, old_token: first })).status, 201);
    const { rows } = await pool.query("SELECT endpoint FROM devices WHERE user_sub = $1", [user.sub]);
    assert.deepEqual(rows.map((r) => r.endpoint), [second]);

    assert.equal((await register(user, { token: fcmToken(), key: "short" })).json.error, "bad_key");
    assert.equal((await register(user, { token: "x", key })).json.error, "bad_token");
    // Web push rotation cannot touch a Firebase device.
    const rotate = await app.call("POST", "/api/devices/rotate", {
      origin: null,
      body: { old_endpoint: second, subscription: { endpoint: `https://localhost:${push.port}/push/hijack`, keys: { p256dh: "x", auth: "y" } } },
    });
    assert.notEqual(rotate.json?.rotated, true);
  });
});

describe("signing in to the app through the browser", () => {
  const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");
  async function issue(user, verifier) {
    const code = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO handoff_codes (code_hash, user_sub, challenge, expires_at) VALUES ($1, $2, $3, now() + interval '2 minutes')",
      [createHash("sha256").update(code).digest(), user.sub, challengeOf(verifier)]
    );
    return code;
  }
  const redeem = (body, cookie) => app.call("POST", "/auth/handoff", { origin: APP_ORIGIN, cookie, body });

  it("keeps the hand-off through the login bounce, for allowed apps only", async () => {
    const challenge = challengeOf(randomBytes(32).toString("base64url"));
    const ok = await app.call("GET", `/auth/complete?handoff=${encodeURIComponent(APP_HANDOFF)}&challenge=${challenge}`);
    const back = decodeURIComponent(new URL(ok.headers.get("location"), app.origin).searchParams.get("return_to"));
    assert.equal(new URL(back, app.origin).searchParams.get("handoff"), APP_HANDOFF);
    assert.equal(new URL(back, app.origin).searchParams.get("challenge"), challenge);

    const evil = await app.call("GET", `/auth/complete?handoff=${encodeURIComponent("evil.app://auth")}&challenge=${challenge}`);
    assert.ok(!decodeURIComponent(evil.headers.get("location")).includes("evil.app"));
  });

  it("signs the app in with the code and the right secret, once", async () => {
    const user = await createUser(pool, { email: "handoff@example.com" });
    const verifier = randomBytes(32).toString("base64url");

    const wrong = await issue(user, verifier);
    assert.equal((await redeem({ code: wrong, verifier: randomBytes(32).toString("base64url") })).status, 400);
    // A wrong secret spends the code.
    assert.equal((await redeem({ code: wrong, verifier })).status, 400);

    const code = await issue(user, verifier);
    const res = await redeem({ code, verifier });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get("access-control-allow-origin"), APP_ORIGIN);
    const session = /__Host-notifier_sess=([^;]+)/.exec(res.headers.get("set-cookie"))[1];
    const me = await app.call("GET", "/api/me", { cookie: session });
    assert.equal(me.json.sub, user.sub);
    assert.equal((await redeem({ code, verifier })).status, 400);
  });

  it("turns the app's anonymous account into the signed-in one", async () => {
    const user = await createUser(pool, { email: "upgrade@example.com" });
    const anon = await createUser(pool, { kind: "anonymous" });
    const device = await createDevice(pool, anon.sub, push);
    const verifier = randomBytes(32).toString("base64url");
    const res = await redeem({ code: await issue(user, verifier), verifier }, anon.cookie);
    assert.equal(res.json.upgraded, true);
    const { rows } = await pool.query("SELECT user_sub FROM devices WHERE id = $1", [device.id]);
    assert.equal(rows[0].user_sub, user.sub);
  });

  it("refuses redemption from other sites", async () => {
    const res = await app.call("POST", "/auth/handoff", { origin: "https://evil.example", body: { code: "x", verifier: "y".repeat(43) } });
    assert.equal(res.status, 403);
  });
});

describe("the app signed in with Google itself", () => {
  const googleStandIn = { token: (opts) => google.token(opts) };
  const bearer = (opts) => ({ authorization: `Bearer ${google.token({ aud: GOOGLE_CLIENT, ...opts })}` });
  const as = (method, path, headers, body) =>
    fetch(app.origin + path, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));

  it("signs in a new Google account with its token alone, no cookie and no origin", async () => {
    const res = await as("GET", "/api/me", bearer({ sub: "google-new-1", email: "new1@example.com", name: "New One" }));
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, "google");
    assert.equal(res.json.email, "new1@example.com");
    const device = await as("POST", "/api/devices", bearer({ sub: "google-new-1", email: "new1@example.com" }), {
      transport: "fcm", token: `fcm-${randomBytes(24).toString("base64url")}`, key: randomBytes(32).toString("base64url"),
    });
    assert.equal(device.status, 201, JSON.stringify(device.json));
  });

  it("finds the account this site's login made, by its verified email", async () => {
    const existing = await createUser(pool, { email: "Mixed.Case@example.com" });
    const res = await as("GET", "/api/me", bearer({ sub: "google-other-id", email: "mixed.case@example.com" }));
    assert.equal(res.json.sub, existing.sub);
    const { rows } = await pool.query("SELECT google_sub FROM users WHERE sub = $1", [existing.sub]);
    assert.equal(rows[0].google_sub, "google-other-id");
    // From then on by its Google id, whatever the address.
    const again = await as("GET", "/api/me", bearer({ sub: "google-other-id", email: "renamed@example.com" }));
    assert.equal(again.json.sub, existing.sub);
  });

  it("refuses tokens it should not trust", async () => {
    const forged = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    for (const [what, opts] of [
      ["another app's", { aud: "someone-else" }],
      ["another issuer's", { iss: "https://evil.example" }],
      ["an expired", { ttl: -600 }],
      ["an unverified email's", { verified: false }],
      ["a forged", { key: forged }],
    ]) {
      const res = await as("GET", "/api/me", bearer({ sub: "google-x", email: "x@example.com", ...opts }));
      assert.equal(res.status, 401, what);
    }
  });

  it("lets the app link a source and run a test, from its own origin", async () => {
    const headers = { ...bearer({ sub: "google-linker", email: "linker@example.com" }), origin: APP_ORIGIN };
    await createSource({ ...ELIEZER, id: "bearer-src", name: "Bearer" });
    const minted = await as("POST", "/api/links", headers, { source_id: "bearer-src" });
    assert.equal(minted.status, 201, JSON.stringify(minted.json));
    assert.equal(minted.headers.get("access-control-allow-origin"), APP_ORIGIN);
    const pre = await fetch(`${app.origin}/api/links`, {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  });

  it("accepts the app's own session for the same account, and not one meant for others", async () => {
    const google = await as("GET", "/api/me", bearer({ sub: "google-session", email: "session@example.com" }));
    const session = (opts) => ({ authorization: `Bearer ${googleStandIn.token({ iss: APP_ORIGIN, aud: "ivrit-app", sub: "google-session", email: "session@example.com", ...opts })}` });
    const viaSession = await as("GET", "/api/me", session({}));
    assert.equal(viaSession.status, 200);
    assert.equal(viaSession.json.sub, google.json.sub);
    assert.equal((await as("GET", "/api/me", session({ aud: "someone-else" }))).status, 401);
    assert.equal((await as("GET", "/api/me", session({ ttl: -600 }))).status, 401);
    assert.equal((await as("GET", "/api/me", session({ iss: "https://evil.example" }))).status, 401);
  });

  it("deletes the account, and the token no longer finds it", async () => {
    const headers = bearer({ sub: "google-leaver", email: "leaver@example.com" });
    const me = await as("GET", "/api/me", headers);
    assert.equal((await as("DELETE", "/api/me", headers)).status, 200);
    const { rowCount } = await pool.query("SELECT 1 FROM users WHERE sub = $1", [me.json.sub]);
    assert.equal(rowCount, 0);
  });
});

describe("test notification", () => {
  it("can be delayed, so the user can leave the app first, and the delay is capped", async () => {
    const user = await createUser(pool);
    await createDevice(pool, user.sub, push);
    const delayed = await app.call("POST", "/api/test", { cookie: user.cookie, body: { delay_seconds: 10 } });
    assert.equal(delayed.status, 202);
    assert.deepEqual(delayed.json, { devices: 1, delay_seconds: 10 });
    const { rows } = await pool.query(
      `SELECT d.next_attempt_at > now() + interval '5 seconds' AS later
         FROM deliveries d JOIN devices v ON v.id = d.device_id
        WHERE v.user_sub = $1`,
      [user.sub]
    );
    assert.equal(rows[0].later, true);
    const capped = await app.call("POST", "/api/test", { cookie: user.cookie, body: { delay_seconds: 999 } });
    assert.equal(capped.json.delay_seconds, 30);
    const now = await app.call("POST", "/api/test", { cookie: user.cookie });
    assert.equal(now.json.delay_seconds, 0);
  });
});

describe("link code stats", () => {
  it("counts how each code ended, for the admin page", async () => {
    const key = await createSource({ ...ELIEZER, id: "counted", name: "Counted" });
    const mint = (user) => app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "counted" } });
    const redeem = (code, subject) =>
      app.call("POST", "/api/source/v1/links", { bearer: key, origin: null, body: { code, subject } });

    // Replaced by a newer code, which is then linked.
    const a = await createUser(pool);
    await mint(a);
    const linked = await mint(a);
    assert.equal((await redeem(linked.json.code, "a")).status, 201);
    // Sent after it expired.
    const b = await createUser(pool);
    const late = await mint(b);
    await pool.query("UPDATE link_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [late.json.link_id]);
    assert.equal((await redeem(late.json.code, "b")).status, 410);
    assert.equal((await redeem(late.json.code, "b")).status, 410); // counted once
    // Never sent at all; counted when the sweep deletes it.
    const c = await createUser(pool);
    const idle = await mint(c);
    await pool.query("UPDATE link_codes SET expires_at = now() - interval '2 hours' WHERE id = $1", [idle.json.link_id]);
    await sweep(pool);

    const res = await app.call("GET", "/api/admin/sources", { cookie: admin.cookie });
    const stats = res.json.sources.find((s) => s.id === "counted").link_stats;
    assert.deepEqual(
      { ...stats, since: undefined },
      { since: undefined, created: 4, linked: 1, tried_expired: 1, unused: 1, replaced: 1 }
    );
    assert.ok(stats.since);
  });

  it("counts linked users by the platform of their devices", async () => {
    const key = await createSource({ ...ELIEZER, id: "platforms", name: "Platforms" });
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
    const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
    const link = async (subject, ...agents) => {
      const user = await createUser(pool);
      for (const userAgent of agents) await createDevice(pool, user.sub, push, { userAgent });
      const minted = await app.call("POST", "/api/links", { cookie: user.cookie, body: { source_id: "platforms" } });
      const redeemed = await app.call("POST", "/api/source/v1/links", {
        bearer: key, origin: null, body: { code: minted.json.code, subject },
      });
      assert.equal(redeemed.status, 201);
      return redeemed.json.subscription_id;
    };

    await link("phone", IPHONE, IPHONE); // two iPhones, one user
    await link("both", IPHONE, MAC);
    await link("android", ANDROID);
    await link("bare");
    const gone = await link("gone", ANDROID);
    await app.call("DELETE", `/api/source/v1/subscriptions/${gone}`, { bearer: key, origin: null });

    const res = await app.call("GET", "/api/admin/sources", { cookie: admin.cookie });
    assert.deepEqual(res.json.sources.find((s) => s.id === "platforms").platforms, {
      iphone: 2, android: 1, other: 1, none: 1, app: 0,
    });
  });
});

describe("retention", () => {
  it("drops partitions older than three days and keeps the rest", async () => {
    const client = await pool.connect();
    try {
      const now = new Date();
      await ensurePartitions(client, new Date(now.getTime() - 6 * 86_400_000));
      const dropped = await dropExpiredPartitions(client, now);
      const day = (n) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "_");
      assert.ok(dropped.includes(`notifications_${day(4)}`));
      assert.ok(!dropped.includes(`notifications_${day(3)}`));
      assert.ok(!dropped.some((name) => name.endsWith(day(0))));
    } finally {
      client.release();
    }
  });
});

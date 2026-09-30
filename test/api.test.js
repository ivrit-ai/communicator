import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL,
  createDevice,
  createUser,
  decrypt,
  freshDatabase,
  startApp,
  startPushService,
  waitFor,
} from "./harness.js";
import { adoptAnonymous } from "../src/accounts.js";
import { dropExpiredPartitions, ensurePartitions } from "../src/migrate.js";

let pool;
let push;
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
  app = await startApp();
  admin = await createUser(pool, { email: ADMIN_EMAIL });
});

after(async () => {
  await app?.stop();
  await push?.close();
  await pool?.end();
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

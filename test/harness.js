// Shared scaffolding for the integration tests: a scratch database, the real
// server as a child process, and a local HTTPS push service that records (and
// can decrypt) what the sender delivers.
import { spawn, execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import webpush from "web-push";

const require = createRequire(import.meta.url);
const ece = require("http_ece");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:dev@127.0.0.1:55439/notifier_test";

export const ADMIN_EMAIL = "admin@example.com";

export async function freshDatabase() {
  const url = new URL(BASE_URL);
  const name = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(BASE_URL), { pathname: "/postgres" }).href });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: BASE_URL, max: 4 });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  return pool;
}

export async function startPushService() {
  const dir = mkdtempSync(path.join(tmpdir(), "notifier-push-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const received = [];
  let respond = () => 201;
  const server = https.createServer(
    { key: readFileSync(path.join(dir, "key.pem")), cert: readFileSync(path.join(dir, "cert.pem")) },
    (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const push = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        received.push(push);
        res.statusCode = respond(push);
        res.end();
      });
    }
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    received,
    respondWith(fn) {
      respond = fn;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function startApp(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      XHOST_HTTP_PORT: String(port),
      DATABASE_URL: BASE_URL,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
      ACK_SECRET: "test-ack-secret",
      EXPECTED_HOSTS: "localhost",
      ADMIN_EMAILS: ADMIN_EMAIL,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const started = Date.now();
  while (!logs.join("").includes('"msg":"ready"')) {
    if (child.exitCode !== null || Date.now() - started > 20_000) {
      throw new Error(`server did not start:\n${logs.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const origin = `http://localhost:${port}`;

  async function call(method, pathname, { body, cookie, bearer, origin: sendOrigin = origin, raw, type } = {}) {
    const headers = {};
    if (cookie) headers.cookie = `__Host-notifier_sess=${cookie}`;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (sendOrigin) headers.origin = sendOrigin;
    let payload;
    if (raw) {
      headers["content-type"] = type;
      payload = raw;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(origin + pathname, { method, headers, body: payload, redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, json, text };
  }

  return {
    origin,
    logs,
    call,
    stop: () =>
      new Promise((r) => {
        child.once("exit", r);
        child.kill("SIGTERM");
      }),
  };
}

// A user and a live session, created directly: the Google sign-in itself
// runs through the xhost platform and cannot be exercised locally.
export async function createUser(pool, { sub, email = null, kind = "google", locale = null } = {}) {
  sub ??= `${kind === "anonymous" ? "anon:" : "g-"}${randomBytes(6).toString("hex")}`;
  await pool.query(
    "INSERT INTO users (sub, email, kind, locale) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [sub, email, kind, locale]
  );
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO sessions (token_hash, user_sub, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [createHash("sha256").update(token).digest(), sub]
  );
  return { sub, cookie: token };
}

// A device whose push endpoint is the local push service, with real keys so
// its pushes can be decrypted.
export async function createDevice(pool, userSub, push) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  const endpoint = `https://localhost:${push.port}/push/${randomBytes(6).toString("hex")}`;
  const { rows } = await pool.query(
    `INSERT INTO devices (user_sub, endpoint_hash, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userSub, createHash("sha256").update(endpoint).digest(), endpoint, ecdh.getPublicKey("base64url"), auth]
  );
  return { id: String(rows[0].id), endpoint, ecdh, auth };
}

export function decrypt(push, device) {
  const plain = ece.decrypt(push.body, { version: "aes128gcm", privateKey: device.ecdh, authSecret: device.auth });
  return JSON.parse(plain.toString());
}

export async function waitFor(check, { timeout = 10_000, what = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPool } from "./src/db.js";
import { migrate } from "./src/migrate.js";
import { authRoutes } from "./src/routes/auth.js";
import { tokenRoutes } from "./src/routes/tokens.js";
import { deviceRoutes } from "./src/routes/devices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// --- env validation: fail fast and loud, never fall back to a default ---
function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`FATAL: ${key} is not set`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(requireEnv("XHOST_HTTP_PORT"));

// Container disk does not survive a redeploy, so these can never be generated
// at boot with a fallback: new keys would silently invalidate every existing
// push subscription, with no recovery short of asking every user to
// re-subscribe. Absent config must be a hard failure, not a regenerated key.
const VAPID_PUBLIC_KEY = requireEnv("VAPID_PUBLIC_KEY");
requireEnv("VAPID_PRIVATE_KEY");
requireEnv("VAPID_SUBJECT");
requireEnv("ACK_SECRET");
requireEnv("EXPECTED_HOSTS");

// Flipped once migrations have run. /api/* refuses to serve until then, so a
// slow migration degrades to a clear 503 instead of a failed health check.
let ready = false;

const pool = createPool("web");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// The service worker must never be cached, or a stale one keeps running
// indefinitely and users stop receiving pushes after a bad deploy.
app.use((req, res, next) => {
  if (req.path === "/sw.js") res.setHeader("Cache-Control", "no-cache");
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    index: ["index.html"],
    maxAge: "1h",
  })
);

// Everything that can touch Postgres sits behind this. GET / deliberately does
// not, so a database blip never fails the health probe.
app.use(["/api", "/auth"], (req, res, next) => {
  if (!ready) return res.status(503).json({ status: "starting" });
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/api/config", (req, res) => {
  res.json({ vapidPublicKey: VAPID_PUBLIC_KEY });
});

app.use(express.json({ limit: "16kb" }));
app.use(authRoutes(pool));
app.use(tokenRoutes(pool));
app.use(deviceRoutes(pool));

app.use((err, req, res, next) => {
  console.error(JSON.stringify({ msg: "unhandled", path: req.path, err: String(err) }));
  res.status(500).json({ error: "internal" });
});

// Bind BEFORE touching Postgres. The platform probes GET / within 120s of
// boot; putting migrations ahead of listen() would put their duration on the
// health-check critical path and risk a restart loop we cannot shell into.
const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(JSON.stringify({ msg: "listening", port: PORT }));

  try {
    await boot();
    ready = true;
    const readyFile = process.env.XHOST_READY_FILE;
    if (readyFile && !existsSync(readyFile)) writeFileSync(readyFile, "");
    console.log(JSON.stringify({ msg: "ready" }));
  } catch (err) {
    console.error(JSON.stringify({ msg: "boot_failed", err: String(err) }));
    process.exit(1);
  }
});

async function boot() {
  await migrate(pool);
  probeEgress();
}

// Every delivery depends on reaching the push services, and a network policy
// that blocks them would otherwise only surface as failed sends much later.
// Logged, never awaited: this must not gate readiness.
function probeEgress() {
  const hosts = [
    "https://fcm.googleapis.com",
    "https://updates.push.services.mozilla.com",
    "https://web.push.apple.com",
  ];
  for (const url of hosts) {
    const started = Date.now();
    fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) })
      .then((r) =>
        console.log(
          JSON.stringify({
            msg: "egress_ok",
            url,
            status: r.status,
            ms: Date.now() - started,
          })
        )
      )
      .catch((err) =>
        console.error(
          JSON.stringify({ msg: "egress_FAIL", url, err: String(err) })
        )
      );
  }
}

function shutdown(signal) {
  console.log(JSON.stringify({ msg: "shutdown", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

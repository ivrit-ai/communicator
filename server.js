import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

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

// Flipped once migrations have run. /api/* refuses to serve until then, so a
// slow migration degrades to a clear 503 instead of a failed health check.
let ready = false;

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

app.use("/api", (req, res, next) => {
  if (!ready) return res.status(503).json({ status: "starting" });
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
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
  // Migrations, sender fork and maintenance loops land here.
}

function shutdown(signal) {
  console.log(JSON.stringify({ msg: "shutdown", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

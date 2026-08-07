import https from "node:https";
import webpush from "web-push";
import { createPool } from "./db.js";
import { signAck } from "./ack.js";

const CONCURRENCY = Number(process.env.SENDER_CONCURRENCY ?? 32);
const LEASE = "60 seconds";
const IDLE_POLL_MS = 1000;
const MAX_ATTEMPTS = 6;
const TTL_SECONDS = 604800; // 7 days, matching history retention

// Push services reject anything over ~4KB of ciphertext. Trimming here turns a
// wasted round trip plus a 413 into a notification that simply arrives.
const MAX_PAYLOAD_BYTES = 3800;

// One socket pool for all sends. Without keep-alive every notification pays a
// fresh TLS handshake to the same handful of hosts.
const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

const pool = createPool("sender");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const log = (o) => console.log(JSON.stringify(o));
const logErr = (o) => console.error(JSON.stringify(o));

// --- per-origin circuit breaker -------------------------------------------
// One push service degrading must not consume every slot in the batch and
// starve the others.
const BREAKER_THRESHOLD = 20;
const BREAKER_COOLDOWN_MS = 30_000;
const breakers = new Map();

function breakerFor(origin) {
  let b = breakers.get(origin);
  if (!b) {
    b = { failures: 0, openUntil: 0 };
    breakers.set(origin, b);
  }
  return b;
}

function breakerOpen(origin) {
  return breakerFor(origin).openUntil > Date.now();
}

function recordFailure(origin, retryAfterMs) {
  const b = breakerFor(origin);
  b.failures += 1;
  if (retryAfterMs || b.failures >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + (retryAfterMs || BREAKER_COOLDOWN_MS);
    b.failures = 0;
    logErr({ msg: "breaker_open", origin, until_ms: b.openUntil - Date.now() });
  }
}

function recordSuccess(origin) {
  const b = breakerFor(origin);
  b.failures = 0;
  b.openUntil = 0;
}

// --- claiming --------------------------------------------------------------
// FOR UPDATE SKIP LOCKED plus a lease means a killed sender loses nothing: its
// rows simply become claimable again once the lease expires. That is also why
// adding a second sender process needs no schema or logic change.
async function claim(limit) {
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT created_at, notification_id, device_id
         FROM deliveries
        WHERE state = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), leased AS (
       UPDATE deliveries d
          SET next_attempt_at = now() + $2::interval,
              attempts = d.attempts + 1
         FROM candidate c
        WHERE d.created_at = c.created_at
          AND d.notification_id = c.notification_id
          AND d.device_id = c.device_id
       RETURNING d.created_at, d.notification_id, d.device_id, d.attempts, d.last_status
     )
     SELECT l.created_at, l.notification_id, l.device_id, l.attempts, l.last_status,
            n.source, n.title, n.body, n.url,
            dev.endpoint, dev.p256dh, dev.auth
       FROM leased l
       JOIN notifications n
         ON n.created_at = l.created_at AND n.id = l.notification_id
       LEFT JOIN devices dev ON dev.id = l.device_id`,
    [limit, LEASE]
  );
  return rows;
}

function keyOf(row) {
  return [row.created_at, row.notification_id, row.device_id];
}

async function markSent(row, status) {
  await pool.query(
    `UPDATE deliveries SET state = 'sent', last_status = $4, last_error = NULL
      WHERE created_at = $1 AND notification_id = $2 AND device_id = $3`,
    [...keyOf(row), status]
  );
  // Throttled to once a day: this exists so the idle-device reaper can tell a
  // live endpoint from an abandoned one, not to keep a precise timestamp, and
  // an extra write per delivery is pure amplification on the hot path.
  await pool.query(
    `UPDATE devices SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '1 day'`,
    [row.device_id]
  );
}

async function markFailed(row, status, error) {
  await pool.query(
    `UPDATE deliveries SET state = 'failed', last_status = $4, last_error = $5
      WHERE created_at = $1 AND notification_id = $2 AND device_id = $3`,
    [...keyOf(row), status ?? null, error?.slice(0, 500) ?? null]
  );
}

async function retryLater(row, status, error, delayMs) {
  const backoff = delayMs ?? Math.min(5000 * 2 ** row.attempts, 3_600_000);
  await pool.query(
    `UPDATE deliveries
        SET next_attempt_at = now() + make_interval(secs => $4),
            last_status = $5, last_error = $6
      WHERE created_at = $1 AND notification_id = $2 AND device_id = $3`,
    [...keyOf(row), backoff / 1000, status ?? null, error?.slice(0, 500) ?? null]
  );
}

// --- payload ---------------------------------------------------------------
// Single-character keys: the envelope would otherwise burn ~60 bytes of a
// genuinely tight budget. Full content travels inside the encrypted push rather
// than a tickle-and-fetch, because a fetch from the service worker would carry
// a possibly-expired cookie and degrade to a useless placeholder.
function buildPayload(row, { stub = false } = {}) {
  const payload = {
    i: row.notification_id,
    d: String(row.device_id),
    k: signAck(row.notification_id, row.device_id),
    s: row.source,
    t: row.title,
    ts: new Date(row.created_at).getTime(),
  };
  if (!stub) {
    if (row.body) payload.b = row.body;
    if (row.url) payload.u = row.url;
  }

  let encoded = JSON.stringify(payload);
  if (!stub && Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    const over = Buffer.byteLength(encoded) - MAX_PAYLOAD_BYTES;
    payload.b = Buffer.from(payload.b ?? "")
      .subarray(0, Math.max(0, Buffer.byteLength(payload.b ?? "") - over - 3))
      .toString()
      .concat("…");
    encoded = JSON.stringify(payload);
  }
  return encoded;
}

async function deleteDevice(deviceId) {
  await pool.query("DELETE FROM devices WHERE id = $1", [deviceId]);
}

function retryAfterMs(headers) {
  const value = headers?.["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds, 3600) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function send(row) {
  // The device row was deleted while this delivery was queued. Nothing to do,
  // and leaving it pending would retry forever against a missing subscription.
  if (!row.endpoint) {
    await markFailed(row, null, "device_removed");
    return;
  }

  const origin = new URL(row.endpoint).origin;
  if (breakerOpen(origin)) {
    await retryLater(row, row.last_status, "breaker_open", BREAKER_COOLDOWN_MS);
    return;
  }

  // A previous attempt was rejected as too large, so drop to a stub rather than
  // dropping the notification entirely.
  const stub = row.last_status === 413;
  const payload = buildPayload(row, { stub });

  try {
    const res = await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      payload,
      { TTL: TTL_SECONDS, agent }
    );
    recordSuccess(origin);
    // 201 means the push service accepted it — not that the device received it.
    // Only an ACK from the service worker proves delivery.
    await markSent(row, res.statusCode);
  } catch (err) {
    const status = err.statusCode;
    const headers = err.headers;

    if (status === 404 || status === 410) {
      // The endpoint is permanently gone. Pruning here is what keeps fanout
      // proportional to live devices rather than to everyone who ever visited.
      recordSuccess(origin);
      await deleteDevice(row.device_id);
      await markFailed(row, status, "endpoint_gone");
      return;
    }

    if (status === 413) {
      if (stub) {
        await markFailed(row, status, "payload_too_large_even_as_stub");
      } else {
        await retryLater(row, status, "payload_too_large", 0);
      }
      return;
    }

    if (status === 403) {
      // Almost certainly a VAPID key mismatch, which means every send is
      // failing, not just this one. Retrying quietly would hide an outage.
      logErr({ msg: "vapid_FAIL_403", origin, err: String(err.body ?? err) });
      await retryLater(row, status, "vapid_mismatch");
      return;
    }

    if (status === 429) {
      recordFailure(origin, retryAfterMs(headers) ?? BREAKER_COOLDOWN_MS);
      await retryLater(row, status, "rate_limited", retryAfterMs(headers));
      return;
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await markFailed(row, status, String(err.body ?? err));
      return;
    }

    if (status >= 500 || status === undefined) recordFailure(origin);
    await retryLater(row, status, String(err.body ?? err));
  }
}

async function runBatch(rows) {
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        await send(row);
      } catch (err) {
        logErr({ msg: "send_crashed", id: row.notification_id, err: String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
}

let running = true;

async function loop() {
  while (running) {
    try {
      const rows = await claim(CONCURRENCY);
      if (!rows.length) {
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
        continue;
      }
      const started = Date.now();
      await runBatch(rows);
      log({ msg: "batch", n: rows.length, ms: Date.now() - started });
    } catch (err) {
      logErr({ msg: "sender_loop_error", err: String(err) });
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
  }
}

function shutdown() {
  running = false;
  // In-flight sends are not awaited: whatever does not finish keeps its lease
  // and is reclaimed by the next container, which is exactly the durability
  // guarantee the outbox exists to provide.
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log({ msg: "sender_started", concurrency: CONCURRENCY });
loop();

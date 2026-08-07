import { dropExpiredPartitions, ensurePartitions } from "./migrate.js";

const INTERVAL_MS = 60 * 60 * 1000;

// A device that has neither received a push nor had the app opened for this
// long is dead in every sense that matters. The common case — an endpoint the
// push service has retired — is already handled sooner by 404/410 pruning.
const DEVICE_IDLE_DAYS = 180;

// Old and new containers overlap during a deploy, and both would otherwise
// race on the same DDL. Whoever loses the lock simply skips this round.
const LOCK_ID = 9138;

async function sweep(pool) {
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
    if (!lock[0].ok) return null;

    try {
      const created = await ensurePartitions(client);
      const dropped = await dropExpiredPartitions(client);
      const dedupe = await client.query("DELETE FROM dedupe WHERE expires_at < now()");
      const sessions = await client.query("DELETE FROM sessions WHERE expires_at < now()");
      const devices = await client.query(
        `DELETE FROM devices WHERE last_seen_at < now() - make_interval(days => $1)`,
        [DEVICE_IDLE_DAYS]
      );
      return {
        partitions_created: created.length,
        partitions_dropped: dropped.length,
        dedupe_pruned: dedupe.rowCount,
        sessions_pruned: sessions.rowCount,
        devices_reaped: devices.rowCount,
      };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

// Lives in the web process rather than the sender: the sender is the hot path
// and a DROP TABLE taking an ACCESS EXCLUSIVE lock has no business sharing a
// process with the delivery loop.
export function startMaintenance(pool) {
  const run = async () => {
    const started = Date.now();
    try {
      const result = await sweep(pool);
      if (result) console.log(JSON.stringify({ msg: "maintenance", ms: Date.now() - started, ...result }));
    } catch (err) {
      // Never fatal. Partitions are created a week ahead precisely so that a
      // few failed sweeps degrade slowly instead of breaking ingest.
      console.error(JSON.stringify({ msg: "maintenance_failed", err: String(err) }));
    }
  };

  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

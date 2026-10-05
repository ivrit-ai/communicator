// The server is a relay, not an archive: each device keeps its own copy of what
// it received, and the server holds messages only long enough for a device that
// was offline for a weekend to catch up.
export const RETENTION_DAYS = 3;

// Partitions are created well ahead of time on purpose. An insert whose
// created_at falls outside every partition fails outright, so the lead time is
// the buffer against maintenance being down for a few days.
const PARTITION_LEAD_DAYS = 7;

const PARTITIONED = ["notifications", "deliveries"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  sub          text PRIMARY KEY,
  email        text NOT NULL,
  name         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   bytea PRIMARY KEY,
  user_sub     text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_sub);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ingest_tokens (
  token_id     text PRIMARY KEY,
  secret_hash  bytea NOT NULL,
  user_sub     text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS ingest_tokens_user_idx
  ON ingest_tokens (user_sub) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS devices (
  id            bigserial PRIMARY KEY,
  user_sub      text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  endpoint_hash bytea NOT NULL UNIQUE,
  endpoint      text NOT NULL,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  label         text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_sub);

CREATE TABLE IF NOT EXISTS notifications (
  created_at timestamptz NOT NULL,
  id         text NOT NULL,
  user_sub   text NOT NULL,
  source     text NOT NULL,
  title      text NOT NULL,
  body       text,
  url        text,
  read_at    timestamptz,
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (user_sub, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  created_at      timestamptz NOT NULL,
  notification_id text NOT NULL,
  device_id       bigint NOT NULL,
  state           text NOT NULL DEFAULT 'pending',
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     int,
  last_error      text,
  acked_at        timestamptz,
  PRIMARY KEY (created_at, notification_id, device_id)
) PARTITION BY RANGE (created_at);
-- Partial on purpose: the queue index stays proportional to outstanding work,
-- not to the days of delivery history sitting in the same table.
CREATE INDEX IF NOT EXISTS deliveries_queue_idx
  ON deliveries (next_attempt_at) WHERE state = 'pending';

-- Dedupe cannot live as a unique index on notifications: a unique index on a
-- partitioned table must contain the partition key, and including created_at
-- would make every retry unique, defeating the point. Hence a small side table
-- with a real global unique key and its own short window.
CREATE TABLE IF NOT EXISTS dedupe (
  user_sub                text NOT NULL,
  dedupe_key              text NOT NULL,
  notification_id         text NOT NULL,
  notification_created_at timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  PRIMARY KEY (user_sub, dedupe_key)
);
CREATE INDEX IF NOT EXISTS dedupe_expiry_idx ON dedupe (expires_at);

-- Anonymous accounts have no email; kind tells them apart from Google ones.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'google';
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text;

-- Services (Eliezer, ...) that deliver to many users. Registered by an admin;
-- they authenticate with a key whose hash lives here, and reach a user only
-- through a subscription the user created by handing them a link code.
CREATE TABLE IF NOT EXISTS sources (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  name_he         text,
  description     text,
  description_he  text,
  accent          text,
  icon_png        bytea,
  icon_etag       text,
  link_methods    jsonb NOT NULL DEFAULT '[]',
  key_hash        bytea NOT NULL,
  key_prefix      text NOT NULL,
  rate_per_minute int NOT NULL DEFAULT 600,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- subject_hash is the source's own stable id for whoever redeemed the code
-- (hashed, so a phone number never lands here). It makes redeeming idempotent
-- for the same subject, and keeps a relink from minting a second, duplicate
-- subscription.
CREATE TABLE IF NOT EXISTS subscriptions (
  id              text PRIMARY KEY,
  user_sub        text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  source_id       text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  subject_hash    bytea NOT NULL,
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx
  ON subscriptions (user_sub) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_subject_idx
  ON subscriptions (user_sub, source_id, subject_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS link_codes (
  id              text PRIMARY KEY,
  code_hash       bytea NOT NULL UNIQUE,
  user_sub        text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  source_id       text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  state           text NOT NULL DEFAULT 'pending',
  subscription_id text
);
CREATE INDEX IF NOT EXISTS link_codes_user_idx ON link_codes (user_sub, source_id);
CREATE INDEX IF NOT EXISTS link_codes_expiry_idx ON link_codes (expires_at);

-- Which app a device belongs to: Communicator's website ("web") or the
-- ivrit.ai app ("app"), which registers devices through the same API.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'web';

-- How link codes end, per source and day, for the admin page. The codes
-- themselves are deleted an hour after expiring; these counts are what is left.
CREATE TABLE IF NOT EXISTS link_code_stats (
  source_id     text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  day           date NOT NULL,
  created       int NOT NULL DEFAULT 0,
  linked        int NOT NULL DEFAULT 0,
  tried_expired int NOT NULL DEFAULT 0,
  unused        int NOT NULL DEFAULT 0,
  replaced      int NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, day)
);

-- Messages from a source carry which one, so the app can show its logo and
-- name even after the source is renamed.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subtitle text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS lang text;
`;

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function partitionName(table, d) {
  return `${table}_${dayKey(d).replace(/-/g, "_")}`;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function utcMidnight(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function ensurePartitions(client, now = new Date()) {
  const today = utcMidnight(now);
  const created = [];
  for (const table of PARTITIONED) {
    for (let i = -RETENTION_DAYS; i <= PARTITION_LEAD_DAYS; i++) {
      const from = addDays(today, i);
      const to = addDays(from, 1);
      const name = partitionName(table, from);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table}
         FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`
      );
      created.push(name);
    }
  }
  return created;
}

export async function dropExpiredPartitions(client, now = new Date()) {
  const cutoff = addDays(utcMidnight(now), -RETENTION_DAYS);
  const dropped = [];

  // Read the catalog rather than assuming which partitions exist. If the app
  // were down for a month, computing expected names would silently leave the
  // older ones behind forever.
  const { rows } = await client.query(
    `SELECT p.relname AS parent, c.relname AS child
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ANY($1)`,
    [PARTITIONED]
  );

  for (const { parent, child } of rows) {
    const m = child.match(/_(\d{4})_(\d{2})_(\d{2})$/);
    if (!m) continue;
    const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (day >= cutoff) continue;
    // Dropping a partition takes an ACCESS EXCLUSIVE lock. Bounding the wait
    // means a long-running read delays cleanup instead of stalling the app.
    await client.query("SET LOCAL lock_timeout = '5s'");
    try {
      await client.query(`DROP TABLE IF EXISTS ${child}`);
      dropped.push(child);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: "partition_drop_failed", parent, child, err: String(err) })
      );
    }
  }
  return dropped;
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    // Old and new containers overlap during a deploy. Without this lock both
    // run the DDL concurrently and one loses to a duplicate-object error.
    const started = Date.now();
    for (;;) {
      const { rows } = await client.query("SELECT pg_try_advisory_lock(9137) AS ok");
      if (rows[0].ok) break;
      if (Date.now() - started > 60_000) {
        throw new Error("timed out waiting for migration advisory lock");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    try {
      await client.query(SCHEMA);
      const created = await ensurePartitions(client);
      console.log(JSON.stringify({ msg: "migrated", partitions: created.length }));
    } finally {
      await client.query("SELECT pg_advisory_unlock(9137)");
    }
  } finally {
    client.release();
  }
}

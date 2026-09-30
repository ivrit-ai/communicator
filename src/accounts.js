import { ulid } from "ulid";

// Everything a user owns, by table. Notifications have no foreign key (they
// live in partitions that are dropped wholesale), so they are listed here
// rather than left to a cascade.
const OWNED = ["devices", "ingest_tokens", "subscriptions", "link_codes", "notifications"];

export async function createAnonymousUser(client, locale) {
  const sub = `anon:${ulid()}`;
  await client.query(
    "INSERT INTO users (sub, email, name, kind, locale) VALUES ($1, NULL, NULL, 'anonymous', $2)",
    [sub, locale]
  );
  return sub;
}

// Signing in with Google from an anonymous session keeps everything the
// anonymous account had: its links keep delivering, its devices stay
// registered, and nothing has to be set up twice. Runs inside the caller's
// transaction.
export async function adoptAnonymous(client, anonSub, googleSub) {
  for (const table of OWNED) {
    await client.query(`UPDATE ${table} SET user_sub = $2 WHERE user_sub = $1`, [anonSub, googleSub]);
  }
  // Two accounts may each hold a live subscription for the same subject at the
  // same source. Keep the older one; the source would otherwise deliver twice.
  await client.query(
    `UPDATE subscriptions s SET revoked_at = now()
      WHERE s.user_sub = $1 AND s.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM subscriptions o
                     WHERE o.user_sub = s.user_sub AND o.source_id = s.source_id
                       AND o.subject_hash = s.subject_hash AND o.revoked_at IS NULL
                       AND (o.created_at, o.id) < (s.created_at, s.id))`,
    [googleSub]
  );
  // Dedupe keys are per user and short-lived; merging them could collide on
  // the primary key for no benefit.
  await client.query("DELETE FROM dedupe WHERE user_sub = $1", [anonSub]);
  await client.query(
    "UPDATE users SET locale = COALESCE(users.locale, a.locale) FROM users a WHERE users.sub = $2 AND a.sub = $1",
    [anonSub, googleSub]
  );
  await client.query("DELETE FROM users WHERE sub = $1", [anonSub]);
}

export async function deleteAccount(client, sub) {
  // Pending deliveries would otherwise be leased and re-leased until their
  // partition is dropped, since their notification and device are gone.
  await client.query(
    `DELETE FROM deliveries WHERE state = 'pending'
        AND device_id IN (SELECT id FROM devices WHERE user_sub = $1)`,
    [sub]
  );
  await client.query("DELETE FROM notifications WHERE user_sub = $1", [sub]);
  await client.query("DELETE FROM dedupe WHERE user_sub = $1", [sub]);
  // Cascades to sessions, devices, tokens, subscriptions and link codes.
  await client.query("DELETE FROM users WHERE sub = $1", [sub]);
}

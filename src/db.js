import pg from "pg";

const { Pool } = pg;

// notifications.created_at drives partition pruning, so the driver must hand
// back real Date objects rather than the strings it defaults to for some
// timestamp OIDs. 1114 = timestamp without time zone.
pg.types.setTypeParser(1114, (v) => new Date(v + "Z"));

// Postgres max_connections for a channel database is not documented, so the
// two processes split a deliberately conservative budget rather than each
// assuming it owns the server.
const POOL_SIZE = { web: 10, sender: 6 };

export function createPool(role) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("FATAL: DATABASE_URL is not set");
    process.exit(1);
  }

  const useSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(url);

  const pool = new Pool({
    connectionString: url,
    max: POOL_SIZE[role],
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  // An idle client killed by the server emits an error on the pool, not on any
  // query. Without this listener node treats it as unhandled and exits.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ msg: "pg_pool_error", role, err: String(err) }));
  });

  return pool;
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

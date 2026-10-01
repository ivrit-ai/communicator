// Counts of how link codes end, per source and day: created, linked, tried
// after expiring, expired without ever being tried, replaced by a newer code
// before being used. Incremented where each happens; read by the admin page.
export const LINK_OUTCOMES = ["created", "linked", "tried_expired", "unused", "replaced"];

export async function countLinkCodes(db, sourceId, outcome, n = 1) {
  if (!LINK_OUTCOMES.includes(outcome)) throw new Error(`unknown link outcome ${outcome}`);
  if (!n) return;
  // The column name comes from the list above, never from input.
  await db.query(
    `INSERT INTO link_code_stats (source_id, day, ${outcome}) VALUES ($1, current_date, $2)
     ON CONFLICT (source_id, day) DO UPDATE
       SET ${outcome} = link_code_stats.${outcome} + EXCLUDED.${outcome}`,
    [sourceId, n]
  );
}

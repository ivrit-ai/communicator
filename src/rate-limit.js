// Per-token token bucket. This is an availability control before it is an
// anti-abuse one: every send spends from a per-project quota at FCM that all
// users share, so one chatty sender degrades delivery for everyone.
//
// The state is in memory, which is only correct while there is exactly one web
// process. Three workers would silently turn a limit of N into 3N.
const PER_MINUTE = Number(process.env.NOTIFY_RATE_PER_MINUTE ?? 120);
const REFILL_PER_MS = PER_MINUTE / 60_000;

// Burst equals one minute of budget: a CI job that fires twenty notifications
// at the end of a run should not be throttled, but a runaway loop should.
const CAPACITY = PER_MINUTE;

// Bounded so a flood of distinct tokens cannot grow the map without limit.
const MAX_BUCKETS = 20_000;

const buckets = new Map();

export function consume(key, now = Date.now()) {
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // Insertion-ordered, so the first key is the least recently created.
      // Evicting refunds its budget, which is the safe direction to err.
      buckets.delete(buckets.keys().next().value);
    }
    buckets.set(key, { tokens: CAPACITY - 1, at: now });
    return { allowed: true };
  }

  // Re-insert so the map stays ordered by recency for eviction.
  buckets.delete(key);
  buckets.set(key, bucket);

  bucket.tokens = Math.min(CAPACITY, bucket.tokens + (now - bucket.at) * REFILL_PER_MS);
  bucket.at = now;

  if (bucket.tokens < 1) {
    return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / REFILL_PER_MS / 1000) };
  }
  bucket.tokens -= 1;
  return { allowed: true };
}

export function rateLimitIngest(req, res, next) {
  const { allowed, retryAfter } = consume(req.ingest.tokenId);
  if (allowed) return next();
  res.setHeader("Retry-After", String(retryAfter));
  // 429 rather than 503: senders are told to back off and retry, and the
  // documented contract already asks them to treat non-2xx as retryable.
  res.status(429).json({ error: "rate_limited", limit_per_minute: PER_MINUTE, retry_after: retryAfter });
}

export function resetRateLimits() {
  buckets.clear();
}

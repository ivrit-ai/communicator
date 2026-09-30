// Token buckets. These are availability controls before they are anti-abuse
// ones: every send spends from a per-project quota at FCM that all users
// share, so one chatty sender degrades delivery for everyone.
//
// The state is in memory, which is only correct while there is exactly one web
// process. Three workers would silently turn a limit of N into 3N.
const PER_MINUTE = Number(process.env.NOTIFY_RATE_PER_MINUTE ?? 120);

// Burst defaults to one minute of budget: a CI job that fires twenty
// notifications at the end of a run should not be throttled, but a runaway
// loop should.
export const LIMITS = {
  ingest: { perMinute: PER_MINUTE },
  // One subscription is one person's feed from one service. Thirty a minute is
  // far beyond anything a human reads, and still shields the shared quota
  // from a source with a bug.
  subscription: { perMinute: 30 },
  // Anonymous accounts are free to create, so creating them is what gets
  // limited: five an hour per address.
  anonymous: { perMinute: 5 / 60, burst: 5 },
  // Link codes, per user: plenty for retrying, useless for grinding.
  linkCode: { perMinute: 1, burst: 10 },
};

// Bounded so a flood of distinct keys cannot grow the map without limit.
const MAX_BUCKETS = 20_000;

const buckets = new Map();

export function consume(key, limit = LIMITS.ingest, now = Date.now()) {
  const capacity = limit.burst ?? limit.perMinute;
  const refillPerMs = limit.perMinute / 60_000;
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // Insertion-ordered, so the first key is the least recently created.
      // Evicting refunds its budget, which is the safe direction to err.
      buckets.delete(buckets.keys().next().value);
    }
    buckets.set(key, { tokens: capacity - 1, at: now });
    return { allowed: true };
  }

  // Re-insert so the map stays ordered by recency for eviction.
  buckets.delete(key);
  buckets.set(key, bucket);

  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
  bucket.at = now;

  if (bucket.tokens < 1) {
    return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000) };
  }
  bucket.tokens -= 1;
  return { allowed: true };
}

export function rejectRateLimited(res, limit, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter));
  // 429 rather than 503: senders are told to back off and retry, and the
  // documented contract already asks them to treat non-2xx as retryable.
  res.status(429).json({
    error: "rate_limited",
    limit_per_minute: limit.perMinute,
    retry_after: retryAfter,
  });
}

export function rateLimitIngest(req, res, next) {
  const { allowed, retryAfter } = consume(`ingest:${req.ingest.tokenId}`, LIMITS.ingest);
  if (allowed) return next();
  rejectRateLimited(res, LIMITS.ingest, retryAfter);
}

export function resetRateLimits() {
  buckets.clear();
}

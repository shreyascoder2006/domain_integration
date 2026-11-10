// In-memory fixed-window rate limiter, keyed by client address. Enough to stop a script
// hammering domain search (which costs real registrar calls) or guessing the admin token.
// Behind several server processes each keeps its own counts: move to Redis if you scale out.

export function createRateLimiter({ windowMs, max, now = () => Date.now(), maxKeys = 10_000 }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Make room for one more key: drop expired entries, then (under attack) the oldest ones.
  function prune(t) {
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    /** Count one request. Returns { ok, retryAfterSec, remaining }. */
    take(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || h.resetAt <= t) {
        if (hits.size >= maxKeys) prune(t);
        h = { count: 0, resetAt: t + windowMs };
        hits.set(key, h);
      }
      h.count++;
      return { ok: h.count <= max, retryAfterSec: Math.max(1, Math.ceil((h.resetAt - t) / 1000)), remaining: Math.max(0, max - h.count) };
    },
    /** Is this key still under the limit? Does not count a request (use to check a lockout before acting). */
    peek(key) {
      const h = hits.get(key);
      return !h || h.resetAt <= now() || h.count < max;
    },
    /** Forget a key (e.g. after a successful admin login). */
    reset(key) { hits.delete(key); },
    get size() { return hits.size; }
  };
}

/**
 * The address to rate-limit on. X-Forwarded-For is attacker-controlled unless a trusted
 * proxy sets it, so it is only used when TRUST_PROXY=1 (take the LAST hop the proxy added).
 */
export function clientKey(req, trustProxy = process.env.TRUST_PROXY === '1') {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

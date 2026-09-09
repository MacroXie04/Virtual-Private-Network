/** Independent, bounded request budgets for trusted and anonymous identities. */

/**
 * Memory-bounded fixed-window limiter. Once the key table is full, unseen
 * addresses share one deliberately conservative overflow bucket.
 */
export class FixedWindowRateLimiter {
  constructor({ limit = 60, windowMs = 60_000, maxEntries = 1024, now = Date.now } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be positive');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be positive');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be positive');
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.overflow = { count: 0, resetAt: 0 };
  }

  take(key) {
    const now = this.now();
    const normalized = typeof key === 'string' && key ? key : 'unknown';
    let entry = this.entries.get(normalized);

    if (!entry && this.entries.size >= this.maxEntries) {
      for (const [storedKey, stored] of this.entries) {
        if (now >= stored.resetAt) this.entries.delete(storedKey);
      }
    }
    if (!entry && this.entries.size < this.maxEntries) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(normalized, entry);
    } else if (!entry) {
      entry = this.overflow;
    }

    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + this.windowMs;
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}

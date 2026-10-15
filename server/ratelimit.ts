import type { NextFunction, Request, Response } from "express";

/**
 * Token bucket per key: `capacity` requests in a burst, refilled at
 * `perMinute`. Small and dependency-free; the clock is injectable for tests.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private capacity: number,
    private perMinute: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns 0 if allowed, otherwise the seconds to wait. */
  take(key: string, cost = 1): number {
    const t = this.now();
    const rate = this.perMinute / 60_000; // tokens per ms
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      this.prune(t);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((cost - b.tokens) / rate / 1000));
  }

  /** Seconds until one token is available, without spending it (0 = free now). */
  blocked(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const rate = this.perMinute / 60_000;
    const tokens = Math.min(this.capacity, b.tokens + (this.now() - b.at) * rate);
    return tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - tokens) / rate / 1000));
  }

  private lastPrune = 0;
  /** Drop full, idle buckets so memory doesn't grow with distinct keys. */
  private prune(t: number) {
    if (t - this.lastPrune < 60_000 || this.buckets.size < 1000) return;
    this.lastPrune = t;
    const refill = (this.capacity / this.perMinute) * 60_000;
    for (const [k, b] of this.buckets) if (t - b.at > refill) this.buckets.delete(k);
  }
}

export function rateLimit(limiter: RateLimiter, key: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const wait = limiter.take(key(req));
    if (!wait) return next();
    res.setHeader("Retry-After", String(wait));
    res.status(429).json({ error: `Too many requests. Try again in ${wait}s.` });
  };
}

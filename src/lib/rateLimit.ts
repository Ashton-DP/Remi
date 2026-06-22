import type { Request, Response, NextFunction } from 'express';

// Tiny in-memory fixed-window rate limiter (no external dependency). Good enough
// for a single web instance; at multi-instance scale move to a shared store
// (e.g. Redis). Protects public endpoints from floods that would run up AI/
// Twilio spend. Note: the WhatsApp/voice webhooks are ALSO signature-gated, so
// this is defence-in-depth — keep the webhook ceiling generous since legitimate
// Twilio traffic shares a small pool of source IPs.

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  name: string;
  keyFn?: (req: Request) => string;
}) {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? 'unknown');

  // Periodic cleanup so the map doesn't grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, opts.windowMs);
  sweep.unref?.();

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = `${opts.name}:${keyFn(req)}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      console.warn(`[ratelimit] ${opts.name} exceeded for ${keyFn(req)} (${b.count}/${opts.max})`);
      return res.status(429).type('text/plain').send('Too many requests');
    }
    next();
  };
}

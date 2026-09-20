import type { Request, Response, NextFunction } from 'express';
import { incrementWindow, isCacheEnabled } from '../cache/redis.js';
import { config } from '../config.js';
import { tooManyRequests } from '../lib/errors.js';
import { getContext } from '../lib/context.js';

/**
 * Fixed-window rate limiting, Redis-backed and **fail-open**.
 *
 * Fail-open is a deliberate trade. A rate limiter that fails closed turns a
 * Redis blip into a total outage, and this service targets 99.95%. The cost is
 * that an attacker who can take Redis down also removes the limit — which is
 * why this is one layer, with WAF/gateway limits in front of it (see
 * docs/threat-model.md).
 *
 * Without Redis (local development), an in-process fallback keeps behaviour
 * roughly correct for a single instance.
 */

const localWindows = new Map<string, { count: number; resetAt: number }>();

function localIncrement(key: string, windowSeconds: number): number {
  const now = Date.now();
  const existing = localWindows.get(key);
  if (!existing || existing.resetAt <= now) {
    localWindows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 1;
  }
  existing.count++;
  return existing.count;
}

// Bound the fallback map so a flood of distinct keys cannot exhaust memory.
setInterval(() => {
  const now = Date.now();
  for (const [key, win] of localWindows) if (win.resetAt <= now) localWindows.delete(key);
}, 60_000).unref();

export interface RateLimitOptions {
  max?: number;
  windowSeconds?: number;
  /** Bucket name, so the login limit and the read limit do not share a counter. */
  bucket: string;
  /** Defaults to the authenticated user, falling back to the hashed IP. */
  keyOf?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const max = opts.max ?? config.RATE_LIMIT_MAX;
  const windowSeconds = opts.windowSeconds ?? config.RATE_LIMIT_WINDOW_SEC;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const identity =
        opts.keyOf?.(req) ??
        (req as Request & { user?: { id: string } }).user?.id ??
        getContext()?.ipHash ??
        'anonymous';

      const key = `rl:${opts.bucket}:${identity}`;
      const count = isCacheEnabled()
        ? await incrementWindow(key, windowSeconds)
        : localIncrement(key, windowSeconds);

      if (count === null) return next(); // Redis unavailable: fail open

      const remaining = Math.max(0, max - count);
      res.setHeader('ratelimit-limit', String(max));
      res.setHeader('ratelimit-remaining', String(remaining));
      res.setHeader('ratelimit-policy', `${max};w=${windowSeconds}`);

      if (count > max) return next(tooManyRequests(windowSeconds));
      next();
    } catch {
      next(); // never let the limiter itself fail a request
    }
  };
}

/**
 * Login and token endpoints are limited per IP rather than per user: the
 * attacker in a credential-stuffing run controls which account they name, so a
 * per-user counter is trivially evaded by rotating the username.
 */
export const authRateLimit = rateLimit({
  bucket: 'auth',
  max: config.RATE_LIMIT_AUTH_MAX,
  windowSeconds: config.RATE_LIMIT_WINDOW_SEC,
  keyOf: () => getContext()?.ipHash ?? 'anonymous',
});

export const readRateLimit = rateLimit({ bucket: 'read' });
export const writeRateLimit = rateLimit({ bucket: 'write', max: 30 });

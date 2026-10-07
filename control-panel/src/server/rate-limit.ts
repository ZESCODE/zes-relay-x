import { ApiHttpError } from './http';
import { env } from './env';

/**
 * In-memory sliding-window rate limiter.
 *
 * Deliberately process-local: the panel is a single-process control plane for a
 * loopback relay, so a distributed store would be over-engineering. The
 * middleware keeps its own cheap counter for the login route as a first line of
 * defence; route handlers use this limiter for accurate limits.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the next slot frees up (0 when allowed). */
  retryAfterMs: number;
  resetAt: number;
}

const MAX_KEYS = 10_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    this.sweepIfNeeded(now);

    if (limit <= 0) {
      return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0, resetAt: now };
    }

    const cutoff = now - windowMs;
    let timestamps = this.hits.get(key);
    if (!timestamps) {
      if (this.hits.size >= MAX_KEYS) {
        // Drop the oldest inserted key — bounded memory beats perfect fairness.
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      timestamps = [];
      this.hits.set(key, timestamps);
    }

    // Prune expired hits in place (the array stays sorted by construction).
    let index = 0;
    while (index < timestamps.length && timestamps[index]! <= cutoff) index += 1;
    if (index > 0) timestamps.splice(0, index);

    if (timestamps.length >= limit) {
      const oldestHit = timestamps[0]!;
      const retryAfterMs = Math.max(1, oldestHit + windowMs - now);
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterMs,
        resetAt: oldestHit + windowMs,
      };
    }

    timestamps.push(now);
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - timestamps.length),
      retryAfterMs: 0,
      resetAt: now + windowMs,
    };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  resetAll(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }

  private sweepIfNeeded(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - env.rateWindowMs * 2;
    for (const [key, timestamps] of this.hits) {
      const last = timestamps[timestamps.length - 1];
      if (last === undefined || last < cutoff) this.hits.delete(key);
    }
  }
}

export type LimitKind = 'login' | 'chat' | 'admin';

export function limitFor(kind: LimitKind): number {
  switch (kind) {
    case 'login':
      return env.loginRateLimit;
    case 'chat':
      return env.chatRateLimit;
    case 'admin':
      return Math.max(10, env.chatRateLimit);
    default:
      return env.chatRateLimit;
  }
}

/** Throws a 429 ApiHttpError when the caller exceeded its budget. */
export function enforceRateLimit(kind: LimitKind, key: string): RateLimitResult {
  const result = getRateLimiter().consume(`${kind}:${key}`, limitFor(kind), env.rateWindowMs);
  if (!result.allowed) {
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    throw new ApiHttpError(
      'rate_limited',
      `Rate limit reached (${result.limit} per ${Math.round(env.rateWindowMs / 1000)}s). Retry in ${seconds}s.`,
      429,
      { retryAfterSeconds: seconds, limit: result.limit, kind },
    );
  }
  return result;
}

const GLOBAL_KEY = Symbol.for('zes.panel.rate-limiter');

type GlobalWithLimiter = typeof globalThis & { [GLOBAL_KEY]?: SlidingWindowLimiter };

export function getRateLimiter(): SlidingWindowLimiter {
  const scope = globalThis as GlobalWithLimiter;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = new SlidingWindowLimiter();
  return scope[GLOBAL_KEY] as SlidingWindowLimiter;
}

export function resetRateLimiter(): void {
  const scope = globalThis as GlobalWithLimiter;
  delete scope[GLOBAL_KEY];
}

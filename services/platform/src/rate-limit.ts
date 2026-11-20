// Rate-limit counters in Redis (docs/architecture.md 1): the only thing platform keeps there, and nothing that must
// survive a restart. A Redis failure fails the request instead of letting it through unlimited.
import type { Logger } from "@bodhchakra/log";
import { createClient, type RedisClientType } from "redis";

export interface RateLimitRule {
  /** Seconds. */
  window: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window frees up; null when allowed. */
  retryAfter: number | null;
}

export type Limit = (key: string, rule: RateLimitRule) => Promise<RateLimitResult>;

export interface Limiter {
  limit: Limit;
  close(): Promise<void>;
}

/**
 * A fixed window per key. INCR, EXPIRE NX and TTL run in one MULTI, so concurrent requests cannot all pass on a
 * stale count.
 */
export function redisLimiter(url: string, log: Logger): Limiter {
  const redis: RedisClientType = createClient({ url });
  redis.on("error", (error: Error) => log.error("redis connection failed", { error }));
  const connected = redis.connect();
  // Awaited by every check, which rethrows; this only keeps an early failure from being unhandled.
  connected.catch(() => undefined);
  return {
    async limit(key, rule) {
      await connected;
      const [count, , ttl] = (await redis
        .multi()
        .incr(`rate:${key}`)
        .expire(`rate:${key}`, rule.window, "NX")
        .ttl(`rate:${key}`)
        .exec()) as [number, unknown, number];
      if (count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: ttl > 0 ? ttl : rule.window };
    },
    async close() {
      await connected;
      await redis.close();
    },
  };
}

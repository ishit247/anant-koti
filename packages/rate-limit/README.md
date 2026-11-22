# @bodhchakra/rate-limit

Fixed-window rate-limit counters in Redis (docs/architecture.md 1). Layer: core. Platform limits sign-in codes
with it (per address and per IP); Kaam Koti limits its public request form and customer-link lookups per IP, and
public-form requests per business per day.

## API

| Export                    | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `redisLimiter(url, log)`  | Connects to Redis and returns `{ limit, close }`.                                                  |
| `limit(key, rule)`        | Counts one hit on `key`; `rule` is `{ window, max }` (seconds, hits). → `{ allowed, retryAfter }`. |
| `Limit`, `RateLimitRule`… | The types, so a caller can take a `Limit` function and tests can pass their own.                   |

## Rules it enforces

- `INCR`, `EXPIRE NX` and `TTL` run in one `MULTI`: concurrent hits cannot all pass on a stale count, and the
  window starts at the first hit and is not extended by later ones.
- Keys are stored as `rate:<key>`. Callers choose the rest (`intake-ip:<ip>`, `code-address:<hash>`); a key never
  carries a raw phone number or email.
- A Redis failure throws, so the request fails instead of passing unlimited. Nothing in Redis has to survive a
  restart: losing it resets the counts.

## Config

The caller passes the Redis URL from its own config (`REDIS_URL`). Each project runs its own Redis in production;
in development the stack has one, shared by platform and Kaam Koti, whose key names do not overlap.

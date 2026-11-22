// Rate limits on what anyone can reach without signing in (docs/architecture.md 1, 7, 10): the public request
// form, per IP and per business per day, and customer-link lookups per IP. Counters live in Redis.
import type { Limit, RateLimitRule } from "@bodhchakra/rate-limit";

/** Set by Caddy from the connecting address, replacing any value the client sent (as in front of platform). */
export const CLIENT_IP_HEADER = "x-client-ip";

export const LIMITS = {
  /** A customer opens their page a handful of times; guessing a 256-bit link would take far more. */
  jobLinkPerIp: { window: 600, max: 60 },
  intakePerIp: { window: 3600, max: 10 },
  /** Requests one business can receive through its form in a day, so a flood cannot bury its inbox. */
  intakePerBusiness: { window: 86_400, max: 200 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * The caller's address, for counting. Without the header (development, or a request that bypassed Caddy) every
 * such request shares one counter, so the limit gets tighter, never looser.
 */
export function clientIp(headers: Headers): string {
  return headers.get(CLIENT_IP_HEADER)?.trim().slice(0, 64) || "unknown";
}

/**
 * Counts the request against each rule in turn and returns a 429 for the first one it is over, or null if all
 * allow it. A refused request is not counted against the rules after the one that refused it.
 */
export async function overLimit(
  limit: Limit,
  checks: readonly (readonly [key: string, rule: RateLimitRule])[],
): Promise<Response | null> {
  for (const [key, rule] of checks) {
    const result = await limit(key, rule);
    if (!result.allowed)
      return new Response("Too many requests. Please try again later.\n", {
        status: 429,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(result.retryAfter),
        },
      });
  }
  return null;
}

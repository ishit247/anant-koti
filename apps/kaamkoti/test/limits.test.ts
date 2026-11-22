// Against the development Redis (infra/compose.dev.yml). Each test counts under fresh keys.
import { randomUUID } from "node:crypto";
import { createLogger } from "@bodhchakra/log";
import { redisLimiter } from "@bodhchakra/rate-limit";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, clientIp, LIMITS, overLimit } from "../src/index.ts";

describe("rate limits on public routes", () => {
  const limiter = redisLimiter("redis://127.0.0.1:45444", createLogger({ service: "test" }));
  afterAll(() => limiter.close());

  it("answers 429 with Retry-After once an IP is past the intake limit", async () => {
    const key = `test-intake-ip:${randomUUID()}`;
    const rule = LIMITS.intakePerIp;
    for (let i = 0; i < rule.max; i++)
      expect(await overLimit(limiter.limit, [[key, rule]])).toBeNull();
    const refused = await overLimit(limiter.limit, [[key, rule]]);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses on the first rule that is over, without counting the later ones", async () => {
    const ip = `test-ip:${randomUUID()}`;
    const business = `test-business:${randomUUID()}`;
    const tight = { window: 60, max: 1 };
    await overLimit(limiter.limit, [[ip, tight]]);
    expect(
      (
        await overLimit(limiter.limit, [
          [ip, tight],
          [business, tight],
        ])
      )?.status,
    ).toBe(429);
    // The business's counter was not touched by the refused request.
    expect(await overLimit(limiter.limit, [[business, tight]])).toBeNull();
  });

  it("counts by the address the proxy sets, and puts requests without one in one counter", () => {
    expect(clientIp(new Headers({ [CLIENT_IP_HEADER]: " 203.0.113.7 " }))).toBe("203.0.113.7");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

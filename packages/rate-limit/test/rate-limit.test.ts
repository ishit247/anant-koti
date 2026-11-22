// Against the development Redis (infra/compose.dev.yml). Each test uses fresh keys, so runs never share counts.
import { randomUUID } from "node:crypto";
import { createLogger } from "@bodhchakra/log";
import { afterAll, describe, expect, it } from "vitest";
import { redisLimiter } from "../src/index.ts";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:45444";

describe("redisLimiter", () => {
  const limiter = redisLimiter(REDIS_URL, createLogger({ service: "test" }));
  afterAll(() => limiter.close());

  it("allows `max` hits in a window and refuses the next with the seconds left", async () => {
    const key = `test:${randomUUID()}`;
    const rule = { window: 60, max: 3 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.limit(key, rule));
    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3]?.allowed).toBe(false);
    expect(results[3]?.retryAfter).toBeGreaterThan(0);
    expect(results[3]?.retryAfter).toBeLessThanOrEqual(60);
  });

  it("counts each key on its own", async () => {
    const rule = { window: 60, max: 1 };
    const one = `test:${randomUUID()}`;
    await limiter.limit(one, rule);
    expect((await limiter.limit(one, rule)).allowed).toBe(false);
    expect((await limiter.limit(`test:${randomUUID()}`, rule)).allowed).toBe(true);
  });
});

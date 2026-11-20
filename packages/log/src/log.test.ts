import { describe, expect, it } from "vitest";
import { createLogger } from "./index";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "test", write: (l) => lines.push(JSON.parse(l)) });
  return { lines, logger };
}

describe("createLogger", () => {
  it("redacts sensitive keys, including nested ones", () => {
    const { lines, logger } = capture();
    logger.info("hello", { phone: "+919999999999", user: { email: "a@b.c", id: 7 } });
    expect(lines[0]).toMatchObject({ phone: "[redacted]", user: { email: "[redacted]", id: 7 } });
  });

  it("adds the request id to every line of a bound logger", () => {
    const { lines, logger } = capture();
    logger.withRequestId("r1").warn("slow");
    expect(lines[0]).toMatchObject({ requestId: "r1", level: "warn", service: "test" });
  });
});

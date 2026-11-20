import { describe, expect, it } from "vitest";
import { MAX_SKEW_SECONDS, signRequest, TIMESTAMP_HEADER, verifyRequest } from "../src/index.ts";

const SECRET = "k".repeat(43);
const OTHER_SECRET = "o".repeat(43);
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const request = {
  method: "POST",
  path: "/internal/v1/notify.send",
  body: '{"key":"a","payload":{}}',
};

const signed = (overrides: { secret?: string; now?: number } = {}) =>
  new Headers(
    signRequest({ client: "kaamkoti", secret: SECRET, ...request, now: NOW, ...overrides }),
  );

const verify = (headers: Headers, overrides: Partial<typeof request> & { now?: number } = {}) =>
  verifyRequest({
    ...request,
    headers,
    secretFor: (client) => (client === "kaamkoti" ? SECRET : undefined),
    now: NOW,
    ...overrides,
  });

describe("signed service requests", () => {
  it("accepts a request signed with the client's secret", () => {
    expect(verify(signed())).toEqual({ ok: true, client: "kaamkoti" });
  });

  it("accepts a timestamp at the edge of the window", () => {
    expect(verify(signed(), { now: NOW + MAX_SKEW_SECONDS * 1000 })).toMatchObject({ ok: true });
  });

  it("refuses a request older than five minutes", () => {
    expect(verify(signed(), { now: NOW + (MAX_SKEW_SECONDS + 1) * 1000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a request from more than five minutes in the future", () => {
    expect(verify(signed({ now: NOW + (MAX_SKEW_SECONDS + 1) * 1000 }))).toMatchObject({
      reason: "expired",
    });
  });

  it("refuses a signature made with another secret", () => {
    expect(verify(signed({ secret: OTHER_SECRET }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a changed body, path or method", () => {
    expect(verify(signed(), { body: '{"key":"b","payload":{}}' })).toMatchObject({
      reason: "bad_signature",
    });
    expect(verify(signed(), { path: "/internal/v1/billing.cancel" })).toMatchObject({
      reason: "bad_signature",
    });
    expect(verify(signed(), { method: "PUT" })).toMatchObject({ reason: "bad_signature" });
  });

  it("refuses a moved timestamp, which the signature covers", () => {
    const headers = signed();
    headers.set(TIMESTAMP_HEADER, String(NOW / 1000 + 1));
    expect(verify(headers)).toMatchObject({ reason: "bad_signature" });
  });

  it("refuses an unknown client", () => {
    const headers = new Headers(
      signRequest({ client: "pos", secret: SECRET, ...request, now: NOW }),
    );
    expect(verify(headers)).toEqual({ ok: false, reason: "unknown_client" });
  });

  it("refuses a request with no signature headers", () => {
    expect(verify(new Headers())).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses to sign with a short secret", () => {
    expect(() => signRequest({ client: "kaamkoti", secret: "short", ...request })).toThrow(
      "secret is too short",
    );
  });
});

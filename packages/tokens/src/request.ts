// Signed service requests between an app and platform (docs/architecture.md 9.1): HMAC-SHA256 with a per-app
// secret over the client id, method, path, timestamp and the body's SHA-256. The receiver refuses a bad
// signature and a timestamp more than five minutes from its own clock.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CLIENT_HEADER = "x-bc-client";
export const TIMESTAMP_HEADER = "x-bc-timestamp";
export const SIGNATURE_HEADER = "x-bc-signature";

/** How far a request's timestamp may be from the receiver's clock, either way. */
export const MAX_SKEW_SECONDS = 5 * 60;
/** 32 bytes as hex or base64 is at least 43 characters; shorter secrets are refused at start-up. */
export const MIN_SECRET_LENGTH = 43;

const CLIENT = /^[a-z][a-z0-9-]{0,39}$/;
const TIMESTAMP = /^\d{1,12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

export interface SignInput {
  client: string;
  secret: string;
  method: string;
  /** The path and query exactly as sent, e.g. `/internal/v1/notify.send`. */
  path: string;
  body: string;
  /** Unix time in milliseconds; defaults to now. */
  now?: number;
}

function digest(
  secret: string,
  client: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret)
    .update(`${client}\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`)
    .digest("hex");
}

/** The headers that authenticate one request. */
export function signRequest(input: SignInput): Record<string, string> {
  if (!CLIENT.test(input.client))
    throw new Error(`signRequest: "${input.client}" is not a client id`);
  if (input.secret.length < MIN_SECRET_LENGTH) throw new Error("signRequest: secret is too short");
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
  return {
    [CLIENT_HEADER]: input.client,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: digest(
      input.secret,
      input.client,
      input.method,
      input.path,
      timestamp,
      input.body,
    ),
  };
}

export interface VerifyInput {
  method: string;
  path: string;
  headers: { get(name: string): string | null };
  body: string;
  /** The shared secret for a client id, or undefined if the client is unknown. */
  secretFor(client: string): string | undefined;
  now?: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly client: string }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unknown_client" | "expired" | "bad_signature";
    };

/** Checks a signed request. The reason is for logs only; callers answer every failure the same way. */
export function verifyRequest(input: VerifyInput): VerifyResult {
  const client = input.headers.get(CLIENT_HEADER);
  const timestamp = input.headers.get(TIMESTAMP_HEADER);
  const signature = input.headers.get(SIGNATURE_HEADER);
  if (!client || !timestamp || !signature) return { ok: false, reason: "malformed" };
  if (!CLIENT.test(client) || !TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature)) {
    return { ok: false, reason: "malformed" };
  }
  const secret = input.secretFor(client);
  if (secret === undefined) return { ok: false, reason: "unknown_client" };
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS)
    return { ok: false, reason: "expired" };
  const expected = digest(secret, client, input.method, input.path, timestamp, input.body);
  // Both are 64 hex characters (checked above), so the lengths match as timingSafeEqual requires.
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, client };
}

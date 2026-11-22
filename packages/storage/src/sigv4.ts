// AWS Signature Version 4 for the S3 API, on node:crypto; Garage verifies it. Two forms: a signed request
// (Authorization header) for the server's own calls, and a presigned URL for a browser to GET one private object.
// The same signer as Profile's storage package (D11: Profile adopts this module when its work touches uploads).
import { createHash, createHmac } from "node:crypto";

export interface Credentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, which S3 requires: encodeURIComponent leaves !'()* alone. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The object path with every segment encoded once and the slashes kept. */
export const encodePath = (path: string) => path.split("/").map(encode).join("/");

/** 20261110T093000Z and 20261110 for a moment. */
function stamps(now: Date) {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function signature(
  creds: Credentials,
  day: string,
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): string {
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), creds.region), "s3"),
    "aws4_request",
  );
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

/** Headers lower-cased, trimmed and sorted, as the canonical request lists them. */
function canonicalHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    block: entries.map(([k, v]) => `${k}:${v}\n`).join(""),
    signed: entries.map(([k]) => k).join(";"),
  };
}

/**
 * Signs a request the server sends itself. Returns the headers to send, `host` excluded (fetch sets it from the
 * URL, and it is signed with the same value).
 */
export function signRequest(
  creds: Credentials,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  now = new Date(),
): Record<string, string> {
  const { amzDate, day } = stamps(now);
  const scope = `${day}/${creds.region}/s3/aws4_request`;
  const sent = { ...headers, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const { block, signed } = canonicalHeaders({ ...sent, host: url.host });
  const request = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    block,
    signed,
    payloadHash,
  ].join("\n");
  const sig = signature(creds, day, amzDate, scope, request);
  return {
    ...sent,
    authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

/** A URL that allows one GET of one object until it expires. */
export function presignGet(
  creds: Credentials,
  url: URL,
  expiresInSeconds: number,
  now = new Date(),
): URL {
  const { amzDate, day } = stamps(now);
  const scope = `${day}/${creds.region}/s3/aws4_request`;
  const { block, signed } = canonicalHeaders({ host: url.host });
  const presigned = new URL(url);
  presigned.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  presigned.searchParams.set("X-Amz-Credential", `${creds.accessKeyId}/${scope}`);
  presigned.searchParams.set("X-Amz-Date", amzDate);
  presigned.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  presigned.searchParams.set("X-Amz-SignedHeaders", signed);
  const request = [
    "GET",
    url.pathname,
    canonicalQuery(presigned.searchParams),
    block,
    signed,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  presigned.searchParams.set("X-Amz-Signature", signature(creds, day, amzDate, scope, request));
  return presigned;
}

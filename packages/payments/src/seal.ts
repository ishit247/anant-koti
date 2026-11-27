// AES-256-GCM for the provider secrets a business gives us (docs/architecture.md 8). Sealed form:
// 12-byte IV ‖ 16-byte tag ‖ ciphertext. The associated data binds a value to its business and field, so a sealed
// secret copied into another business's row, or into the other column, fails to open instead of being used.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The 32-byte key from config, given as base64; throws at start-up on anything else. */
export function sealingKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("payments: the sealing key must be 32 bytes, base64");
  return key;
}

export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Throws if the value was tampered with, sealed under another key, or for another business or field. */
export function open(key: Buffer, sealed: Buffer, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

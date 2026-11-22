// Mobile numbers as people type them in India, stored in E.164 (docs/architecture.md 5.3).
import { z } from "zod";

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * A phone number as people type it in India, in E.164: a 10-digit mobile, with or without 0 or 91 in front,
 * or a full +<country> number. Anything else is returned as typed, and the E.164 check refuses it.
 */
export function toE164(typed: string): string {
  const compact = typed.replace(/[\s().-]/g, "");
  const indian = /^(?:\+?91|0)?([6-9][0-9]{9})$/.exec(compact);
  if (indian) return `+91${indian[1]}`;
  return compact;
}

/** A typed mobile, read as E.164 and refused if it is not one. */
export const phone = z.string().transform(toE164).pipe(z.string().regex(E164));

/** As people in India type it back into a form: a +91 mobile without the country code; anything else in E.164. */
export const localPhone = (e164: string) => e164.replace(/^\+91(?=[6-9]\d{9}$)/, "");

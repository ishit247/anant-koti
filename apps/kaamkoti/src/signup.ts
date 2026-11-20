// Owner signup input, parsed once where it enters (docs/architecture.md 4.1 constraints are the last line).
import { randomBytes } from "node:crypto";
import { z } from "zod";

/** A 10-digit Indian mobile number, or international with `+`; spaces and dashes are allowed. */
function toE164(text: string): string | null {
  const compact = text.replace(/[\s-]/g, "");
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}

const field = (max: number) => z.string().trim().min(1).max(max);

export const signupInput = z.object({
  yourName: field(120),
  businessName: field(120),
  city: field(80),
  phone: z.string().transform((text, ctx) => {
    const phone = toE164(text);
    if (!phone) ctx.addIssue({ code: "custom", message: "not a phone number" });
    return phone ?? z.NEVER;
  }),
});

export type SignupInput = z.infer<typeof signupInput>;

/** A public-URL slug from the business name; the suffix keeps names with no letters (or too short) valid. */
export function slugFor(businessName: string, attempt = 0): string {
  const base = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  // The first try is the plain name; a taken slug retries with a random suffix.
  const suffix = attempt > 0 || base.length < 3 ? `-${randomBytes(2).toString("hex")}` : "";
  const slug = `${base}${suffix}`.replace(/^-+/, "");
  return slug.length >= 3 ? slug : `biz${suffix}`;
}

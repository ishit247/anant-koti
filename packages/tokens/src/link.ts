// Scoped, expiring, revocable links (docs/architecture.md 7). The link is 32 random bytes in base64url; the
// table keeps only its SHA-256. `issue` and `revoke` run inside `withTenant` of the link's business;
// `resolve` needs no tenant, because the person arriving has only the link.
import { createHash, randomBytes } from "node:crypto";
import type { DbClient } from "@bodhchakra/db";

export type LinkPurpose = "job" | "invite";

export interface NewLink {
  purpose: LinkPurpose;
  businessId: string;
  /** The invite or job the link opens. */
  subjectId: string;
  actions?: readonly string[];
  expiresAt: Date;
}

export interface Link {
  readonly id: string;
  readonly purpose: LinkPurpose;
  readonly businessId: string;
  readonly subjectId: string;
  readonly actions: readonly string[];
}

/** 32 random bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Stores a new link and returns its id and the secret to hand out. The secret cannot be recovered later. */
export async function issue(
  client: DbClient,
  link: NewLink,
): Promise<{ id: string; secret: string }> {
  const secret = randomBytes(32).toString("base64url");
  const { rows } = await client.query<{ id: string }>(
    `insert into tokens.token (hash, purpose, business_id, subject_id, actions, expires_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      sha256(secret),
      link.purpose,
      link.businessId,
      link.subjectId,
      link.actions ?? [],
      link.expiresAt,
    ],
  );
  return { id: (rows[0] as { id: string }).id, secret };
}

interface LinkRow {
  id: string;
  purpose: LinkPurpose;
  business_id: string;
  subject_id: string;
  actions: string[];
}

/** The live link a secret names, or null for one that is unknown, malformed, revoked or expired. */
export async function resolve(client: DbClient, secret: string): Promise<Link | null> {
  if (!TOKEN.test(secret)) return null;
  const { rows } = await client.query<LinkRow>(
    "select id, purpose, business_id, subject_id, actions from tokens.resolve($1)",
    [sha256(secret)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    purpose: row.purpose,
    businessId: row.business_id,
    subjectId: row.subject_id,
    actions: row.actions,
  };
}

/** Ends a link now. Runs inside `withTenant` of its business; RLS makes another business's link a no-op. */
export async function revoke(client: DbClient, id: string): Promise<void> {
  await client.query(
    "update tokens.token set revoked_at = now() where id = $1 and revoked_at is null",
    [id],
  );
}

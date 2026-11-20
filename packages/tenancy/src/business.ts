import { randomUUID } from "node:crypto";
import type { Db, DbClient } from "@bodhchakra/db";
import { addMember, type Membership } from "./member.ts";

/** Already validated at the edge (the signup form); the table's checks are the last line. */
export interface NewBusiness {
  slug: string;
  name: string;
  /** E.164. */
  phone: string;
  city: string;
}

export interface Owner {
  identityId: string;
  displayName: string;
}

/**
 * Creates the business and its owner in one transaction, inside `withTenant` of the new id: RLS lets the
 * runtime role insert only the business it is working in. A taken slug rejects with Postgres code 23505.
 */
export async function createBusiness(
  db: Db,
  business: NewBusiness,
  owner: Owner,
): Promise<Membership> {
  const businessId = randomUUID();
  return db.withTenant(businessId, async (client) => {
    await client.query(
      "insert into tenancy.business (id, slug, name, phone, city) values ($1, $2, $3, $4, $5)",
      [businessId, business.slug, business.name, business.phone, business.city],
    );
    return addMember(client, { businessId, ...owner, role: "owner" });
  });
}

/** The business id for a public slug, or null. Needs no tenant: public pages use it to open one. */
export async function resolveSlug(client: DbClient, slug: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string | null }>(
    "select tenancy.resolve_slug($1) as id",
    [slug],
  );
  return rows[0]?.id ?? null;
}

export interface BusinessProfile {
  readonly name: string;
  readonly slug: string;
  readonly city: string;
}

/** The business `withTenant` opened: RLS leaves exactly one row. */
export async function currentBusiness(client: DbClient): Promise<BusinessProfile> {
  const { rows } = await client.query<BusinessProfile>(
    "select name, slug, city from tenancy.business",
  );
  if (rows.length !== 1) throw new Error("currentBusiness: not inside withTenant of one business");
  return rows[0] as BusinessProfile;
}

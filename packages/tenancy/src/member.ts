import type { DbClient } from "@bodhchakra/db";

export const ROLES = ["owner", "technician"] as const;
export type Role = (typeof ROLES)[number];

/** One person's place in one business. */
export interface Membership {
  readonly memberId: string;
  readonly businessId: string;
  readonly role: Role;
  readonly displayName: string;
}

interface MembershipRow {
  member_id: string;
  business_id: string;
  role: Role;
  display_name: string;
}

const toMembership = (row: MembershipRow): Membership => ({
  memberId: row.member_id,
  businessId: row.business_id,
  role: row.role,
  displayName: row.display_name,
});

export interface NewMember {
  businessId: string;
  identityId: string;
  displayName: string;
  role: Role;
}

/** Adds a member to the business. Runs inside `withTenant` of that business; RLS refuses any other. */
export async function addMember(client: DbClient, member: NewMember): Promise<Membership> {
  const { rows } = await client.query<MembershipRow>(
    `insert into tenancy.member (business_id, identity_id, display_name, role)
     values ($1, $2, $3, $4)
     returning id as member_id, business_id, role, display_name`,
    [member.businessId, member.identityId, member.displayName, member.role],
  );
  return toMembership(rows[0] as MembershipRow);
}

/**
 * The identity's current memberships, oldest first; removed members are left out. Needs no tenant: sign-in
 * uses it to find which business to open.
 */
export async function membershipsOf(client: DbClient, identityId: string): Promise<Membership[]> {
  const { rows } = await client.query<MembershipRow>(
    "select member_id, business_id, role, display_name from tenancy.memberships_of($1)",
    [identityId],
  );
  return rows.map(toMembership);
}

/** The member's role is not among those the action allows. */
export class NotPermittedError extends Error {
  readonly code = "not_permitted";
  constructor(role: Role, allowed: readonly Role[]) {
    super(`role "${role}" may not do this; allowed: ${allowed.join(", ")}`);
    this.name = "NotPermittedError";
  }
}

/** The permission check: what the role may do (docs/architecture.md 4.3). Scope is checked separately. */
export function requireRole(membership: Membership, ...allowed: [Role, ...Role[]]): void {
  if (!allowed.includes(membership.role)) throw new NotPermittedError(membership.role, allowed);
}

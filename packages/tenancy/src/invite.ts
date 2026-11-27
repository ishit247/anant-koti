import { randomUUID } from "node:crypto";
import type { Db, DbClient } from "@bodhchakra/db";
import { issue, resolve, revoke } from "@bodhchakra/tokens";
import { addMember, type Membership } from "./member.ts";

const INVITE_DAYS = 7;

/** The link was not one that can still be used: unknown, expired, revoked, used, or for someone already in. */
export class InviteRefused extends Error {
  readonly code = "invite_refused";
  constructor(reason: string) {
    super(`invite refused: ${reason}`);
    this.name = "InviteRefused";
  }
}

/**
 * Invites a technician: returns the secret for the owner to share (copy, or `wa.me`). Runs inside
 * `withTenant` of the business; the caller has already checked the member may invite (`requireRole`).
 */
export async function createInvite(
  client: DbClient,
  inviter: Membership,
): Promise<{ inviteId: string; secret: string; expiresAt: Date }> {
  const inviteId = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  const link = await issue(client, {
    purpose: "invite",
    businessId: inviter.businessId,
    subjectId: inviteId,
    expiresAt,
  });
  await client.query(
    `insert into tenancy.invite (id, business_id, role, invited_by, token_id, expires_at)
     values ($1, $2, 'technician', $3, $4, $5)`,
    [inviteId, inviter.businessId, inviter.memberId, link.id, expiresAt],
  );
  return { inviteId, secret: link.secret, expiresAt };
}

export interface InviteSummary {
  readonly businessName: string;
  readonly invitedByName: string;
}

/** What the invitee is asked to join, for the page before they accept; null if the link is not live. */
export async function inviteSummary(db: Db, secret: string): Promise<InviteSummary | null> {
  return db.tx(async (client) => {
    const link = await resolve(client, secret);
    if (link?.purpose !== "invite") return null;
    const { rows } = await client.query<{ business_name: string; invited_by_name: string }>(
      "select business_name, invited_by_name from tenancy.invite_summary($1)",
      [link.subjectId],
    );
    const row = rows[0];
    return row ? { businessName: row.business_name, invitedByName: row.invited_by_name } : null;
  });
}

/**
 * Accepts an invite for a signed-in identity: adds them as a technician and ends the link, in one transaction.
 * The invite row is locked first, so two taps of the same link make one member and one refusal. `admit` runs in
 * the same transaction just before the member is added, for what the app must check first (a free seat); a throw
 * from it adds no one and leaves the link usable.
 */
export async function acceptInvite(
  db: Db,
  secret: string,
  person: { identityId: string; displayName: string },
  admit?: (client: DbClient) => Promise<unknown>,
): Promise<Membership> {
  const link = await db.tx((client) => resolve(client, secret));
  if (link?.purpose !== "invite") throw new InviteRefused("the link is not live");
  return db.withTenant(link.businessId, async (client) => {
    const { rows } = await client.query<{ accepted_member_id: string | null }>(
      "select accepted_member_id from tenancy.invite where id = $1 for update",
      [link.subjectId],
    );
    if (!rows[0] || rows[0].accepted_member_id) throw new InviteRefused("already used");
    const existing = await client.query(
      "select 1 from tenancy.member where identity_id = $1 and business_id = $2",
      [person.identityId, link.businessId],
    );
    if (existing.rowCount) throw new InviteRefused("already a member");
    await admit?.(client);
    const member = await addMember(client, {
      businessId: link.businessId,
      identityId: person.identityId,
      displayName: person.displayName,
      role: "technician",
    });
    await client.query("update tenancy.invite set accepted_member_id = $2 where id = $1", [
      link.subjectId,
      member.memberId,
    ]);
    await revoke(client, link.id);
    return member;
  });
}

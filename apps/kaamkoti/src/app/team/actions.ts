"use server";
import { createInvite, defineRoute } from "@bodhchakra/tenancy";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface InviteState {
  readonly secret?: string;
}

/** The secret is shown once, in the owner's own response; only its hash is stored. */
export async function inviteTechnician(): Promise<InviteState> {
  const owner = await requireMember(route);
  const { secret } = await server().db.withTenant(owner.businessId, (client) =>
    createInvite(client, owner),
  );
  return { secret };
}

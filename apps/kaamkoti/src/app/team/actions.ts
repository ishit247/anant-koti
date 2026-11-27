"use server";
import { LimitReached } from "@bodhchakra/billing";
import { createInvite, defineRoute } from "@bodhchakra/tenancy";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";
import { assertSeatFree, seatRefusal } from "../../subscription.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface InviteState {
  readonly secret?: string;
  readonly error?: string;
}

/**
 * The secret is shown once, in the owner's own response; only its hash is stored. No link is made while every
 * seat is taken; joining checks again, since links made earlier can still be used.
 */
export async function inviteTechnician(): Promise<InviteState> {
  const owner = await requireMember(route);
  try {
    const { secret } = await server().db.withTenant(owner.businessId, async (client) => {
      await assertSeatFree(client);
      return createInvite(client, owner);
    });
    return { secret };
  } catch (error) {
    if (!(error instanceof LimitReached)) throw error;
    return { error: seatRefusal(error.error) };
  }
}

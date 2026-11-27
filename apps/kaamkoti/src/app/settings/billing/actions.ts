"use server";
import { defineRoute, listMembers } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { requireMember, requireSession } from "../../../guard.ts";
import { server } from "../../../server.ts";
import { checkoutInput } from "../../../subscription.ts";

// The owner's own business only: the tenant is the signed-in owner's, and platform checks the identity is the
// account's payer as well.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface CheckoutState {
  readonly error?: string;
}

const REFUSED = {
  unavailable: "Could not reach billing just now. Please try again in a minute.",
  unknown_tenant: "Your trial is still being set up. Please try again in a minute.",
  not_payer: "Only the person who opened this business can pay for it.",
  subscribed: "You have already subscribed. It shows here once Razorpay confirms it.",
} as const;

/** Sends the owner to Razorpay's page to authorise the subscription. Nothing changes here until its webhook. */
export async function subscribe(_previous: CheckoutState, form: FormData): Promise<CheckoutState> {
  const owner = await requireMember(route, "/settings/billing");
  const { identityId } = await requireSession("/settings/billing");
  const input = checkoutInput.safeParse({ plan: form.get("plan"), seats: form.get("seats") });
  if (!input.success)
    return { error: "Pick a plan, and for Team the number of people (1 to 100)." };
  // A plan with fewer seats than the people already here would refuse them at once (D20).
  const people = await server().db.withTenant(
    owner.businessId,
    async (client) => (await listMembers(client)).length,
  );
  if (input.data.seats < people)
    return {
      error:
        input.data.plan === "solo"
          ? `Solo is for one person, and ${people} people are in your business. Pick Team for ${people}.`
          : `${people} people are in your business, so Team needs at least ${people} seats.`,
    };
  const answer = await server().billing.checkout({
    tenantId: owner.businessId,
    identityId,
    ...input.data,
  });
  if ("error" in answer) return { error: REFUSED[answer.error.code] };
  redirect(answer.url);
}

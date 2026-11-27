"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "../../../guard.ts";
import { server } from "../../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface ConnectState {
  readonly error?: string;
}

// Razorpay's shapes, checked loosely: a key id names its mode, and the secrets are opaque strings.
const keys = z.object({
  keyId: z
    .string()
    .trim()
    .regex(/^rzp_(test|live)_[A-Za-z0-9]{10,30}$/),
  keySecret: z.string().trim().min(10).max(100),
  webhookSecret: z.string().trim().min(8).max(100),
});

/** Connects the business's own Razorpay account, replacing any earlier keys. Only the owner may. */
export async function connectRazorpay(
  _previous: ConnectState,
  form: FormData,
): Promise<ConnectState> {
  const owner = await requireMember(route, "/settings/payments");
  const input = keys.safeParse({
    keyId: form.get("keyId") ?? "",
    keySecret: form.get("keySecret") ?? "",
    webhookSecret: form.get("webhookSecret") ?? "",
  });
  if (!input.success) {
    return {
      error:
        "Check the three values: the key id starts rzp_test_ or rzp_live_, and both secrets are copied whole.",
    };
  }
  const { db, payments } = server();
  await db.withTenant(owner.businessId, (client) =>
    payments.connectAccount(client, {
      businessId: owner.businessId,
      ...input.data,
      by: owner.memberId,
    }),
  );
  redirect("/settings/payments?saved=1");
}

// The subscription a business pays the platform for (docs/architecture.md 13). Platform keeps the billing
// account and the subscription, and moves its status only from a verified provider webhook; each app keeps a local
// copy, sent to it as signed `billing.status_changed` events. This file is the contract both sides parse.
import { z } from "zod";

/** The plans on sale (D9). Business joins when it is priced. */
export const PLANS = ["solo", "team"] as const;
export type Plan = (typeof PLANS)[number];

/** Seats are the owner plus technicians. Solo is one person; Team is billed per seat. */
export const MAX_SEATS = 100;

/** The trial is Team for up to this many people, whatever its row's seats (D20). */
export const TRIAL_SEATS = 10;

/** What a plan allows. Both sides compute it from the subscription, so nothing stored can disagree. */
export interface Limits {
  /** People in the business: members, owner included. */
  readonly seats: number;
  /** WhatsApp messages a month (D18); over it, platform sends by email. */
  readonly whatsapp: number;
}

export function limitsOf(subscription: {
  readonly plan: Plan;
  readonly seats: number;
  readonly status: Status;
}): Limits {
  const { plan, seats, status } = subscription;
  return {
    seats: status === "trialing" ? TRIAL_SEATS : seats,
    whatsapp: plan === "solo" ? 200 : 500 + 100 * seats,
  };
}

/** App → platform, through the outbox: a new business starts its trial; platform opens the subscription. */
export const REGISTER_TOPIC = "billing.register";
export const registration = z.object({
  tenantId: z.uuid(),
  /** The owner, who pays: the billing account belongs to this identity (one bill across products, D12). */
  identityId: z.uuid(),
  /** The app set its local copy with the same date, so the trial is the same on both sides. */
  trialEndsAt: z.iso.datetime({ offset: true }),
});
export type Registration = z.infer<typeof registration>;

/**
 * App → platform, a signed call answered at once: the provider's page where the owner authorises the
 * subscription. Nothing is paid until the provider's webhook says so.
 */
export const CHECKOUT_CALL = "billing.checkout";
export const checkoutRequest = z
  .object({
    tenantId: z.uuid(),
    /** The signed-in owner; platform refuses anyone but the account's identity. */
    identityId: z.uuid(),
    plan: z.enum(PLANS),
    seats: z.number().int().min(1).max(MAX_SEATS),
  })
  .refine((request) => request.plan !== "solo" || request.seats === 1, {
    message: "solo is one seat",
    path: ["seats"],
  });
export type CheckoutRequest = z.infer<typeof checkoutRequest>;
export const checkoutAnswer = z.union([
  z.object({ url: z.url({ protocol: /^https?$/ }) }),
  z.object({ error: z.object({ code: z.enum(["unknown_tenant", "not_payer", "subscribed"]) }) }),
]);
export type CheckoutAnswer = z.infer<typeof checkoutAnswer>;

export const STATUSES = ["trialing", "active", "past_due", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

/** Platform → app, through platform's outbox: the subscription as it now stands. */
export const STATUS_CHANGED_TOPIC = "billing.status_changed";
export const statusChanged = z.object({
  tenantId: z.uuid(),
  plan: z.enum(PLANS),
  seats: z.number().int().min(1).max(MAX_SEATS),
  status: z.enum(STATUSES),
  trialEndsAt: z.iso.datetime({ offset: true }),
  /** The end of the last period paid for; null until the first payment. */
  paidThrough: z.iso.datetime({ offset: true }).nullable(),
  /** Grows by one with every change: the app applies an event only if it is newer than its copy. */
  version: z.number().int().min(1),
});
export type StatusChanged = z.infer<typeof statusChanged>;

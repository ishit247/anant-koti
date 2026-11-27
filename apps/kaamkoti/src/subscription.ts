// What the owner reads about their subscription (docs/architecture.md 13), and the checkout form's input. The
// state itself is the billing module's copy; live is computed from it at request time.
import {
  assertWithin,
  isLive,
  type LimitError,
  MAX_SEATS,
  type Plan,
  type Subscription,
  subscriptionOf,
} from "@bodhchakra/billing";
import type { DbClient } from "@bodhchakra/db";
import { type Money, money } from "@bodhchakra/money";
import { listMembers } from "@bodhchakra/tenancy";
import { z } from "zod";
import { formatDay } from "./job-labels.ts";

/**
 * The monthly prices the owner chooses between (D9). Shown only: what is charged is the Razorpay plan's price,
 * so a change there must be made here too.
 */
export const PLAN_PRICES: Readonly<Record<Plan, Money>> = {
  solo: money(39_900, "INR"),
  team: money(119_900, "INR"),
};

export interface SubscriptionView {
  readonly live: boolean;
  /** The chip's words and tone (ui-guidelines: a chip carries text, never colour alone). */
  readonly label: string;
  readonly tone: "go" | "wait" | "";
  /** One line on what happens next. */
  readonly line: string;
  /** Whether the owner can start a checkout: not while a paid subscription is running. */
  readonly canSubscribe: boolean;
}

export function subscriptionView(subscription: Subscription, now: Date): SubscriptionView {
  const live = isLive(subscription, now);
  const { status, trialEndsAt, paidThrough } = subscription;
  const trialLeft = now < trialEndsAt;
  if (!live)
    return {
      live,
      label: "Lapsed",
      tone: "",
      line: "Customers see your contact details but cannot send requests or pay online. Subscribe to open your page again.",
      canSubscribe: status === "trialing" || status === "cancelled",
    };
  if (status === "trialing")
    return {
      live,
      label: "Free trial",
      tone: "wait",
      line: `Your free trial ends on ${formatDay(trialEndsAt)}. Subscribe before then to keep your page open.`,
      canSubscribe: true,
    };
  if (status === "active")
    return {
      live,
      label: "Paid",
      tone: "go",
      line:
        paidThrough && !trialLeft
          ? `Paid through ${formatDay(paidThrough)}. It renews each month.`
          : `Subscribed. The first payment is taken on ${formatDay(trialEndsAt)}, when your trial ends.`,
      canSubscribe: false,
    };
  if (status === "past_due")
    return {
      live,
      label: "Payment due",
      tone: "wait",
      line: "Razorpay could not take the last payment and will try again. Check the card or UPI mandate you gave it.",
      canSubscribe: false,
    };
  return {
    live,
    label: "Cancelled",
    tone: "",
    line: paidThrough
      ? `Cancelled. Your page stays open until ${formatDay(paidThrough)}, the end of the time paid for.`
      : `Cancelled. Your page stays open until your trial ends on ${formatDay(trialEndsAt)}.`,
    canSubscribe: true,
  };
}

/**
 * Refuses (`LimitReached`) one more person beyond the plan's seats (D20), inside `withTenant` of the business. The
 * copy is locked before the members are counted, so two people joining at once cannot share the last seat.
 */
export async function assertSeatFree(client: DbClient): Promise<void> {
  const subscription = await subscriptionOf(client, { lock: true });
  assertWithin(subscription, "seats", (await listMembers(client)).length);
}

/** What the owner reads when a seat limit refuses them. */
export function seatRefusal(error: LimitError): string {
  return error.plan === "solo"
    ? "Solo is for one person. Technicians can join on the Team plan."
    : "Every seat on your plan is taken.";
}

/** The checkout form. Solo is one person, so its seats are always one. */
export const checkoutInput = z
  .object({
    plan: z.enum(["solo", "team"]),
    seats: z.coerce.number().int().min(1).max(MAX_SEATS),
  })
  .transform((input) => (input.plan === "solo" ? { ...input, seats: 1 } : input));

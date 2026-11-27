import { pathToFileURL } from "node:url";
import type { MigrationFolder } from "@bodhchakra/db";

export {
  assertWithin,
  type BillingClient,
  type BillingClientConfig,
  type CheckoutResult,
  createBillingClient,
  GRACE_DAYS,
  isLive,
  type Limit,
  type LimitError,
  LimitReached,
  STATUS_EVENTS_PATH,
  type Subscription,
  subscriptionOf,
  TRIAL_DAYS,
} from "./app.ts";
export {
  CHECKOUT_CALL,
  type CheckoutAnswer,
  type CheckoutRequest,
  checkoutAnswer,
  checkoutRequest,
  type Limits,
  limitsOf,
  MAX_SEATS,
  PLANS,
  type Plan,
  REGISTER_TOPIC,
  type Registration,
  registration,
  STATUS_CHANGED_TOPIC,
  STATUSES,
  type Status,
  type StatusChanged,
  statusChanged,
  TRIAL_SEATS,
} from "./contract.ts";

/** The app's copy (`billing.status`); an app lists this after outbox. Platform's own tables live in platform. */
export const migrations: MigrationFolder = {
  name: "billing",
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};

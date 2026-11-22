// The app's side of notify (docs/architecture.md 9.2): a message to a customer or an owner is written to the
// outbox in the business transaction, so it goes out only if that work commits, and waits while platform is
// down. Platform picks the channel, renders the template and retries the send.
import type { DbClient } from "@bodhchakra/db";
import type { Outbox } from "@bodhchakra/outbox";
import { z } from "zod";

/** The outbox topic, and so platform's path `/internal/v1/notify.send`. */
export const NOTIFY_TOPIC = "notify.send";

/**
 * One message, as platform receives it. The product is not in it: platform takes it from the signed client id,
 * so an app can only use its own templates. Variables are display text the app has already formatted (money,
 * dates in the business's time zone); templates only place them.
 */
export const notifyMessage = z.object({
  businessId: z.uuid(),
  /** A template of the sending product, e.g. `quote.sent`. */
  template: z
    .string()
    .max(80)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /**
   * Every address the app has; platform chooses among them. None is a message nobody can receive. A member (an
   * owner) is named by `identityId`, the identity's `sub`: their addresses live in platform, which uses them in
   * place of any given here.
   */
  to: z.object({
    identityId: z.uuid().optional(),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{6,14}$/)
      .optional(),
  }),
  vars: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.string().max(1000)),
});
export type NotifyMessage = z.infer<typeof notifyMessage>;

export interface Notify {
  /**
   * Queues the message on the caller's transaction. `key` names the event it reports (e.g. `quote.sent:<id>`):
   * the same key twice is one message.
   */
  send(client: DbClient, message: NotifyMessage, key: string): Promise<void>;
}

export function createNotify(outbox: Pick<Outbox, "enqueue">): Notify {
  return {
    send: (client, message, key) => outbox.enqueue(client, NOTIFY_TOPIC, message, `notify:${key}`),
  };
}

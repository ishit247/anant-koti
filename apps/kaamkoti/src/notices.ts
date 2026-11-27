// The messages Kaam Koti sends through notify (docs/architecture.md 9.2's table). Each is queued in the transaction
// of the change it reports, so it goes out only if that change commits; platform picks the channel. Variables
// are formatted here, in the business's currency and time zone; platform's templates only place them. A
// customer is given every address their row has; the owner is named by their identity, whose addresses only
// platform holds. Every function but `startWorking` runs inside `withTenant`, after the change it reports.
import { randomUUID } from "node:crypto";
import type { Db, DbClient } from "@bodhchakra/db";
import { defineJob, type Jobs, type JobType } from "@bodhchakra/jobs";
import { formatMoney, money } from "@bodhchakra/money";
import type { Notify, NotifyMessage } from "@bodhchakra/notify";
import type { Payment, PaymentLink } from "@bodhchakra/payments";
import { z } from "zod";
import { requestPageUrl } from "./customer-space.ts";
import { DEPOSIT } from "./deposit.ts";
import { formatDay, formatWhen } from "./job-labels.ts";

export interface Notices {
  /** The job types to pass to `jobs.start`, in the web and the worker. */
  readonly jobTypes: readonly JobType<object>[];
  /** A customer sent a request: the owner is told, the customer gets an acknowledgement. */
  requestReceived(client: DbClient, jobId: string): Promise<void>;
  /** The customer changed a request (an unchanged save is not a change): the owner is told. */
  requestEdited(client: DbClient, jobId: string): Promise<void>;
  /** `quote.sent` to the customer, and the owner's notice at its expiry, unless it is answered first. */
  quoteSent(client: DbClient, quoteId: string): Promise<void>;
  /** The customer accepted, rejected or countered the quote: the owner is told. */
  quoteAnswered(client: DbClient, quoteId: string): Promise<void>;
  /** The owner put a change order to the customer: they are asked to approve or reject it (4.3). */
  changeOrderProposed(client: DbClient, changeOrderId: string): Promise<void>;
  /** A visit was planned (a site visit, or the work once its time is confirmed) or moved: the customer is told when. */
  visitPlanned(client: DbClient, appointmentId: string): Promise<void>;
  /** The owner set out for a planned visit: the customer is told. */
  visitOnTheWay(client: DbClient, appointmentId: string): Promise<void>;
  /** The owner proposed the work's time: the customer is asked to confirm it or ask for another. */
  visitProposed(client: DbClient, appointmentId: string): Promise<void>;
  /** The customer confirmed the proposed time or asked for another: the owner is told. */
  visitAnswered(client: DbClient, appointmentId: string): Promise<void>;
  /** Razorpay's verified webhook recorded money for a job: the owner is told, once per payment. */
  paymentReceived(client: DbClient, payment: Payment, link: PaymentLink): Promise<void>;
  /** Worker only: runs the expiry notices and the visit reminders. Call after `jobs.start`. */
  startWorking(db: Db): Promise<void>;
}

export interface NoticesDeps {
  readonly notify: Notify;
  readonly jobs: Jobs;
  /** The app host: the owner's links. */
  readonly appOrigin: string;
  /** The bare domain: the customer's links. */
  readonly publicOrigin: string;
}

/** The job, its business and the customer who asked, as the messages name them. */
interface JobFacts {
  business_id: string;
  slug: string;
  business_name: string;
  job_id: string;
  number: number;
  customer_name: string;
  email: string | null;
  phone_e164: string;
}

const JOB_COLUMNS = `b.id as business_id, b.slug, b.name as business_name, j.id as job_id, j.number,
  c.name as customer_name, c.email, c.phone_e164`;
const JOB_JOINS = `join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
  join tenancy.business b on b.id = j.business_id`;

async function jobFacts(client: DbClient, jobId: string): Promise<JobFacts> {
  const { rows } = await client.query<JobFacts>(
    `select ${JOB_COLUMNS} from kk.job j ${JOB_JOINS} where j.id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new Error(`notices: job ${jobId} is not here`);
  return job;
}

/** The business's owner's identity (one owner per business, architecture 4.1). */
async function ownerId(client: DbClient): Promise<string> {
  const { rows } = await client.query<{ identity_id: string }>(
    "select identity_id from tenancy.member where role = 'owner' and removed_at is null",
  );
  const owner = rows[0];
  if (!owner) throw new Error("notices: the business has no owner");
  return owner.identity_id;
}

const ownerTo = async (client: DbClient): Promise<NotifyMessage["to"]> => ({
  identityId: await ownerId(client),
});

/**
 * A message to the customer: every address their row has, and the owner, whom platform tells if the business's
 * WhatsApp messages ran out and so the customer got nothing.
 */
const forCustomer = async (
  client: DbClient,
  job: JobFacts,
): Promise<Pick<NotifyMessage, "to" | "owner">> => ({
  to: { ...(job.email && { email: job.email }), phone: job.phone_e164 },
  owner: await ownerId(client),
});

const quoteExpiry = z.object({ businessId: z.uuid(), quoteId: z.uuid() });
// The time is part of the payload: a visit moved since is no longer the one this reminder was queued for.
const visitReminder = z.object({
  businessId: z.uuid(),
  appointmentId: z.uuid(),
  startsAt: z.iso.datetime(),
});

const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

export function createNotices(deps: NoticesDeps): Notices {
  const { notify, jobs } = deps;
  const ownerLink = (jobId: string) => `${deps.appOrigin}/jobs/${jobId}`;
  const customerLink = (job: JobFacts) => requestPageUrl(deps.publicOrigin, job.slug, job.job_id);
  // A failed attempt is retried once a minute; after that the owner has the job page in any case.
  const expiry = defineJob("kaamkoti.quote_expiry", quoteExpiry, {
    retry: { retryLimit: 5, retryDelay: 60 },
  });
  const reminder = defineJob("kaamkoti.visit_reminder", visitReminder, {
    retry: { retryLimit: 5, retryDelay: 60 },
  });

  /** A planned visit's variables for the customer's messages about it. */
  const visitVars = (visit: JobFacts & { kind: string; starts_at: Date }) => ({
    customerName: visit.customer_name,
    businessName: visit.business_name,
    visit: visit.kind === "work" ? ("work visit" as const) : ("site visit" as const),
    when: formatWhen(visit.starts_at),
    link: customerLink(visit),
  });

  /** A quote with its job, as a quote's messages name it; null if no quote of that id has this status. */
  async function quoteFacts(client: DbClient, quoteId: string, statuses: readonly string[]) {
    const { rows } = await client.query<
      JobFacts & {
        status: "sent" | "accepted" | "rejected" | "countered";
        currency: string;
        total_minor: string;
        counter_total_minor: string | null;
        valid_until: Date;
      }
    >(
      `select ${JOB_COLUMNS}, q.status, b.currency, q.total_minor, q.counter_total_minor, q.valid_until
       from kk.quote q
       join kk.job j on j.business_id = q.business_id and j.id = q.job_id
       ${JOB_JOINS}
       where q.id = $1 and q.status = any($2)`,
      [quoteId, statuses],
    );
    return rows[0] ?? null;
  }

  /** A visit with its job, as a visit's messages name it; null if no visit of that id has this status. */
  async function visitFacts(client: DbClient, appointmentId: string, statuses: readonly string[]) {
    const { rows } = await client.query<
      JobFacts & {
        kind: string;
        status: string;
        starts_at: Date;
        customer_note: string | null;
      }
    >(
      `select ${JOB_COLUMNS}, a.kind, a.status, a.starts_at, a.customer_note
       from kk.appointment a
       join kk.job j on j.business_id = a.business_id and j.id = a.job_id
       ${JOB_JOINS}
       where a.id = $1 and a.status = any($2)`,
      [appointmentId, statuses],
    );
    return rows[0] ?? null;
  }

  return {
    jobTypes: [expiry, reminder],

    async requestReceived(client, jobId) {
      const job = await jobFacts(client, jobId);
      const { rows } = await client.query<{ title: string }>(
        "select title from kk.job_task where job_id = $1 and status <> 'dropped' order by added_at, id",
        [jobId],
      );
      const number = `#${job.number}`;
      await notify.send(
        client,
        {
          businessId: job.business_id,
          template: "request.received",
          to: await ownerTo(client),
          vars: {
            customerName: job.customer_name,
            number,
            items: rows.map((task) => `- ${task.title}`).join("\n"),
            link: ownerLink(jobId),
          },
        },
        `request.received:${jobId}`,
      );
      await notify.send(
        client,
        {
          businessId: job.business_id,
          template: "request.acknowledged",
          ...(await forCustomer(client, job)),
          vars: {
            customerName: job.customer_name,
            businessName: job.business_name,
            number,
            link: customerLink(job),
          },
        },
        `request.acknowledged:${jobId}`,
      );
    },

    async requestEdited(client, jobId) {
      const job = await jobFacts(client, jobId);
      await notify.send(
        client,
        {
          businessId: job.business_id,
          template: "request.edited",
          to: await ownerTo(client),
          vars: {
            customerName: job.customer_name,
            number: `#${job.number}`,
            link: ownerLink(jobId),
          },
        },
        // Every saved change is its own message.
        `request.edited:${jobId}:${randomUUID()}`,
      );
    },

    async quoteSent(client, quoteId) {
      const quote = await quoteFacts(client, quoteId, ["sent"]);
      if (!quote) throw new Error(`notices: quote ${quoteId} is not a sent quote here`);
      await notify.send(
        client,
        {
          businessId: quote.business_id,
          template: "quote.sent",
          ...(await forCustomer(client, quote)),
          vars: {
            customerName: quote.customer_name,
            businessName: quote.business_name,
            total: formatMoney(money(Number(quote.total_minor), quote.currency)),
            validUntil: formatDay(quote.valid_until),
            link: customerLink(quote),
          },
        },
        `quote.sent:${quoteId}`,
      );
      await jobs.send(
        client,
        expiry,
        { businessId: quote.business_id, quoteId },
        { startAfter: quote.valid_until },
      );
    },

    async quoteAnswered(client, quoteId) {
      const quote = await quoteFacts(client, quoteId, ["accepted", "rejected", "countered"]);
      if (!quote) throw new Error(`notices: quote ${quoteId} is not an answered quote here`);
      const shown = (minor: string) => formatMoney(money(Number(minor), quote.currency));
      const common = {
        customerName: quote.customer_name,
        number: `#${quote.number}`,
        total: shown(quote.total_minor),
        link: ownerLink(quote.job_id),
      };
      const vars =
        quote.status === "countered"
          ? { ...common, answer: "countered", offered: shown(quote.counter_total_minor ?? "0") }
          : { ...common, answer: quote.status };
      await notify.send(
        client,
        {
          businessId: quote.business_id,
          template: "quote.response",
          to: await ownerTo(client),
          vars,
        },
        `quote.response:${quoteId}`,
      );
    },

    async changeOrderProposed(client, changeOrderId) {
      const { rows } = await client.query<
        JobFacts & { currency: string; change_number: number; total_minor: string }
      >(
        `select ${JOB_COLUMNS}, b.currency, o.number as change_number, o.total_minor
         from kk.change_order o
         join kk.job j on j.business_id = o.business_id and j.id = o.job_id
         ${JOB_JOINS}
         where o.id = $1 and o.status = 'proposed'`,
        [changeOrderId],
      );
      const order = rows[0];
      if (!order) throw new Error(`notices: change order ${changeOrderId} is not proposed here`);
      await notify.send(
        client,
        {
          businessId: order.business_id,
          template: "change_order.proposed",
          ...(await forCustomer(client, order)),
          vars: {
            customerName: order.customer_name,
            businessName: order.business_name,
            number: `#${order.number}`,
            total: formatMoney(money(Number(order.total_minor), order.currency)),
            link: customerLink(order),
          },
        },
        `change_order.proposed:${changeOrderId}`,
      );
    },

    async visitPlanned(client, appointmentId) {
      const visit = await visitFacts(client, appointmentId, ["planned"]);
      if (!visit)
        throw new Error(`notices: appointment ${appointmentId} is not a planned visit here`);
      await notify.send(
        client,
        {
          businessId: visit.business_id,
          template: "appointment.confirmed",
          ...(await forCustomer(client, visit)),
          vars: visitVars(visit),
        },
        // A moved visit is told again; the same time twice is one message.
        `appointment.confirmed:${appointmentId}:${visit.starts_at.toISOString()}`,
      );
      // A visit less than a day away was just told; the reminder is for the ones further out.
      const remindAt = new Date(visit.starts_at.getTime() - REMINDER_LEAD_MS);
      if (remindAt.getTime() > Date.now()) {
        await jobs.send(
          client,
          reminder,
          {
            businessId: visit.business_id,
            appointmentId,
            startsAt: visit.starts_at.toISOString(),
          },
          { startAfter: remindAt },
        );
      }
    },

    async visitOnTheWay(client, appointmentId) {
      const visit = await visitFacts(client, appointmentId, ["planned"]);
      if (!visit)
        throw new Error(`notices: appointment ${appointmentId} is not a planned visit here`);
      const { customerName, businessName, link } = visitVars(visit);
      await notify.send(
        client,
        {
          businessId: visit.business_id,
          template: "appointment.on_the_way",
          ...(await forCustomer(client, visit)),
          vars: { customerName, businessName, link },
        },
        // Once per visit time: a second tap does not message the customer again.
        `appointment.on_the_way:${appointmentId}:${visit.starts_at.toISOString()}`,
      );
    },

    async visitProposed(client, appointmentId) {
      const visit = await visitFacts(client, appointmentId, ["proposed"]);
      if (!visit)
        throw new Error(`notices: appointment ${appointmentId} is not a proposed visit here`);
      await notify.send(
        client,
        {
          businessId: visit.business_id,
          template: "appointment.proposed",
          ...(await forCustomer(client, visit)),
          vars: {
            customerName: visit.customer_name,
            businessName: visit.business_name,
            when: formatWhen(visit.starts_at),
            link: customerLink(visit),
          },
        },
        `appointment.proposed:${appointmentId}`,
      );
    },

    async visitAnswered(client, appointmentId) {
      const visit = await visitFacts(client, appointmentId, ["planned", "declined"]);
      if (!visit)
        throw new Error(`notices: appointment ${appointmentId} is not an answered visit here`);
      const common = {
        customerName: visit.customer_name,
        number: `#${visit.number}`,
        when: formatWhen(visit.starts_at),
        link: ownerLink(visit.job_id),
      };
      await notify.send(
        client,
        {
          businessId: visit.business_id,
          template: "appointment.response",
          to: await ownerTo(client),
          vars:
            visit.status === "planned"
              ? { ...common, answer: "confirmed" }
              : {
                  ...common,
                  answer: "declined",
                  ...(visit.customer_note && { note: visit.customer_note }),
                },
        },
        `appointment.response:${appointmentId}`,
      );
    },

    async paymentReceived(client, payment, link) {
      const job = await jobFacts(client, link.subjectId);
      await notify.send(
        client,
        {
          businessId: job.business_id,
          template: "payment.received",
          to: await ownerTo(client),
          vars: {
            customerName: job.customer_name,
            number: `#${job.number}`,
            amount: formatMoney(payment.amount),
            what: link.purpose === DEPOSIT ? "the deposit" : "the bill",
            link: ownerLink(job.job_id),
          },
        },
        `payment.received:${payment.id}`,
      );
    },

    async startWorking(db) {
      await jobs.work(expiry, ({ businessId, quoteId }) =>
        db.withTenant(businessId, async (client) => {
          // Answered or replaced before it ran out: nothing to tell. Expiry itself is computed, not stored
          // (architecture 6), so a quote still `sent` at this moment is the expired one.
          const quote = await quoteFacts(client, quoteId, ["sent"]);
          if (!quote) return;
          await notify.send(
            client,
            {
              businessId,
              template: "quote.expired",
              to: await ownerTo(client),
              vars: {
                customerName: quote.customer_name,
                number: `#${quote.number}`,
                total: formatMoney(money(Number(quote.total_minor), quote.currency)),
                link: ownerLink(quote.job_id),
              },
            },
            `quote.expired:${quoteId}`,
          );
        }),
      );
      await jobs.work(reminder, ({ businessId, appointmentId, startsAt }) =>
        db.withTenant(businessId, async (client) => {
          const visit = await visitFacts(client, appointmentId, ["planned"]);
          // Moved or cancelled since: the new time queued its own reminder, if it needs one.
          if (!visit || visit.starts_at.toISOString() !== startsAt) return;
          await notify.send(
            client,
            {
              businessId,
              template: "appointment.reminder",
              ...(await forCustomer(client, visit)),
              vars: visitVars(visit),
            },
            `appointment.reminder:${appointmentId}:${startsAt}`,
          );
        }),
      );
    },
  };
}

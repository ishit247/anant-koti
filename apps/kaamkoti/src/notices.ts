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
import { z } from "zod";
import { requestPageUrl } from "./customer-space.ts";
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
  /** A visit was planned or moved: the customer is told when. */
  visitPlanned(client: DbClient, appointmentId: string): Promise<void>;
  /** Worker only: runs the expiry notices. Call after `jobs.start`. */
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

const customerTo = (job: JobFacts): NotifyMessage["to"] => ({
  ...(job.email && { email: job.email }),
  phone: job.phone_e164,
});

/** The business's owner, by identity (one owner per business, architecture 4.1). */
async function ownerTo(client: DbClient): Promise<NotifyMessage["to"]> {
  const { rows } = await client.query<{ identity_id: string }>(
    "select identity_id from tenancy.member where role = 'owner' and removed_at is null",
  );
  const owner = rows[0];
  if (!owner) throw new Error("notices: the business has no owner");
  return { identityId: owner.identity_id };
}

const quoteExpiry = z.object({ businessId: z.uuid(), quoteId: z.uuid() });

export function createNotices(deps: NoticesDeps): Notices {
  const { notify, jobs } = deps;
  const ownerLink = (jobId: string) => `${deps.appOrigin}/jobs/${jobId}`;
  const customerLink = (job: JobFacts) => requestPageUrl(deps.publicOrigin, job.slug, job.job_id);
  // A failed attempt is retried once a minute; after that the owner has the job page in any case.
  const expiry = defineJob("kaamkoti.quote_expiry", quoteExpiry, {
    retry: { retryLimit: 5, retryDelay: 60 },
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

  return {
    jobTypes: [expiry],

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
          to: customerTo(job),
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
          to: customerTo(quote),
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

    async visitPlanned(client, appointmentId) {
      const { rows } = await client.query<{ job_id: string; kind: string; starts_at: Date }>(
        "select job_id, kind, starts_at from kk.appointment where id = $1 and status = 'planned'",
        [appointmentId],
      );
      const visit = rows[0];
      if (!visit)
        throw new Error(`notices: appointment ${appointmentId} is not a planned visit here`);
      const job = await jobFacts(client, visit.job_id);
      await notify.send(
        client,
        {
          businessId: job.business_id,
          template: "appointment.confirmed",
          to: customerTo(job),
          vars: {
            customerName: job.customer_name,
            businessName: job.business_name,
            visit: visit.kind === "work" ? "work visit" : "site visit",
            when: formatWhen(visit.starts_at),
            link: customerLink(job),
          },
        },
        // A moved visit is told again; the same time twice is one message.
        `appointment.confirmed:${appointmentId}:${visit.starts_at.toISOString()}`,
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
    },
  };
}

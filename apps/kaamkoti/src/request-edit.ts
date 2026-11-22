// The customer's own request page (architecture 6, 7): one request with its work items, and the change of those
// items until the business has accepted nothing yet (`requested` or `quoted`). Every query names the customer,
// so another customer's or business's job id is simply not found. A save that changes nothing keeps the quote;
// one that changes an item withdraws the quote (superseded) and puts the request back to `requested`.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import type { CheckedImage, Storage } from "@bodhchakra/storage";
import { z } from "zod";
import { addAddress, chooseAddress, label, type Place, readPlace } from "./address-book.ts";
import type { SpaceCustomer } from "./customer-space.ts";
import {
  activeItemsByName,
  type IntakeInput,
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  MAX_REQUEST_PHOTOS,
  sameName,
} from "./intake.ts";
import { type JobStatus, transitionJob, type WorkItem, workItems } from "./job.ts";
import {
  type AnswerError,
  answerQuote,
  customerQuote,
  type Quote,
  type QuoteAnswer,
} from "./quote.ts";

export interface CustomerRequest {
  readonly id: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly createdAt: Date;
  /** Where and whom, as this request has them (E.164 phone). */
  readonly place: Place;
  /** Work items still in the request, in the order they were added, with the photos sent for each. */
  readonly items: readonly WorkItem[];
  /** The newest quote the business sent, unless replaced; never a draft. */
  readonly quote: Quote | null;
  /** True until the customer accepts a quote: the items can still be changed. */
  readonly editable: boolean;
}

export async function customerRequest(
  client: DbClient,
  customer: SpaceCustomer,
  jobId: string,
): Promise<CustomerRequest | null> {
  // A malformed id is simply not found, rather than a database error.
  if (!z.uuid().safeParse(jobId).success) return null;
  const { rows } = await client.query<{
    id: string;
    number: number;
    status: JobStatus;
    created_at: Date;
    contact_name: string;
    contact_phone_e164: string;
    address: string;
    latitude: number | null;
    longitude: number | null;
  }>(
    `select id, number, status, created_at, contact_name, contact_phone_e164, address, latitude, longitude
     from kk.job
     where business_id = $1 and customer_id = $2 and id = $3`,
    [customer.businessId, customer.id, jobId],
  );
  const job = rows[0];
  if (!job) return null;
  return {
    id: job.id,
    number: job.number,
    status: job.status,
    createdAt: job.created_at,
    place: {
      contactName: job.contact_name,
      contactPhone: job.contact_phone_e164,
      address: job.address,
      location:
        job.latitude !== null && job.longitude !== null
          ? { latitude: job.latitude, longitude: job.longitude }
          : null,
    },
    // Only after the job was found under this customer: both read by job id alone.
    items: await workItems(client, job.id),
    quote: await customerQuote(client, job.id),
    editable: job.status === "requested" || job.status === "quoted",
  };
}

/**
 * The signed-in customer's answer to the quote on their own request (architecture 6, 7). The job is looked up
 * under the customer first, so another customer's or business's job is `not_found`, like a missing one; then
 * `answerQuote` takes only that job's current sent version.
 */
export async function answerRequestQuote(
  client: DbClient,
  audit: Audit,
  customer: SpaceCustomer,
  jobId: string,
  quoteId: string,
  answer: QuoteAnswer,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AnswerError }> {
  if (!z.uuid().safeParse(jobId).success) return { ok: false, error: "not_found" };
  const { rowCount } = await client.query(
    "select 1 from kk.job where business_id = $1 and customer_id = $2 and id = $3",
    [customer.businessId, customer.id, jobId],
  );
  if (rowCount === 0) return { ok: false, error: "not_found" };
  return answerQuote(client, audit, jobId, quoteId, answer);
}

const text = {
  title: z.string().trim().min(1).max(MAX_ITEM_TITLE),
  details: z
    .string()
    .trim()
    .max(MAX_ITEM_DETAILS)
    .transform((s) => s || null),
};
const submitted = z
  .array(z.object({ id: z.union([z.uuid(), z.literal("")]), ...text }))
  .min(1)
  .max(MAX_REQUEST_ITEMS);

export type EditResult =
  | "saved"
  | "unchanged"
  | "not_found"
  | "locked"
  | "contact"
  | "location"
  | "address"
  | "addresses_full"
  | "items"
  | "too_many_photos";

/**
 * The place of the form, as a new request sends it (a saved address by id, or a typed place saved under `label`
 * if `saveAddress`), checked: a saved address must be this customer's own.
 */
async function choosePlace(
  client: DbClient,
  customer: SpaceCustomer,
  choice: IntakeInput,
): Promise<{ ok: true; place: Place } | { ok: false; error: EditResult }> {
  if (choice.addressId) {
    const saved = await chooseAddress(client, customer, choice.addressId);
    return saved ? { ok: true, place: saved } : { ok: false, error: "address" };
  }
  const read = readPlace(choice);
  if (!read.ok) return read;
  if (choice.saveAddress) {
    const name = label.safeParse(choice.label);
    if (!name.success) return { ok: false, error: "contact" };
    if ((await addAddress(client, customer, name.data, read.place)) === "full")
      return { ok: false, error: "addresses_full" };
  }
  return read;
}

/**
 * The customer's edit of their request, as the form sends it: where and whom, and the items. An item with the id
 * of a task is kept (and may change), one without is new, and a task no item names is dropped. `photos[i]` are
 * the checked photos newly added to `items[i]`; with the photos the kept items already hold they are at most
 * `MAX_REQUEST_PHOTOS`. A changed place counts as a change like a changed item does. The job row is locked
 * first, so a quote sent or answered at the same moment is never half-edited over.
 */
export async function editRequest(
  client: DbClient,
  storage: Storage,
  audit: Audit,
  customer: SpaceCustomer,
  jobId: string,
  input: IntakeInput,
  photos: readonly (readonly CheckedImage[])[],
): Promise<EditResult> {
  if (!z.uuid().safeParse(jobId).success) return "not_found";
  const { rows } = await client.query<{ status: JobStatus }>(
    `select status from kk.job where business_id = $1 and customer_id = $2 and id = $3 for update`,
    [customer.businessId, customer.id, jobId],
  );
  const job = rows[0];
  if (!job) return "not_found";
  if (job.status !== "requested" && job.status !== "quoted") return "locked";

  const parsed = submitted.safeParse(input.items.map((i) => ({ id: i.id ?? "", ...i })));
  if (!parsed.success) return "items";
  const current = await client.query<{ id: string; title: string; details: string | null }>(
    `select id, title, details from kk.job_task
     where business_id = $1 and job_id = $2 and status <> 'dropped'`,
    [customer.businessId, jobId],
  );
  const existing = new Map(current.rows.map((t) => [t.id, t]));
  const named = new Set(parsed.data.map((i) => i.id).filter(Boolean));
  // An id that is not an item of this request (another customer's, or one already dropped) is not honoured.
  if (
    named.size !== parsed.data.filter((i) => i.id).length ||
    [...named].some((id) => !existing.has(id))
  )
    return "items";

  const kept = await client.query<{ n: number }>(
    `select count(*)::int as n from kk.job_photo
     where business_id = $1 and job_id = $2 and job_task_id = any($3::uuid[])`,
    [customer.businessId, jobId, [...named]],
  );
  const added = photos.reduce((n, list) => n + list.length, 0);
  if ((kept.rows[0]?.n ?? 0) + added > MAX_REQUEST_PHOTOS) return "too_many_photos";

  // The place comes last among the refusals: nothing is written until the whole edit is accepted.
  const where = await choosePlace(client, customer, input);
  if (!where.ok) return where.error;
  const { place } = where;
  // Only a difference updates a row, so the count says whether the place changed.
  const relocated = await client.query(
    `update kk.job set contact_name = $4, contact_phone_e164 = $5, address = $6, latitude = $7, longitude = $8
     where business_id = $1 and customer_id = $2 and id = $3
       and (contact_name, contact_phone_e164, address, latitude, longitude)
           is distinct from ($4, $5, $6, $7::float8, $8::float8)`,
    [
      customer.businessId,
      customer.id,
      jobId,
      place.contactName,
      place.contactPhone,
      place.address,
      place.location?.latitude ?? null,
      place.location?.longitude ?? null,
    ],
  );
  const placeChanged = (relocated.rowCount ?? 0) > 0;

  const catalogue = await activeItemsByName(client);
  const resolved = parsed.data.map((item) => {
    const match = catalogue.get(sameName(item.title));
    return { ...item, title: match?.name ?? item.title, catalogueId: match?.id ?? null };
  });
  const changed =
    placeChanged ||
    resolved.length !== existing.size ||
    resolved.some((item, i) => {
      const before = existing.get(item.id);
      return (
        !before ||
        before.title !== item.title ||
        (before.details ?? null) !== item.details ||
        (photos[i]?.length ?? 0) > 0
      );
    });
  if (!changed) return "unchanged";

  for (const id of existing.keys())
    if (!named.has(id))
      await client.query(
        "update kk.job_task set status = 'dropped' where business_id = $1 and job_id = $2 and id = $3",
        [customer.businessId, jobId, id],
      );
  for (const [i, item] of resolved.entries()) {
    let taskId = item.id;
    if (taskId)
      // Back to `requested`: its price in a withdrawn quote no longer stands.
      await client.query(
        `update kk.job_task set title = $4, details = $5, catalogue_item_id = $6, status = 'requested'
         where business_id = $1 and job_id = $2 and id = $3`,
        [customer.businessId, jobId, taskId, item.title, item.details, item.catalogueId],
      );
    else {
      const inserted = await client.query<{ id: string }>(
        `insert into kk.job_task (business_id, job_id, catalogue_item_id, title, details, added_by)
         values ($1, $2, $3, $4, $5, 'customer') returning id`,
        [customer.businessId, jobId, item.catalogueId, item.title, item.details],
      );
      taskId = inserted.rows[0]?.id ?? "";
      if (!taskId) throw new Error("editRequest: the task insert returned no row");
    }
    for (const image of photos[i] ?? []) {
      const object = await storage.putImage(client, image, null);
      await client.query(
        `insert into kk.job_photo (business_id, job_id, job_task_id, object_id, kind)
         values ($1, $2, $3, $4, 'request')`,
        [customer.businessId, jobId, taskId, object.id],
      );
    }
  }
  if (job.status === "quoted") {
    await client.query(
      `update kk.quote set status = 'superseded'
       where business_id = $1 and job_id = $2 and status in ('sent', 'rejected', 'countered')`,
      [customer.businessId, jobId],
    );
    const moved = await transitionJob(client, audit, jobId, {
      event: "edit",
      actor: { role: "customer" },
    });
    if (!moved.ok) throw new Error("editRequest: a quoted request would not go back to requested");
  }
  return "saved";
}

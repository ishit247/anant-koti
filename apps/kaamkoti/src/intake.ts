// The public request form (docs/architecture.md 4.3, scope `public-intake`): a slug opens one business, and the
// form may only create a request in it. Everything the customer sent is checked here, before any write: the
// contact details and address, the picked location, the work items and their photos (checkImage). Then one
// transaction writes the customer, the job, a task per work item with its photos, and the link the customer is
// sent to. A work item whose title is the name of one of the business's active catalogue items is that item, at
// its price; any other title is the customer's own words, for the business to price in the quote.
import type { Db, DbClient } from "@bodhchakra/db";
import { type CheckedImage, checkImage, type Storage } from "@bodhchakra/storage";
import { resolveSlug } from "@bodhchakra/tenancy";
import { z } from "zod";
import { businessProfile } from "./business-profile.ts";
import { issueJobLink } from "./job-link.ts";

/** Up to this many photos per request, across its work items (docs/architecture.md 10). */
export const MAX_REQUEST_PHOTOS = 6;
export const MAX_REQUEST_ITEMS = 20;
export const MAX_ITEM_TITLE = 120;
export const MAX_ITEM_DETAILS = 1000;

/** One work item as it arrived. */
export interface WorkItemInput {
  readonly title: string;
  readonly details: string;
  readonly photos: readonly Uint8Array[];
}

/** The form as it arrived; nothing in it is trusted yet. */
export interface IntakeInput {
  readonly name: string;
  readonly phone: string;
  readonly address: string;
  /** Both empty unless the customer picked their location. */
  readonly latitude: string;
  readonly longitude: string;
  readonly items: readonly WorkItemInput[];
}

export type IntakeError =
  | "not_found"
  | "contact"
  | "location"
  | "items"
  | "too_many_photos"
  | "photo_too_large"
  | "photo_not_an_image";

export type IntakeResult =
  | { readonly ok: true; readonly jobId: string; readonly number: number; readonly secret: string }
  | { readonly ok: false; readonly error: IntakeError };

const ITEM_FIELD = /^item\.(\d{1,2})\.(title|details|photo)$/;

/**
 * The form's fields as the page names them: `name`, `phone`, `address`, `latitude`, `longitude`, and per work
 * item `item.<n>.title`, `item.<n>.details` and `item.<n>.photo` (files). Items keep the order of `<n>`. An
 * empty file input arrives as a file of 0 bytes and is skipped, and so is an item left wholly blank.
 */
export async function readIntakeForm(form: FormData): Promise<IntakeInput> {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const items = new Map<number, { title: string; details: string; photos: Uint8Array[] }>();
  for (const [name, value] of form) {
    const field = ITEM_FIELD.exec(name);
    if (!field) continue;
    const n = Number(field[1]);
    const item = items.get(n) ?? { title: "", details: "", photos: [] };
    items.set(n, item);
    if (field[2] === "photo") {
      if (typeof value !== "string" && value.size > 0)
        item.photos.push(new Uint8Array(await value.arrayBuffer()));
    } else if (typeof value === "string") item[field[2] === "title" ? "title" : "details"] = value;
  }
  return {
    name: text("name"),
    phone: text("phone"),
    address: text("address"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    items: [...items]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item)
      .filter((item) => item.title.trim() || item.details.trim() || item.photos.length > 0),
  };
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * A phone number as people type it in India, in E.164: a 10-digit mobile, with or without 0 or 91 in front,
 * or a full +<country> number. Anything else is returned as typed, and the E.164 check refuses it.
 */
export function toE164(typed: string): string {
  const compact = typed.replace(/[\s().-]/g, "");
  const indian = /^(?:\+?91|0)?([6-9][0-9]{9})$/.exec(compact);
  if (indian) return `+91${indian[1]}`;
  return compact;
}

export const contact = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().transform(toE164).pipe(z.string().regex(E164)),
  address: z.string().trim().min(1).max(500),
});

/** A number typed as text; an empty string is refused, not read as 0. */
const coordinate = (limit: number) =>
  z.string().trim().min(1).pipe(z.coerce.number<string>().min(-limit).max(limit));

/** Null when no location was picked; anything else must be a real coordinate pair. */
const location = z.union([
  z.object({ latitude: z.literal(""), longitude: z.literal("") }).transform(() => null),
  z.object({ latitude: coordinate(90), longitude: coordinate(180) }),
]);
export type Location = { readonly latitude: number; readonly longitude: number };

const workItems = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(MAX_ITEM_TITLE),
      details: z
        .string()
        .trim()
        .max(MAX_ITEM_DETAILS)
        .transform((s) => s || null),
    }),
  )
  .min(1)
  .max(MAX_REQUEST_ITEMS);

/** The same name, whatever the case and spacing the customer typed it with. */
const sameName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Creates a request from the public form of the business with this slug. */
export async function submitRequest(
  db: Db,
  storage: Storage,
  slug: string,
  input: IntakeInput,
): Promise<IntakeResult> {
  const person = contact.safeParse(input);
  if (!person.success) return { ok: false, error: "contact" };
  const place = location.safeParse(input);
  if (!place.success) return { ok: false, error: "location" };
  const items = workItems.safeParse(input.items);
  if (!items.success) return { ok: false, error: "items" };
  if (input.items.flatMap((item) => item.photos).length > MAX_REQUEST_PHOTOS)
    return { ok: false, error: "too_many_photos" };

  // Decoding is the slow part; it runs before a connection is taken.
  const photos: CheckedImage[][] = [];
  for (const item of input.items) {
    const checkedItem: CheckedImage[] = [];
    for (const bytes of item.photos) {
      const checked = await checkImage(bytes);
      if (!checked.ok)
        return {
          ok: false,
          error: checked.reason === "too_large" ? "photo_too_large" : "photo_not_an_image",
        };
      checkedItem.push(checked.image);
    }
    photos.push(checkedItem);
  }

  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) return { ok: false, error: "not_found" };
  return db.withTenant(businessId, async (client): Promise<IntakeResult> => {
    if (!(await businessProfile(client))) return { ok: false, error: "not_found" };
    const catalogue = await activeItemsByName(client);

    const customerId = await findOrCreateCustomer(client, businessId, person.data);
    const job = await createJob(client, businessId, customerId, person.data, place.data);
    for (const [i, item] of items.data.entries()) {
      const known = catalogue.get(sameName(item.title));
      const { rows } = await client.query<{ id: string }>(
        `insert into kk.job_task (business_id, job_id, catalogue_item_id, title, details, added_by)
         values ($1, $2, $3, $4, $5, 'customer')
         returning id`,
        [businessId, job.id, known?.id ?? null, known?.name ?? item.title, item.details],
      );
      const task = rows[0];
      if (!task) throw new Error("intake: the task insert returned no row");
      for (const image of photos[i] ?? []) {
        const object = await storage.putImage(client, image, null);
        await client.query(
          `insert into kk.job_photo (business_id, job_id, job_task_id, object_id, kind)
           values ($1, $2, $3, $4, 'request')`,
          [businessId, job.id, task.id, object.id],
        );
      }
    }
    const { secret } = await issueJobLink(client, job.id);
    return { ok: true, jobId: job.id, number: job.number, secret };
  });
}

/** The business's active catalogue items by name; the first in display order wins a shared name. */
async function activeItemsByName(client: DbClient) {
  const { rows } = await client.query<{ id: string; name: string }>(
    "select id, name from kk.catalogue_item where active order by position desc",
  );
  // Reversed, so the earliest item is set last and wins.
  return new Map(rows.map((row) => [sameName(row.name), row]));
}

/** The requested items that this business offers now, in its display order. RLS keeps other businesses out. */
export async function activeItems(client: DbClient, ids: readonly string[]) {
  const { rows } = await client.query<{ id: string; name: string }>(
    `select id, name from kk.catalogue_item where id = any($1::uuid[]) and active order by position`,
    [ids],
  );
  return rows;
}

export type Contact = z.infer<typeof contact>;

/**
 * The business's customer with this phone, or a new one. An existing customer's details are left alone: a form
 * anyone can fill in must not rename someone else's customer record. This request's address goes on the job.
 */
export async function findOrCreateCustomer(
  client: DbClient,
  businessId: string,
  person: Contact,
): Promise<string> {
  const created = await client.query<{ id: string }>(
    `insert into kk.customer (business_id, name, phone_e164, address) values ($1, $2, $3, $4)
     on conflict (business_id, phone_e164) do nothing
     returning id`,
    [businessId, person.name, person.phone, person.address],
  );
  if (created.rows[0]) return created.rows[0].id;
  const { rows } = await client.query<{ id: string }>(
    "select id from kk.customer where phone_e164 = $1",
    [person.phone],
  );
  const existing = rows[0];
  // The insert conflicted, so the row exists, and the app can never delete a customer.
  if (!existing) throw new Error("intake: customer conflict without a customer");
  return existing.id;
}

/** Numbers run per business; the lock makes concurrent requests to one business take turns for the next one. */
export async function createJob(
  client: DbClient,
  businessId: string,
  customerId: string,
  person: Contact,
  place: Location | null,
  source: "public_form" | "phone" = "public_form",
): Promise<{ id: string; number: number }> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('kk.job.number:' || $1, 0))", [
    businessId,
  ]);
  const { rows } = await client.query<{ id: string; number: number }>(
    `insert into kk.job (business_id, customer_id, number, source, address, latitude, longitude)
     select $1, $2, coalesce(max(number), 0) + 1, $3, $4, $5, $6 from kk.job
     returning id, number`,
    [
      businessId,
      customerId,
      source,
      person.address,
      place?.latitude ?? null,
      place?.longitude ?? null,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("intake: the job insert returned no row");
  return job;
}

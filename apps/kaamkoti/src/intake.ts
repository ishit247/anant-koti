// The request form (docs/architecture.md 4.3, 7; scope `customer` since D15): a signed-in customer asks one
// business, the slug's, for work. Everything they sent is checked here, before any write: where and whom (one of
// their saved addresses, or a place typed with its contact and picked location), the work items and their photos
// (checkImage). Then one transaction writes the job with its own copy of the contact and address, a task per work
// item with its photos, and a job link (until step 3.2f's second half replaces links with the customer's job
// page). A work item whose title is the name of one of the business's active catalogue items is that item, at
// its price; any other title is the customer's own words, for the business to price in the quote.
import type { Audit } from "@bodhchakra/audit";
import type { CustomerSession } from "@bodhchakra/auth";
import type { Db, DbClient } from "@bodhchakra/db";
import { type CheckedImage, checkImage, type Storage } from "@bodhchakra/storage";
import { resolveSlug } from "@bodhchakra/tenancy";
import { z } from "zod";
import {
  addAddress,
  chooseAddress,
  label,
  type Place,
  type PlaceInput,
  readPlace,
  readPlaceForm,
} from "./address-book.ts";
import { businessProfile } from "./business-profile.ts";
import { customerFor, type SpaceCustomer } from "./customer-space.ts";
import type { Notices } from "./notices.ts";
import { phone } from "./phone.ts";

/** Up to this many photos per request, across its work items (docs/architecture.md 10). */
export const MAX_REQUEST_PHOTOS = 6;
export const MAX_REQUEST_ITEMS = 20;
export const MAX_ITEM_TITLE = 120;
export const MAX_ITEM_DETAILS = 1000;

/** One work item as it arrived. */
export interface WorkItemInput {
  /** Only when editing a request: the task this item already is; absent or empty for a new item. */
  readonly id?: string;
  readonly title: string;
  readonly details: string;
  readonly photos: readonly Uint8Array[];
}

/**
 * The form as it arrived; nothing in it is trusted yet. With `addressId` set, the job goes to that saved address
 * and the typed place is ignored; empty, the typed place is used, and saved under `label` if `saveAddress`.
 */
export interface IntakeInput extends PlaceInput {
  readonly addressId: string;
  readonly saveAddress: boolean;
  readonly label: string;
  readonly items: readonly WorkItemInput[];
}

export type IntakeError =
  | "not_found"
  | "contact"
  | "phone_taken"
  | "location"
  | "address"
  | "addresses_full"
  | "items"
  | "too_many_photos"
  | "photo_too_large"
  | "photo_not_an_image";

export type IntakeResult =
  | { readonly ok: true; readonly jobId: string; readonly number: number }
  | { readonly ok: false; readonly error: IntakeError };

const ITEM_FIELD = /^item\.(\d{1,2})\.(id|title|details|photo)$/;

/**
 * The form's fields as the page names them: `addressId`, the place fields (readPlaceForm), `saveAddress` (a
 * checkbox) and `label`, and per work item `item.<n>.title`, `item.<n>.details` and `item.<n>.photo` (files).
 * Items keep the order of `<n>`. An empty file input arrives as a file of 0 bytes and is skipped, and so is an
 * item left wholly blank.
 */
export async function readIntakeForm(form: FormData): Promise<IntakeInput> {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const items = new Map<
    number,
    { id?: string; title: string; details: string; photos: Uint8Array[] }
  >();
  for (const [name, value] of form) {
    const field = ITEM_FIELD.exec(name);
    if (!field) continue;
    const n = Number(field[1]);
    const item = items.get(n) ?? { title: "", details: "", photos: [] };
    items.set(n, item);
    if (field[2] === "photo") {
      if (typeof value !== "string" && value.size > 0)
        item.photos.push(new Uint8Array(await value.arrayBuffer()));
    } else if (typeof value === "string") item[field[2] as "id" | "title" | "details"] = value;
  }
  return {
    ...readPlaceForm(form),
    addressId: text("addressId"),
    saveAddress: text("saveAddress") === "on",
    label: text("label"),
    items: [...items]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item)
      .filter(
        (item) => item.id || item.title.trim() || item.details.trim() || item.photos.length > 0,
      ),
  };
}

/** The owner's phone enquiry: the customer's name and mobile, and the address of this request. */
export const contact = z.object({
  name: z.string().trim().min(1).max(120),
  phone,
  address: z.string().trim().min(1).max(500),
});

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

/**
 * The photos of every item decoded and checked, before a connection is taken: decoding is the slow part. At most
 * `MAX_REQUEST_PHOTOS` in all (an edit counts the photos already kept as well).
 */
export async function checkItemPhotos(
  items: readonly WorkItemInput[],
  alreadyKept = 0,
): Promise<
  | { readonly ok: true; readonly photos: CheckedImage[][] }
  | {
      readonly ok: false;
      readonly error: "too_many_photos" | "photo_too_large" | "photo_not_an_image";
    }
> {
  if (alreadyKept + items.flatMap((item) => item.photos).length > MAX_REQUEST_PHOTOS)
    return { ok: false, error: "too_many_photos" };
  const photos: CheckedImage[][] = [];
  for (const item of items) {
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
  return { ok: true, photos };
}

/** The same name, whatever the case and spacing the customer typed it with. */
export const sameName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Creates a request from the signed-in customer to the business with this slug, and queues its notices in the
 * same transaction.
 */
export async function submitRequest(
  db: Db,
  storage: Storage,
  audit: Audit,
  notices: Pick<Notices, "requestReceived">,
  slug: string,
  session: CustomerSession,
  input: IntakeInput,
): Promise<IntakeResult> {
  // A saved address is looked up in the customer's own book inside the transaction; a typed place is checked
  // now, and so is the label it is to be saved under.
  let typed: Place | null = null;
  let saveAs: string | null = null;
  if (!input.addressId) {
    const read = readPlace(input);
    if (!read.ok) return read;
    typed = read.place;
    if (input.saveAddress) {
      const name = label.safeParse(input.label);
      if (!name.success) return { ok: false, error: "contact" };
      saveAs = name.data;
    }
  }
  const items = workItems.safeParse(input.items);
  if (!items.success) return { ok: false, error: "items" };

  const checked = await checkItemPhotos(input.items);
  if (!checked.ok) return checked;
  const photos = checked.photos;

  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) return { ok: false, error: "not_found" };
  return db.withTenant(businessId, async (client): Promise<IntakeResult> => {
    if (!(await businessProfile(client))) return { ok: false, error: "not_found" };
    const catalogue = await activeItemsByName(client);

    // A first request: the customer's own name and mobile are the ones they typed for the place. Someone with
    // no row yet has no saved addresses, so a saved address id from them is refused like any other.
    const customer =
      (await customerFor(client, audit, session)) ??
      (typed ? await newCustomer(client, audit, session, businessId, typed) : null);
    if (!customer) return { ok: false, error: typed ? "phone_taken" : "address" };
    let where: Place;
    if (typed) {
      if (saveAs && (await addAddress(client, customer, saveAs, typed)) === "full")
        return { ok: false, error: "addresses_full" };
      where = typed;
    } else {
      // Only the customer's own book is searched, so another customer's id is not found.
      const saved = await chooseAddress(client, customer, input.addressId);
      if (!saved) return { ok: false, error: "address" };
      where = saved;
    }
    const job = await createJob(client, businessId, customer.id, where);
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
    await notices.requestReceived(client, job.id);
    return { ok: true, jobId: job.id, number: job.number };
  });
}

/** The business's active catalogue items by name; the first in display order wins a shared name. */
export async function activeItemsByName(client: DbClient) {
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
 * A new customer row for the signed-in person, with the name and mobile of the place they typed on their first
 * request. Null when the mobile is on another customer's row: a phone is not verified yet (3.3), so typing
 * someone's number must neither file the request under their record nor take the number over.
 */
async function newCustomer(
  client: DbClient,
  audit: Audit,
  session: CustomerSession,
  businessId: string,
  first: Place,
): Promise<SpaceCustomer | null> {
  const created = await client.query<{ id: string }>(
    `insert into kk.customer (business_id, identity_id, name, phone_e164, email)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning id`,
    [businessId, session.identityId, first.contactName, first.contactPhone, session.email],
  );
  if (created.rows[0]) return { id: created.rows[0].id, businessId };
  // Either the same person's other request created their row a moment ago, or the phone is someone else's.
  return customerFor(client, audit, session);
}

/**
 * The business's customer with this phone, or a new one (the owner's phone enquiry). An existing customer's
 * details are left alone. This request's address goes on the job and into the customer's book.
 */
export async function findOrCreateCustomer(
  client: DbClient,
  businessId: string,
  person: Contact,
): Promise<string> {
  const created = await client.query<{ id: string }>(
    `insert into kk.customer (business_id, name, phone_e164) values ($1, $2, $3)
     on conflict (business_id, phone_e164) do nothing
     returning id`,
    [businessId, person.name, person.phone],
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
  place: Place,
  source: "public_form" | "phone" = "public_form",
): Promise<{ id: string; number: number }> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('kk.job.number:' || $1, 0))", [
    businessId,
  ]);
  const { rows } = await client.query<{ id: string; number: number }>(
    `insert into kk.job (business_id, customer_id, number, source, contact_name, contact_phone_e164, address,
                         latitude, longitude)
     select $1, $2, coalesce(max(number), 0) + 1, $3, $4, $5, $6, $7, $8 from kk.job
     returning id, number`,
    [
      businessId,
      customerId,
      source,
      place.contactName,
      place.contactPhone,
      place.address,
      place.location?.latitude ?? null,
      place.location?.longitude ?? null,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("intake: the job insert returned no row");
  return job;
}

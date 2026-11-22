// The customer's address book in one business (docs/architecture.md 5.3, 7): the places they ask for work at,
// each with the person to meet there (a parent's house, a shop). Every query names the customer as well as the
// address, inside withTenant, so another customer's or another business's address is never found: a forged id
// reads as a missing one.
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";
import type { SpaceCustomer } from "./customer-space.ts";
import { phone } from "./phone.ts";

export const MAX_ADDRESSES = 10;
export const MAX_ADDRESS = 500;
export const MAX_LABEL = 40;

export type Location = { readonly latitude: number; readonly longitude: number };

/** Where the work is and whom to meet there, checked. A job copies this at send. */
export interface Place {
  readonly contactName: string;
  /** E.164. */
  readonly contactPhone: string;
  readonly address: string;
  /** The point picked with "Use my current location", if one was. */
  readonly location: Location | null;
}

/** A place as a form posts it; nothing in it is trusted yet. Both coordinates are empty unless one was picked. */
export interface PlaceInput {
  readonly contactName: string;
  readonly contactPhone: string;
  readonly address: string;
  readonly latitude: string;
  readonly longitude: string;
}

export interface SavedAddress extends Place {
  readonly id: string;
  readonly label: string;
}

const who = z.object({
  contactName: z.string().trim().min(1).max(120),
  contactPhone: phone,
  address: z.string().trim().min(1).max(MAX_ADDRESS),
});

/** A number typed as text; an empty string is refused, not read as 0. */
const coordinate = (limit: number) =>
  z.string().trim().min(1).pipe(z.coerce.number<string>().min(-limit).max(limit));

/** Null when no location was picked; anything else must be a real coordinate pair. */
const point = z.union([
  z.object({ latitude: z.literal(""), longitude: z.literal("") }).transform(() => null),
  z.object({ latitude: coordinate(90), longitude: coordinate(180) }),
]);

export const label = z.string().trim().min(1).max(MAX_LABEL);

export type PlaceError = "contact" | "location";

/** The typed place, or which part of it is wrong. */
export function readPlace(
  input: PlaceInput,
):
  | { readonly ok: true; readonly place: Place }
  | { readonly ok: false; readonly error: PlaceError } {
  const person = who.safeParse(input);
  if (!person.success) return { ok: false, error: "contact" };
  const at = point.safeParse(input);
  if (!at.success) return { ok: false, error: "location" };
  return { ok: true, place: { ...person.data, location: at.data } };
}

/** The place fields of a posted form, named as the pages name them. */
export function readPlaceForm(form: FormData): PlaceInput {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    contactName: text("contactName"),
    contactPhone: text("contactPhone"),
    address: text("address"),
    latitude: text("latitude"),
    longitude: text("longitude"),
  };
}

interface AddressRow {
  id: string;
  label: string;
  contact_name: string;
  contact_phone_e164: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

const COLUMNS = "id, label, contact_name, contact_phone_e164, address, latitude, longitude";

const toSaved = (row: AddressRow): SavedAddress => ({
  id: row.id,
  label: row.label,
  contactName: row.contact_name,
  contactPhone: row.contact_phone_e164,
  address: row.address,
  // The table's check keeps the two together.
  location:
    row.latitude !== null && row.longitude !== null
      ? { latitude: row.latitude, longitude: row.longitude }
      : null,
});

const anId = z.uuid();

/** The customer's saved addresses, the most recently used first. */
export async function addressBook(
  client: DbClient,
  customer: SpaceCustomer,
): Promise<SavedAddress[]> {
  const { rows } = await client.query<AddressRow>(
    `select ${COLUMNS} from kk.customer_address
     where business_id = $1 and customer_id = $2
     order by last_used_at desc, created_at desc`,
    [customer.businessId, customer.id],
  );
  return rows.map(toSaved);
}

/** The customer's own saved address with this id, marked as just used; null for any other id. */
export async function chooseAddress(
  client: DbClient,
  customer: SpaceCustomer,
  id: string,
): Promise<SavedAddress | null> {
  if (!anId.safeParse(id).success) return null;
  const { rows } = await client.query<AddressRow>(
    `update kk.customer_address set last_used_at = now()
     where business_id = $1 and customer_id = $2 and id = $3
     returning ${COLUMNS}`,
    [customer.businessId, customer.id, id],
  );
  return rows[0] ? toSaved(rows[0]) : null;
}

/**
 * Saves a place in the customer's book, unless the same place (address, name and mobile) is there already,
 * which is only marked as used. "full" when the book holds MAX_ADDRESSES; the lock on the customer row makes
 * two saves at once take turns, so they cannot both take the last place.
 */
export async function addAddress(
  client: DbClient,
  customer: SpaceCustomer,
  name: string,
  place: Place,
): Promise<"saved" | "full"> {
  await client.query("select 1 from kk.customer where business_id = $1 and id = $2 for update", [
    customer.businessId,
    customer.id,
  ]);
  const same = await client.query(
    `update kk.customer_address set last_used_at = now()
     where business_id = $1 and customer_id = $2
       and address = $3 and contact_name = $4 and contact_phone_e164 = $5`,
    [customer.businessId, customer.id, place.address, place.contactName, place.contactPhone],
  );
  if ((same.rowCount ?? 0) > 0) return "saved";
  const { rows } = await client.query<{ id: string }>(
    `insert into kk.customer_address (business_id, customer_id, label, contact_name, contact_phone_e164,
                                      address, latitude, longitude)
     select $1, $2, $3, $4, $5, $6, $7, $8
     where (select count(*) from kk.customer_address where business_id = $1 and customer_id = $2) < $9
     returning id`,
    [
      customer.businessId,
      customer.id,
      name,
      place.contactName,
      place.contactPhone,
      place.address,
      place.location?.latitude ?? null,
      place.location?.longitude ?? null,
      MAX_ADDRESSES,
    ],
  );
  return rows[0] ? "saved" : "full";
}

/** Changes one of the customer's own addresses; false for any other id. Jobs keep their own copy. */
export async function updateAddress(
  client: DbClient,
  customer: SpaceCustomer,
  id: string,
  name: string,
  place: Place,
): Promise<boolean> {
  if (!anId.safeParse(id).success) return false;
  const { rowCount } = await client.query(
    `update kk.customer_address
     set label = $4, contact_name = $5, contact_phone_e164 = $6, address = $7, latitude = $8, longitude = $9
     where business_id = $1 and customer_id = $2 and id = $3`,
    [
      customer.businessId,
      customer.id,
      id,
      name,
      place.contactName,
      place.contactPhone,
      place.address,
      place.location?.latitude ?? null,
      place.location?.longitude ?? null,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Removes one of the customer's own addresses; false for any other id. Jobs keep their own copy. */
export async function deleteAddress(
  client: DbClient,
  customer: SpaceCustomer,
  id: string,
): Promise<boolean> {
  if (!anId.safeParse(id).success) return false;
  const { rowCount } = await client.query(
    "delete from kk.customer_address where business_id = $1 and customer_id = $2 and id = $3",
    [customer.businessId, customer.id, id],
  );
  return (rowCount ?? 0) > 0;
}

// The public request form (docs/architecture.md 4.3, scope `public-intake`): a slug opens one business, and the
// form may only create a request in it. Everything the customer sent is checked here, before any write: the
// contact details, the tasks (active catalogue items of this business), the answers (this business's
// questions) and the photos (checkImage). Then one transaction writes the customer, the job, its tasks and
// photos, and the link the customer is sent to.
import type { Db, DbClient } from "@bodhchakra/db";
import { type CheckedImage, checkImage, type Storage } from "@bodhchakra/storage";
import { resolveSlug } from "@bodhchakra/tenancy";
import { z } from "zod";
import { businessProfile } from "./business-profile.ts";
import { issueJobLink } from "./job-link.ts";
import type { intakeQuestion } from "./trade-template.ts";

/** Up to this many photos per request (docs/architecture.md 10). */
export const MAX_REQUEST_PHOTOS = 6;
export const MAX_REQUEST_TASKS = 20;
const MAX_TEXT_ANSWER = 1000;
const MAX_NUMBER_ANSWER = 1_000_000;

/** The form as it arrived; nothing in it is trusted yet. */
export interface IntakeInput {
  /** Catalogue item ids. */
  readonly tasks: readonly string[];
  readonly name: string;
  readonly phone: string;
  readonly address: string;
  readonly preferredWindow: string;
  /** By question key. */
  readonly answers: Readonly<Record<string, string>>;
  /** Each under the key of the photo question it answers. */
  readonly photos: readonly { readonly question: string; readonly bytes: Uint8Array }[];
}

export type IntakeError =
  | "not_found"
  | "contact"
  | "tasks"
  | "answers"
  | "too_many_photos"
  | "photo_too_large"
  | "photo_not_an_image";

export type IntakeResult =
  | { readonly ok: true; readonly jobId: string; readonly number: number; readonly secret: string }
  | { readonly ok: false; readonly error: IntakeError };

/**
 * The form's fields as the page names them: `task` (repeated), `name`, `phone`, `address`, `preferredWindow`,
 * `q.<key>` for an answer and `photo.<key>` for the files answering a photo question. An empty file input
 * arrives as a file of 0 bytes and is skipped.
 */
export async function readIntakeForm(form: FormData): Promise<IntakeInput> {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const answers: Record<string, string> = {};
  const photos: { question: string; bytes: Uint8Array }[] = [];
  for (const [name, value] of form) {
    if (name.startsWith("q.") && typeof value === "string") answers[name.slice(2)] = value;
    else if (name.startsWith("photo.") && typeof value !== "string" && value.size > 0)
      photos.push({ question: name.slice(6), bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  return {
    tasks: form.getAll("task").filter((v) => typeof v === "string"),
    name: text("name"),
    phone: text("phone"),
    address: text("address"),
    preferredWindow: text("preferredWindow"),
    answers,
    photos,
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

const contact = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().transform(toE164).pipe(z.string().regex(E164)),
  address: z.string().trim().min(1).max(500),
  preferredWindow: z
    .string()
    .trim()
    .max(200)
    .transform((s) => s || null),
});

const taskIds = z.array(z.uuid()).min(1).max(MAX_REQUEST_TASKS);

type Question = z.infer<typeof intakeQuestion>;
export type Answers = Record<string, string | number>;

/** The answers to a business's questions, or null if one is missing or not a valid answer to its question. */
export function parseAnswers(
  questions: readonly Question[],
  raw: Readonly<Record<string, string>>,
): Answers | null {
  const answers: Answers = {};
  for (const question of questions) {
    if (question.type === "photo") continue;
    const value = (raw[question.key] ?? "").trim();
    if (!value) {
      if (question.required) return null;
      continue;
    }
    if (question.type === "text") {
      if (value.length > MAX_TEXT_ANSWER) return null;
      answers[question.key] = value;
    } else if (question.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > MAX_NUMBER_ANSWER) return null;
      answers[question.key] = n;
    } else {
      if (!question.options.includes(value)) return null;
      answers[question.key] = value;
    }
  }
  return answers;
}

/** Photos may only answer the business's photo questions, and a required one needs at least one. */
function photosFit(questions: readonly Question[], sent: readonly string[]): boolean {
  const photoQuestions = questions.filter((q) => q.type === "photo");
  if (!sent.every((key) => photoQuestions.some((q) => q.key === key))) return false;
  return photoQuestions.every((q) => !q.required || sent.includes(q.key));
}

/** Creates a request from the public form of the business with this slug. */
export async function submitRequest(
  db: Db,
  storage: Storage,
  slug: string,
  input: IntakeInput,
): Promise<IntakeResult> {
  const person = contact.safeParse(input);
  if (!person.success) return { ok: false, error: "contact" };
  const tasks = taskIds.safeParse([...new Set(input.tasks)]);
  if (!tasks.success) return { ok: false, error: "tasks" };
  if (input.photos.length > MAX_REQUEST_PHOTOS) return { ok: false, error: "too_many_photos" };

  // Decoding is the slow part; it runs before a connection is taken.
  const photos: { question: string; image: CheckedImage }[] = [];
  for (const photo of input.photos) {
    const checked = await checkImage(photo.bytes);
    if (!checked.ok)
      return {
        ok: false,
        error: checked.reason === "too_large" ? "photo_too_large" : "photo_not_an_image",
      };
    photos.push({ question: photo.question, image: checked.image });
  }

  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) return { ok: false, error: "not_found" };
  return db.withTenant(businessId, async (client): Promise<IntakeResult> => {
    const profile = await businessProfile(client);
    if (!profile) return { ok: false, error: "not_found" };
    const answers = parseAnswers(profile.intake, input.answers);
    if (
      !answers ||
      !photosFit(
        profile.intake,
        photos.map((p) => p.question),
      )
    )
      return { ok: false, error: "answers" };
    const items = await activeItems(client, tasks.data);
    if (items.length !== tasks.data.length) return { ok: false, error: "tasks" };

    const customerId = await findOrCreateCustomer(client, businessId, person.data);
    const job = await createJob(client, businessId, customerId, person.data, answers);
    for (const item of items) {
      await client.query(
        `insert into kk.job_task (business_id, job_id, catalogue_item_id, title, added_by)
         values ($1, $2, $3, $4, 'customer')`,
        [businessId, job.id, item.id, item.name],
      );
    }
    for (const { image } of photos) {
      const object = await storage.putImage(client, image, null);
      await client.query(
        `insert into kk.job_photo (business_id, job_id, object_id, kind) values ($1, $2, $3, 'request')`,
        [businessId, job.id, object.id],
      );
    }
    const { secret } = await issueJobLink(client, job.id);
    return { ok: true, jobId: job.id, number: job.number, secret };
  });
}

/** The requested items that this business offers now, in its display order. RLS keeps other businesses out. */
async function activeItems(client: DbClient, ids: readonly string[]) {
  const { rows } = await client.query<{ id: string; name: string }>(
    `select id, name from kk.catalogue_item where id = any($1::uuid[]) and active order by position`,
    [ids],
  );
  return rows;
}

type Contact = z.infer<typeof contact>;

/**
 * The business's customer with this phone, or a new one. An existing customer's details are left alone: a form
 * anyone can fill in must not rename someone else's customer record. This request's address goes on the job.
 */
async function findOrCreateCustomer(
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
async function createJob(
  client: DbClient,
  businessId: string,
  customerId: string,
  person: Contact,
  answers: Answers,
): Promise<{ id: string; number: number }> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('kk.job.number:' || $1, 0))", [
    businessId,
  ]);
  const { rows } = await client.query<{ id: string; number: number }>(
    `insert into kk.job (business_id, customer_id, number, source, answers, address, preferred_window)
     select $1, $2, coalesce(max(number), 0) + 1, 'public_form', $3, $4, $5 from kk.job
     returning id, number`,
    [businessId, customerId, JSON.stringify(answers), person.address, person.preferredWindow],
  );
  const job = rows[0];
  if (!job) throw new Error("intake: the job insert returned no row");
  return job;
}

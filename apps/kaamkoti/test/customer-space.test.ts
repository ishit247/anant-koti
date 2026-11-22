// The customer space (D15, architecture 7) on the seeded database: a signed-in identity finds its own customer
// row in one business, claims an owner-entered one by verified email, and sees only that customer's jobs.
import { createAudit } from "@bodhchakra/audit";
import type { CustomerSession } from "@bodhchakra/auth";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customerFor,
  customerJobs,
  type JobGroup,
  migrations,
  RUNTIME_ROLE,
  seed,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
/** Seeded identities (services/platform/seed.sql) and the customer rows they are, or will be. */
const ANITA: CustomerSession = {
  identityId: "00000000-0000-4000-8000-00000000d005",
  email: "anita@example.com",
};
const SURESH: CustomerSession = {
  identityId: "00000000-0000-4000-8000-00000000d006",
  email: "suresh@example.com",
};
const ANITA_AT_SHARMA = "10000000-0000-4000-8000-0000000c0001";
const ANITA_AT_KAVERI = "20000000-0000-4000-8000-0000000c0003";

describe("the customer space on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  const log = createLogger({ service: "test", write: () => undefined });
  const audit = createAudit(log);

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
  });
  afterAll(() => database.drop());

  /** What the customer's home shows: the job numbers in one group. */
  const home = (businessId: string, session: CustomerSession, group: JobGroup = "active") =>
    app.withTenant(businessId, async (client) => {
      const customer = await customerFor(client, audit, session);
      return customer
        ? (await customerJobs(client, customer, group)).map((job) => job.number)
        : null;
    });

  it("shows a signed-in customer only their own jobs with that business", async () => {
    // Sharma's #2 belongs to another customer, Rahul; Kaveri's #1 to Suresh.
    expect(await home(SHARMA, ANITA)).toEqual([1]);
    expect(await home(KAVERI, SURESH)).toEqual([3, 1]);
    expect(await home(SHARMA, SURESH)).toBeNull();
  });

  it("claims an owner-entered customer by verified email, case ignored, once", async () => {
    // Kaveri entered Anita as Anita@Example.com with no identity; her request is Kaveri's #2.
    expect(await home(KAVERI, ANITA)).toEqual([2]);
    const { rows } = await owner.tx((c) =>
      c.query<{ identity_id: string; claims: string }>(
        `select identity_id,
                (select count(*) from audit.event where action = 'customer.claimed' and entity_id = $1) as claims
         from kk.customer where id = $1`,
        [ANITA_AT_KAVERI],
      ),
    );
    expect(rows[0]).toEqual({ identity_id: ANITA.identityId, claims: "1" });
    // Found by identity from now on: no second claim.
    expect(await home(KAVERI, ANITA)).toEqual([2]);
    const again = await owner.tx((c) =>
      c.query("select 1 from audit.event where action = 'customer.claimed'"),
    );
    expect(again.rowCount).toBe(1);
  });

  it("does not hand a claimed customer to another identity with the same email", async () => {
    const other = { identityId: "00000000-0000-4000-8000-00000000d099", email: ANITA.email };
    expect(await home(SHARMA, other)).toBeNull();
    const { rows } = await owner.tx((c) =>
      c.query<{ identity_id: string }>("select identity_id from kk.customer where id = $1", [
        ANITA_AT_SHARMA,
      ]),
    );
    expect(rows[0]?.identity_id).toBe(ANITA.identityId);
  });

  it("claims nothing for an email no customer row carries", async () => {
    const stranger = {
      identityId: "00000000-0000-4000-8000-00000000d098",
      email: "nobody@example.com",
    };
    expect(await home(SHARMA, stranger)).toBeNull();
  });

  it("groups the customer's jobs as Active, Completed and Cancelled", async () => {
    expect(await home(SHARMA, ANITA, "completed")).toEqual([]);
    expect(await home(SHARMA, ANITA, "cancelled")).toEqual([]);
    await owner.tx((c) =>
      c.query("update kk.job set status = 'cancelled' where business_id = $1 and number = 1", [
        SHARMA,
      ]),
    );
    expect(await home(SHARMA, ANITA, "cancelled")).toEqual([1]);
    expect(await home(SHARMA, ANITA)).toEqual([]);
  });
});

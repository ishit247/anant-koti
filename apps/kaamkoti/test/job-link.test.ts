import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { issue } from "@bodhchakra/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  issueJobLink,
  migrations,
  openJobLink,
  RUNTIME_ROLE,
  revokeJobLinks,
  seed,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const SHARMA_JOB_2 = "10000000-0000-4000-8000-0000000e0002";
const KAVERI_JOB_1 = "20000000-0000-4000-8000-0000000e0001";
const SEEDED_SHARMA_LINK = "dev-job-link-sharma-request-1-xxxxxxxxxxxxx";

describe("customer job links on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), createLogger({ service: "test" }));
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  const linkTo = (businessId: string, jobId: string) =>
    app.withTenant(businessId, (client) => issueJobLink(client, jobId));
  const forge = (purpose: "job" | "invite", businessId: string, subjectId: string) =>
    app.withTenant(businessId, (client) =>
      issue(client, { purpose, businessId, subjectId, expiresAt: new Date(Date.now() + 60_000) }),
    );

  it("opens the job it was issued for, and only that job", async () => {
    const one = await linkTo(SHARMA, SHARMA_JOB_1);
    const two = await linkTo(SHARMA, SHARMA_JOB_2);
    expect(await openJobLink(app, one.secret)).toMatchObject({
      businessName: "Sharma Cooling Services",
      businessPhone: "+919000000101",
      number: 1,
      status: "requested",
      customerName: "Anita Deshpande",
    });
    expect(await openJobLink(app, two.secret)).toMatchObject({
      number: 2,
      customerName: "Rahul Joshi",
    });
  });

  it("lives for 30 days", async () => {
    const { expiresAt } = await linkTo(SHARMA, SHARMA_JOB_1);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 86_400_000 - 60_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("opens the seeded development link", async () => {
    expect(await openJobLink(app, SEEDED_SHARMA_LINK)).toMatchObject({ number: 1 });
  });

  it("refuses a link whose business does not own the job", async () => {
    const { secret } = await forge("job", SHARMA, KAVERI_JOB_1);
    expect(await openJobLink(app, secret)).toBeNull();
  });

  it("refuses a link of another purpose naming a job", async () => {
    const { secret } = await forge("invite", SHARMA, SHARMA_JOB_1);
    expect(await openJobLink(app, secret)).toBeNull();
  });

  it("refuses an expired link", async () => {
    const { secret } = await linkTo(KAVERI, KAVERI_JOB_1);
    await database
      .connect("kaamkoti_owner")
      .tx((client) =>
        client.query(
          "update tokens.token set expires_at = now() - interval '1 second' where subject_id = $1",
          [KAVERI_JOB_1],
        ),
      );
    expect(await openJobLink(app, secret)).toBeNull();
  });

  it("refuses a malformed or unknown link", async () => {
    expect(await openJobLink(app, "nope")).toBeNull();
    expect(await openJobLink(app, "x".repeat(43))).toBeNull();
  });

  it("revokes a job's links without touching another job's, and a new link works", async () => {
    const old = await linkTo(SHARMA, SHARMA_JOB_2);
    const sibling = await linkTo(SHARMA, SHARMA_JOB_1);
    await app.withTenant(SHARMA, (client) => revokeJobLinks(client, SHARMA_JOB_2));
    expect(await openJobLink(app, old.secret)).toBeNull();
    expect(await openJobLink(app, sibling.secret)).not.toBeNull();
    const fresh = await linkTo(SHARMA, SHARMA_JOB_2);
    expect(await openJobLink(app, fresh.secret)).toMatchObject({ number: 2 });
  });

  it("refuses issuing a link to another business's job", async () => {
    await expect(linkTo(SHARMA, KAVERI_JOB_1)).rejects.toThrow(/no job/);
  });

  it("refuses a job naming another business's customer", async () => {
    await expect(
      app.withTenant(SHARMA, (client) =>
        client.query(
          `insert into kk.job (business_id, customer_id, number, source, contact_name, contact_phone_e164)
           values ($1, '20000000-0000-4000-8000-0000000c0001', 99, 'phone', 'X', '+919000009999')`,
          [SHARMA],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses deleting a job", async () => {
    await expect(
      app.withTenant(SHARMA, (client) => client.query("delete from kk.job")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

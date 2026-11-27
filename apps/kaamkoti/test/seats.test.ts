// Seats (D20) against the seeded database: Sharma is in the trial with two people, Kaveri pays Team for two and
// has two.
import { randomUUID } from "node:crypto";
import { LimitReached } from "@bodhchakra/billing";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import {
  acceptInvite,
  createInvite,
  inviteSummary,
  listMembers,
  type Membership,
} from "@bodhchakra/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations, RUNTIME_ROLE, seed } from "../src/index.ts";
import { assertSeatFree } from "../src/subscription.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const KAVERI_OWNER = "20000000-0000-4000-8000-0000000a0001";

describe("seats", () => {
  const log = createLogger({ service: "test" });
  const sharma: Membership = {
    businessId: SHARMA,
    memberId: SHARMA_OWNER,
    role: "owner",
    displayName: "Owner",
  };
  const kaveri: Membership = { ...sharma, businessId: KAVERI, memberId: KAVERI_OWNER };
  let database: TestDb;
  let app: Db;
  let owner: Db;

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

  /** An invite made without the seat check, as one made before the team filled up. */
  const invite = (by: Membership) =>
    app.withTenant(by.businessId, async (client) => (await createInvite(client, by)).secret);
  const join = (secret: string) =>
    acceptInvite(app, secret, { identityId: randomUUID(), displayName: "Ravi" }, assertSeatFree);
  const people = (businessId: string) =>
    app.withTenant(businessId, async (client) => (await listMembers(client)).length);
  const setSeats = (businessId: string, seats: number) =>
    owner.tx((client) =>
      client.query("update billing.status set seats = $2 where business_id = $1", [
        businessId,
        seats,
      ]),
    );

  it("refuses a new invite when every paid seat is taken, in the one limit shape", async () => {
    const refused = app.withTenant(KAVERI, assertSeatFree);
    await expect(refused).rejects.toBeInstanceOf(LimitReached);
    await expect(refused).rejects.toMatchObject({
      error: { code: "limit", limit: "seats", plan: "team" },
    });
  });

  it("refuses joining a full team, adds no one, and leaves the link usable", async () => {
    const secret = await invite(kaveri);
    await expect(join(secret)).rejects.toBeInstanceOf(LimitReached);
    expect(await people(KAVERI)).toBe(2);
    expect(await inviteSummary(app, secret)).not.toBeNull();
  });

  it("lets the trial seat more people than its row's one seat", async () => {
    await join(await invite(sharma));
    expect(await people(SHARMA)).toBe(3);
  });

  it("gives the last seat to one of two people joining at once", async () => {
    await setSeats(KAVERI, 3);
    const links = [await invite(kaveri), await invite(kaveri)];
    const outcomes = await Promise.allSettled(links.map(join));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(refused.map((outcome) => outcome.reason)).toEqual([expect.any(LimitReached)]);
    expect(await people(KAVERI)).toBe(3);
  });
});

import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { migrations as tokensMigrations } from "@bodhchakra/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptInvite,
  createBusiness,
  createInvite,
  InviteRefused,
  inviteSummary,
  type Membership,
  membershipsOf,
  migrations,
} from "../src/index.ts";

const ASHA = "a5a00000-0000-4000-8000-000000000001";
const VIJAY = "f1a00000-0000-4000-8000-000000000003";
const MEENA = "3e000000-0000-4000-8000-000000000004";

describe("technician invites", () => {
  let database: TestDb;
  let app: Db;
  let sharma: Membership;

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [tokensMigrations, migrations],
    });
    app = database.connect("kaamkoti_app");
    sharma = await createBusiness(
      app,
      { slug: "sharma-cooling", name: "Sharma Cooling", phone: "+919000000101", city: "Pune" },
      { identityId: ASHA, displayName: "Asha" },
    );
  });
  afterAll(() => database.drop());

  const invite = () => app.withTenant(sharma.businessId, (client) => createInvite(client, sharma));

  it("lets the invitee see who invited them, then makes them a technician of that business", async () => {
    const { secret } = await invite();

    expect(await inviteSummary(app, secret)).toEqual({
      businessName: "Sharma Cooling",
      invitedByName: "Asha",
    });
    const member = await acceptInvite(app, secret, { identityId: VIJAY, displayName: "Vijay" });

    expect(member).toMatchObject({ businessId: sharma.businessId, role: "technician" });
    expect(await app.tx((client) => membershipsOf(client, VIJAY))).toHaveLength(1);
  });

  it("works once: a second use of the same link is refused and adds no member", async () => {
    const { secret } = await invite();
    await acceptInvite(app, secret, { identityId: MEENA, displayName: "Meena" });

    await expect(
      acceptInvite(app, secret, {
        identityId: "9b000000-0000-4000-8000-000000000009",
        displayName: "X",
      }),
    ).rejects.toBeInstanceOf(InviteRefused);
    expect(await inviteSummary(app, secret)).toBeNull();
  });

  it("adds no one when the app's admit check refuses, and keeps the link usable", async () => {
    const { secret } = await invite();
    const person = { identityId: "9c000000-0000-4000-8000-00000000000c", displayName: "Kiran" };
    const full = new Error("no free seat");

    await expect(
      acceptInvite(app, secret, person, async () => {
        throw full;
      }),
    ).rejects.toBe(full);
    expect(await app.tx((client) => membershipsOf(client, person.identityId))).toHaveLength(0);
    expect(await inviteSummary(app, secret)).not.toBeNull();
  });

  it("makes simultaneous taps of one link produce exactly one member", async () => {
    const { secret } = await invite();
    const people = Array.from({ length: 8 }, (_, i) => ({
      identityId: `c${i}000000-0000-4000-8000-000000000001`,
      displayName: "Racer",
    }));

    const results = await Promise.allSettled(people.map((p) => acceptInvite(app, secret, p)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses an expired link", async () => {
    const { secret, inviteId } = await invite();
    await database
      .connect("kaamkoti_owner")
      .tx((client) =>
        client.query(
          "update tokens.token set expires_at = now() - interval '1 minute' where subject_id = $1",
          [inviteId],
        ),
      );

    await expect(
      acceptInvite(app, secret, {
        identityId: "e1000000-0000-4000-8000-000000000001",
        displayName: "Late",
      }),
    ).rejects.toBeInstanceOf(InviteRefused);
  });

  it("refuses a guessed or malformed link", async () => {
    await expect(
      acceptInvite(app, "A".repeat(43), { identityId: VIJAY, displayName: "Vijay" }),
    ).rejects.toBeInstanceOf(InviteRefused);
    expect(await inviteSummary(app, "short")).toBeNull();
  });

  it("refuses someone who is already a member of the business", async () => {
    const { secret } = await invite();

    await expect(
      acceptInvite(app, secret, { identityId: ASHA, displayName: "Asha" }),
    ).rejects.toBeInstanceOf(InviteRefused);
  });
});

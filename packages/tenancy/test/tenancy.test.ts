import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  createBusiness,
  type Membership,
  membershipsOf,
  migrations,
  NotPermittedError,
  requireRole,
  resolveSlug,
} from "../src/index.ts";

const ASHA = "a5a00000-0000-4000-8000-000000000001"; // owns Sharma, also a technician at Kaveri
const RAVI = "7a110000-0000-4000-8000-000000000002"; // owns Kaveri
const VIJAY = "f1a00000-0000-4000-8000-000000000003"; // technician at Sharma

const memberNames = async (client: DbClient) =>
  (
    await client.query<{ display_name: string }>(
      "select display_name from tenancy.member order by display_name",
    )
  ).rows.map((r) => r.display_name);

const businessSlugs = async (client: DbClient) =>
  (
    await client.query<{ slug: string }>("select slug from tenancy.business order by slug")
  ).rows.map((r) => r.slug);

describe("tenancy", () => {
  let database: TestDb;
  let app: Db;
  let sharma: Membership;
  let kaveri: Membership;

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [migrations],
    });
    app = database.connect("kaamkoti_app");
    sharma = await createBusiness(
      app,
      { slug: "sharma-cooling", name: "Sharma Cooling", phone: "+919000000101", city: "Pune" },
      { identityId: ASHA, displayName: "Asha" },
    );
    kaveri = await createBusiness(
      app,
      { slug: "kaveri-electricals", name: "Kaveri", phone: "+919000000202", city: "Bengaluru" },
      { identityId: RAVI, displayName: "Ravi" },
    );
    await app.withTenant(sharma.businessId, (client) =>
      addMember(client, {
        businessId: sharma.businessId,
        identityId: VIJAY,
        displayName: "Vijay",
        role: "technician",
      }),
    );
    await app.withTenant(kaveri.businessId, (client) =>
      addMember(client, {
        businessId: kaveri.businessId,
        identityId: ASHA,
        displayName: "Asha K",
        role: "technician",
      }),
    );
  });
  afterAll(() => database.drop());

  describe("createBusiness", () => {
    it("makes the creator the business's owner", () => {
      expect(sharma).toMatchObject({ role: "owner", displayName: "Asha" });
    });

    it("rejects a slug that is taken", async () => {
      await expect(
        createBusiness(
          app,
          { slug: "sharma-cooling", name: "Other", phone: "+919000000303", city: "Pune" },
          { identityId: VIJAY, displayName: "Vijay" },
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("row-level security for the runtime role", () => {
    it("shows only the current business and its members", async () => {
      expect(await app.withTenant(sharma.businessId, businessSlugs)).toEqual(["sharma-cooling"]);
      expect(await app.withTenant(sharma.businessId, memberNames)).toEqual(["Asha", "Vijay"]);
      expect(await app.withTenant(kaveri.businessId, memberNames)).toEqual(["Asha K", "Ravi"]);
    });

    it("shows no business and no member without a tenant", async () => {
      expect(await app.tx(businessSlugs)).toEqual([]);
      expect(await app.tx(memberNames)).toEqual([]);
    });

    it("refuses adding a member to another business", async () => {
      await expect(
        app.withTenant(sharma.businessId, (client) =>
          addMember(client, {
            businessId: kaveri.businessId,
            identityId: VIJAY,
            displayName: "Vijay",
            role: "technician",
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("changes nothing when updating another business or its members", async () => {
      const updated = await app.withTenant(sharma.businessId, async (client) => {
        const business = await client.query(
          "update tenancy.business set name = 'x' where id = $1",
          [kaveri.businessId],
        );
        const member = await client.query(
          "update tenancy.member set role = 'owner' where id = $1",
          [kaveri.memberId],
        );
        return [business.rowCount, member.rowCount];
      });
      expect(updated).toEqual([0, 0]);
    });

    it("refuses moving a member to another business", async () => {
      await expect(
        app.withTenant(sharma.businessId, (client) =>
          client.query("update tenancy.member set business_id = $1 where id = $2", [
            kaveri.businessId,
            sharma.memberId,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("refuses deleting a business or a member", async () => {
      for (const table of ["tenancy.business", "tenancy.member"]) {
        await expect(
          app.withTenant(sharma.businessId, (client) => client.query(`delete from ${table}`)),
        ).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("refuses a second owner", async () => {
      await expect(
        app.withTenant(sharma.businessId, (client) =>
          addMember(client, {
            businessId: sharma.businessId,
            identityId: RAVI,
            displayName: "Ravi",
            role: "owner",
          }),
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("lookups without a tenant", () => {
    it("resolves a slug to its business id, and an unknown slug to null", async () => {
      expect(await app.tx((client) => resolveSlug(client, "kaveri-electricals"))).toBe(
        kaveri.businessId,
      );
      expect(await app.tx((client) => resolveSlug(client, "no-such-business"))).toBeNull();
    });

    it("lists an identity's memberships across businesses, oldest first", async () => {
      const memberships = await app.tx((client) => membershipsOf(client, ASHA));

      expect(memberships.map((m) => [m.businessId, m.role])).toEqual([
        [sharma.businessId, "owner"],
        [kaveri.businessId, "technician"],
      ]);
    });

    it("leaves out a removed member", async () => {
      const removed = "0d000000-0000-4000-8000-000000000009";
      await app.withTenant(kaveri.businessId, async (client) => {
        const member = await addMember(client, {
          businessId: kaveri.businessId,
          identityId: removed,
          displayName: "Gone",
          role: "technician",
        });
        await client.query("update tenancy.member set removed_at = now() where id = $1", [
          member.memberId,
        ]);
      });

      expect(await app.tx((client) => membershipsOf(client, removed))).toEqual([]);
    });
  });
});

describe("requireRole", () => {
  const technician: Membership = {
    memberId: "m",
    businessId: "b",
    role: "technician",
    displayName: "Vijay",
  };

  it("allows a role in the list", () => {
    expect(() => requireRole(technician, "owner", "technician")).not.toThrow();
  });

  it("refuses a role not in the list", () => {
    expect(() => requireRole(technician, "owner")).toThrow(NotPermittedError);
  });
});

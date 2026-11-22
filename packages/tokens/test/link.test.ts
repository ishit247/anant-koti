import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issue, migrations, resolve, revoke } from "../src/index.ts";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const INVITE_1 = "a0000000-0000-4000-8000-0000000e0001";
const THEIR_INVITE = "b0000000-0000-4000-8000-0000000e0001";

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

describe("links", () => {
  let database: TestDb;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [migrations],
    });
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  const link = (subjectId: string, expiresAt = inDays(30), businessId = A) =>
    app.withTenant(businessId, (client) =>
      issue(client, { purpose: "invite", businessId, subjectId, expiresAt }),
    );
  const open = (secret: string) => app.tx((client) => resolve(client, secret));

  it("resolves a live link to its business and subject", async () => {
    const { id, secret } = await link(INVITE_1);
    expect(await open(secret)).toEqual({
      id,
      purpose: "invite",
      businessId: A,
      subjectId: INVITE_1,
    });
  });

  it("refuses an expired link", async () => {
    const { secret } = await link(INVITE_1, new Date(Date.now() - 1000));
    expect(await open(secret)).toBeNull();
  });

  it("refuses a revoked link", async () => {
    const { id, secret } = await link(INVITE_1);
    await app.withTenant(A, (client) => revoke(client, id));
    expect(await open(secret)).toBeNull();
  });

  it("refuses a malformed or unknown secret", async () => {
    expect(await open("not-a-token")).toBeNull();
    expect(await open("A".repeat(43))).toBeNull();
  });

  it("cannot revoke another business's link", async () => {
    const theirs = await link(THEIR_INVITE, inDays(30), B);
    await app.withTenant(A, (client) => revoke(client, theirs.id));
    expect(await open(theirs.secret)).not.toBeNull();
  });

  it("refuses issuing a link for another business", async () => {
    await expect(
      app.withTenant(A, (client) =>
        issue(client, {
          purpose: "invite",
          businessId: B,
          subjectId: INVITE_1,
          expiresAt: inDays(1),
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

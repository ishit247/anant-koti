import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, createAudit, migrations } from "../src/index.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const JOB = "10b00000-0000-4000-8000-000000000001";

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  businessId: A,
  actor: { kind: "system" },
  action: "job.closed",
  entity: "job",
  entityId: JOB,
  data: { amount: 120000 },
  ...overrides,
});

const actions = async (client: DbClient) =>
  (await client.query<{ action: string }>("select action from audit.event order by at")).rows.map(
    (r) => r.action,
  );

describe("audit", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let logged: string[];
  const audit = createAudit(createLogger({ service: "test", write: (line) => logged.push(line) }));

  // A stand-in for the business write an audit event describes.
  const writeJob = (client: DbClient, label: string) =>
    client.query("insert into fx.job (label) values ($1)", [label]);
  const jobs = () =>
    owner.tx(async (client) =>
      (await client.query<{ label: string }>("select label from fx.job order by label")).rows.map(
        (r) => r.label,
      ),
    );

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [migrations],
    });
    owner = database.connect("kaamkoti_owner");
    await owner.tx((client) =>
      client.query(`create schema fx;
        create table fx.job (label text primary key);
        grant usage on schema fx to kaamkoti_app;
        grant select, insert on fx.job to kaamkoti_app`),
    );
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());
  beforeEach(() => {
    logged = [];
  });

  it("records an event the business can read back", async () => {
    await app.withTenant(A, (client) =>
      audit.record(client, event({ actor: { kind: "member", id: JOB } })),
    );

    const rows = await app.withTenant(
      A,
      async (client) =>
        (await client.query("select actor_kind, actor_id, data from audit.event")).rows,
    );
    expect(rows).toEqual([{ actor_kind: "member", actor_id: JOB, data: { amount: 120000 } }]);
    expect(await app.withTenant(B, actions)).toEqual([]);
  });

  it("keeps the business write and logs the failure when record fails", async () => {
    await app.withTenant(A, async (client) => {
      await writeJob(client, "kept");
      await audit.record(client, event({ action: "Not A Valid Action" }));
    });

    expect(await jobs()).toContain("kept");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toMatchObject({
      level: "error",
      action: "Not A Valid Action",
    });
  });

  it("lets later work in the transaction continue after record fails", async () => {
    await app.withTenant(A, async (client) => {
      await audit.record(client, event({ action: "bad" }));
      await writeJob(client, "after-failed-audit");
    });

    expect(await jobs()).toContain("after-failed-audit");
  });

  it("aborts the business write when recordStrict fails", async () => {
    await expect(
      app.withTenant(A, async (client) => {
        await writeJob(client, "lost");
        await audit.recordStrict(client, event({ action: "bad" }));
      }),
    ).rejects.toMatchObject({ code: "23514" });

    expect(await jobs()).not.toContain("lost");
  });

  it("refuses an event for another business", async () => {
    await expect(
      app.withTenant(A, (client) => audit.recordStrict(client, event({ businessId: B }))),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses the runtime role update, delete and truncate", async () => {
    for (const sql of [
      "update audit.event set action = 'job.reopened'",
      "delete from audit.event",
      "truncate audit.event",
    ]) {
      await expect(app.withTenant(A, (client) => client.query(sql))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
});

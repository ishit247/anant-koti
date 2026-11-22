import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JOB_EVENTS,
  JOB_STATUSES,
  type JobRole,
  jobTransition,
  migrations,
  RUNTIME_ROLE,
  seed,
  transitionJob,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const SHARMA_JOB_1_CUSTOMER = "10000000-0000-4000-8000-0000000c0001";
const SHARMA_JOB_2 = "10000000-0000-4000-8000-0000000e0002";
const SHARMA_SENT_QUOTE = "10000000-0000-4000-8000-000000100001";
const KAVERI_JOB_1 = "20000000-0000-4000-8000-0000000e0001";
const KAVERI_ACCEPTED_QUOTE = "20000000-0000-4000-8000-000000100003";

/** Section 6 of docs/architecture.md, written out: from, event, to, who. */
const SECTION_6 = [
  ["requested", "quote_sent", "quoted", "owner"],
  ["requested", "decline", "declined", "owner"],
  ["quoted", "accept", "accepted", "customer"],
  ["quoted", "reject", "quoted", "customer"],
  ["quoted", "counter", "quoted", "customer"],
  ["quoted", "revise", "quoted", "owner"],
  ["quoted", "edit", "requested", "customer"],
  ["quoted", "close_lost", "lost", "owner"],
  ["accepted", "schedule", "scheduled", "owner"],
  ["scheduled", "check_in", "in_progress", "technician"],
  ["scheduled", "check_in", "in_progress", "owner"],
  ["in_progress", "complete", "completed", "technician"],
  ["in_progress", "complete", "completed", "owner"],
  ...["requested", "quoted", "accepted", "scheduled"].flatMap((from) => [
    [from, "cancel", "cancelled", "owner"],
    [from, "cancel", "cancelled", "customer"],
  ]),
];
const ROLES: readonly JobRole[] = ["owner", "technician", "customer"];

describe("the job state machine", () => {
  it("allows exactly the transitions of section 6, and refuses every other state, event and role", () => {
    const allowed = JOB_STATUSES.flatMap((from) =>
      JOB_EVENTS.flatMap((event) =>
        ROLES.flatMap((role) => {
          const to = jobTransition(from, event, role);
          return to === null ? [] : [[from, event, to, role]];
        }),
      ),
    );
    expect(new Set(allowed.map((t) => t.join(" ")))).toEqual(
      new Set(SECTION_6.map((t) => t.join(" "))),
    );
    // Every combination was asked: 9 states × 12 events × 3 roles, of which the table allows these.
    expect(allowed).toHaveLength(SECTION_6.length);
  });

  it("lets nothing leave a final state", () => {
    for (const from of ["completed", "declined", "lost", "cancelled"] as const)
      for (const event of JOB_EVENTS)
        for (const role of ROLES) expect(jobTransition(from, event, role)).toBeNull();
  });
});

describe("transitionJob on the seeded database", () => {
  const log = createLogger({ service: "test" });
  const audit = createAudit(log);
  const ownerActor = { role: "owner", memberId: SHARMA_OWNER } as const;
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

  const statusOf = async (jobId: string) =>
    (await owner.tx((c) => c.query("select status from kk.job where id = $1", [jobId]))).rows[0]
      ?.status;

  it("moves the job and audits the move, naming the customer when they act by link", async () => {
    const result = await app.withTenant(SHARMA, (c) =>
      transitionJob(c, audit, SHARMA_JOB_1, { event: "cancel", actor: { role: "customer" } }),
    );
    expect(result).toEqual({ ok: true, from: "requested", to: "cancelled" });
    expect(await statusOf(SHARMA_JOB_1)).toBe("cancelled");
    const { rows } = await owner.tx((c) =>
      c.query(
        "select actor_kind, actor_id, data from audit.event where entity_id = $1 and action = 'job.cancel'",
        [SHARMA_JOB_1],
      ),
    );
    expect(rows).toEqual([
      {
        actor_kind: "customer",
        actor_id: SHARMA_JOB_1_CUSTOMER,
        data: { from: "requested", to: "cancelled" },
      },
    ]);
  });

  it("refuses a pair not in the table and changes nothing", async () => {
    const result = await app.withTenant(SHARMA, (c) =>
      transitionJob(c, audit, SHARMA_JOB_2, { event: "schedule", actor: ownerActor }),
    );
    expect(result).toEqual({ ok: false, error: "refused" });
    expect(await statusOf(SHARMA_JOB_2)).toBe("quoted");
  });

  it("refuses an event by a role the table does not name", async () => {
    const result = await app.withTenant(SHARMA, (c) =>
      transitionJob(c, audit, SHARMA_JOB_2, { event: "close_lost", actor: { role: "customer" } }),
    );
    expect(result).toEqual({ ok: false, error: "refused" });
  });

  it("does not find another business's job", async () => {
    const result = await app.withTenant(SHARMA, (c) =>
      transitionJob(c, audit, KAVERI_JOB_1, { event: "decline", actor: ownerActor }),
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an accepted quote id without accept, and accept without one", async () => {
    await expect(
      app.withTenant(SHARMA, (c) =>
        transitionJob(c, audit, SHARMA_JOB_2, {
          event: "revise",
          actor: ownerActor,
          acceptedQuoteId: SHARMA_SENT_QUOTE,
        }),
      ),
    ).rejects.toThrow(/only with accept/);
    await expect(
      app.withTenant(SHARMA, (c) =>
        transitionJob(c, audit, SHARMA_JOB_2, { event: "accept", actor: { role: "customer" } }),
      ),
    ).rejects.toThrow(/only with accept/);
  });

  describe("the database keeps the accepted quote with its job", () => {
    const asApp = (sql: string, params: unknown[]) =>
      app.withTenant(SHARMA, (c) => c.query(sql, params));

    it("refuses an accepted job without an accepted quote", async () => {
      await expect(
        asApp("update kk.job set status = 'accepted' where id = $1", [SHARMA_JOB_2]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("refuses a job still being quoted that names an accepted quote", async () => {
      await expect(
        asApp("update kk.job set accepted_quote_id = $2 where id = $1", [
          SHARMA_JOB_2,
          SHARMA_SENT_QUOTE,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("refuses a quote of another job as the accepted one", async () => {
      // As the owner role, past row-level security: only the composite key stands in the way.
      await expect(
        owner.tx((c) =>
          c.query("update kk.job set status = 'accepted', accepted_quote_id = $2 where id = $1", [
            SHARMA_JOB_2,
            KAVERI_ACCEPTED_QUOTE,
          ]),
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });
});

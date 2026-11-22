import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrations,
  moveVisit,
  plannedVisits,
  planVisit,
  RUNTIME_ROLE,
  seed,
  type VisitInput,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_TECHNICIAN = "10000000-0000-4000-8000-0000000a0002";
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const SHARMA_JOB_2 = "10000000-0000-4000-8000-0000000e0002";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const KAVERI_OWNER = "20000000-0000-4000-8000-0000000a0001";
const KAVERI_TECHNICIAN = "20000000-0000-4000-8000-0000000a0002";
const KAVERI_ACCEPTED_JOB = "20000000-0000-4000-8000-0000000e0003";

describe("scheduling visits", () => {
  const log = createLogger({ service: "test" });
  const audit = createAudit(log);
  const sharma = { businessId: SHARMA, memberId: SHARMA_OWNER };
  const kaveri = { businessId: KAVERI, memberId: KAVERI_OWNER };
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

  // Far from the seeded visit (tomorrow), so only the bookings made here can collide.
  const siteVisit = (start: string, over: Partial<VisitInput> = {}): VisitInput => ({
    jobId: SHARMA_JOB_1,
    kind: "site_visit",
    technicianId: SHARMA_TECHNICIAN,
    start,
    minutes: 60,
    ...over,
  });
  const plan = (input: VisitInput) =>
    app.withTenant(SHARMA, (c) => planVisit(c, audit, sharma, input));

  it("plans a visit in the business's time zone and lists it", async () => {
    const result = await plan(siteVisit("2031-03-10T10:00"));
    expect(result.ok).toBe(true);
    const visits = await app.withTenant(SHARMA, (c) => plannedVisits(c, new Date("2031-03-10")));
    expect(visits).toHaveLength(1);
    // 10:00 in Asia/Kolkata (UTC+5:30) is 04:30 UTC.
    expect(visits[0]?.startsAt.toISOString()).toBe("2031-03-10T04:30:00.000Z");
    expect(visits[0]?.endsAt.toISOString()).toBe("2031-03-10T05:30:00.000Z");
  });

  it("refuses a technician a second visit that overlaps one, and stores nothing", async () => {
    const result = await plan(siteVisit("2031-03-10T10:30", { jobId: SHARMA_JOB_2 }));
    expect(result).toEqual({ ok: false, error: "conflict" });
    const { rows } = await owner.tx((c) =>
      c.query("select count(*)::int as n from kk.appointment where job_id = $1", [SHARMA_JOB_2]),
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("allows a visit that starts as the previous one ends, and another technician at the same time", async () => {
    expect((await plan(siteVisit("2031-03-10T11:00", { jobId: SHARMA_JOB_2 }))).ok).toBe(true);
    const owners = await plan(siteVisit("2031-03-10T10:00", { technicianId: SHARMA_OWNER }));
    expect(owners.ok).toBe(true);
  });

  it("is enforced by the database itself, not only by the code", async () => {
    await expect(
      owner.tx((c) =>
        c.query(
          `insert into kk.appointment (business_id, job_id, kind, technician_member_id, starts_at, ends_at)
           values ($1, $2, 'site_visit', $3, '2031-03-10T04:45Z', '2031-03-10T05:00Z')`,
          [SHARMA, SHARMA_JOB_1, SHARMA_TECHNICIAN],
        ),
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("frees the time when a visit is cancelled", async () => {
    await owner.tx((c) =>
      c.query(
        "update kk.appointment set status = 'cancelled' where job_id = $1 and technician_member_id = $2",
        [SHARMA_JOB_1, SHARMA_OWNER],
      ),
    );
    expect((await plan(siteVisit("2031-03-10T10:00", { technicianId: SHARMA_OWNER }))).ok).toBe(
      true,
    );
  });

  it("moves a visit, and refuses a move onto another visit", async () => {
    const planned = await plan(siteVisit("2031-03-11T09:00"));
    if (!planned.ok) throw new Error("setup");
    const free = await app.withTenant(SHARMA, (c) =>
      moveVisit(c, audit, sharma, planned.appointmentId, {
        technicianId: SHARMA_TECHNICIAN,
        start: "2031-03-11T15:00",
        minutes: 30,
      }),
    );
    expect(free.ok).toBe(true);
    const clash = await app.withTenant(SHARMA, (c) =>
      moveVisit(c, audit, sharma, planned.appointmentId, {
        technicianId: SHARMA_TECHNICIAN,
        start: "2031-03-10T10:15",
        minutes: 30,
      }),
    );
    expect(clash).toEqual({ ok: false, error: "conflict" });
    const visits = await app.withTenant(SHARMA, (c) =>
      plannedVisits(c, new Date("2031-03-11"), SHARMA_JOB_1),
    );
    expect(visits.map((v) => v.startsAt.toISOString())).toEqual(["2031-03-11T09:30:00.000Z"]);
  });

  it("schedules the work of an accepted job, which moves it to scheduled and is audited", async () => {
    const result = await app.withTenant(KAVERI, (c) =>
      planVisit(c, audit, kaveri, {
        jobId: KAVERI_ACCEPTED_JOB,
        kind: "work",
        technicianId: KAVERI_TECHNICIAN,
        start: "2031-03-12T09:00",
        minutes: 120,
      }),
    );
    expect(result.ok).toBe(true);
    const job = await owner.tx((c) =>
      c.query("select status from kk.job where id = $1", [KAVERI_ACCEPTED_JOB]),
    );
    expect(job.rows[0]?.status).toBe("scheduled");
    const events = await owner.tx((c) =>
      c.query(
        `select action from audit.event
         where (action = 'appointment.planned' and data->>'jobId' = $1)
            or (action = 'job.schedule' and entity_id = $2)
         order by action`,
        [KAVERI_ACCEPTED_JOB, KAVERI_ACCEPTED_JOB],
      ),
    );
    expect(events.rows.map((r) => r.action)).toEqual(["appointment.planned", "job.schedule"]);
  });

  it("does not schedule work for a job that is not accepted, or on a second try", async () => {
    const quoted = await plan(siteVisit("2031-03-13T09:00", { jobId: SHARMA_JOB_2, kind: "work" }));
    expect(quoted).toEqual({ ok: false, error: "closed" });
    const again = await app.withTenant(KAVERI, (c) =>
      planVisit(c, audit, kaveri, {
        jobId: KAVERI_ACCEPTED_JOB,
        kind: "work",
        technicianId: KAVERI_TECHNICIAN,
        start: "2031-03-14T09:00",
        minutes: 60,
      }),
    );
    expect(again).toEqual({ ok: false, error: "closed" });
  });

  it("refuses another business's job, another business's technician, and a malformed time", async () => {
    expect(await plan(siteVisit("2031-03-15T09:00", { jobId: KAVERI_ACCEPTED_JOB }))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await plan(siteVisit("2031-03-15T09:00", { technicianId: KAVERI_TECHNICIAN }))).toEqual({
      ok: false,
      error: "technician",
    });
    expect(await plan(siteVisit("tomorrow"))).toEqual({ ok: false, error: "input" });
    expect(await plan(siteVisit("2031-03-15T09:00", { minutes: 0 }))).toEqual({
      ok: false,
      error: "input",
    });
  });
});

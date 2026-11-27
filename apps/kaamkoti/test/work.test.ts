// Doing the work (4.2) against the seeded database and the development Garage (infra/compose.dev.yml): Sharma's
// request #3 is scheduled for today with the technician Imran.
import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { type CheckedImage, checkImage, createStorage } from "@bodhchakra/storage";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkPhotos,
  checkIn,
  completeWork,
  MAX_WORK_PHOTOS,
  migrations,
  myWork,
  PRIVATE_BUCKET,
  RUNTIME_ROLE,
  seed,
  tickChecklist,
  type Worker,
  workSheet,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const SCHEDULED_JOB = "10000000-0000-4000-8000-0000000e0003";
const QUOTED_JOB = "10000000-0000-4000-8000-0000000e0002";
const IMRAN: Worker = { memberId: "10000000-0000-4000-8000-0000000a0002", role: "technician" };
const PRAKASH: Worker = { memberId: "10000000-0000-4000-8000-0000000a0001", role: "owner" };
const KAVYA: Worker = { memberId: "20000000-0000-4000-8000-0000000a0001", role: "owner" };
/** A second Sharma technician, added here, to whom the job was not given. */
const DEEPAK: Worker = { memberId: "10000000-0000-4000-8000-0000000a0003", role: "technician" };

const storage = createStorage({
  endpoint: "http://127.0.0.1:45447",
  publicEndpoint: "http://127.0.0.1:45447",
  region: "garage",
  // DEV key from apps/kaamkoti/.env.development, public in the repository.
  accessKeyId: "GK6b61616d6b6f74692d776562",
  secretAccessKey: "6b61616d6b6f74692d7765622d6465762d6f6e6c792d6e6f742d736563726574",
  bucket: PRIVATE_BUCKET,
});

async function photo(): Promise<CheckedImage> {
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#1d6fa5" },
  })
    .jpeg()
    .toBuffer();
  const checked = await checkImage(new Uint8Array(bytes));
  if (!checked.ok) throw new Error("the test photo did not pass checkImage");
  return checked.image;
}

describe("doing the work", () => {
  const log = createLogger({ service: "test" });
  const audit = createAudit(log);
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
    await owner.tx((c) =>
      c.query(
        `insert into tenancy.member (id, business_id, identity_id, display_name, role)
         values ($1, $2, gen_random_uuid(), 'Deepak More', 'technician')`,
        [DEEPAK.memberId, SHARMA],
      ),
    );
  });
  afterAll(() => database.drop());

  const atSharma = <T>(fn: (client: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);
  const jobRow = async () => {
    const { rows } = await owner.tx((c) =>
      c.query<{ status: string; appointment: string; task: string }>(
        `select j.status, a.status as appointment, t.status as task from kk.job j
         join kk.appointment a on a.job_id = j.id and a.kind = 'work'
         join kk.job_task t on t.job_id = j.id
         where j.id = $1`,
        [SCHEDULED_JOB],
      ),
    );
    return rows[0];
  };

  it("lists the scheduled work for its technician only", async () => {
    const mine = await atSharma((c) => myWork(c, IMRAN.memberId));
    expect(mine.map((row) => row.jobId)).toEqual([SCHEDULED_JOB]);
    expect(await atSharma((c) => myWork(c, DEEPAK.memberId))).toEqual([]);
  });

  it("shows the job sheet to its technician and the owner, with the checklist not yet ticked", async () => {
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.status).toBe("scheduled");
    expect(sheet?.checklist.map((item) => [item.key, item.done])).toEqual([
      ["power_off", false],
      ["cause_found", false],
      ["drain_checked", false],
    ]);
    expect(await atSharma((c) => workSheet(c, PRAKASH, SCHEDULED_JOB))).not.toBeNull();
  });

  it("hides the job from a technician it was not given to, and from another business", async () => {
    expect(await atSharma((c) => workSheet(c, DEEPAK, SCHEDULED_JOB))).toBeNull();
    expect(await app.withTenant(KAVERI, (c) => workSheet(c, KAVYA, SCHEDULED_JOB))).toBeNull();
  });

  it("has no sheet for a job whose work is not planned", async () => {
    expect(await atSharma((c) => workSheet(c, PRAKASH, QUOTED_JOB))).toBeNull();
  });

  it("refuses a check-in by a technician it was not given to, and changes nothing", async () => {
    expect(await atSharma((c) => checkIn(c, audit, DEEPAK, SCHEDULED_JOB))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await app.withTenant(KAVERI, (c) => checkIn(c, audit, KAVYA, SCHEDULED_JOB))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect((await jobRow())?.status).toBe("scheduled");
  });

  it("refuses ticks and photos before the check-in", async () => {
    expect(await atSharma((c) => tickChecklist(c, IMRAN, SCHEDULED_JOB, ["power_off"]))).toEqual({
      ok: false,
      error: "refused",
    });
    const image = await photo();
    expect(
      await atSharma((c) => addWorkPhotos(c, storage, IMRAN, SCHEDULED_JOB, "before", [image])),
    ).toEqual({ ok: false, error: "refused" });
  });

  it("checks the technician in: the job is under way, once", async () => {
    expect(await atSharma((c) => checkIn(c, audit, IMRAN, SCHEDULED_JOB))).toEqual({ ok: true });
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.status).toBe("in_progress");
    expect(sheet?.checkedInAt).toBeInstanceOf(Date);
    expect(await atSharma((c) => checkIn(c, audit, IMRAN, SCHEDULED_JOB))).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("ticks exactly the items sent, ignoring keys not on the checklist", async () => {
    await atSharma((c) => tickChecklist(c, IMRAN, SCHEDULED_JOB, ["power_off", "drain_checked"]));
    await atSharma((c) => tickChecklist(c, IMRAN, SCHEDULED_JOB, ["power_off", "made_up"]));
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.checklist.map((item) => [item.key, item.done])).toEqual([
      ["power_off", true],
      ["cause_found", false],
      ["drain_checked", false],
    ]);
  });

  it("keeps the visit's checklist when the business changes its own", async () => {
    await owner.tx((c) =>
      c.query("update kk.business_profile set checklist = '[]' where business_id = $1", [SHARMA]),
    );
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.checklist).toHaveLength(3);
  });

  it("adds before and after photos, up to the limit", async () => {
    const image = await photo();
    expect(
      await atSharma((c) => addWorkPhotos(c, storage, IMRAN, SCHEDULED_JOB, "before", [image])),
    ).toEqual({ ok: true });
    expect(
      await atSharma((c) => addWorkPhotos(c, storage, IMRAN, SCHEDULED_JOB, "after", [image])),
    ).toEqual({ ok: true });
    const tooMany = Array.from({ length: MAX_WORK_PHOTOS - 1 }, () => image);
    expect(
      await atSharma((c) => addWorkPhotos(c, storage, IMRAN, SCHEDULED_JOB, "after", tooMany)),
    ).toEqual({ ok: false, error: "too_many_photos" });
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.photos.map((p) => p.kind)).toEqual(["before", "after"]);
  });

  it("refuses a completion by a technician it was not given to", async () => {
    expect(await atSharma((c) => completeWork(c, audit, DEEPAK, SCHEDULED_JOB, ""))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect((await jobRow())?.status).toBe("in_progress");
  });

  it("completes the job: visit closed with the note, appointment and work items done", async () => {
    expect(
      await atSharma((c) => completeWork(c, audit, IMRAN, SCHEDULED_JOB, "  Cleaned the coils.  ")),
    ).toEqual({ ok: true });
    expect(await jobRow()).toEqual({ status: "completed", appointment: "done", task: "done" });
    const sheet = await atSharma((c) => workSheet(c, IMRAN, SCHEDULED_JOB));
    expect(sheet?.note).toBe("Cleaned the coils.");
    expect(sheet?.completedAt).toBeInstanceOf(Date);
    expect(await atSharma((c) => myWork(c, IMRAN.memberId))).toEqual([]);
  });

  it("refuses ticks, photos and a second completion once complete", async () => {
    expect(await atSharma((c) => tickChecklist(c, IMRAN, SCHEDULED_JOB, []))).toEqual({
      ok: false,
      error: "refused",
    });
    const image = await photo();
    expect(
      await atSharma((c) => addWorkPhotos(c, storage, IMRAN, SCHEDULED_JOB, "after", [image])),
    ).toEqual({ ok: false, error: "refused" });
    expect(await atSharma((c) => completeWork(c, audit, IMRAN, SCHEDULED_JOB, ""))).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("audits the check-in and the completion as the technician", async () => {
    const { rows } = await owner.tx((c) =>
      c.query<{ action: string; actor_id: string }>(
        `select action, actor_id from audit.event where entity_id = $1 and action like 'job.%'
         order by at`,
        [SCHEDULED_JOB],
      ),
    );
    expect(rows).toEqual([
      { action: "job.check_in", actor_id: IMRAN.memberId },
      { action: "job.complete", actor_id: IMRAN.memberId },
    ]);
  });
});

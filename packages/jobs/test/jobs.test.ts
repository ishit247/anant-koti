import { readFile } from "node:fs/promises";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { getConstructionPlans } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJobs, defineJob, type Jobs, migrations } from "../src/index.ts";

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const note = z.object({ text: z.string() });
const fast = { retryLimit: 1, retryDelay: 1 };

describe("jobs", () => {
  let database: TestDb;
  let app: Db;
  let jobs: Jobs;
  const seen: string[] = [];
  const dead: string[] = [];

  const deadNote = defineJob("test.note_dead", note, { retry: { retryLimit: 0, retryDelay: 0 } });
  const noted = defineJob("test.note", note, { retry: fast });
  const failing = defineJob("test.failing", note, { retry: fast, deadLetter: deadNote });

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [migrations],
    });
    app = database.connect("kaamkoti_app");
    const log = createLogger({ service: "test", write: () => {} });
    jobs = createJobs({ url: database.url("kaamkoti_app"), log, pollingIntervalSeconds: 0.5 });
    await jobs.start([noted, failing, deadNote]);
    await jobs.work(noted, async ({ text }) => {
      seen.push(text);
    });
    await jobs.work(failing, async () => {
      throw new Error("provider down");
    });
    await jobs.work(deadNote, async ({ text }) => {
      dead.push(text);
    });
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
  });

  it("installs exactly the schema the installed pg-boss expects", async () => {
    const file = await readFile(new URL("0001_pgboss.sql", migrations.dir), "utf8");
    const plan = getConstructionPlans("pgboss")
      .replace(/^\s*BEGIN;\n/, "")
      .replace(/\n\s*COMMIT;\s*$/, "\n");
    expect(file.replace(/^(--[^\n]*\n)+/, "")).toBe(plan);
  });

  it("runs a job sent in a committed transaction", async () => {
    await app.tx((client) => jobs.send(client, noted, { text: "committed" }));
    await until(() => seen.includes("committed"), "the job to run");
  });

  it("drops a job sent in a transaction that rolls back", async () => {
    await expect(
      app.tx(async (client) => {
        await jobs.send(client, noted, { text: "rolled-back" });
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");
    await app.tx((client) => jobs.send(client, noted, { text: "marker" }));
    await until(() => seen.includes("marker"), "the marker job");
    expect(seen).not.toContain("rolled-back");
  });

  it("retries a failing job, then hands its payload to the dead-letter job", async () => {
    await app.tx((client) => jobs.send(client, failing, { text: "undeliverable" }));
    await until(() => dead.includes("undeliverable"), "the dead letter");
  });

  it("gives the runtime role no DDL and no truncate on the pg-boss schema", async () => {
    for (const sql of [
      "truncate pgboss.job",
      "create table pgboss.extra (id int)",
      "drop table pgboss.queue",
    ]) {
      await expect(app.tx((client) => client.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});

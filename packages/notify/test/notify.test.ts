import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs, migrations as jobsMigrations } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createOutbox, migrations as outboxMigrations } from "@bodhchakra/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotify, type Notify, type NotifyMessage, notifyMessage } from "../src/index.ts";

// Platform's handling of the message (channel, template, retries) is tested in services/platform.
describe("notify client", () => {
  let database: TestDb;
  let app: Db;
  let jobs: Jobs;
  let notify: Notify;

  const message: NotifyMessage = {
    businessId: "00000000-0000-4000-8000-000000000001",
    template: "quote.sent",
    to: { email: "customer@example.com", phone: "+919000000001" },
    vars: { businessName: "Sharma Cooling", total: "₹295.00" },
  };

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [jobsMigrations, outboxMigrations],
    });
    app = database.connect("kaamkoti_app");
    const log = createLogger({ service: "test", write: () => {} });
    jobs = createJobs({ url: database.url("kaamkoti_app"), log, sendOnly: true });
    const outbox = createOutbox({ jobs, log });
    await jobs.start(outbox.jobTypes);
    notify = createNotify(outbox);
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
  });

  it("queues the message for platform once per key", async () => {
    for (let i = 0; i < 2; i++) {
      await app.tx((client) => notify.send(client, message, "quote.sent:q1"));
    }

    const { rows } = await app.tx((client) =>
      client.query<{ topic: string; payload: unknown }>(
        "select topic, payload from outbox.message where idempotency_key = 'notify:quote.sent:q1'",
      ),
    );
    expect(rows).toEqual([{ topic: "notify.send", payload: message }]);
    expect(notifyMessage.parse(rows[0]?.payload)).toEqual(message);
  });
});

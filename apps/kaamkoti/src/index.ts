import { readFile } from "node:fs/promises";
import { migrations as audit } from "@bodhchakra/audit";
import { migrations as auth } from "@bodhchakra/auth";
import { createPool, type MigrationFolder } from "@bodhchakra/db";
import { migrations as jobs } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { migrations as outbox } from "@bodhchakra/outbox";
import { migrations as storage } from "@bodhchakra/storage";
import { migrations as tenancy } from "@bodhchakra/tenancy";
import { migrations as tokens } from "@bodhchakra/tokens";
import { seedTemplates } from "./seed-templates.ts";
import { saveTradeTemplate } from "./trade-template.ts";

export {
  type BusinessProfile,
  businessProfile,
  type CatalogueItem,
  catalogueRowInput,
  listCatalogue,
  saveCatalogue,
  startFromTemplate,
} from "./business-profile.ts";
export { PRIVATE_BUCKET } from "./config.ts";
export {
  type IntakeError,
  type IntakeInput,
  type IntakeResult,
  MAX_REQUEST_PHOTOS,
  parseAnswers,
  readIntakeForm,
  submitRequest,
  toE164,
} from "./intake.ts";
export { JOB_STATUSES, type JobStatus } from "./job.ts";
export {
  type CustomerJobView,
  issueJobLink,
  JOB_LINK_DAYS,
  openJobLink,
  revokeJobLinks,
} from "./job-link.ts";
export { CLIENT_IP_HEADER, clientIp, LIMITS, overLimit } from "./limits.ts";
export { type PublicPage, publicPage } from "./public-page.ts";
export {
  latestTradeTemplate,
  listTradeTemplates,
  saveTradeTemplate,
  type TradeTemplate,
} from "./trade-template.ts";

/** The role web and worker connect as (docs/architecture.md, section 2); migrations grant to it. */
export const RUNTIME_ROLE = "kaamkoti_app";

/** Every migration folder the Kaam Koti database needs: modules in dependency order, then the app's own. */
export const migrations: readonly MigrationFolder[] = [
  audit,
  jobs,
  outbox,
  tokens,
  storage,
  tenancy,
  auth,
  { name: "kaamkoti", dir: new URL("../migrations/", import.meta.url) },
];

/** Loads the development seed. `url` connects as the database's owner role. */
export async function seed(url: string, log: Logger): Promise<void> {
  const sql = await readFile(new URL("../seed.sql", import.meta.url), "utf8");
  const db = createPool({ url, log, max: 1 });
  try {
    await db.tx(async (client) => {
      await client.query(sql);
      for (const template of seedTemplates) await saveTradeTemplate(client, template);
    });
  } finally {
    await db.end();
  }
}

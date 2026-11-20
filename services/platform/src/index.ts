import type { MigrationFolder } from "@bodhchakra/db";
import { migrations as outbox } from "@bodhchakra/outbox";

/** The role the platform container connects as (docs/architecture.md, section 2); migrations grant to it. */
export const RUNTIME_ROLE = "platform_app";

/** better-auth's tables (src/identity.ts); platform's own, so the folder lives here and not in a module. */
const identity: MigrationFolder = {
  name: "identity",
  dir: new URL("../migrations/identity/", import.meta.url),
};

/** Every migration folder the platform database needs, in dependency order. */
export const migrations: readonly MigrationFolder[] = [outbox, identity];

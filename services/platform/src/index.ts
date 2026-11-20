import type { MigrationFolder } from "@bodhchakra/db";
import { migrations as outbox } from "@bodhchakra/outbox";

/** The role the platform container connects as (docs/architecture.md, section 2); migrations grant to it. */
export const RUNTIME_ROLE = "platform_app";

/** Every migration folder the platform database needs, in dependency order. */
export const migrations: readonly MigrationFolder[] = [outbox];

import { pathToFileURL } from "node:url";
import type { DbClient, MigrationFolder } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";

export type Actor =
  | { readonly kind: "system" }
  | { readonly kind: "member" | "customer" | "platform"; readonly id: string };

export interface AuditEvent {
  readonly businessId: string;
  readonly actor: Actor;
  /** Dotted lower-case, e.g. `payment.recorded`. */
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  /** Ids and amounts only, never names, phones or free text. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Audit {
  /**
   * Records the event inside a savepoint on the caller's transaction. If the audit insert fails, only the
   * savepoint is rolled back and the failure is logged, so the business write it describes still commits.
   */
  record(client: DbClient, event: AuditEvent): Promise<void>;
  /**
   * Records the event with no savepoint, so a failure aborts the caller's transaction. For money events
   * (payment recorded, invoice paid or void): a payment that cannot be audited must not be written.
   */
  recordStrict(client: DbClient, event: AuditEvent): Promise<void>;
}

async function insert(client: DbClient, event: AuditEvent): Promise<void> {
  await client.query(
    `insert into audit.event (business_id, actor_kind, actor_id, action, entity, entity_id, data)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.businessId,
      event.actor.kind,
      event.actor.kind === "system" ? null : event.actor.id,
      event.action,
      event.entity,
      event.entityId,
      event.data ?? {},
    ],
  );
}

export function createAudit(log: Logger): Audit {
  return {
    async record(client, event) {
      await client.query("savepoint audit_record");
      try {
        await insert(client, event);
      } catch (error) {
        // The documented fallback (docs/architecture.md 11): keep the caller's work, lose only the audit row.
        // If the rollback itself fails the connection is broken, and that error propagates.
        await client.query("rollback to savepoint audit_record");
        log.error("audit record failed; business write kept", {
          action: event.action,
          entity: event.entity,
          entityId: event.entityId,
          error,
        });
      }
      await client.query("release savepoint audit_record");
    },
    recordStrict: insert,
  };
}

/** The module's schema migrations; an app lists this before its own folder. */
export const migrations: MigrationFolder = {
  name: "audit",
  // Not `new URL(…, import.meta.url)`: the web bundler would try to resolve the folder as a module.
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};

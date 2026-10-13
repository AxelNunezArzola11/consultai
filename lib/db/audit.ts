/**
 * Audit log write helper — append-only.
 *
 * All audit log writes MUST go through this function.
 * The DB enforces append-only at the trigger level (0001_audit_log_append_only_trigger.sql).
 * This module is the app-layer enforcement: no UPDATE or DELETE exports.
 */

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

export interface AuditLogEntry {
  entityType:
    | "project"
    | "milestone"
    | "candidate"
    | "payment"
    | "nda"
    | "meeting"
    | "dispute";
  entityId: string;
  event: string;
  actor: string;
  payload?: Record<string, unknown>;
}

/**
 * Appends one entry to the audit log.
 * Returns the inserted row's bigint id.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<bigint> {
  const [row] = await db
    .insert(auditLog)
    .values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      event: entry.event,
      actor: entry.actor,
      payload: entry.payload ?? null,
    })
    .returning({ id: auditLog.id });

  return row.id;
}

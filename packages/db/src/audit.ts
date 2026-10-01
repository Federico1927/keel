import type { DbExecutor } from "./client";
import { auditLogs } from "./schema";

export type ActorType = "user" | "system" | "super_admin" | "impersonation";

export interface AuditInput {
  tenantId: string | null;
  actorUserId?: string | null;
  actorType?: ActorType;
  impersonatedBy?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Appends an audit row. Inside `withTenant` the app role may only insert rows for
 * the current tenant (RLS); platform-level rows (tenantId null) need the admin executor.
 */
export async function recordAudit(executor: DbExecutor, input: AuditInput): Promise<void> {
  await executor.insert(auditLogs).values({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? (input.actorUserId ? "user" : "system"),
    impersonatedBy: input.impersonatedBy ?? null,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    diff: input.diff ?? {},
    metadata: input.metadata ?? {},
    ip: input.ip ?? null,
  });
}

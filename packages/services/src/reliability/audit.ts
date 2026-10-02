import { and, eq, inArray, isNull, lt, or, recordAudit, schema, sql, type Database, type SQL } from "@hullwise/db";
import { PLATFORM_AUDIT_RETENTION_DAYS, auditRetentionDays } from "@hullwise/config";
import { retentionCutoff } from "@hullwise/core";
import { finishJobRun, startJobRun } from "./jobs";

/* ---------- viewer filters (owner page and console page share them) ---------- */

export const AUDIT_ACTOR_TYPES = ["user", "impersonation", "super_admin", "system"] as const;

export interface AuditFilters {
  /** Action prefix (`order.`, `tenant.data_export`). */
  action?: string;
  /** Exact actor (user id): matches the acting user or the super-admin behind an impersonation. */
  actorUserId?: string;
  /** Part of the actor's email (console only: reads the platform users table). */
  actorEmail?: string;
  actorType?: string;
  entityType?: string;
  /** The record: entity id. */
  entityId?: string;
  /** Inclusive dates (YYYY-MM-DD) in `timezone`. */
  from?: string;
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const like = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Query string → filters (unknown values dropped). */
export function parseAuditFilters(q: Record<string, string | undefined>): AuditFilters {
  const f: AuditFilters = {};
  if (q.action?.trim()) f.action = q.action.trim().slice(0, 80);
  if (q.actor_id && UUID.test(q.actor_id)) f.actorUserId = q.actor_id;
  if (q.actor?.trim()) f.actorEmail = q.actor.trim().slice(0, 120);
  if ((AUDIT_ACTOR_TYPES as readonly string[]).includes(q.actor_type ?? "")) f.actorType = q.actor_type;
  if (q.entity_type && /^[a-z0-9_.:-]{1,60}$/i.test(q.entity_type)) f.entityType = q.entity_type;
  if (q.entity?.trim()) f.entityId = q.entity.trim().slice(0, 120);
  if (q.from && DATE.test(q.from)) f.from = q.from;
  if (q.to && DATE.test(q.to)) f.to = q.to;
  return f;
}

/** SQL conditions on `audit_logs` for the filters; dates are whole days in the viewer's time zone. */
export function auditFilterConditions(f: AuditFilters, opts: { timezone?: string } = {}): SQL[] {
  const a = schema.auditLogs;
  const tz = opts.timezone ?? "UTC";
  const conds: SQL[] = [];
  if (f.action) conds.push(sql`${a.action} like ${like(f.action) + "%"}`);
  if (f.actorUserId) conds.push(or(eq(a.actorUserId, f.actorUserId), eq(a.impersonatedBy, f.actorUserId))!);
  if (f.actorEmail) {
    const pattern = `%${like(f.actorEmail)}%`;
    conds.push(or(sql`${a.actorUserId} in (select id from users where email ilike ${pattern})`, sql`${a.impersonatedBy} in (select id from users where email ilike ${pattern})`)!);
  }
  if (f.actorType) conds.push(eq(a.actorType, f.actorType));
  if (f.entityType) conds.push(eq(a.entityType, f.entityType));
  if (f.entityId) conds.push(eq(a.entityId, f.entityId));
  if (f.from) conds.push(sql`${a.createdAt} >= (${f.from}::date)::timestamp at time zone ${tz}`);
  if (f.to) conds.push(sql`${a.createdAt} < ((${f.to}::date + 1)::timestamp at time zone ${tz})`);
  return conds;
}

/* ---------- retention ---------- */

export interface AuditRetentionResult {
  tenantId: string | null;
  retentionDays: number;
  cutoff: Date;
  deleted: number;
  batches: number;
}

async function purgeScope(db: Database, scope: { tenantId: string | null; planKey: string | null }, opts: { now: Date; batchSize: number; maxBatches: number }): Promise<AuditRetentionResult> {
  const a = schema.auditLogs;
  const retentionDays = scope.tenantId ? auditRetentionDays(scope.planKey) : PLATFORM_AUDIT_RETENTION_DAYS;
  const cutoff = retentionCutoff(retentionDays, opts.now);
  const runId = await startJobRun(db, { queue: "scheduler.tick", jobType: "audit.retention", tenantId: scope.tenantId, trigger: "schedule" }, opts.now);
  const owner = scope.tenantId ? eq(a.tenantId, scope.tenantId) : isNull(a.tenantId);
  let deleted = 0;
  let batches = 0;
  try {
    // short batches: each delete is its own statement, so the table is never locked for long
    for (; batches < opts.maxBatches; ) {
      const r = await db.delete(a).where(inArray(a.id, db.select({ id: a.id }).from(a).where(and(owner, lt(a.createdAt, cutoff))).limit(opts.batchSize)));
      const n = r.rowCount ?? 0;
      if (n === 0) break;
      deleted += n;
      batches++;
      if (n < opts.batchSize) break;
    }
    if (deleted > 0) await recordAudit(db, { tenantId: scope.tenantId, actorType: "system", action: "audit.retention_purged", entityType: "audit_logs", metadata: { deleted, batches, cutoff: cutoff.toISOString(), retentionDays } });
    await finishJobRun(db, runId, { status: "succeeded", startedAt: opts.now, rows: deleted, summary: { batches, cutoff: cutoff.toISOString(), retentionDays, planKey: scope.planKey } });
  } catch (e) {
    await finishJobRun(db, runId, { status: "failed", startedAt: opts.now, rows: deleted, error: e instanceof Error ? e.message : String(e), summary: { batches } });
    throw e;
  }
  return { tenantId: scope.tenantId, retentionDays, cutoff, deleted, batches };
}

/**
 * Nightly audit retention (#32): per tenant, rows older than the plan's window (`auditRetentionDays`)
 * are deleted in batches; platform rows keep the longest window. Each scope leaves a `job_runs` row
 * (`audit.retention`, rows = deleted, batches and cutoff in the summary) and, when something went,
 * one audit row saying how much. Runs on the admin connection (tenants can never delete audit rows).
 */
export async function purgeExpiredAudit(db: Database, opts: { now?: Date; batchSize?: number; maxBatches?: number; tenantIds?: string[] } = {}): Promise<AuditRetentionResult[]> {
  const now = opts.now ?? new Date();
  const cfg = { now, batchSize: opts.batchSize ?? 5000, maxBatches: opts.maxBatches ?? 200 };
  const tenants = await db.select({ id: schema.tenants.id, planKey: schema.tenants.planKey }).from(schema.tenants).where(opts.tenantIds ? inArray(schema.tenants.id, opts.tenantIds) : undefined);
  const out: AuditRetentionResult[] = [];
  for (const t of tenants) out.push(await purgeScope(db, { tenantId: t.id, planKey: t.planKey }, cfg));
  if (!opts.tenantIds) out.push(await purgeScope(db, { tenantId: null, planKey: null }, cfg));
  return out;
}

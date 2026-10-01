import { and, eq, inArray, lt, schema, sql } from "@keel/db";
import type { ServiceContext } from "../context";

export interface PurgeResult {
  webhookEvents: number;
  platformWrites: number;
  syncRuns: number;
  drift: number;
}

/**
 * Platform history housekeeping (daily tick): rows older than the retention window are deleted
 * when they are finished: processed webhook events, succeeded or superseded outbox writes,
 * synchronous write records (their flow owns the failure), successful runs, failed runs already
 * followed by a success, drift not seen since. Failed webhooks and failed asynchronous writes stay
 * until they are resolved (replayed, retried, or superseded by a newer write).
 */
export async function purgeExpiredPlatformRows(ctx: ServiceContext, opts: { days: number; now?: Date }): Promise<PurgeResult> {
  const cutoff = new Date((opts.now ?? ctx.now ?? new Date()).getTime() - opts.days * 864e5);
  const t = ctx.tenantId;
  const webhookEvents = await ctx.tx.delete(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, t), eq(schema.webhookEvents.status, "processed"), lt(sql`coalesce(${schema.webhookEvents.processedAt}, ${schema.webhookEvents.receivedAt})`, cutoff))).returning({ id: schema.webhookEvents.id });
  const finishedWrites = await ctx.tx.delete(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, t), inArray(schema.platformWrites.status, ["succeeded", "superseded"]), lt(sql`coalesce(${schema.platformWrites.completedAt}, ${schema.platformWrites.updatedAt})`, cutoff))).returning({ id: schema.platformWrites.id });
  const syncWrites = await ctx.tx.delete(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, t), eq(schema.platformWrites.mode, "sync"), eq(schema.platformWrites.status, "failed"), lt(schema.platformWrites.updatedAt, cutoff))).returning({ id: schema.platformWrites.id });
  const runs = await ctx.tx.delete(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, t), lt(sql`coalesce(${schema.syncRuns.finishedAt}, ${schema.syncRuns.startedAt})`, cutoff), sql`(${schema.syncRuns.status} = 'success' or (${schema.syncRuns.status} = 'error' and exists (select 1 from sync_runs s2 where s2.tenant_id = ${schema.syncRuns.tenantId} and s2.provider = ${schema.syncRuns.provider} and s2.object_type = ${schema.syncRuns.objectType} and s2.status = 'success' and s2.started_at > ${schema.syncRuns.startedAt})))`)).returning({ id: schema.syncRuns.id });
  const drift = await ctx.tx.delete(schema.inventoryDrift).where(and(eq(schema.inventoryDrift.tenantId, t), lt(schema.inventoryDrift.lastSeenAt, cutoff))).returning({ id: schema.inventoryDrift.id });
  return { webhookEvents: webhookEvents.length, platformWrites: finishedWrites.length + syncWrites.length, syncRuns: runs.length, drift: drift.length };
}

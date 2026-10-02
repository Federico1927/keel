import { and, eq, inArray, recordAudit, schema, sql } from "@hullwise/db";
import { SOURCE_PROBLEM_STATUSES, WATCHDOG_NOTIFY_EVERY_HOURS } from "@hullwise/config";
import { isSyncDelayed, sourceStaleness, sourceStatus, windowElapsed, type TenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { membersWithRoles, notifyUsers } from "../notifications";

/**
 * Integration watchdog (#32), one tenant per call inside its RLS transaction (the `watchdog` tick
 * runs it every 10 minutes):
 * - a source with no success inside its freshness window becomes `stale`, one that keeps writing
 *   nothing becomes `idle` (same rule as `recordHealth`, `sourceStatus` in core);
 * - a stale source gets one automatic resync per stale episode (the caller enqueues it): if that
 *   does not help (an expired token), more resyncs would not either, people are told instead;
 * - owners and admins hear about a stale or idle source at most once every 6 hours per source
 *   (a stale one only once it is late beyond the tenant's grace, `syncDelayGraceMinutes`).
 * The caller raises the platform alert for stale sources (admin connection).
 */
export interface WatchdogSource {
  source: string;
  provider: string;
  status: string;
  minutesLate: number;
}

export interface WatchdogResult {
  checked: number;
  stale: WatchdogSource[];
  idle: WatchdogSource[];
  /** Sources to resync now. */
  resync: WatchdogSource[];
  notified: string[];
}

const PROBLEMS: readonly string[] = SOURCE_PROBLEM_STATUSES;

export async function runWatchdog(ctx: ServiceContext, settings: Pick<TenantSettings, "syncDelayGraceMinutes">): Promise<WatchdogResult> {
  const now = ctx.now ?? new Date();
  const out: WatchdogResult = { checked: 0, stale: [], idle: [], resync: [], notified: [] };
  const integrations = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), inArray(schema.integrations.status, ["connected", "error", "syncing"])));
  if (!integrations.length) return out;
  const health = await ctx.tx.select().from(schema.integrationHealth).where(eq(schema.integrationHealth.tenantId, ctx.tenantId));
  let recipients: string[] | null = null;
  const sys: ServiceContext = { ...ctx, actor: { type: "system", userId: null } };
  for (const h of health) {
    const provider = h.source.split(":")[0]!;
    const integ = integrations.find((i) => i.provider === provider);
    if (!integ) continue;
    out.checked++;
    const state = { source: h.source, lastSuccessAt: h.lastSuccessAt, connectedAt: integ.createdAt, freshnessMinutes: h.freshnessMinutes, consecutiveFailures: h.consecutiveFailures, zeroRowRuns: h.zeroRowRuns };
    const status = sourceStatus(state, now);
    const { stale, minutesLate } = sourceStaleness(state, now);
    const item: WatchdogSource = { source: h.source, provider, status, minutesLate };
    const set: Partial<typeof schema.integrationHealth.$inferInsert> = {};
    if (status !== h.status) set.status = status;
    if (stale) {
      out.stale.push(item);
      // one automatic resync per stale episode: none yet, or the last one predates the last success
      if (!h.resyncRequestedAt || (h.lastSuccessAt && h.resyncRequestedAt < h.lastSuccessAt)) {
        out.resync.push(item);
        set.resyncRequestedAt = now;
        await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "integration.watchdog_resync", entityType: "integration", entityId: provider, metadata: { source: h.source, minutesLate, lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null } });
      }
    } else if (status === "idle") out.idle.push(item);
    const worthTelling = status === "idle" || (stale && isSyncDelayed({ lastSuccessAt: h.lastSuccessAt, connectedAt: integ.createdAt, freshnessMinutes: h.freshnessMinutes, graceMinutes: settings.syncDelayGraceMinutes, now }).delayed);
    if (worthTelling && windowElapsed(h.watchdogNotifiedAt, WATCHDOG_NOTIFY_EVERY_HOURS * 60, now)) {
      recipients ??= await membersWithRoles(ctx, ["owner", "admin"]);
      const link = `/integrations#${provider}`;
      if (stale) await notifyUsers(sys, { userIds: recipients, type: "sync_delay", severity: "warning", title: h.source, body: `+${Math.max(1, Math.round(minutesLate / 60))}h`, link, metadata: { source: h.source, minutesLate, status } });
      else await notifyUsers(sys, { userIds: recipients, type: "integration_health", severity: "warning", title: h.source, body: "idle", link, metadata: { source: h.source, zeroRowRuns: h.zeroRowRuns, status } });
      set.watchdogNotifiedAt = now;
      out.notified.push(h.source);
    }
    if (Object.keys(set).length) await ctx.tx.update(schema.integrationHealth).set({ ...set, updatedAt: now }).where(eq(schema.integrationHealth.id, h.id));
  }
  return out;
}

/** Sources of connected integrations that are not OK: the dashboard widget. */
export async function sourcesNeedingAttention(ctx: ServiceContext): Promise<{ total: number; problems: { source: string; status: string; lastSuccessAt: Date | null }[] }> {
  const rows = await ctx.tx
    .select({ source: schema.integrationHealth.source, status: schema.integrationHealth.status, lastSuccessAt: schema.integrationHealth.lastSuccessAt })
    .from(schema.integrationHealth)
    .innerJoin(schema.integrations, and(eq(schema.integrations.tenantId, schema.integrationHealth.tenantId), sql`${schema.integrations.provider} = split_part(${schema.integrationHealth.source}, ':', 1)`))
    .where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), inArray(schema.integrations.status, ["connected", "error", "syncing"])))
    .orderBy(schema.integrationHealth.source);
  return { total: rows.length, problems: rows.filter((r) => PROBLEMS.includes(r.status)) };
}

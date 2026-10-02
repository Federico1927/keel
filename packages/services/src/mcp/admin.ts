import { and, eq, gt, gte, isNull, recordAudit, schema, sql, type Database } from "@keel/db";
import { parseTenantSettings } from "@keel/core";
import { mcpAvailabilityFor, type McpAvailability } from "./auth";

/**
 * Super-admin view of the MCP server (#21): usage per tenant and the kill switch. Runs on the admin
 * connection (console code only); every change to a tenant is audited.
 */

export interface McpTenantUsage {
  tenantId: string;
  name: string;
  slug: string;
  planKey: string;
  availability: McpAvailability;
  enabledByTenant: boolean;
  killedAt: Date | null;
  killNote: string | null;
  calls: number;
  errors: number;
  denied: number;
  rateLimited: number;
  authFailed: number;
  users: number;
  activeConnections: number;
  pendingProposals: number;
  lastCallAt: Date | null;
}

export async function mcpUsageByTenant(admin: Database, opts: { days?: number; now?: Date } = {}): Promise<{ tenants: McpTenantUsage[]; unknownTokenFailures: number; platformDisabled: boolean }> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 30) * 864e5);
  const l = schema.mcpRequestLog;
  const [tenants, usage, tokens, proposals, unknown] = await Promise.all([
    admin.select().from(schema.tenants).orderBy(schema.tenants.name),
    admin
      .select({ tenantId: l.tenantId, calls: sql<number>`count(*) filter (where ${l.method} in ('tools/call','tools/list'))::int`, errors: sql<number>`count(*) filter (where ${l.outcome} = 'error')::int`, denied: sql<number>`count(*) filter (where ${l.outcome} in ('denied','disabled'))::int`, rateLimited: sql<number>`count(*) filter (where ${l.outcome} = 'rate_limited')::int`, authFailed: sql<number>`count(*) filter (where ${l.outcome} = 'auth_failed')::int`, users: sql<number>`count(distinct ${l.userId})::int`, lastCallAt: sql<Date | null>`max(${l.createdAt})` })
      .from(l)
      .where(gte(l.createdAt, since))
      .groupBy(l.tenantId),
    admin.select({ tenantId: schema.mcpTokens.tenantId, n: sql<number>`count(*)::int` }).from(schema.mcpTokens).where(and(isNull(schema.mcpTokens.revokedAt), sql`(${schema.mcpTokens.expiresAt} > ${now} or ${schema.mcpTokens.refreshExpiresAt} > ${now})`)).groupBy(schema.mcpTokens.tenantId),
    admin.select({ tenantId: schema.mcpPendingActions.tenantId, n: sql<number>`count(*)::int` }).from(schema.mcpPendingActions).where(and(eq(schema.mcpPendingActions.status, "pending"), gt(schema.mcpPendingActions.expiresAt, now))).groupBy(schema.mcpPendingActions.tenantId),
    admin.select({ n: sql<number>`count(*)::int` }).from(l).where(and(isNull(l.tenantId), gte(l.createdAt, since))),
  ]);
  return {
    platformDisabled: process.env.KEEL_MCP_DISABLED === "1",
    unknownTokenFailures: unknown[0]?.n ?? 0,
    tenants: tenants.map((t) => {
      const u = usage.find((x) => x.tenantId === t.id);
      const settings = parseTenantSettings(t.settings);
      return { tenantId: t.id, name: t.name, slug: t.slug, planKey: t.planKey, availability: mcpAvailabilityFor({ planKey: t.planKey, status: t.status, settings, mcpDisabledAt: t.mcpDisabledAt }), enabledByTenant: settings.mcpEnabled, killedAt: t.mcpDisabledAt, killNote: t.mcpDisabledNote, calls: u?.calls ?? 0, errors: u?.errors ?? 0, denied: u?.denied ?? 0, rateLimited: u?.rateLimited ?? 0, authFailed: u?.authFailed ?? 0, users: u?.users ?? 0, activeConnections: tokens.find((x) => x.tenantId === t.id)?.n ?? 0, pendingProposals: proposals.find((x) => x.tenantId === t.id)?.n ?? 0, lastCallAt: u?.lastCallAt ? new Date(u.lastCallAt) : null };
    }),
  };
}

/** Kill switch: every MCP call of the tenant is refused (403) until a super-admin clears it. Audited on the tenant. */
export async function setMcpKillSwitch(admin: Database, input: { tenantId: string; disabled: boolean; note?: string | null; actorUserId: string; now?: Date }): Promise<boolean> {
  const [t] = await admin.select({ id: schema.tenants.id, disabledAt: schema.tenants.mcpDisabledAt }).from(schema.tenants).where(eq(schema.tenants.id, input.tenantId)).limit(1);
  if (!t) return false;
  const now = input.now ?? new Date();
  const note = input.note?.trim().slice(0, 300) || null;
  const next = input.disabled ? (t.disabledAt ?? now) : null;
  await admin.update(schema.tenants).set({ mcpDisabledAt: next, mcpDisabledNote: input.disabled ? note : null }).where(eq(schema.tenants.id, t.id));
  await recordAudit(admin, { tenantId: t.id, actorUserId: input.actorUserId, actorType: "super_admin", action: input.disabled ? "mcp.kill_switch_on" : "mcp.kill_switch_off", entityType: "tenant", entityId: t.id, diff: { mcpDisabledAt: { from: t.disabledAt?.toISOString() ?? null, to: next?.toISOString() ?? null } }, metadata: { note } });
  return true;
}

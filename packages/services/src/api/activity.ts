import { and, desc, eq, gte, schema, sql } from "@hullwise/db";
import type { ServiceContext } from "../context";

/** The tenant's latest API requests (Settings → Developers), with the token name and counts of the last days. */
export async function apiRecentActivity(ctx: ServiceContext, opts: { limit?: number; days?: number } = {}) {
  const l = schema.apiRequestLog;
  const since = new Date((ctx.now ?? new Date()).getTime() - (opts.days ?? 7) * 864e5);
  const rows = await ctx.tx.select({ id: l.id, createdAt: l.createdAt, method: l.method, route: l.route, status: l.status, errorCode: l.errorCode, durationMs: l.durationMs, tokenName: schema.mcpTokens.name, userName: schema.users.name, userEmail: schema.users.email }).from(l).leftJoin(schema.mcpTokens, eq(schema.mcpTokens.id, l.tokenId)).leftJoin(schema.users, eq(schema.users.id, l.userId)).where(and(eq(l.tenantId, ctx.tenantId), gte(l.createdAt, since))).orderBy(desc(l.createdAt)).limit(opts.limit ?? 25);
  const [counts] = await ctx.tx.select({ calls: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${l.status} >= 500)::int`, denied: sql<number>`count(*) filter (where ${l.status} in (401, 403))::int`, rateLimited: sql<number>`count(*) filter (where ${l.status} = 429)::int` }).from(l).where(and(eq(l.tenantId, ctx.tenantId), gte(l.createdAt, since)));
  return { rows, counts: counts ?? { calls: 0, errors: 0, denied: 0, rateLimited: 0 } };
}

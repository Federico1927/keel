import { and, desc, eq, gte, lt, schema, sql, withTenant } from "@hullwise/db";
import type { ServiceContext } from "../context";
import { MCP_LIMITS } from "@hullwise/config";
import type { McpDeps } from "./auth";

/**
 * Rate limits and the request log of the MCP server (#21).
 *
 * Limits are fixed one-minute windows per token and per tenant, counted in Postgres so every web
 * instance shares them. They FAIL CLOSED: if the counter cannot be read or written, the call is
 * refused (429 with a short retry), never let through.
 */

export interface RateDecision {
  ok: boolean;
  /** Seconds until the window resets (the `Retry-After` header). */
  retryAfter: number;
  reason?: "token" | "tenant" | "limiter_unavailable";
}

export interface RateLimits {
  perToken: number;
  perTenant: number;
}

const DEFAULT_LIMITS: RateLimits = { perToken: MCP_LIMITS.perTokenPerMinute, perTenant: MCP_LIMITS.perTenantPerMinute };

/** `bucketPrefix` keeps other users of the windows apart (the REST API counts under `api:`). */
export async function checkMcpRateLimit(deps: McpDeps, input: { tenantId: string; tokenId: string; bucketPrefix?: string }, limits: RateLimits = DEFAULT_LIMITS): Promise<RateDecision> {
  const prefix = input.bucketPrefix ?? "";
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
  try {
    return await withTenant(
      input.tenantId,
      async (tx) => {
        const bump = async (bucket: string) => {
          const b = schema.mcpRateBuckets;
          const [r] = await tx.insert(b).values({ tenantId: input.tenantId, bucket, windowStart, count: 1 }).onConflictDoUpdate({ target: [b.tenantId, b.bucket, b.windowStart], set: { count: sql`${b.count} + 1` } }).returning({ count: b.count });
          const n = Number(r?.count);
          if (!Number.isFinite(n)) throw new Error("rate counter unreadable");
          // first call of a new window: drop this bucket's old windows
          if (n === 1) await tx.delete(schema.mcpRateBuckets).where(and(eq(schema.mcpRateBuckets.tenantId, input.tenantId), eq(schema.mcpRateBuckets.bucket, bucket), lt(schema.mcpRateBuckets.windowStart, windowStart)));
          return n;
        };
        const tenantCount = await bump(`${prefix}tenant`);
        const tokenCount = await bump(`${prefix}token:${input.tokenId}`);
        if (tokenCount > limits.perToken) return { ok: false, retryAfter, reason: "token" as const };
        if (tenantCount > limits.perTenant) return { ok: false, retryAfter, reason: "tenant" as const };
        return { ok: true, retryAfter };
      },
      deps.app,
    );
  } catch (err) {
    console.error("[mcp] rate limiter unavailable, refusing the call", err);
    return { ok: false, retryAfter: 5, reason: "limiter_unavailable" };
  }
}

export type McpOutcome = "ok" | "error" | "denied" | "invalid_input" | "not_found" | "rate_limited" | "auth_failed" | "disabled";

export interface McpLogEntry {
  tenantId?: string | null;
  tokenId?: string | null;
  userId?: string | null;
  clientName?: string | null;
  method: string;
  tool?: string | null;
  outcome: McpOutcome;
  errorCode?: string | null;
  durationMs?: number;
}

/**
 * One row per call: never arguments or results. Tenant rows are written in the tenant's own
 * transaction (RLS); calls with no tenant (unknown token) through the admin connection.
 * A logging failure is reported and never fails the call.
 */
export async function logMcpRequest(deps: McpDeps, e: McpLogEntry): Promise<void> {
  const row = { tenantId: e.tenantId ?? null, tokenId: e.tokenId ?? null, userId: e.userId ?? null, clientName: e.clientName?.slice(0, 100) ?? null, method: e.method.slice(0, 40), tool: e.tool?.slice(0, 80) ?? null, outcome: e.outcome, errorCode: e.errorCode?.slice(0, 80) ?? null, durationMs: Math.max(0, Math.round(e.durationMs ?? 0)), createdAt: deps.now?.() ?? new Date() };
  try {
    if (row.tenantId) await withTenant(row.tenantId, (tx) => tx.insert(schema.mcpRequestLog).values(row), deps.app);
    else await deps.admin.insert(schema.mcpRequestLog).values(row);
  } catch (err) {
    console.error("[mcp] request log write failed", err);
  }
}

/** The tenant's latest MCP calls (Settings → AI & MCP), with the user's name. */
export async function mcpRecentActivity(ctx: ServiceContext, opts: { limit?: number; days?: number } = {}) {
  const l = schema.mcpRequestLog;
  const since = new Date((ctx.now ?? new Date()).getTime() - (opts.days ?? 7) * 864e5);
  const rows = await ctx.tx.select({ id: l.id, createdAt: l.createdAt, method: l.method, tool: l.tool, outcome: l.outcome, errorCode: l.errorCode, durationMs: l.durationMs, clientName: l.clientName, userName: schema.users.name, userEmail: schema.users.email }).from(l).leftJoin(schema.users, eq(schema.users.id, l.userId)).where(and(eq(l.tenantId, ctx.tenantId), gte(l.createdAt, since))).orderBy(desc(l.createdAt)).limit(opts.limit ?? 25);
  const [counts] = await ctx.tx.select({ calls: sql<number>`count(*) filter (where ${l.method} in ('tools/call','tools/list'))::int`, errors: sql<number>`count(*) filter (where ${l.outcome} = 'error')::int`, denied: sql<number>`count(*) filter (where ${l.outcome} in ('denied','disabled','auth_failed'))::int`, rateLimited: sql<number>`count(*) filter (where ${l.outcome} = 'rate_limited')::int` }).from(l).where(and(eq(l.tenantId, ctx.tenantId), gte(l.createdAt, since)));
  return { rows, counts: counts ?? { calls: 0, errors: 0, denied: 0, rateLimited: 0 } };
}

import { and, count, desc, eq, gt, isNull, recordAudit, schema, sql } from "@hullwise/db";
import { API_LIMITS, API_SCOPES, MCP_LIMITS, MCP_PII_ROLES, isModuleInPlan, isTenantOperational, type ApiScope, type TenantRole } from "@hullwise/config";
import { apiPiiMode, parseApiScopes, sanitizeFreeText } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { activeRole, loadMcpTenant, McpTokenError, type McpDeps, type McpTenantInfo } from "../mcp/auth";
import { hashMcpSecret, isWellFormedMcpSecret, newMcpSecret } from "../mcp/crypto";

/**
 * Authentication of the public REST API (#81). A bearer token is an MCP token (personal access
 * token or OAuth access token, same table, same HMAC lookup); the API reads only the API scopes of
 * its `scopes` column. Gates: the token is live, the membership active, `core.api` in the plan
 * (Growth and up, like MCP), the tenant operational, no platform kill switch for tokens
 * (`tenants.mcp_disabled_at`), and `HULLWISE_API_DISABLED` unset.
 */

export type ApiAvailability = "ok" | "plan" | "killed" | "suspended" | "platform_disabled";

export function apiAvailabilityFor(t: Pick<McpTenantInfo, "planKey" | "status" | "mcpDisabledAt">, env: Record<string, string | undefined> = process.env): ApiAvailability {
  if (env.HULLWISE_API_DISABLED === "1") return "platform_disabled";
  if (!isModuleInPlan("core.api", t.planKey)) return "plan";
  if (t.mcpDisabledAt) return "killed";
  if (!isTenantOperational(t.status)) return "suspended";
  return "ok";
}

export interface ApiPrincipal {
  tokenId: string;
  tokenName: string;
  userId: string;
  role: TenantRole;
  scopes: ApiScope[];
  tenant: McpTenantInfo;
  activeAddons: string[];
  pii: "full" | "masked";
  lastUsedAt: Date | null;
}

export type ApiAuthFailure = { ok: false; status: 401; code: "missing_token" | "invalid_token" } | { ok: false; status: 403; code: Exclude<ApiAvailability, "ok">; tenantId: string; tokenId: string; userId: string };

export async function resolveApiBearer(deps: McpDeps, raw: string | null | undefined): Promise<{ ok: true; principal: ApiPrincipal } | ApiAuthFailure> {
  if (!raw) return { ok: false, status: 401, code: "missing_token" };
  if (!isWellFormedMcpSecret(raw, "pat") && !isWellFormedMcpSecret(raw, "access")) return { ok: false, status: 401, code: "invalid_token" };
  const [t] = await deps.admin.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.accessHash, hashMcpSecret(raw))).limit(1);
  const now = deps.now?.() ?? new Date();
  // unknown, revoked and expired tokens look the same to the caller
  if (!t || t.revokedAt || t.expiresAt.getTime() <= now.getTime()) return { ok: false, status: 401, code: "invalid_token" };
  const role = await activeRole(deps.admin, t.tenantId, t.userId);
  const loaded = role ? await loadMcpTenant(deps.admin, t.tenantId) : null;
  if (!role || !loaded) return { ok: false, status: 401, code: "invalid_token" };
  const availability = apiAvailabilityFor(loaded.tenant);
  if (availability !== "ok") return { ok: false, status: 403, code: availability, tenantId: t.tenantId, tokenId: t.id, userId: t.userId };
  const scopes = parseApiScopes(t.scopes);
  return { ok: true, principal: { tokenId: t.id, tokenName: t.name, userId: t.userId, role, scopes, tenant: loaded.tenant, activeAddons: loaded.activeAddons, pii: apiPiiMode(scopes, MCP_PII_ROLES.includes(role), loaded.tenant.settings.mcpFullPii), lastUsedAt: t.lastUsedAt } };
}

/* ---------- API tokens (Settings → Developers) ---------- */

/** Roles that may create tokens with API scopes: the API is an integration surface, like Integrations. */
export const API_TOKEN_ROLES: readonly TenantRole[] = ["owner", "admin"];

export interface IssuedApiToken {
  id: string;
  /** Shown once; only its HMAC is stored. */
  token: string;
  displayPrefix: string;
  expiresAt: Date;
  scopes: ApiScope[];
}

/**
 * A personal access token with API scopes (and nothing else: no MCP write scope). Owners and admins
 * only; counts against the same per-user limit as MCP tokens.
 */
export async function createApiToken(ctx: ServiceContext, input: { userId: string; role: TenantRole; name: string; scopes: readonly string[]; days: number; audit?: { actorType: "user" | "impersonation"; impersonatedBy: string | null } }): Promise<IssuedApiToken> {
  if (!API_TOKEN_ROLES.includes(input.role)) throw new McpTokenError("forbidden");
  const name = sanitizeFreeText(input.name, 60).replace(/\n/g, " ");
  const scopes = parseApiScopes(input.scopes);
  if (!name || !scopes.length || !(API_LIMITS.tokenDays as readonly number[]).includes(input.days)) throw new McpTokenError("invalid_input");
  const now = ctx.now ?? new Date();
  const [active] = await ctx.tx.select({ n: count() }).from(schema.mcpTokens).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.userId, input.userId), eq(schema.mcpTokens.kind, "pat"), isNull(schema.mcpTokens.revokedAt), gt(schema.mcpTokens.expiresAt, now)));
  if ((active?.n ?? 0) >= MCP_LIMITS.patsPerUser) throw new McpTokenError("limit_reached");
  const secret = newMcpSecret("pat");
  const expiresAt = new Date(now.getTime() + input.days * 864e5);
  const [row] = await ctx.tx.insert(schema.mcpTokens).values({ tenantId: ctx.tenantId, userId: input.userId, kind: "pat", name, displayPrefix: secret.displayPrefix, accessHash: secret.hash, scopes, expiresAt, rotatedAt: now, createdAt: now, updatedAt: now }).returning({ id: schema.mcpTokens.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.userId, actorType: input.audit?.actorType ?? "user", impersonatedBy: input.audit?.impersonatedBy ?? null, action: "api.token_created", entityType: "mcp_token", entityId: row!.id, diff: { scopes: { from: null, to: scopes } }, metadata: { name, expiresAt: expiresAt.toISOString() } });
  return { id: row!.id, token: secret.raw, displayPrefix: secret.displayPrefix, expiresAt, scopes };
}

export interface ApiTokenRow {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: ApiScope[];
  userId: string;
  userName: string | null;
  userEmail: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  state: "active" | "expired" | "revoked";
}

/** Tokens of the tenant that carry at least one API scope, newest first (revoked ones of the last 30 days included). */
export async function listApiTokens(ctx: ServiceContext, opts: { limit?: number } = {}): Promise<ApiTokenRow[]> {
  const now = ctx.now ?? new Date();
  const t = schema.mcpTokens;
  const rows = await ctx.tx
    .select({ t, userName: schema.users.name, userEmail: schema.users.email })
    .from(t)
    .innerJoin(schema.users, eq(schema.users.id, t.userId))
    .where(and(eq(t.tenantId, ctx.tenantId), sql`${t.scopes} && ${sql.param([...API_SCOPES])}::text[]`))
    .orderBy(desc(t.createdAt))
    .limit(opts.limit ?? 100);
  return rows
    .filter((r) => !r.t.revokedAt || now.getTime() - r.t.revokedAt.getTime() < 30 * 864e5)
    .map((r) => ({ id: r.t.id, name: r.t.name, displayPrefix: r.t.displayPrefix, scopes: parseApiScopes(r.t.scopes), userId: r.t.userId, userName: r.userName, userEmail: r.userEmail, createdAt: r.t.createdAt, lastUsedAt: r.t.lastUsedAt, expiresAt: r.t.expiresAt, state: r.t.revokedAt ? "revoked" : r.t.expiresAt > now ? "active" : "expired" }));
}

/** Stamps `last_used_at` at most once a minute (inside the request's tenant transaction). */
export async function touchApiToken(ctx: ServiceContext, principal: Pick<ApiPrincipal, "tokenId" | "lastUsedAt">): Promise<void> {
  const now = ctx.now ?? new Date();
  if (principal.lastUsedAt && now.getTime() - principal.lastUsedAt.getTime() < 60_000) return;
  await ctx.tx.update(schema.mcpTokens).set({ lastUsedAt: now }).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.id, principal.tokenId)));
}


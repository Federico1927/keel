import { and, count, desc, eq, gte, gt, isNull, or, recordAudit, schema, withTenant, type Database } from "@keel/db";
import { MCP_LIMITS, isModuleInPlan, isTenantRole, type McpScope, type TenantRole } from "@keel/config";
import { mcpPiiMode, parseMcpScopes, parseTenantSettings, sanitizeFreeText, type TenantSettings } from "@keel/core";
import type { ServiceContext } from "../context";
import { appBaseUrl } from "../email/unsubscribe";
import { hashMcpSecret, isWellFormedMcpSecret, newMcpSecret, randomBase62, verifyPkceS256 } from "./crypto";

/**
 * Authentication of the remote MCP server (#21): personal access tokens, OAuth 2.1 (dynamic client
 * registration, authorization code + PKCE, refresh with rotation and reuse detection, revocation)
 * and the resolution of a bearer token to the person and tenant it acts for.
 *
 * Token rows are tenant data under RLS. A bearer token arrives before the tenant is known, so the
 * lookup by hash (and only that) goes through the admin connection, like invitations and sessions;
 * every write after it runs in `withTenant` on the application connection.
 */

export interface McpDeps {
  /** Admin connection: token and code lookups by hash, platform tables (clients, tenants, memberships). */
  admin: Database;
  /** Application connection (RLS): everything tenant-scoped. */
  app: Database;
  now?: () => Date;
}

const nowOf = (deps: McpDeps) => deps.now?.() ?? new Date();

/** The MCP endpoint, which is also the OAuth protected resource identifier. */
export function mcpResourceUrl(): string {
  return `${appBaseUrl()}/api/mcp`;
}

/* ---------- availability ---------- */

export type McpAvailability = "ok" | "plan" | "tenant_disabled" | "killed" | "platform_disabled" | "suspended";

export interface McpTenantInfo {
  id: string;
  slug: string;
  name: string;
  country: string;
  currency: string;
  timezone: string;
  orderNumberPrefix: string;
  planKey: string;
  status: string;
  settings: TenantSettings;
  mcpDisabledAt: Date | null;
}

/** Plan (`core.mcp` from Growth), super-admin kill switch, tenant switch, suspension, and the platform-wide `KEEL_MCP_DISABLED=1`. */
export function mcpAvailabilityFor(t: Pick<McpTenantInfo, "planKey" | "status" | "settings" | "mcpDisabledAt">, env: Record<string, string | undefined> = process.env): McpAvailability {
  if (env.KEEL_MCP_DISABLED === "1") return "platform_disabled";
  if (!isModuleInPlan("core.mcp", t.planKey)) return "plan";
  if (t.mcpDisabledAt) return "killed";
  if (t.status === "suspended" || t.status === "churned") return "suspended";
  if (!t.settings.mcpEnabled) return "tenant_disabled";
  return "ok";
}

export async function loadMcpTenant(admin: Database, tenantId: string): Promise<{ tenant: McpTenantInfo; activeAddons: string[] } | null> {
  const [t] = await admin.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!t) return null;
  const addons = await admin.select({ key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true)));
  return {
    tenant: { id: t.id, slug: t.slug, name: t.name, country: t.country, currency: t.currency, timezone: t.timezone, orderNumberPrefix: t.orderNumberPrefix, planKey: t.planKey, status: t.status, settings: parseTenantSettings(t.settings), mcpDisabledAt: t.mcpDisabledAt },
    activeAddons: addons.map((a) => a.key),
  };
}

export async function activeRole(admin: Database, tenantId: string, userId: string): Promise<TenantRole | null> {
  const [m] = await admin.select({ role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, tenantId), eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
  return m && isTenantRole(m.role) ? m.role : null;
}

/* ---------- bearer resolution ---------- */

export interface McpPrincipal {
  tokenId: string;
  kind: "oauth" | "pat";
  userId: string;
  role: TenantRole;
  scopes: McpScope[];
  clientName: string;
  tenant: McpTenantInfo;
  activeAddons: string[];
  pii: "full" | "masked";
  /** When the token was last used before this request (to throttle the "last used" write). */
  lastUsedAt: Date | null;
}

export type McpAuthFailure = { ok: false; status: 401; code: "missing_token" | "unknown_token" | "expired_token" | "revoked_token" | "no_membership"; tokenId?: string; tenantId?: string; userId?: string } | { ok: false; status: 403; code: Exclude<McpAvailability, "ok">; tokenId: string; tenantId: string; userId: string; clientName: string };

/** A bearer token → the person, tenant, role and scopes it acts for, with every gate checked. */
export async function resolveMcpBearer(deps: McpDeps, raw: string | null | undefined): Promise<{ ok: true; principal: McpPrincipal } | McpAuthFailure> {
  if (!raw) return { ok: false, status: 401, code: "missing_token" };
  if (!isWellFormedMcpSecret(raw, "pat") && !isWellFormedMcpSecret(raw, "access")) return { ok: false, status: 401, code: "unknown_token" };
  const [row] = await deps.admin.select({ token: schema.mcpTokens, clientName: schema.oauthClients.clientName }).from(schema.mcpTokens).leftJoin(schema.oauthClients, eq(schema.oauthClients.id, schema.mcpTokens.clientId)).where(eq(schema.mcpTokens.accessHash, hashMcpSecret(raw))).limit(1);
  if (!row) return { ok: false, status: 401, code: "unknown_token" };
  const t = row.token;
  const base = { tokenId: t.id, tenantId: t.tenantId, userId: t.userId };
  if (t.revokedAt) return { ok: false, status: 401, code: "revoked_token", ...base };
  if (t.expiresAt.getTime() <= nowOf(deps).getTime()) return { ok: false, status: 401, code: "expired_token", ...base };
  const role = await activeRole(deps.admin, t.tenantId, t.userId);
  if (!role) return { ok: false, status: 401, code: "no_membership", ...base };
  const loaded = await loadMcpTenant(deps.admin, t.tenantId);
  if (!loaded) return { ok: false, status: 401, code: "unknown_token" };
  const clientName = row.clientName ?? t.name;
  const availability = mcpAvailabilityFor(loaded.tenant);
  if (availability !== "ok") return { ok: false, status: 403, code: availability, ...base, clientName };
  return {
    ok: true,
    principal: { tokenId: t.id, kind: t.kind === "oauth" ? "oauth" : "pat", userId: t.userId, role, scopes: parseMcpScopes(t.scopes), clientName, tenant: loaded.tenant, activeAddons: loaded.activeAddons, pii: mcpPiiMode(role, loaded.tenant.settings.mcpFullPii), lastUsedAt: t.lastUsedAt },
  };
}

/* ---------- personal access tokens and connections (tenant context) ---------- */

export class McpTokenError extends Error {
  constructor(readonly code: "invalid_input" | "limit_reached" | "not_found" | "forbidden") {
    super(code);
    this.name = "McpTokenError";
  }
}

export interface IssuedPat {
  id: string;
  /** Shown once; only its HMAC is stored. */
  token: string;
  displayPrefix: string;
  expiresAt: Date;
}

export async function createPersonalAccessToken(ctx: ServiceContext, input: { userId: string; name: string; scopes: readonly string[]; days: number }): Promise<IssuedPat> {
  const name = sanitizeFreeText(input.name, 60).replace(/\n/g, " ");
  if (!name || !Number.isInteger(input.days) || input.days < 1 || input.days > MCP_LIMITS.patMaxDays) throw new McpTokenError("invalid_input");
  const now = ctx.now ?? new Date();
  const [active] = await ctx.tx.select({ n: count() }).from(schema.mcpTokens).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.userId, input.userId), eq(schema.mcpTokens.kind, "pat"), isNull(schema.mcpTokens.revokedAt), gt(schema.mcpTokens.expiresAt, now)));
  if ((active?.n ?? 0) >= MCP_LIMITS.patsPerUser) throw new McpTokenError("limit_reached");
  const scopes = parseMcpScopes(input.scopes);
  const secret = newMcpSecret("pat");
  const expiresAt = new Date(now.getTime() + input.days * 864e5);
  const [row] = await ctx.tx.insert(schema.mcpTokens).values({ tenantId: ctx.tenantId, userId: input.userId, kind: "pat", name, displayPrefix: secret.displayPrefix, accessHash: secret.hash, scopes, expiresAt, rotatedAt: now, createdAt: now, updatedAt: now }).returning({ id: schema.mcpTokens.id });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.userId, action: "mcp.token_created", entityType: "mcp_token", entityId: row!.id, diff: { scopes: { from: null, to: scopes } }, metadata: { kind: "pat", name, expiresAt: expiresAt.toISOString() } });
  return { id: row!.id, token: secret.raw, displayPrefix: secret.displayPrefix, expiresAt };
}

/** New secret for an existing personal access token (same name and scopes, new expiry); the old secret stops working at once. */
export async function rotatePersonalAccessToken(ctx: ServiceContext, input: { tokenId: string; userId: string; days?: number }): Promise<IssuedPat> {
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx.select().from(schema.mcpTokens).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.id, input.tokenId))).limit(1);
  if (!row || row.kind !== "pat" || row.revokedAt) throw new McpTokenError("not_found");
  if (row.userId !== input.userId) throw new McpTokenError("forbidden");
  const days = input.days ?? Math.max(1, Math.min(MCP_LIMITS.patMaxDays, Math.round((row.expiresAt.getTime() - row.rotatedAt.getTime()) / 864e5)));
  const secret = newMcpSecret("pat");
  const expiresAt = new Date(now.getTime() + days * 864e5);
  await ctx.tx.update(schema.mcpTokens).set({ accessHash: secret.hash, displayPrefix: secret.displayPrefix, expiresAt, rotatedAt: now, updatedAt: now }).where(eq(schema.mcpTokens.id, row.id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.userId, action: "mcp.token_rotated", entityType: "mcp_token", entityId: row.id, diff: { displayPrefix: { from: row.displayPrefix, to: secret.displayPrefix }, expiresAt: { from: row.expiresAt.toISOString(), to: expiresAt.toISOString() } } });
  return { id: row.id, token: secret.raw, displayPrefix: secret.displayPrefix, expiresAt };
}

/** Revokes a connection (PAT or OAuth grant). People revoke their own; owners and admins any connection of the tenant. */
export async function revokeMcpToken(ctx: ServiceContext, input: { tokenId: string; actorUserId: string; canRevokeOthers: boolean }): Promise<boolean> {
  const [row] = await ctx.tx.select().from(schema.mcpTokens).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.id, input.tokenId))).limit(1);
  if (!row) throw new McpTokenError("not_found");
  if (row.userId !== input.actorUserId && !input.canRevokeOthers) throw new McpTokenError("forbidden");
  if (row.revokedAt) return false;
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.mcpTokens).set({ revokedAt: now, revokedBy: input.actorUserId, updatedAt: now }).where(eq(schema.mcpTokens.id, row.id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: input.actorUserId, action: "mcp.token_revoked", entityType: "mcp_token", entityId: row.id, diff: { revokedAt: { from: null, to: now.toISOString() } }, metadata: { kind: row.kind, name: row.name, owner: row.userId } });
  return true;
}

export interface McpConnectionRow {
  id: string;
  kind: string;
  name: string;
  clientName: string | null;
  displayPrefix: string;
  scopes: string[];
  userId: string;
  userName: string | null;
  userEmail: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
  rotatedAt: Date;
  revokedAt: Date | null;
  /** active | expired | revoked (an OAuth grant stays active while its refresh token is valid). */
  state: "active" | "expired" | "revoked";
}

/** Connections of the tenant (or of one person), newest first, with their last use. */
export async function listMcpConnections(ctx: ServiceContext, opts: { userId?: string; includeInactive?: boolean; limit?: number } = {}): Promise<McpConnectionRow[]> {
  const now = ctx.now ?? new Date();
  const t = schema.mcpTokens;
  const conds = [eq(t.tenantId, ctx.tenantId)];
  if (opts.userId) conds.push(eq(t.userId, opts.userId));
  if (!opts.includeInactive) conds.push(isNull(t.revokedAt), or(gt(t.expiresAt, now), gt(t.refreshExpiresAt, now))!);
  const rows = await ctx.tx
    .select({ t, clientName: schema.oauthClients.clientName, userName: schema.users.name, userEmail: schema.users.email })
    .from(t)
    .innerJoin(schema.users, eq(schema.users.id, t.userId))
    .leftJoin(schema.oauthClients, eq(schema.oauthClients.id, t.clientId))
    .where(and(...conds))
    .orderBy(desc(t.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map((r) => {
    const live = r.t.expiresAt > now || (r.t.refreshExpiresAt !== null && r.t.refreshExpiresAt > now);
    return { id: r.t.id, kind: r.t.kind, name: r.t.name, clientName: r.clientName, displayPrefix: r.t.displayPrefix, scopes: r.t.scopes, userId: r.t.userId, userName: r.userName, userEmail: r.userEmail, createdAt: r.t.createdAt, lastUsedAt: r.t.lastUsedAt, expiresAt: r.t.expiresAt, refreshExpiresAt: r.t.refreshExpiresAt, rotatedAt: r.t.rotatedAt, revokedAt: r.t.revokedAt, state: r.t.revokedAt ? "revoked" : live ? "active" : "expired" };
  });
}

/** Stamps `last_used_at`, at most once a minute per token (inside the request's tenant transaction). */
export async function touchMcpToken(ctx: ServiceContext, principal: Pick<McpPrincipal, "tokenId" | "lastUsedAt">): Promise<void> {
  const now = ctx.now ?? new Date();
  if (principal.lastUsedAt && now.getTime() - principal.lastUsedAt.getTime() < 60_000) return;
  await ctx.tx.update(schema.mcpTokens).set({ lastUsedAt: now }).where(and(eq(schema.mcpTokens.tenantId, ctx.tenantId), eq(schema.mcpTokens.id, principal.tokenId)));
}

/* ---------- OAuth 2.1 ---------- */

export type OAuthErrorCode = "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "access_denied" | "invalid_redirect_uri" | "invalid_client_metadata" | "server_error" | "temporarily_unavailable" | "unsupported_response_type";

export class OAuthError extends Error {
  constructor(
    readonly error: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);
const isLoopback = (u: URL) => u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

/** https anywhere, http on loopback only, or a private-use scheme of a native app (`cursor://…`); no fragment. */
export function isAllowedRedirectUri(raw: string): boolean {
  if (raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || FORBIDDEN_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return isLoopback(u);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(r)) return false;
  return registered.some((x) => {
    try {
      const u = new URL(x);
      return isLoopback(u) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

/** The resource indicator a client sends must be this server (endpoint or origin). */
export function resourceMatches(resource: string | null | undefined): boolean {
  if (!resource) return true;
  const strip = (s: string) => s.replace(/\/+$/, "");
  return [mcpResourceUrl(), appBaseUrl()].map(strip).includes(strip(resource));
}

export interface ClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
}

/** Dynamic client registration (RFC 7591). Public clients only (PKCE, no secret), rate limited per IP. */
export async function registerOAuthClient(deps: McpDeps, body: unknown, ipHash: string | null): Promise<ClientRegistration> {
  if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "Expected a JSON object.");
  const b = body as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || uris.length !== (b.redirect_uris as unknown[]).length) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs.");
  const bad = uris.find((u) => !isAllowedRedirectUri(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `Redirect URI not allowed: https, loopback http or a private-use scheme only (${bad.slice(0, 80)}).`);
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  const now = nowOf(deps);
  if (ipHash) {
    const [n] = await deps.admin.select({ n: count() }).from(schema.oauthClients).where(and(eq(schema.oauthClients.registrationIpHash, ipHash), gte(schema.oauthClients.createdAt, new Date(now.getTime() - 3600_000))));
    if ((n?.n ?? 0) >= MCP_LIMITS.registrationsPerIpPerHour) throw new OAuthError("temporarily_unavailable", "Too many client registrations from this address; try again later.", 429);
  }
  const clientName = sanitizeFreeText(typeof b.client_name === "string" ? b.client_name : "", 100).replace(/\n/g, " ") || "MCP client";
  const text = (v: unknown, max: number) => (typeof v === "string" ? sanitizeFreeText(v, max) || null : null);
  const clientId = `kc_${randomBase62(24)}`;
  await deps.admin.insert(schema.oauthClients).values({ clientId, clientName, redirectUris: uris, tokenEndpointAuthMethod: "none", clientUri: text(b.client_uri, 300), softwareId: text(b.software_id, 100), softwareVersion: text(b.software_version, 50), registrationIpHash: ipHash, createdAt: now });
  return { client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: clientName, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read write:notes write:orders write:campaigns write:purchasing" };
}

export async function findOAuthClient(admin: Database, clientId: string | null | undefined): Promise<typeof schema.oauthClients.$inferSelect | null> {
  if (!clientId || clientId.length > 80) return null;
  const [c] = await admin.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId)).limit(1);
  return c ?? null;
}

export interface AuthorizeRequest {
  client: typeof schema.oauthClients.$inferSelect;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: McpScope[];
  resource: string | null;
}

/**
 * Validates `/oauth/authorize` parameters. Errors before the client and its redirect URI are known
 * are shown on the page (`redirect: false`); later ones go back to the client.
 */
export async function checkAuthorizeRequest(admin: Database, p: Record<string, string | undefined>): Promise<{ ok: true; request: AuthorizeRequest } | { ok: false; error: OAuthErrorCode; description: string; redirect: false } | { ok: false; error: OAuthErrorCode; description: string; redirect: true; redirectUri: string; state: string | null }> {
  const client = await findOAuthClient(admin, p.client_id);
  if (!client) return { ok: false, error: "invalid_client", description: "Unknown client_id.", redirect: false };
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) return { ok: false, error: "invalid_request", description: "redirect_uri does not match the registered ones.", redirect: false };
  const state = p.state ? p.state.slice(0, 500) : null;
  const back = (error: OAuthErrorCode, description: string) => ({ ok: false as const, error, description, redirect: true as const, redirectUri, state });
  if (p.response_type !== "code") return back("unsupported_response_type", "response_type must be code.");
  if (!p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return back("invalid_request", "code_challenge (S256) is required.");
  if ((p.code_challenge_method ?? "S256") !== "S256") return back("invalid_request", "code_challenge_method must be S256.");
  if (!resourceMatches(p.resource)) return back("invalid_request", "resource is not this server.");
  return { ok: true, request: { client, redirectUri, state, codeChallenge: p.code_challenge, scopes: parseMcpScopes(p.scope), resource: p.resource ?? null } };
}

/** After consent: a single-use code (5 minutes) bound to the user, the chosen tenant, the PKCE challenge and the redirect URI. */
export async function createAuthorizationCode(deps: McpDeps, input: { tenantId: string; userId: string; request: AuthorizeRequest; scopes: McpScope[] }): Promise<string> {
  const now = nowOf(deps);
  const role = await activeRole(deps.admin, input.tenantId, input.userId);
  const loaded = await loadMcpTenant(deps.admin, input.tenantId);
  if (!role || !loaded || mcpAvailabilityFor(loaded.tenant) !== "ok") throw new OAuthError("access_denied", "MCP is not available for this workspace.");
  const code = newMcpSecret("code");
  await withTenant(
    input.tenantId,
    async (tx) => {
      await tx.insert(schema.mcpAuthorizationCodes).values({ tenantId: input.tenantId, userId: input.userId, clientId: input.request.client.id, codeHash: code.hash, redirectUri: input.request.redirectUri, codeChallenge: input.request.codeChallenge, scopes: input.scopes, resource: input.request.resource, expiresAt: new Date(now.getTime() + MCP_LIMITS.authCodeTtlSeconds * 1000), createdAt: now });
      await recordAudit(tx, { tenantId: input.tenantId, actorUserId: input.userId, action: "mcp.client_authorized", entityType: "oauth_client", entityId: input.request.client.clientId, diff: { scopes: { from: null, to: input.scopes } }, metadata: { clientName: input.request.client.clientName } });
    },
    deps.app,
  );
  return code.raw;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function issueGrantSecrets(now: Date) {
  const access = newMcpSecret("access");
  const refresh = newMcpSecret("refresh");
  return { access, refresh, expiresAt: new Date(now.getTime() + MCP_LIMITS.accessTokenTtlSeconds * 1000), refreshExpiresAt: new Date(now.getTime() + MCP_LIMITS.refreshTokenTtlDays * 864e5) };
}

/** `authorization_code` grant: checks client, redirect URI, PKCE verifier, expiry and single use, then issues the grant. */
export async function exchangeAuthorizationCode(deps: McpDeps, p: { code?: string; codeVerifier?: string; clientId?: string; redirectUri?: string; resource?: string }): Promise<TokenResponse> {
  if (!p.code || !p.codeVerifier || !p.clientId) throw new OAuthError("invalid_request", "code, code_verifier and client_id are required.");
  const client = await findOAuthClient(deps.admin, p.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
  if (!isWellFormedMcpSecret(p.code, "code")) throw new OAuthError("invalid_grant", "Invalid authorization code.");
  const [code] = await deps.admin.select().from(schema.mcpAuthorizationCodes).where(eq(schema.mcpAuthorizationCodes.codeHash, hashMcpSecret(p.code))).limit(1);
  const now = nowOf(deps);
  if (!code || code.clientId !== client.id) throw new OAuthError("invalid_grant", "Invalid authorization code.");
  if (code.usedAt || code.expiresAt <= now) throw new OAuthError("invalid_grant", "The authorization code expired or was already used.");
  if (p.redirectUri && p.redirectUri !== code.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
  if (!verifyPkceS256(p.codeVerifier, code.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
  if (p.resource && !resourceMatches(p.resource)) throw new OAuthError("invalid_request", "resource is not this server.");
  const role = await activeRole(deps.admin, code.tenantId, code.userId);
  const loaded = await loadMcpTenant(deps.admin, code.tenantId);
  if (!role || !loaded || mcpAvailabilityFor(loaded.tenant) !== "ok") throw new OAuthError("access_denied", "MCP is not available for this workspace.");
  const s = issueGrantSecrets(now);
  const scopes = parseMcpScopes(code.scopes);
  await withTenant(
    code.tenantId,
    async (tx) => {
      // single use, even under concurrent requests
      const used = await tx.update(schema.mcpAuthorizationCodes).set({ usedAt: now }).where(and(eq(schema.mcpAuthorizationCodes.id, code.id), isNull(schema.mcpAuthorizationCodes.usedAt))).returning({ id: schema.mcpAuthorizationCodes.id });
      if (!used.length) throw new OAuthError("invalid_grant", "The authorization code was already used.");
      await tx.insert(schema.mcpTokens).values({ tenantId: code.tenantId, userId: code.userId, kind: "oauth", clientId: client.id, name: client.clientName, displayPrefix: s.access.displayPrefix, accessHash: s.access.hash, refreshHash: s.refresh.hash, scopes, resource: code.resource ?? p.resource ?? null, expiresAt: s.expiresAt, refreshExpiresAt: s.refreshExpiresAt, rotatedAt: now, createdAt: now, updatedAt: now });
    },
    deps.app,
  );
  await deps.admin.update(schema.oauthClients).set({ lastUsedAt: now }).where(eq(schema.oauthClients.id, client.id));
  return { access_token: s.access.raw, token_type: "Bearer", expires_in: MCP_LIMITS.accessTokenTtlSeconds, refresh_token: s.refresh.raw, scope: scopes.join(" ") };
}

/** `refresh_token` grant with rotation: the old refresh token stops working; presenting it again revokes the whole grant. */
export async function refreshOAuthToken(deps: McpDeps, p: { refreshToken?: string; clientId?: string; scope?: string }): Promise<TokenResponse> {
  if (!p.refreshToken || !p.clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
  const client = await findOAuthClient(deps.admin, p.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
  if (!isWellFormedMcpSecret(p.refreshToken, "refresh")) throw new OAuthError("invalid_grant", "Invalid refresh token.");
  const hash = hashMcpSecret(p.refreshToken);
  const now = nowOf(deps);
  const [row] = await deps.admin.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.refreshHash, hash)).limit(1);
  if (!row) {
    const [reused] = await deps.admin.select({ id: schema.mcpTokens.id, tenantId: schema.mcpTokens.tenantId, userId: schema.mcpTokens.userId }).from(schema.mcpTokens).where(eq(schema.mcpTokens.previousRefreshHash, hash)).limit(1);
    if (reused) {
      await withTenant(reused.tenantId, async (tx) => {
        await tx.update(schema.mcpTokens).set({ revokedAt: now, updatedAt: now }).where(and(eq(schema.mcpTokens.id, reused.id), isNull(schema.mcpTokens.revokedAt)));
        await recordAudit(tx, { tenantId: reused.tenantId, actorType: "system", action: "mcp.refresh_reuse_revoked", entityType: "mcp_token", entityId: reused.id, diff: { revokedAt: { from: null, to: now.toISOString() } } });
      }, deps.app);
    }
    throw new OAuthError("invalid_grant", "Invalid refresh token.");
  }
  if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "Invalid refresh token.");
  if (row.revokedAt || !row.refreshExpiresAt || row.refreshExpiresAt <= now) throw new OAuthError("invalid_grant", "The refresh token expired or was revoked.");
  const role = await activeRole(deps.admin, row.tenantId, row.userId);
  const loaded = await loadMcpTenant(deps.admin, row.tenantId);
  if (!role || !loaded || mcpAvailabilityFor(loaded.tenant) !== "ok") throw new OAuthError("invalid_grant", "MCP is not available for this workspace.");
  const current = parseMcpScopes(row.scopes);
  const scopes = p.scope ? parseMcpScopes(p.scope) : current;
  if (scopes.some((x) => !current.includes(x))) throw new OAuthError("invalid_scope", "A refresh cannot add scopes.");
  const s = issueGrantSecrets(now);
  await withTenant(
    row.tenantId,
    async (tx) => {
      const r = await tx.update(schema.mcpTokens).set({ accessHash: s.access.hash, refreshHash: s.refresh.hash, previousRefreshHash: hash, displayPrefix: s.access.displayPrefix, scopes, expiresAt: s.expiresAt, refreshExpiresAt: s.refreshExpiresAt, rotatedAt: now, updatedAt: now }).where(and(eq(schema.mcpTokens.id, row.id), eq(schema.mcpTokens.refreshHash, hash))).returning({ id: schema.mcpTokens.id });
      if (!r.length) throw new OAuthError("invalid_grant", "Invalid refresh token.");
    },
    deps.app,
  );
  return { access_token: s.access.raw, token_type: "Bearer", expires_in: MCP_LIMITS.accessTokenTtlSeconds, refresh_token: s.refresh.raw, scope: scopes.join(" ") };
}

/** RFC 7009: revokes the grant an access or refresh token belongs to. Unknown tokens are not an error. */
export async function revokeOAuthToken(deps: McpDeps, p: { token?: string; clientId?: string }): Promise<void> {
  if (!p.token || !isWellFormedMcpSecret(p.token)) return;
  const hash = hashMcpSecret(p.token);
  const [row] = await deps.admin.select({ id: schema.mcpTokens.id, tenantId: schema.mcpTokens.tenantId, userId: schema.mcpTokens.userId, clientId: schema.mcpTokens.clientId, revokedAt: schema.mcpTokens.revokedAt }).from(schema.mcpTokens).where(or(eq(schema.mcpTokens.accessHash, hash), eq(schema.mcpTokens.refreshHash, hash))).limit(1);
  if (!row || row.revokedAt) return;
  if (p.clientId) {
    const client = await findOAuthClient(deps.admin, p.clientId);
    if (!client || client.id !== row.clientId) return;
  }
  const now = nowOf(deps);
  await withTenant(row.tenantId, async (tx) => {
    await tx.update(schema.mcpTokens).set({ revokedAt: now, updatedAt: now }).where(eq(schema.mcpTokens.id, row.id));
    await recordAudit(tx, { tenantId: row.tenantId, actorUserId: row.userId, action: "mcp.token_revoked", entityType: "mcp_token", entityId: row.id, diff: { revokedAt: { from: null, to: now.toISOString() } }, metadata: { via: "oauth_revoke" } });
  }, deps.app);
}

/** Tenants a person can connect an AI client to, for the consent screen, with the reason when they cannot. */
export async function mcpTenantChoices(admin: Database, userId: string): Promise<{ tenantId: string; slug: string; name: string; role: TenantRole; availability: McpAvailability }[]> {
  const rows = await admin.select({ tenant: schema.tenants, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId)).where(and(eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).orderBy(schema.tenants.name);
  return rows.filter((r) => isTenantRole(r.role)).map((r) => ({ tenantId: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name, role: r.role as TenantRole, availability: mcpAvailabilityFor({ planKey: r.tenant.planKey, status: r.tenant.status, settings: parseTenantSettings(r.tenant.settings), mcpDisabledAt: r.tenant.mcpDisabledAt }) }));
}


import { createHash, randomUUID } from "node:crypto";
import { and, eq, schema, sql, withTenant, type Transaction } from "@hullwise/db";
import { API_LIMITS, canDo, canViewPage, canWritePage, isPageEnabled } from "@hullwise/config";
import { API_ERRORS, maskPii, parseApiLimit, type ApiErrorCode, type WebhookUrlPolicy } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { InventoryControlError } from "../inventory/control";
import { checkMcpRateLimit, type RateLimits } from "../mcp/limits";
import type { McpDeps, McpTenantInfo } from "../mcp/auth";
import type { PlatformWriteRow } from "../writes";
import { WebhookError } from "../webhooks/endpoints";
import { webhookUrlPolicy } from "../webhooks/transport";
import { resolveApiBearer, touchApiToken, type ApiPrincipal } from "./auth";
import { API_ROUTES, ApiError, matchApiPath, type ApiRoute, type ApiRuntime } from "./routes";

/**
 * The HTTP layer of the public REST API (#81), framework-free (a `Request` in, a `Response` out) so
 * the Next.js route and the tests share it. Order: route → bearer token and gates → rate limits
 * (fail closed) → scope → role → input → (writes) idempotency → the route inside `withTenant` as
 * actor `api` → PII masking → request log. Errors are always `{ error: { code, message } }`.
 */

export interface ApiHttpDeps extends McpDeps {
  policy?: WebhookUrlPolicy;
  resolveHost?: (host: string) => Promise<string[] | null>;
  limits?: RateLimits;
  /** Platform writes of a committed request (the web dispatches them like the UI does). */
  onPlatformWrites?: (tenant: McpTenantInfo, writes: PlatformWriteRow[]) => Promise<void>;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Expose-Headers": "Retry-After, Idempotency-Replayed, X-Request-Id",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...headers } });
}

function errorBody(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

const UNAVAILABLE: Record<string, string> = {
  plan: "The API is not included in this store's plan (Growth and above).",
  killed: "Token access to this store was suspended by the platform. Contact support.",
  suspended: "This store is suspended.",
  platform_disabled: "The API is temporarily unavailable.",
};

/** Known service errors → API errors the caller can act on. */
function mapError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof WebhookError) {
    if (err.code === "not_found") return new ApiError("not_found", "No webhook endpoint with this id in this store.");
    if (err.code === "limit_reached") return new ApiError("conflict", "This store already has the maximum number of webhook endpoints.");
    const message: Record<string, string> = { invalid_url: "The URL must be https, without credentials or fragment, on a public host name.", private_address: "The URL points to a private, loopback, link-local or metadata address.", unresolvable: "The host name does not resolve.", invalid_events: "Unknown or duplicate event types." };
    return new ApiError("unprocessable", message[err.code] ?? "Invalid webhook endpoint.", { reason: err.code, ...(err.detail ? { detail: err.detail } : {}) });
  }
  if (err instanceof InventoryControlError) return err.code === "not_found" ? new ApiError("not_found", "No variant or location with this id in this store.") : new ApiError("unprocessable", `The adjustment was refused: ${err.code}.`, { reason: err.code });
  return null;
}

function findRoute(method: string, path: string): { route: ApiRoute; params: Record<string, string> } | { allow: string[] } | null {
  const allow: string[] = [];
  for (const r of API_ROUTES) {
    const params = matchApiPath(r.path, path);
    if (!params) continue;
    if (r.method === method) return { route: r, params };
    allow.push(r.method);
  }
  return allow.length ? { allow } : null;
}

function allowed(route: ApiRoute, p: ApiPrincipal): "scope" | "role" | "module" | null {
  if (route.scope && !p.scopes.includes(route.scope)) return "scope";
  if (route.page && !isPageEnabled(route.page, p.activeAddons)) return "module";
  if (route.method === "GET") {
    if (route.page && !canViewPage(p.role, route.page)) return "role";
  } else if (route.action ? !canDo(p.role, route.action) : route.page ? !canWritePage(p.role, route.page) : false) return "role";
  return null;
}

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: ApiError }> {
  const type = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  if (Buffer.byteLength(raw) > API_LIMITS.maxBodyBytes) return { ok: false, error: new ApiError("payload_too_large", `The body is larger than ${API_LIMITS.maxBodyBytes / 1024} KB.`) };
  if (!raw.trim()) return { ok: true, value: {} };
  if (!type.includes("application/json")) return { ok: false, error: new ApiError("invalid_request", "Send the body as application/json.") };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: new ApiError("invalid_request", "The body is not valid JSON.") };
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Same key + same request within 24 hours → the stored answer, without running the write again; same
 * key + another request → 422. Requests with one key are serialised by an advisory lock, so a retry
 * racing the original waits for it and replays it. Only successful answers are stored: a failed
 * request can be retried with the same key.
 */
async function withIdempotency(tx: Transaction, input: { tenantId: string; tokenId: string; key: string; method: string; path: string; requestHash: string; now: Date }, run: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const k = schema.apiIdempotencyKeys;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}:${input.tokenId}:${input.key}`}, 0))`);
  const [row] = await tx.select().from(k).where(and(eq(k.tenantId, input.tenantId), eq(k.tokenId, input.tokenId), eq(k.key, input.key))).limit(1);
  if (row && row.expiresAt > input.now) {
    if (row.requestHash !== input.requestHash) throw new ApiError("idempotency_key_reused", "This Idempotency-Key was used with a different request.");
    return { status: row.responseStatus, body: row.responseBody, replayed: true };
  }
  if (row) await tx.delete(k).where(eq(k.id, row.id));
  const out = await run();
  await tx.insert(k).values({ tenantId: input.tenantId, tokenId: input.tokenId, key: input.key, method: input.method, path: input.path.slice(0, 300), requestHash: input.requestHash, responseStatus: out.status, responseBody: out.body as Record<string, unknown>, createdAt: input.now, expiresAt: new Date(input.now.getTime() + API_LIMITS.idempotencyTtlHours * 3600e3) });
  return { ...out, replayed: false };
}

async function logRequest(deps: McpDeps, p: ApiPrincipal, e: { method: string; route: string; status: number; errorCode: string | null; durationMs: number }) {
  try {
    await withTenant(p.tenant.id, (tx) => tx.insert(schema.apiRequestLog).values({ tenantId: p.tenant.id, tokenId: p.tokenId, userId: p.userId, method: e.method, route: e.route.slice(0, 120), status: e.status, errorCode: e.errorCode, durationMs: Math.max(0, Math.round(e.durationMs)), createdAt: deps.now?.() ?? new Date() }), deps.app);
  } catch (err) {
    console.error("[api] request log write failed", err);
  }
}

/**
 * Handles one API request. `path` is the API path without the `/api` prefix (`/v1/orders`), as
 * served at `apiEndpoint(path)`.
 */
export async function handleApiRequest(deps: ApiHttpDeps, req: Request, path: string): Promise<Response> {
  const started = Date.now();
  const requestId = randomUUID();
  const base = { "X-Request-Id": requestId };
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const fail = (code: ApiErrorCode, message: string, extra: Record<string, string> = {}, details?: Record<string, unknown>) => json(API_ERRORS[code], errorBody(code, message, details), { ...base, ...extra });

  const found = findRoute(method, path);
  if (!found) return fail("not_found", `No API route ${method} ${path.slice(0, 120)}. See the API documentation for the routes.`);
  if ("allow" in found) return fail("method_not_allowed", `${method} is not allowed here.`, { Allow: [...found.allow, "OPTIONS"].join(", ") });
  const { route, params } = found;

  const header = req.headers.get("authorization");
  const raw = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  const auth = await resolveApiBearer(deps, raw);
  if (!auth.ok) {
    if (auth.status === 401) return fail(auth.code === "missing_token" ? "unauthorized" : "invalid_token", auth.code === "missing_token" ? "Send a token: Authorization: Bearer <token>." : "The token is unknown, expired or revoked.", { "WWW-Authenticate": `Bearer realm="api"${auth.code === "invalid_token" ? ', error="invalid_token"' : ""}` });
    return fail("not_available", UNAVAILABLE[auth.code] ?? "The API is not available for this store.", {}, { reason: auth.code });
  }
  const p = auth.principal;
  const done = async (res: Response, errorCode: string | null) => {
    await logRequest(deps, p, { method, route: route.path, status: res.status, errorCode, durationMs: Date.now() - started });
    return res;
  };
  const failLogged = (code: ApiErrorCode, message: string, extra: Record<string, string> = {}, details?: Record<string, unknown>) => done(fail(code, message, extra, details), code);

  const rate = await checkMcpRateLimit(deps, { tenantId: p.tenant.id, tokenId: p.tokenId, bucketPrefix: "api:" }, deps.limits ?? { perToken: API_LIMITS.perTokenPerMinute, perTenant: API_LIMITS.perTenantPerMinute });
  if (!rate.ok) return failLogged("rate_limited", rate.reason === "limiter_unavailable" ? "Rate limiter unavailable; retry shortly." : `Rate limit reached (${rate.reason === "token" ? "this token" : "this store"}); retry in ${rate.retryAfter}s.`, { "Retry-After": String(rate.retryAfter) });

  const denial = allowed(route, p);
  if (denial === "scope") return failLogged("insufficient_scope", `This token was not granted the "${route.scope}" scope.`, {}, { requiredScope: route.scope });
  if (denial === "role") return failLogged("forbidden", `The token's user (role ${p.role}) may not ${method === "GET" ? "read" : "change"} this in the app.`);
  if (denial === "module") return failLogged("forbidden", "This feature is not active for this store.");

  // query: only the declared parameters (a typo is an error, not a silently ignored filter)
  const url = new URL(req.url);
  const known = new Set([...Object.keys(route.query ?? {}), ...(route.paginated ? ["limit", "cursor"] : [])]);
  const unknown = [...url.searchParams.keys()].filter((k) => !known.has(k));
  if (unknown.length) return failLogged("invalid_request", `Unknown query parameter: ${unknown.slice(0, 5).join(", ")}.`, {}, { allowed: [...known] });
  const limit = route.paginated ? parseApiLimit(url.searchParams.get("limit")) : API_LIMITS.defaultPageSize;
  if (limit === null) return failLogged("invalid_request", `limit must be an integer from 1 to ${API_LIMITS.maxPageSize}.`);
  const queryInput = Object.fromEntries([...Object.keys(route.query ?? {})].map((k) => [k, url.searchParams.get(k) ?? undefined]));
  const query: Record<string, unknown> = {};
  for (const [k, schemaOf] of Object.entries(route.query ?? {})) {
    const r = schemaOf.safeParse(queryInput[k]);
    if (!r.success) return failLogged("invalid_request", `Invalid query parameter ${k}: ${r.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
    query[k] = r.data;
  }

  let body: unknown = undefined;
  let bodyRaw: unknown = undefined;
  if (route.body) {
    const b = await readBody(req);
    if (!b.ok) return failLogged(b.error.code, b.error.message);
    bodyRaw = b.value;
    const parsed = route.body.safeParse(b.value);
    if (!parsed.success) return failLogged("unprocessable", `Invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 500)}`, {}, { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
    body = parsed.data;
  }

  const key = route.write ? req.headers.get("idempotency-key")?.trim() || null : null;
  if (key !== null && !/^[\x21-\x7e]{1,200}$/.test(key)) return failLogged("invalid_request", "Idempotency-Key must be 1 to 200 visible ASCII characters.");

  const platformWrites: PlatformWriteRow[] = [];
  try {
    const out = await withTenant(
      p.tenant.id,
      async (tx) => {
        const now = deps.now?.() ?? new Date();
        const ctx: ServiceContext = { tenantId: p.tenant.id, tx, actor: { type: "api", userId: p.userId }, now: deps.now?.() };
        await touchApiToken(ctx, p);
        const rt: ApiRuntime = { ctx, principal: p, platformWrites, webhookPolicy: deps.policy ?? webhookUrlPolicy(), resolveHost: deps.resolveHost };
        const run = async () => {
          const result = await route.run(rt, { params, query: query as never, body: body as never, limit, cursor: url.searchParams.get("cursor") });
          const safe = p.pii === "masked" ? maskPii(result) : result;
          return { status: route.status ?? 200, body: safe };
        };
        if (!key) return { ...(await run()), replayed: false };
        const requestHash = createHash("sha256").update(`${method} ${path}\n${stableJson(bodyRaw ?? null)}`).digest("hex");
        return withIdempotency(tx, { tenantId: p.tenant.id, tokenId: p.tokenId, key, method, path, requestHash, now }, run);
      },
      deps.app,
    );
    if (platformWrites.length && !out.replayed && deps.onPlatformWrites) await deps.onPlatformWrites(p.tenant, platformWrites).catch((e: unknown) => console.error("[api] platform write dispatch failed", e));
    return done(json(out.status, out.body, { ...base, ...(out.replayed ? { "Idempotency-Replayed": "true" } : {}) }), null);
  } catch (err) {
    const mapped = mapError(err);
    if (mapped) return failLogged(mapped.code, mapped.message, {}, mapped.details);
    console.error(`[api] ${method} ${route.path} failed`, err);
    return failLogged("internal_error", `Something went wrong on our side (request ${requestId}).`);
  }
}

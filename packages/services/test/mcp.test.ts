import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, desc, eq, inArray, isNull, schema, sql, withTenant, type Database } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import * as dbSchema from "@hullwise/db/schema";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import type { McpScope, TenantRole } from "@hullwise/config";
import {
  MCP_CORE_TOOLS,
  ProposalError,
  askAssistant,
  checkAuthorizeRequest,
  checkMcpRateLimit,
  createAuthorizationCode,
  createMcpServer,
  createPersonalAccessToken,
  decideProposal,
  exchangeAuthorizationCode,
  hashMcpSecret,
  listProposals,
  mcpUsageByTenant,
  pkceChallengeS256,
  refreshOAuthToken,
  registerOAuthClient,
  resolveMcpBearer,
  revokeMcpToken,
  revokeOAuthToken,
  rotatePersonalAccessToken,
  setMcpKillSwitch,
  type McpDeps,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let A = "";
let B = "";
const deps: McpDeps = { admin: pools.admin as unknown as Database, app: pools.app as unknown as Database };
const uid = (email: string) => ctx.userIds[email]!;

/** Turns MCP on for both demo tenants of the test database (Harbor Home moves to Growth here only). */
async function setTenant(tenantId: string, patch: { planKey?: string; settings?: Record<string, unknown>; mcpDisabledAt?: Date | null }) {
  const [t] = await pools.admin.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await pools.admin.update(schema.tenants).set({ ...(patch.planKey ? { planKey: patch.planKey } : {}), ...(patch.settings ? { settings: { ...(t!.settings as object), ...patch.settings } } : {}), ...("mcpDisabledAt" in patch ? { mcpDisabledAt: patch.mcpDisabledAt } : {}) }).where(eq(schema.tenants.id, tenantId));
}

async function pat(tenantId: string, email: string, scopes: McpScope[] = ["read"], days = 30): Promise<string> {
  const r = await withTenant(tenantId, (tx) => createPersonalAccessToken({ tenantId, tx, actor: { type: "user", userId: uid(email) } }, { userId: uid(email), name: `test ${email}`, scopes, days }), pools.app);
  return r.token;
}

async function connect(token: string, tools = MCP_CORE_TOOLS): Promise<Client> {
  const auth = await resolveMcpBearer(deps, token);
  if (!auth.ok) throw new Error(`auth failed: ${auth.code}`);
  const server = createMcpServer({ deps, principal: auth.principal, tools, linkBase: "https://hullwise.test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(ct);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> | null }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content.map((c) => c.text).join("");
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { isError: Boolean(r.isError), text, json };
}

const listNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  A = ctx.tenantIds.northwind;
  B = ctx.tenantIds.harbor;
  await setTenant(A, { settings: { mcpEnabled: true } });
  await setTenant(B, { planKey: "growth", settings: { mcpEnabled: true } });
});
afterAll(async () => {
  await setTenant(B, { planKey: "starter", settings: { mcpEnabled: false } });
  await pools.close();
});

async function idsOf(tenantId: string): Promise<string[]> {
  const out: string[] = [];
  for (const table of [schema.orders, schema.customers, schema.products, schema.campaigns, schema.purchaseOrders, schema.returnRequests, schema.segments, schema.suppliers]) {
    const rows = await pools.admin.select({ id: table.id }).from(table).where(eq(table.tenantId, tenantId));
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

describe("MCP tools: tenant isolation", () => {
  it("every read tool of tenant A returns only A's records, and B's token only B's", async () => {
    const [aIds, bIds] = [new Set(await idsOf(A)), new Set(await idsOf(B))];
    const ca = await connect(await pat(A, "owner@northwind.demo"));
    const cb = await connect(await pat(B, "owner@harborhome.demo"));
    const [aOrder] = await pools.admin.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, A)).orderBy(desc(schema.orders.placedAt)).limit(1);
    const [bOrder] = await pools.admin.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, B)).orderBy(desc(schema.orders.placedAt)).limit(1);
    const [aCustomer] = await pools.admin.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.tenantId, A)).limit(1);
    const [bCustomer] = await pools.admin.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.tenantId, B)).limit(1);
    const readTools = (await ca.listTools()).tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readTools.length).toBeGreaterThanOrEqual(17);
    const argsFor = (name: string, mine: { order: string; customer: string }) => (name === "get_order" ? { order: mine.order } : name === "get_customer" ? { customerId: mine.customer } : {});
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    for (const name of readTools) {
      const ra = await call(ca, name, argsFor(name, { order: aOrder!.name, customer: aCustomer!.id }));
      expect(ra.isError, `${name} (A): ${ra.text.slice(0, 200)}`).toBe(false);
      expect((ra.text.match(uuidRe) ?? []).filter((id) => bIds.has(id)), name).toEqual([]);
      expect(ra.text, name).not.toContain('"HH-');
      if (name === "get_cod_queue" || name === "list_customer_campaigns") continue;
      const rb = await call(cb, name, argsFor(name, { order: bOrder!.name, customer: bCustomer!.id }));
      expect(rb.isError, `${name} (B): ${rb.text.slice(0, 200)}`).toBe(false);
      expect((rb.text.match(uuidRe) ?? []).filter((id) => aIds.has(id)), name).toEqual([]);
      expect(rb.text, name).not.toContain('"NW-');
    }
    // references to the other tenant's records are not found
    const [bOrderRow] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, B)).limit(1);
    expect((await call(ca, "get_order", { order: bOrderRow!.id })).text).toContain("No order");
    expect((await call(ca, "get_order", { order: bOrder!.name })).isError).toBe(true);
    expect((await call(ca, "get_customer", { customerId: bCustomer!.id })).isError).toBe(true);
  });

  it("write tools and proposals of tenant A cannot touch tenant B", async () => {
    const ca = await connect(await pat(A, "owner@northwind.demo", ["read", "write:notes", "write:orders", "write:campaigns", "write:purchasing"]));
    const [bOrder] = await pools.admin.select({ id: schema.orders.id, assignedTo: schema.orders.assignedTo, status: schema.orders.status }).from(schema.orders).where(and(eq(schema.orders.tenantId, B), inArray(schema.orders.status, ["new", "pending_review", "confirmed"]))).limit(1);
    const [bCampaign] = await pools.admin.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, B), eq(schema.campaigns.platform, "meta"))).limit(1);
    const [bSupplier] = await pools.admin.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, B)).limit(1);
    const before = await pools.admin.select({ n: sql<number>`count(*)::int` }).from(schema.orderEvents).where(eq(schema.orderEvents.orderId, bOrder!.id));
    for (const [name, args] of [
      ["add_order_note", { order: bOrder!.id, body: "cross-tenant" }],
      ["assign_order", { order: bOrder!.id, assignee: "me" }],
      ["set_order_status", { order: bOrder!.id, status: "on_hold" }],
      ["propose_order_cancellation", { order: bOrder!.id, reason: "cross-tenant test" }],
      ["propose_refund", { order: bOrder!.id, amount: 1, reason: "cross-tenant test" }],
      ["propose_campaign_pause", { campaign: bCampaign!.id, reason: "cross-tenant test" }],
      ["propose_purchase_order", { supplier: bSupplier!.id, lines: [{ sku: "X", quantity: 1 }], reason: "cross-tenant test" }],
    ] as const) {
      const r = await call(ca, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/No |not found/i);
    }
    const after = await pools.admin.select({ n: sql<number>`count(*)::int` }).from(schema.orderEvents).where(eq(schema.orderEvents.orderId, bOrder!.id));
    expect(after[0]!.n).toBe(before[0]!.n);
    const [still] = await pools.admin.select({ assignedTo: schema.orders.assignedTo, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, bOrder!.id));
    expect(still).toEqual({ assignedTo: bOrder!.assignedTo, status: bOrder!.status });
    expect(await pools.admin.select().from(schema.mcpPendingActions).where(eq(schema.mcpPendingActions.tenantId, B))).toEqual([]);
  });
});

describe("MCP authorization", () => {
  it("a viewer token never gets write tools, whatever scopes it holds", async () => {
    const c = await connect(await pat(A, "viewer@northwind.demo", ["read", "write:notes", "write:orders", "write:campaigns", "write:purchasing"]));
    const names = await listNames(c);
    expect(names).toContain("search_orders");
    expect(names.filter((n) => /^(add_|assign_|set_|propose_)/.test(n))).toEqual([]);
    const [order] = await pools.admin.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, A)).limit(1);
    const r = await call(c, "add_order_note", { order: order!.name, body: "hello" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("role (viewer)");
    const [log] = await pools.admin.select().from(schema.mcpRequestLog).where(and(eq(schema.mcpRequestLog.tenantId, A), eq(schema.mcpRequestLog.tool, "add_order_note"))).orderBy(desc(schema.mcpRequestLog.createdAt)).limit(1);
    expect(log).toMatchObject({ outcome: "denied", errorCode: "role", method: "tools/call" });
  });

  it("a read-only token cannot write even when the role could", async () => {
    const c = await connect(await pat(A, "owner@northwind.demo", ["read"]));
    expect(await listNames(c)).not.toContain("add_order_note");
    const r = await call(c, "add_order_note", { order: "1", body: "x" });
    expect(r.text).toContain('"write:notes" scope');
  });

  it("masks PII by default; full PII only when the tenant enables it, and never for marketing", async () => {
    const owner = await connect(await pat(A, "owner@northwind.demo"));
    const masked = await call(owner, "search_orders", { pageSize: 10 });
    const orders = (masked.json!.orders as { email: string | null; customerName: string | null }[]).filter((o) => o.email);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expect(o.email).toMatch(/^.\*\*\*@/);
    expect(masked.text).not.toMatch(/"email":"[^"*]+@/);
    await setTenant(A, { settings: { mcpFullPii: true } });
    try {
      const care = await call(await connect(await pat(A, "care@northwind.demo")), "search_orders", { pageSize: 10 });
      expect(care.text).toMatch(/"email":"[^"*]+@[^"]+"/);
      const marketing = await call(await connect(await pat(A, "marketing@northwind.demo")), "search_orders", { pageSize: 10 });
      expect(marketing.isError).toBe(false);
      expect(marketing.text).not.toMatch(/"email":"[^"*]+@/);
      expect(marketing.text).toMatch(/"email":".\*\*\*@/);
    } finally {
      await setTenant(A, { settings: { mcpFullPii: false } });
    }
  });

  it("add-on tools exist only with the add-on: customer campaigns listed for A, refused for B", async () => {
    const ca = await connect(await pat(A, "owner@northwind.demo"));
    const cb = await connect(await pat(B, "owner@harborhome.demo"));
    expect(await listNames(ca)).toContain("list_customer_campaigns");
    expect(await listNames(cb)).not.toContain("list_customer_campaigns");
    const r = await call(cb, "list_customer_campaigns");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not active");
    // segments are core: listed for both, control groups only with the add-on
    expect((await call(ca, "list_segments")).text).toContain("controlGroupPercent");
    expect((await call(cb, "list_segments")).text).not.toContain("controlGroupPercent");
  });

  it("rejects unknown, revoked and expired tokens, and the gates (plan, tenant switch, kill switch)", async () => {
    expect(await resolveMcpBearer(deps, "kpat_" + "x".repeat(32))).toMatchObject({ ok: false, code: "unknown_token" });
    expect(await resolveMcpBearer(deps, "garbage")).toMatchObject({ ok: false, code: "unknown_token" });
    expect(await resolveMcpBearer(deps, null)).toMatchObject({ ok: false, code: "missing_token" });
    const raw = await pat(A, "ops@northwind.demo");
    const [row] = await pools.admin.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.accessHash, hashMcpSecret(raw)));
    expect(row!.accessHash).not.toBe(raw);
    expect(row!.displayPrefix).toBe(raw.slice(0, 9));
    expect((await resolveMcpBearer(deps, raw)).ok).toBe(true);
    await pools.admin.update(schema.mcpTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.mcpTokens.id, row!.id));
    expect(await resolveMcpBearer(deps, raw)).toMatchObject({ ok: false, status: 401, code: "expired_token" });
    const raw2 = await pat(A, "ops@northwind.demo");
    const [row2] = await pools.admin.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.accessHash, hashMcpSecret(raw2)));
    const s = (userId: string): ServiceContext => ({ tenantId: A, tx: undefined as never, actor: { type: "user", userId } });
    await expect(withTenant(A, (tx) => revokeMcpToken({ ...s(uid("care@northwind.demo")), tx }, { tokenId: row2!.id, actorUserId: uid("care@northwind.demo"), canRevokeOthers: false }), pools.app)).rejects.toThrow("forbidden");
    expect(await withTenant(A, (tx) => revokeMcpToken({ ...s(uid("ops@northwind.demo")), tx }, { tokenId: row2!.id, actorUserId: uid("ops@northwind.demo"), canRevokeOthers: false }), pools.app)).toBe(true);
    expect(await resolveMcpBearer(deps, raw2)).toMatchObject({ ok: false, code: "revoked_token" });
    // rotation: the old secret stops working at once
    const raw3 = await pat(A, "ops@northwind.demo");
    const [row3] = await pools.admin.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.accessHash, hashMcpSecret(raw3)));
    const rotated = await withTenant(A, (tx) => rotatePersonalAccessToken({ ...s(uid("ops@northwind.demo")), tx }, { tokenId: row3!.id, userId: uid("ops@northwind.demo") }), pools.app);
    expect(await resolveMcpBearer(deps, raw3)).toMatchObject({ ok: false, code: "unknown_token" });
    expect((await resolveMcpBearer(deps, rotated.token)).ok).toBe(true);
    // gates
    await setTenant(A, { settings: { mcpEnabled: false } });
    expect(await resolveMcpBearer(deps, rotated.token)).toMatchObject({ ok: false, status: 403, code: "tenant_disabled" });
    await setTenant(A, { settings: { mcpEnabled: true } });
    await setMcpKillSwitch(deps.admin, { tenantId: A, disabled: true, note: "abuse", actorUserId: uid("superadmin@hullwise.demo") });
    expect(await resolveMcpBearer(deps, rotated.token)).toMatchObject({ ok: false, status: 403, code: "killed" });
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, "mcp.kill_switch_on"))).limit(1);
    expect(audit).toMatchObject({ actorType: "super_admin" });
    await setMcpKillSwitch(deps.admin, { tenantId: A, disabled: false, actorUserId: uid("superadmin@hullwise.demo") });
    await setTenant(B, { planKey: "starter" });
    expect(await resolveMcpBearer(deps, await pat(B, "owner@harborhome.demo"))).toMatchObject({ ok: false, status: 403, code: "plan" });
    await setTenant(B, { planKey: "growth" });
    expect((await resolveMcpBearer(deps, rotated.token)).ok).toBe(true);
  });
});

describe("MCP rate limits", () => {
  it("counts per token and per tenant, and fails closed when the counter is unavailable", async () => {
    const raw = await pat(A, "ops@northwind.demo");
    const auth = await resolveMcpBearer(deps, raw);
    if (!auth.ok) throw new Error("auth");
    const id = { tenantId: A, tokenId: auth.principal.tokenId };
    const limits = { perToken: 2, perTenant: 1000 };
    expect((await checkMcpRateLimit(deps, id, limits)).ok).toBe(true);
    expect((await checkMcpRateLimit(deps, id, limits)).ok).toBe(true);
    const third = await checkMcpRateLimit(deps, id, limits);
    expect(third).toMatchObject({ ok: false, reason: "token" });
    expect(third.retryAfter).toBeGreaterThan(0);
    expect((await checkMcpRateLimit(deps, { tenantId: A, tokenId: "00000000-0000-0000-0000-000000000001" }, { perToken: 100, perTenant: 1 })).reason).toBe("tenant");
    // a database that refuses every query: the call is refused, never let through
    const broken = new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    const brokenDeps: McpDeps = { admin: deps.admin, app: drizzle(broken, { schema: dbSchema }) as unknown as Database };
    expect(await checkMcpRateLimit(brokenDeps, id, limits)).toMatchObject({ ok: false, reason: "limiter_unavailable" });
    await broken.end();
  });
});

describe("MCP OAuth 2.1", () => {
  it("registers a client, issues a code bound to PKCE, exchanges it once, rotates refresh tokens and revokes", async () => {
    const client = await registerOAuthClient(deps, { client_name: "Test client", redirect_uris: ["http://127.0.0.1:33418/callback"] }, "iphash-test");
    expect(client.token_endpoint_auth_method).toBe("none");
    await expect(registerOAuthClient(deps, { redirect_uris: ["javascript:alert(1)"] }, null)).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(registerOAuthClient(deps, { redirect_uris: ["http://evil.example/cb"] }, null)).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    const verifier = "v".repeat(20) + "-verifier-" + "x".repeat(30);
    const params = { client_id: client.client_id, redirect_uri: "http://127.0.0.1:50999/callback", response_type: "code", code_challenge: pkceChallengeS256(verifier), code_challenge_method: "S256", scope: "read write:notes admin", state: "abc" };
    const checked = await checkAuthorizeRequest(deps.admin, params);
    if (!checked.ok) throw new Error(checked.description);
    expect(checked.request.scopes).toEqual(["read", "write:notes"]);
    expect(await checkAuthorizeRequest(deps.admin, { ...params, redirect_uri: "https://evil.example/cb" })).toMatchObject({ ok: false, redirect: false });
    expect(await checkAuthorizeRequest(deps.admin, { ...params, code_challenge: undefined })).toMatchObject({ ok: false, redirect: true, error: "invalid_request" });
    const code = await createAuthorizationCode(deps, { tenantId: A, userId: uid("care@northwind.demo"), request: checked.request, scopes: ["read", "write:notes"] });
    await expect(exchangeAuthorizationCode(deps, { code, codeVerifier: "w".repeat(43), clientId: client.client_id })).rejects.toMatchObject({ error: "invalid_grant" });
    const tokens = await exchangeAuthorizationCode(deps, { code, codeVerifier: verifier, clientId: client.client_id, redirectUri: params.redirect_uri });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write:notes" });
    await expect(exchangeAuthorizationCode(deps, { code, codeVerifier: verifier, clientId: client.client_id })).rejects.toMatchObject({ error: "invalid_grant" });
    const auth = await resolveMcpBearer(deps, tokens.access_token);
    expect(auth).toMatchObject({ ok: true, principal: { role: "customer_care", clientName: "Test client", kind: "oauth" } });
    const refreshed = await refreshOAuthToken(deps, { refreshToken: tokens.refresh_token, clientId: client.client_id });
    expect(await resolveMcpBearer(deps, tokens.access_token)).toMatchObject({ ok: false, code: "unknown_token" });
    expect((await resolveMcpBearer(deps, refreshed.access_token)).ok).toBe(true);
    await expect(refreshOAuthToken(deps, { refreshToken: refreshed.refresh_token, clientId: client.client_id, scope: "read write:orders" })).rejects.toMatchObject({ error: "invalid_scope" });
    // presenting the replaced refresh token again revokes the whole grant
    await expect(refreshOAuthToken(deps, { refreshToken: tokens.refresh_token, clientId: client.client_id })).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await resolveMcpBearer(deps, refreshed.access_token)).toMatchObject({ ok: false, code: "revoked_token" });
    // revocation endpoint
    const code2 = await createAuthorizationCode(deps, { tenantId: A, userId: uid("care@northwind.demo"), request: checked.request, scopes: ["read"] });
    const t2 = await exchangeAuthorizationCode(deps, { code: code2, codeVerifier: verifier, clientId: client.client_id });
    await revokeOAuthToken(deps, { token: t2.refresh_token, clientId: client.client_id });
    expect(await resolveMcpBearer(deps, t2.access_token)).toMatchObject({ ok: false, code: "revoked_token" });
  });
});

describe("MCP writes and proposals", () => {
  it("adds a note as the user via the client, with actor mcp on the timeline and in the audit log", async () => {
    const c = await connect(await pat(A, "care@northwind.demo", ["read", "write:notes"]));
    const [order] = await pools.admin.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, A)).limit(1);
    const r = await call(c, "add_order_note", { order: order!.name, body: "Customer confirmed the address \u0007 by phone." });
    expect(r.isError, r.text).toBe(false);
    const [note] = await pools.admin.select().from(schema.orderNotes).where(eq(schema.orderNotes.orderId, order!.id)).orderBy(desc(schema.orderNotes.createdAt)).limit(1);
    expect(note).toMatchObject({ body: "Customer confirmed the address  by phone.", authorId: uid("care@northwind.demo") });
    const [ev] = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, order!.id), eq(schema.orderEvents.type, "note_added"))).orderBy(desc(schema.orderEvents.createdAt)).limit(1);
    expect(ev).toMatchObject({ actorType: "mcp", actorUserId: uid("care@northwind.demo") });
    expect(ev!.metadata).toMatchObject({ mcpClient: "test care@northwind.demo" });
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, "order.note_added"), eq(schema.auditLogs.entityId, order!.id))).orderBy(desc(schema.auditLogs.createdAt)).limit(1);
    expect(audit).toMatchObject({ actorType: "mcp", actorUserId: uid("care@northwind.demo") });
    expect(audit!.diff).toMatchObject({ noteId: { from: null, to: note!.id } });
  });

  it("changes status only along the allowed transitions", async () => {
    const c = await connect(await pat(A, "ops@northwind.demo", ["read", "write:orders"]));
    const [delivered] = await pools.admin.select({ name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "delivered"))).limit(1);
    const bad = await call(c, "set_order_status", { order: delivered!.name, status: "on_hold" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("cannot move");
    const [open] = await pools.admin.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"), isNull(schema.orders.cancelledAt))).limit(1);
    const ok = await call(c, "set_order_status", { order: open!.name, status: "on_hold", note: "Waiting for the size" });
    expect(ok.isError, ok.text).toBe(false);
    const [ev] = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, open!.id), eq(schema.orderEvents.type, "status_changed"))).orderBy(desc(schema.orderEvents.createdAt)).limit(1);
    expect(ev).toMatchObject({ actorType: "mcp", diff: { status: { from: "confirmed", to: "on_hold" } } });
  });

  it("proposes a cancellation that changes nothing until a person who may cancel approves it", async () => {
    const c = await connect(await pat(A, "owner@northwind.demo", ["read", "write:orders"]));
    const [order] = await pools.admin.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, A), inArray(schema.orders.status, ["new", "pending_review", "confirmed"]), isNull(schema.orders.cancelledAt))).limit(1);
    const r = await call(c, "propose_order_cancellation", { order: order!.name, reason: "Customer asked to cancel" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ status: "pending_approval" });
    const [still] = await pools.admin.select({ cancelledAt: schema.orders.cancelledAt }).from(schema.orders).where(eq(schema.orders.id, order!.id));
    expect(still!.cancelledAt).toBeNull();
    const id = String(r.json!.proposalId);
    // asking again for the same order does not add a second card
    expect((await call(c, "propose_order_cancellation", { order: order!.name, reason: "Asked twice" })).json!.proposalId).toBe(id);
    const run = <T>(email: string, fn: (s: ServiceContext) => Promise<T>) => withTenant(A, (tx) => fn({ tenantId: A, tx, actor: { type: "user", userId: uid(email) } }), pools.app);
    const inbox = await run("owner@northwind.demo", (s) => listProposals(s, { view: "pending" }));
    expect(inbox.find((p) => p.id === id)).toMatchObject({ kind: "order.cancel", status: "pending", clientName: "test owner@northwind.demo", summary: { orderName: order!.name } });
    const [notification] = await pools.admin.select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, A), eq(schema.notifications.type, "mcp_proposal"))).orderBy(desc(schema.notifications.createdAt)).limit(1);
    expect(notification).toBeTruthy();
    await expect(run("marketing@northwind.demo", (s) => decideProposal(s, { id, decision: "approve", role: "marketing" as TenantRole, commerce: async () => undefined }))).rejects.toBeInstanceOf(ProposalError);
    const out = await run("ops@northwind.demo", (s) => decideProposal(s, { id, decision: "approve", role: "operations", commerce: async () => undefined }));
    expect(out.status).toBe("approved");
    const [cancelled] = await pools.admin.select({ cancelledAt: schema.orders.cancelledAt, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, order!.id));
    expect(cancelled!.cancelledAt).not.toBeNull();
    const [ev] = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, order!.id), eq(schema.orderEvents.type, "cancelled"))).limit(1);
    expect(ev).toMatchObject({ actorUserId: uid("ops@northwind.demo"), metadata: { proposalId: id } });
    await expect(run("ops@northwind.demo", (s) => decideProposal(s, { id, decision: "reject", role: "operations", commerce: async () => undefined }))).rejects.toMatchObject({ code: "not_pending" });
    const usage = await mcpUsageByTenant(deps.admin);
    const a = usage.tenants.find((t) => t.tenantId === A)!;
    expect(a.calls).toBeGreaterThan(0);
    expect(a.availability).toBe("ok");
  });
});

describe("assistant on the shared tool layer", () => {
  it("still answers through the same tools (smoke)", async () => {
    const { MockLlmProvider } = await import("@hullwise/integrations");
    const { parseTenantSettings } = await import("@hullwise/core");
    const userId = uid("owner@northwind.demo");
    const r = await askAssistant((fn) => withTenant(A, (tx) => fn({ tenantId: A, tx, actor: { type: "user", userId } }), pools.app), { tenant: { id: A, name: "Northwind Apparel", slug: "northwind-apparel", country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) }, userId, role: "owner", activeAddons: [], locale: "en" }, new MockLlmProvider({ today: new Date() }), { question: "How did revenue go last week?" });
    expect(r.outcome).toBe("answered");
  });
});

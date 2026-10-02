import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, schema, withTenant, type Database } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import type { TenantRole } from "@hullwise/config";
import { API_ROUTES, apiRouteCatalog, createApiToken, handleApiRequest, matchApiPath, revokeMcpToken, type ApiHttpDeps } from "../src";

/**
 * Public REST API (#81) through its HTTP layer: authentication and plan gate, scopes and roles,
 * cursor pagination and filters, PII masking, tenant isolation of reads and writes, idempotent
 * writes (replay and key reuse), the status and stock writes, rate limits and the error format.
 */

const pools = testPools();
let ctx: SeedContext;
let A = "";
let B = "";
const deps: ApiHttpDeps = { admin: pools.admin as unknown as Database, app: pools.app as unknown as Database, policy: { allowLoopback: true } };
const uid = (email: string) => ctx.userIds[email]!;

async function setTenant(tenantId: string, patch: { planKey?: string; settings?: Record<string, unknown> }) {
  const [t] = await pools.admin.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await pools.admin.update(schema.tenants).set({ ...(patch.planKey ? { planKey: patch.planKey } : {}), ...(patch.settings ? { settings: { ...(t!.settings as object), ...patch.settings } } : {}) }).where(eq(schema.tenants.id, tenantId));
}

const issued = new Map<string, { token: string; id: string }>();
/** One token per tenant, person and scope set (a person holds at most 10 live tokens); `fresh` for tests that revoke. */
async function token(tenantId: string, email: string, scopes: string[], role: TenantRole = "owner", fresh = false): Promise<{ token: string; id: string }> {
  const cacheKey = `${tenantId}|${email}|${[...scopes].sort().join(",")}`;
  if (!fresh && issued.has(cacheKey)) return issued.get(cacheKey)!;
  const r = await withTenant(tenantId, (tx) => createApiToken({ tenantId, tx, actor: { type: "user", userId: uid(email) } }, { userId: uid(email), role, name: `api test ${email}`, scopes, days: 30 }), pools.app);
  if (!fresh) issued.set(cacheKey, { token: r.token, id: r.id });
  return { token: r.token, id: r.id };
}

const ALL = ["orders:read", "orders:write", "customers:read", "products:read", "inventory:read", "inventory:write", "shipments:read", "returns:read", "discounts:read", "purchasing:read", "webhooks:manage"];

async function call(tok: string | null, method: string, pathWithQuery: string, opts: { body?: unknown; headers?: Record<string, string>; deps?: ApiHttpDeps } = {}) {
  const url = new URL(`http://api.test/api${pathWithQuery}`);
  const req = new Request(url, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const res = await handleApiRequest(opts.deps ?? deps, req, url.pathname.replace(/^\/api/, ""));
  const text = await res.text();
  // response bodies are read loosely: each test asserts the fields it cares about
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Record<string, any> };
}

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  A = ctx.tenantIds.northwind;
  B = ctx.tenantIds.harbor;
  // Harbor Home is on Starter in the demo: Growth here so both tenants have the API
  await setTenant(B, { planKey: "growth" });
});
afterAll(async () => {
  await setTenant(B, { planKey: "starter" });
  await pools.close();
});

describe("route registry", () => {
  it("ids are unique, paths are versioned, every write takes a body or a path id", () => {
    const ids = API_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of API_ROUTES) expect(r.path.startsWith("/v1/")).toBe(true);
    expect(matchApiPath("/v1/orders/{id}/events", "/v1/orders/abc/events")).toEqual({ id: "abc" });
    expect(matchApiPath("/v1/orders/{id}", "/v1/orders")).toBeNull();
    const catalog = apiRouteCatalog();
    expect(catalog.find((r) => r.id === "orders_list")!.query).toEqual(expect.arrayContaining(["status", "updatedSince", "limit", "cursor"]));
    expect(catalog.find((r) => r.id === "orders_notes_create")!.body).toEqual(["body"]);
  });
});

describe("authentication, plan and errors", () => {
  it("401 without or with a bad token, JSON error with a stable code", async () => {
    const none = await call(null, "GET", "/v1/orders");
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    const bad = await call("kpat_" + "x".repeat(32), "GET", "/v1/orders");
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("invalid_token");
  });

  it("a revoked token stops at once", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:read"], "owner", true);
    expect((await call(t.token, "GET", "/v1/me")).status).toBe(200);
    await withTenant(A, (tx) => revokeMcpToken({ tenantId: A, tx, actor: { type: "user", userId: uid("owner@northwind.demo") } }, { tokenId: t.id, actorUserId: uid("owner@northwind.demo"), canRevokeOthers: true }), pools.app);
    expect((await call(t.token, "GET", "/v1/me")).json.error.code).toBe("invalid_token");
  });

  it("the API is from Growth: a Starter store gets 403 not_available", async () => {
    const t = await token(B, "owner@harborhome.demo", ["orders:read"]);
    await setTenant(B, { planKey: "starter" });
    try {
      const r = await call(t.token, "GET", "/v1/orders");
      expect(r.status).toBe(403);
      expect(r.json.error).toMatchObject({ code: "not_available", details: { reason: "plan" } });
    } finally {
      await setTenant(B, { planKey: "growth" });
    }
  });

  it("unknown routes 404, wrong methods 405, unknown query parameters 400", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:read"]);
    expect((await call(t.token, "GET", "/v1/nope")).json.error.code).toBe("not_found");
    const m = await call(t.token, "DELETE", "/v1/orders");
    expect(m.status).toBe(405);
    expect(m.headers.get("allow")).toContain("GET");
    const q = await call(t.token, "GET", "/v1/orders?stauts=new");
    expect(q.status).toBe(400);
    expect(q.json.error.message).toContain("stauts");
    expect((await call(t.token, "GET", "/v1/orders?limit=0")).status).toBe(400);
    expect((await call(t.token, "GET", "/v1/orders?status=bogus")).status).toBe(400);
    expect((await call(t.token, "GET", "/v1/orders?cursor=garbage")).json.error.code).toBe("invalid_cursor");
  });

  it("only owners and admins create API tokens; nothing is implied by a scope", async () => {
    await expect(token(A, "ops@northwind.demo", ["orders:read"], "operations")).rejects.toThrow();
    await expect(token(A, "owner@northwind.demo", ["read", "write:notes"])).rejects.toThrow();
    const t = await token(A, "admin@northwind.demo", ["customers:read"], "admin");
    const r = await call(t.token, "GET", "/v1/orders");
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: "insufficient_scope", details: { requiredScope: "orders:read" } });
    expect((await call(t.token, "GET", "/v1/customers?limit=2")).status).toBe(200);
  });

  it("the role decides too: a token of a person later made viewer cannot write", async () => {
    const t = await token(A, "admin@northwind.demo", ["orders:write", "orders:read"], "admin");
    const m = schema.tenantMemberships;
    await pools.admin.update(m).set({ role: "viewer" }).where(and(eq(m.tenantId, A), eq(m.userId, uid("admin@northwind.demo"))));
    try {
      const [o] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, A)).limit(1);
      const r = await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: "hello" } });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("forbidden");
      expect((await call(t.token, "GET", `/v1/orders/${o!.id}`)).status).toBe(200);
    } finally {
      await pools.admin.update(m).set({ role: "admin" }).where(and(eq(m.tenantId, A), eq(m.userId, uid("admin@northwind.demo"))));
    }
  });

  it("rate limits per token answer 429 with Retry-After and are logged", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:read"], "owner", true);
    const limited = { ...deps, limits: { perToken: 2, perTenant: 1000 } };
    expect((await call(t.token, "GET", "/v1/me", { deps: limited })).status).toBe(200);
    expect((await call(t.token, "GET", "/v1/me", { deps: limited })).status).toBe(200);
    const r = await call(t.token, "GET", "/v1/me", { deps: limited });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("rate_limited");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    const log = await pools.admin.select().from(schema.apiRequestLog).where(and(eq(schema.apiRequestLog.tenantId, A), eq(schema.apiRequestLog.tokenId, t.id)));
    expect(log.map((l) => l.status).sort()).toEqual([200, 200, 429]);
    expect(log.every((l) => l.route === "/v1/me")).toBe(true);
  });
});

describe("reads: pagination, filters, PII", () => {
  it("orders: keyset pages without gaps or duplicates, newest first", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:read"]);
    const seen: string[] = [];
    let cursor: string | null = null;
    const placed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call(t.token, "GET", `/v1/orders?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.json.object).toBe("list");
      seen.push(...r.json.data.map((o: { id: string }) => o.id));
      placed.push(...r.json.data.map((o: { placedAt: string }) => o.placedAt));
      cursor = r.json.nextCursor;
      expect(r.json.hasMore).toBe(true);
    }
    expect(new Set(seen).size).toBe(28);
    expect([...placed].sort().reverse()).toEqual(placed);
    const expected = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, A)).orderBy(desc(schema.orders.placedAt), desc(schema.orders.id)).limit(28);
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it("filters mirror the list: status, payment method, customer", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:read"]);
    const r = await call(t.token, "GET", "/v1/orders?status=cancelled,delivered&paymentMethod=card&limit=50");
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBeGreaterThan(0);
    for (const o of r.json.data) {
      expect(["cancelled", "delivered"]).toContain(o.status);
      expect(o.paymentMethod).toBe("card");
    }
    const customerId = r.json.data.find((o: { customerId: string | null }) => o.customerId)!.customerId;
    const byCustomer = await call(t.token, "GET", `/v1/orders?customerId=${customerId}`);
    expect(byCustomer.json.data.every((o: { customerId: string }) => o.customerId === customerId)).toBe(true);
  });

  it("customer PII is masked unless the token has pii:read, the role may see it and the store switched full PII on", async () => {
    const masked = await token(A, "owner@northwind.demo", ["customers:read", "orders:read"]);
    const r = await call(masked.token, "GET", "/v1/customers?limit=20");
    const withEmail = r.json.data.find((c: { email: string | null }) => c.email);
    expect(withEmail.email).toMatch(/^.\*\*\*@/);
    const full = await token(A, "owner@northwind.demo", ["customers:read", "pii:read"]);
    expect((await call(full.token, "GET", `/v1/customers/${withEmail.id}`)).json.email).toMatch(/^.\*\*\*@/);
    await setTenant(A, { settings: { mcpFullPii: true } });
    try {
      const shown = await call(full.token, "GET", `/v1/customers/${withEmail.id}`);
      expect(shown.json.email).toContain("@");
      expect(shown.json.email).not.toMatch(/\*\*\*/);
      expect((await call(full.token, "GET", "/v1/me")).json.pii).toBe("full");
    } finally {
      await setTenant(A, { settings: { mcpFullPii: false } });
    }
  });

  it("every read route answers 200 for a token with every scope", async () => {
    const t = await token(A, "owner@northwind.demo", ALL);
    const [o] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, A)).limit(1);
    const [p] = await pools.admin.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.tenantId, A)).limit(1);
    const [s] = await pools.admin.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.tenantId, A)).limit(1);
    const [rr] = await pools.admin.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, A)).limit(1);
    const [d] = await pools.admin.select({ id: schema.discounts.id }).from(schema.discounts).where(eq(schema.discounts.tenantId, A)).limit(1);
    const [po] = await pools.admin.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, A)).limit(1);
    const [c] = await pools.admin.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.tenantId, A)).limit(1);
    const ids: Record<string, string> = { "orders_get": o!.id, "orders_events": o!.id, "customers_get": c!.id, "products_get": p!.id, "shipments_get": s!.id, "returns_get": rr!.id, "discounts_get": d!.id, "purchase_orders_get": po!.id };
    for (const r of API_ROUTES.filter((x) => x.method === "GET")) {
      const path = r.path.replace("{id}", ids[r.id] ?? "");
      const res = await call(t.token, "GET", path);
      expect(res.status, `${r.id} ${res.json?.error?.message ?? ""}`).toBe(200);
    }
    const detail = await call(t.token, "GET", `/v1/orders/${o!.id}`);
    expect(detail.json.lines.length).toBeGreaterThan(0);
    const product = await call(t.token, "GET", `/v1/products/${p!.id}`);
    expect(product.json.variants.length).toBeGreaterThan(0);
  });
});

describe("tenant isolation", () => {
  it("tenant A's token never reads tenant B's records, by list or by id", async () => {
    const t = await token(A, "owner@northwind.demo", ALL);
    const bIds = new Set<string>();
    for (const table of [schema.orders, schema.customers, schema.products, schema.shipments, schema.returnRequests, schema.discounts, schema.purchaseOrders]) for (const r of await pools.admin.select({ id: table.id }).from(table).where(eq(table.tenantId, B))) bIds.add(r.id);
    for (const path of ["/v1/orders", "/v1/customers", "/v1/products", "/v1/variants", "/v1/inventory-levels", "/v1/shipments", "/v1/returns", "/v1/discounts", "/v1/purchase-orders", "/v1/locations"]) {
      const r = await call(t.token, "GET", `${path}?limit=100`);
      expect(r.status, path).toBe(200);
      for (const row of r.json.data) expect(bIds.has(row.id), `${path} leaked ${row.id}`).toBe(false);
    }
    const [bOrder] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, B)).limit(1);
    const [bProduct] = await pools.admin.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.tenantId, B)).limit(1);
    expect((await call(t.token, "GET", `/v1/orders/${bOrder!.id}`)).status).toBe(404);
    expect((await call(t.token, "GET", `/v1/orders/${bOrder!.id}/events`)).status).toBe(404);
    expect((await call(t.token, "GET", `/v1/products/${bProduct!.id}`)).status).toBe(404);
  });

  it("tenant A's token never writes tenant B's records", async () => {
    const t = await token(A, "owner@northwind.demo", ALL);
    const [bOrder] = await pools.admin.select({ id: schema.orders.id, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.tenantId, B)).limit(1);
    const notesBefore = await pools.admin.select({ id: schema.orderNotes.id }).from(schema.orderNotes).where(eq(schema.orderNotes.orderId, bOrder!.id));
    expect((await call(t.token, "POST", `/v1/orders/${bOrder!.id}/notes`, { body: { body: "cross-tenant" } })).status).toBe(404);
    expect((await call(t.token, "POST", `/v1/orders/${bOrder!.id}/status`, { body: { status: "on_hold" } })).status).toBe(404);
    const notesAfter = await pools.admin.select({ id: schema.orderNotes.id }).from(schema.orderNotes).where(eq(schema.orderNotes.orderId, bOrder!.id));
    expect(notesAfter.length).toBe(notesBefore.length);
    const [after] = await pools.admin.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, bOrder!.id));
    expect(after!.status).toBe(bOrder!.status);
    const [bLevel] = await pools.admin.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, B)).limit(1);
    const adj = await call(t.token, "POST", "/v1/inventory-levels/adjust", { body: { variantId: bLevel!.variantId, locationId: bLevel!.locationId, delta: 5, reason: "found" } });
    expect(adj.status).toBe(404);
    const [levelAfter] = await pools.admin.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.id, bLevel!.id));
    expect(levelAfter!.available).toBe(bLevel!.available);
    // and B's own token sees B's order
    const tb = await token(B, "owner@harborhome.demo", ["orders:read"]);
    expect((await call(tb.token, "GET", `/v1/orders/${bOrder!.id}`)).status).toBe(200);
  });
});

describe("writes", () => {
  it("a note with an Idempotency-Key is written once and replayed; the same key with another body is refused", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:write"]);
    const [o] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, A)).orderBy(desc(schema.orders.placedAt)).limit(1);
    const key = `note-${Date.now()}`;
    const first = await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: "Packed with care" }, headers: { "Idempotency-Key": key } });
    expect(first.status).toBe(201);
    const again = await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: "Packed with care" }, headers: { "Idempotency-Key": key } });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(again.json).toEqual(first.json);
    const notes = await pools.admin.select().from(schema.orderNotes).where(and(eq(schema.orderNotes.orderId, o!.id), eq(schema.orderNotes.body, "Packed with care")));
    expect(notes.length).toBe(1);
    const reused = await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: "Something else" }, headers: { "Idempotency-Key": key } });
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe("idempotency_key_reused");
    // timeline and audit carry the API actor
    const [event] = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, o!.id), eq(schema.orderEvents.type, "note_added"))).orderBy(desc(schema.orderEvents.createdAt)).limit(1);
    expect(event!.actorType).toBe("api");
    expect((event!.metadata as Record<string, unknown>).apiTokenId).toBe(t.id);
    const [auditRow] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, "order.note_added"), eq(schema.auditLogs.entityId, o!.id))).orderBy(desc(schema.auditLogs.createdAt)).limit(1);
    expect(auditRow!.actorType).toBe("api");
  });

  it("status changes go through the status engine, along the reversible steps only", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:write"]);
    const [o] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "confirmed"))).limit(1);
    const hold = await call(t.token, "POST", `/v1/orders/${o!.id}/status`, { body: { status: "on_hold", note: "waiting for stock" } });
    expect(hold.status).toBe(200);
    expect(hold.json).toMatchObject({ status: "on_hold", previousStatus: "confirmed" });
    const [event] = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, o!.id), eq(schema.orderEvents.type, "status_changed"))).orderBy(desc(schema.orderEvents.createdAt)).limit(1);
    expect(event!.actorType).toBe("api");
    const [delivered] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, A), eq(schema.orders.status, "delivered"))).limit(1);
    const refused = await call(t.token, "POST", `/v1/orders/${delivered!.id}/status`, { body: { status: "on_hold" } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("conflict");
    const invalid = await call(t.token, "POST", `/v1/orders/${o!.id}/status`, { body: { status: "delivered" } });
    expect(invalid.status).toBe(422);
  });

  it("stock adjustments use the inventory service: movement, audit, new level", async () => {
    const t = await token(A, "owner@northwind.demo", ["inventory:write", "inventory:read"]);
    const [level] = await pools.admin.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.tenantId, A)).orderBy(desc(schema.inventoryLevels.available)).limit(1);
    const r = await call(t.token, "POST", "/v1/inventory-levels/adjust", { body: { variantId: level!.variantId, locationId: level!.locationId, delta: -2, reason: "damaged", note: "box crushed" }, headers: { "Idempotency-Key": `adj-${Date.now()}` } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ before: level!.available, after: level!.available - 2 });
    const [m] = await pools.admin.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.id, r.json.movementId));
    expect(m).toMatchObject({ delta: -2, reasonCode: "damaged" });
    const [a] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, "inventory.adjusted"), eq(schema.auditLogs.entityId, level!.variantId))).orderBy(desc(schema.auditLogs.createdAt)).limit(1);
    expect(a!.actorType).toBe("api");
    const list = await call(t.token, "GET", `/v1/inventory-levels?variantId=${level!.variantId}`);
    expect(list.json.data.find((l: { locationId: string }) => l.locationId === level!.locationId).available).toBe(level!.available - 2);
    const bad = await call(t.token, "POST", "/v1/inventory-levels/adjust", { body: { variantId: level!.variantId, locationId: level!.locationId, delta: 0, reason: "damaged" } });
    expect(bad.status).toBe(422);
  });

  it("bodies are validated: unknown fields, wrong types, not JSON", async () => {
    const t = await token(A, "owner@northwind.demo", ["orders:write"]);
    const [o] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, A)).limit(1);
    expect((await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: "x", extra: 1 } })).status).toBe(422);
    expect((await call(t.token, "POST", `/v1/orders/${o!.id}/notes`, { body: { body: 42 } })).json.error.code).toBe("unprocessable");
    const url = `http://api.test/api/v1/orders/${o!.id}/notes`;
    const res = await handleApiRequest(deps, new Request(url, { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: "{not json" }), `/v1/orders/${o!.id}/notes`);
    expect(res.status).toBe(400);
  });
});

describe("webhook endpoints through the API", () => {
  it("create (secret once), list, delete; refused for private targets; isolated per tenant", async () => {
    const t = await token(A, "owner@northwind.demo", ["webhooks:manage"]);
    const created = await call(t.token, "POST", "/v1/webhook-endpoints", { body: { url: "http://127.0.0.1:9/hook", eventTypes: ["order.created", "order.status_changed"] } });
    expect(created.status).toBe(201);
    expect(created.json.secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
    const listed = await call(t.token, "GET", "/v1/webhook-endpoints");
    expect(listed.json.data.map((e: { id: string }) => e.id)).toContain(created.json.id);
    expect(JSON.stringify(listed.json)).not.toContain(created.json.secret);
    const metadata = await call(t.token, "POST", "/v1/webhook-endpoints", { body: { url: "https://169.254.169.254/latest", eventTypes: ["order.created"] } });
    expect(metadata.status).toBe(422);
    expect(metadata.json.error.details.reason).toBe("private_address");
    const tb = await token(B, "owner@harborhome.demo", ["webhooks:manage"]);
    expect((await call(tb.token, "DELETE", `/v1/webhook-endpoints/${created.json.id}`)).status).toBe(404);
    expect((await call(tb.token, "GET", "/v1/webhook-endpoints")).json.data.map((e: { id: string }) => e.id)).not.toContain(created.json.id);
    expect((await call(t.token, "DELETE", `/v1/webhook-endpoints/${created.json.id}`)).status).toBe(200);
    const left = await pools.admin.select().from(schema.webhookEndpoints).where(inArray(schema.webhookEndpoints.id, [created.json.id]));
    expect(left).toEqual([]);
  });
});

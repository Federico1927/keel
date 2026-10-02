import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockCommercePlatform } from "@hullwise/integrations";
import { parseTenantSettings, queryParams } from "@hullwise/core";
import { SkipItem, buildListCsv, bulkOrders, bulkProducts, bulkReturns, countListExport, deleteView, globalSearch, listSavedViews, orderListWhere, parseOrderFilters, requestListExport, runBatch, runListExport, saveView, takeExportFile, type BulkRunner, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let harborId = "";
const settings = parseTenantSettings({});
const scope = () => ({ tenantId, userId: seed.userIds["owner@northwind.demo"]!, orderNumberPrefix: "NW-", settings });

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.northwind;
  harborId = seed.tenantIds.harbor;
});
afterAll(() => pools.close());

const owner = () => seed.userIds["owner@northwind.demo"]!;
const run = <T>(fn: (s: ServiceContext) => Promise<T>, tid = tenantId) => withTenant(tid, (tx) => fn({ tenantId: tid, tx, actor: { type: "user", userId: owner() } }), pools.app);
const runner = (): BulkRunner => ({ tenantId, actor: { type: "user", userId: owner() }, audit: { actorUserId: owner(), actorType: "user", impersonatedBy: null }, run: (fn) => run(fn) });
const mockPlatform = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 900000 });

describe("batch runner", () => {
  it("keeps at most N items in flight and reports every outcome in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, label: `#${i}` }));
    const summary = await runBatch(items, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (item.id === "i3") throw new SkipItem("already_done");
      if (item.id === "i7") throw new Error("boom");
    }, { concurrency: 3 });
    expect(peak).toBe(3);
    expect(summary).toMatchObject({ total: 10, done: 8, skipped: 1, failed: 1 });
    expect(summary.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(summary.items[3]).toMatchObject({ status: "skipped", reason: "already_done", label: "#3" });
    expect(summary.items[7]).toMatchObject({ status: "failed", reason: "boom" });
  });
});

describe("bulk orders", () => {
  it("bulk-cancels 20 orders with 2 platform failures: 18 done, 2 failed with reasons, 18 timeline events", async () => {
    const ids = await run(async (s) => (await s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), isNull(schema.orders.cancelledAt), sql`${schema.orders.externalId} is not null`, sql`${schema.orders.replacedByOrderId} is null`)).limit(20)).map((r) => r.id));
    expect(ids).toHaveLength(20);
    const platform = mockPlatform();
    platform.failures.failNext("rate_limited", 2);
    const summary = await bulkOrders(runner(), platform, ids, { action: "cancel", reason: "customer", restock: true, refund: false }, { concurrency: 3 });
    expect(summary).toMatchObject({ total: 20, done: 18, skipped: 0, failed: 2 });
    const failed = summary.items.filter((i) => i.status === "failed");
    expect(failed.every((f) => f.reason?.startsWith("rate_limited"))).toBe(true);
    expect(failed.every((f) => f.label?.startsWith("#"))).toBe(true);
    const events = await run((s) => s.tx.select({ orderId: schema.orderEvents.orderId, type: schema.orderEvents.type }).from(schema.orderEvents).where(and(eq(schema.orderEvents.tenantId, tenantId), sql`${schema.orderEvents.metadata}->>'batchId' = ${summary.batchId}`)));
    expect(events).toHaveLength(18);
    expect(events.every((e) => e.type === "cancelled")).toBe(true);
    expect(new Set(events.map((e) => e.orderId))).toEqual(new Set(summary.items.filter((i) => i.status === "done").map((i) => i.id)));
    const audits = await run((s) => s.tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), sql`${schema.auditLogs.metadata}->>'batchId' = ${summary.batchId}`)));
    expect(audits.filter((a) => a.action === "order.cancelled")).toHaveLength(18);
    expect(audits.filter((a) => a.action === "bulk.order.cancel")).toHaveLength(1);
    const cancelled = await run((s) => s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(inArray(schema.orders.id, ids), sql`${schema.orders.cancelledAt} is not null`)));
    expect(cancelled).toHaveLength(18);
    expect(platform.writeLog.filter((w) => w.op === "cancelOrder")).toHaveLength(18);
    // every accepted platform call is in the outbox (a refused one rolls back with its record)
    const writes = await run((s) => s.tx.select({ entityId: schema.platformWrites.entityId, status: schema.platformWrites.status }).from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, tenantId), eq(schema.platformWrites.kind, "order.cancel"), inArray(schema.platformWrites.entityId, ids))));
    expect(writes).toHaveLength(18);
    expect(writes.every((w) => w.status === "succeeded")).toBe(true);
    // running it again skips what is already cancelled and retries only the two that failed
    const again = await bulkOrders(runner(), platform, ids, { action: "cancel", reason: "customer", restock: true, refund: false }, { concurrency: 3 });
    expect(again).toMatchObject({ done: 2, skipped: 18, failed: 0 });
    expect(again.items.find((i) => i.status === "skipped")?.reason).toBe("already_cancelled");
  });

  it("tags, assigns and sets the status with one event per order", async () => {
    const ids = await run(async (s) => (await s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "confirmed"))).limit(4)).map((r) => r.id));
    const platform = mockPlatform();
    const tagged = await bulkOrders(runner(), platform, ids, { action: "tag", add: ["Priority"], remove: [] }, { concurrency: 3 });
    expect(tagged.done).toBe(ids.length);
    expect(platform.writeLog.filter((w) => w.op === "updateOrderTags")).toHaveLength(ids.length);
    const rows = await run((s) => s.tx.select({ tags: schema.orders.platformTags }).from(schema.orders).where(inArray(schema.orders.id, ids)));
    expect(rows.every((r) => r.tags.includes("priority"))).toBe(true);
    const assignee = seed.userIds["ops@northwind.demo"]!;
    const assigned = await bulkOrders(runner(), platform, ids, { action: "assign", userId: assignee }, { concurrency: 3 });
    expect(assigned.done).toBe(ids.length);
    const held = await bulkOrders(runner(), platform, ids, { action: "status", status: "on_hold", note: "stock check" }, { concurrency: 3 });
    expect(held.done).toBe(ids.length);
    const events = await run((s) => s.tx.select({ type: schema.orderEvents.type }).from(schema.orderEvents).where(sql`${schema.orderEvents.metadata}->>'batchId' in (${tagged.batchId}, ${assigned.batchId}, ${held.batchId})`));
    expect(events.filter((e) => e.type === "tags_updated")).toHaveLength(ids.length);
    expect(events.filter((e) => e.type === "assigned")).toHaveLength(ids.length);
    expect(events.filter((e) => e.type === "status_changed")).toHaveLength(ids.length);
    const repeat = await bulkOrders(runner(), platform, ids, { action: "status", status: "on_hold" }, { concurrency: 3 });
    expect(repeat).toMatchObject({ done: 0, skipped: ids.length });
  });
});

describe("bulk products and returns", () => {
  it("changes prices, compare-at and status through the platform", async () => {
    // active products in a fixed order: other suites may have moved some to draft
    const products = await run((s) => s.tx.select({ id: schema.products.id, externalId: schema.products.externalId }).from(schema.products).where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.status, "active"))).orderBy(schema.products.id).limit(2));
    const ids = products.map((p) => p.id);
    const before = await run((s) => s.tx.select({ id: schema.productVariants.id, price: schema.productVariants.priceMinor }).from(schema.productVariants).where(inArray(schema.productVariants.productId, ids)));
    const platform = mockPlatform();
    const r = await bulkProducts(runner(), platform, ids, { action: "price", price: { mode: "percent", bps: -1000 } }, { concurrency: 3 });
    expect(r.done).toBe(2);
    const after = await run((s) => s.tx.select({ id: schema.productVariants.id, price: schema.productVariants.priceMinor }).from(schema.productVariants).where(inArray(schema.productVariants.productId, ids)));
    for (const v of after) expect(v.price).toBe(Math.round((before.find((b) => b.id === v.id)!.price * 9000) / 10000));
    expect(platform.writeLog.filter((w) => w.op === "updateVariant")).toHaveLength(before.filter((b) => b.price > 0).length);
    const c = await bulkProducts(runner(), platform, ids, { action: "compare_at", compareAt: { mode: "set", valueMinor: 9900 } }, { concurrency: 3 });
    expect(c.done).toBe(2);
    const s1 = await bulkProducts(runner(), platform, ids, { action: "status", status: "draft" }, { concurrency: 3 });
    expect(s1.done).toBe(2);
    expect(platform.writeLog.filter((w) => w.op === "updateProductStatus")).toHaveLength(products.filter((p) => p.externalId).length);
    const tags = await bulkProducts(runner(), platform, ids, { action: "tags", add: ["Summer"], remove: [] }, { concurrency: 3 });
    expect(tags.done).toBe(2);
    expect(platform.writeLog.filter((w) => w.op === "updateProductTags")).toHaveLength(products.filter((p) => p.externalId).length);
  });

  it("rejects open returns and skips closed ones with the reason", async () => {
    const rows = await run((s) => s.tx.select({ id: schema.returnRequests.id, status: schema.returnRequests.status }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, tenantId)));
    const open = rows.filter((r) => ["requested", "approved", "received", "inspected"].includes(r.status)).slice(0, 2);
    const closed = rows.filter((r) => r.status === "refunded").slice(0, 1);
    expect(open.length).toBeGreaterThan(0);
    expect(closed.length).toBe(1);
    const r = await bulkReturns(runner(), mockPlatform(), settings, [...open, ...closed].map((x) => x.id), { action: "reject", note: "bulk" }, { concurrency: 3, country: "IT" });
    expect(r.done).toBe(open.length);
    expect(r.skipped).toBe(1);
    expect(r.items.find((i) => i.status === "skipped")?.reason).toBe("bad_transition:refunded");
    const after = await run((s) => s.tx.select({ status: schema.returnRequests.status }).from(schema.returnRequests).where(inArray(schema.returnRequests.id, open.map((o) => o.id))));
    expect(after.every((a) => a.status === "rejected")).toBe(true);
  });
});

describe("saved views", () => {
  it("shows private views to the owner only and shared views to everyone, and reopens with identical results", async () => {
    const ops = seed.userIds["ops@northwind.demo"]!;
    const care = seed.userIds["care@northwind.demo"]!;
    const priv = await run((s) => saveView(s, { pageKey: "orders", name: "My paid card orders", query: "page=3&payment=card&paymentStatus=paid", isShared: false, userId: ops }));
    const shared = await run((s) => saveView(s, { pageKey: "orders", name: "Team on hold", query: "status=on_hold", isShared: true, userId: ops }));
    const forOps = await run((s) => listSavedViews(s, "orders", ops));
    const forCare = await run((s) => listSavedViews(s, "orders", care));
    expect(forOps.map((v) => v.id)).toEqual(expect.arrayContaining([priv.id, shared.id]));
    expect(forCare.map((v) => v.id)).toContain(shared.id);
    expect(forCare.map((v) => v.id)).not.toContain(priv.id);
    const view = forOps.find((v) => v.id === priv.id)!;
    expect(view.query).toBe("payment=card&paymentStatus=paid");
    // saving the same name again replaces the view
    expect((await run((s) => saveView(s, { pageKey: "orders", name: "My paid card orders", query: "payment=card&paymentStatus=paid", isShared: false, userId: ops }))).replaced).toBe(true);
    const ids = (q: string) => run(async (s) => (await s.tx.select({ id: schema.orders.id }).from(schema.orders).where(orderListWhere({ ...scope(), userId: ops }, parseOrderFilters(queryParams(q)))).orderBy(schema.orders.id)).map((r) => r.id));
    expect(await ids(view.query)).toEqual(await ids("paymentStatus=paid&payment=card&page=1"));
    await expect(run((s) => deleteView(s, shared.id, care, false))).rejects.toThrow("forbidden");
    await expect(run((s) => deleteView(s, priv.id, care, true))).rejects.toThrow("not_found");
    await run((s) => deleteView(s, shared.id, owner(), true));
    expect((await run((s) => listSavedViews(s, "orders", care))).map((v) => v.id)).not.toContain(shared.id);
  });
});

describe("global search", () => {
  it("finds an order by phone in E.164 and in local format, by number and by email", async () => {
    const [o] = await run((s) => s.tx.select({ id: schema.orders.id, phone: schema.orders.phoneE164, number: schema.orders.orderNumber, email: schema.orders.emailNormalized }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.phoneE164} like '+39%'`, sql`${schema.orders.emailNormalized} is not null`)).limit(1));
    expect(o).toBeTruthy();
    const opts = { country: "IT", orderNumberPrefix: "NW-", areas: ["orders", "customers", "products", "purchasing"] as const };
    const local = o!.phone!.replace(/^\+39/, "");
    const spaced = `${local.slice(0, 3)} ${local.slice(3)}`;
    for (const q of [o!.phone!, `+39 ${spaced}`, spaced]) {
      const r = await run((s) => globalSearch(s, q, { ...opts, limit: 10 }));
      expect(r.orders.map((x) => x.id), q).toContain(o!.id);
    }
    expect((await run((s) => globalSearch(s, `#NW-${o!.number}`, opts))).orders[0]?.id).toBe(o!.id);
    expect((await run((s) => globalSearch(s, o!.email!.toUpperCase(), { ...opts, limit: 10 }))).orders.map((x) => x.id)).toContain(o!.id);
    const sku = await run(async (s) => (await s.tx.select({ sku: schema.productVariants.sku }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, tenantId), sql`${schema.productVariants.sku} is not null`)).limit(1))[0]!.sku!);
    expect((await run((s) => globalSearch(s, sku.toLowerCase(), opts))).products.length).toBeGreaterThan(0);
    const po = await run(async (s) => (await s.tx.select({ number: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, tenantId)).limit(1))[0]!.number);
    expect((await run((s) => globalSearch(s, po, opts))).purchaseOrders.map((p) => p.number)).toContain(po);
    // areas the role cannot open are not searched
    expect((await run((s) => globalSearch(s, po, { ...opts, areas: ["orders"] }))).purchaseOrders).toEqual([]);
  });

  it("never returns another tenant's rows (isolation)", async () => {
    const [b] = await run((s) => s.tx.select({ phone: schema.orders.phoneE164, email: schema.orders.emailNormalized, name: schema.orders.customerName }).from(schema.orders).where(and(eq(schema.orders.tenantId, harborId), sql`${schema.orders.phoneE164} is not null`, sql`${schema.orders.emailNormalized} is not null`)).limit(1), harborId);
    expect(b).toBeTruthy();
    const opts = { country: "US", orderNumberPrefix: "HH-", areas: ["orders", "customers", "products", "purchasing"] as const, limit: 50 };
    const [harborProduct] = await run((s) => s.tx.select({ title: schema.products.title }).from(schema.products).where(eq(schema.products.tenantId, harborId)).limit(1), harborId);
    for (const q of [b!.phone!, b!.email!, b!.name!, harborProduct!.title]) {
      const fromA = await run((s) => globalSearch(s, q, opts));
      const ids = [...fromA.orders.map((x) => x.id), ...fromA.customers.map((x) => x.id), ...fromA.products.map((x) => x.id), ...fromA.purchaseOrders.map((x) => x.id)];
      if (!ids.length) continue;
      const leaked = await withTenant(harborId, async (tx) => {
        const n = await tx.execute<{ n: number }>(sql`select (select count(*) from orders where id = any(${sql.param(ids)}::uuid[])) + (select count(*) from customers where id = any(${sql.param(ids)}::uuid[])) + (select count(*) from products where id = any(${sql.param(ids)}::uuid[])) + (select count(*) from purchase_orders where id = any(${sql.param(ids)}::uuid[])) as n`);
        return Number(n.rows[0]!.n);
      }, pools.app);
      expect(leaked, q).toBe(0);
    }
    // and a search with tenant B's own context does find its phone
    expect((await run((s) => globalSearch(s, b!.phone!, opts), harborId)).orders.length).toBeGreaterThan(0);
  });
});

describe("csv export", () => {
  it("exports exactly the filtered list and runs large exports in the background with a notification", async () => {
    const params = queryParams("status=delivered&payment=card");
    const count = await run((s) => countListExport(s, "orders", params, scope()));
    const { csv, rows } = await run((s) => buildListCsv(s, "orders", params, scope()));
    expect(rows).toBe(count);
    expect(csv.split("\n")[0]).toContain("order,placed_at,status");
    expect(csv.trim().split("\n")).toHaveLength(count + 1);
    for (const list of ["products", "customers", "returns"] as const) {
      const n = await run((s) => countListExport(s, list, {}, scope()));
      expect((await run((s) => buildListCsv(s, list, {}, scope()))).rows, list).toBe(n);
    }
    const id = await run((s) => requestListExport(s, { list: "orders", query: "status=delivered&payment=card", userId: owner(), expectedRows: count }));
    expect(await run((s) => takeExportFile(s, id, owner()))).toBeNull();
    const r = await run((s) => runListExport(s, id));
    expect(r).toEqual({ status: "done", rows: count });
    const notes = await run((s) => s.tx.select({ title: schema.notifications.title, body: schema.notifications.body }).from(schema.notifications).where(and(eq(schema.notifications.tenantId, tenantId), eq(schema.notifications.userId, owner()), eq(schema.notifications.type, "export_ready"))));
    expect(notes).toContainEqual({ title: String(count), body: "orders" });
    expect(await run((s) => takeExportFile(s, id, seed.userIds["ops@northwind.demo"]!))).toBeNull();
    expect((await run((s) => takeExportFile(s, id, owner())))?.content).toBe(csv);
  });
});

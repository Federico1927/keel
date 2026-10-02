import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import type { MockCommercePlatform, NormalizedOrder } from "@keel/integrations";
import { AWAITING_STOCK_REASON, optionStockGrid, parseTenantSettings } from "@keel/core";
import { applyCancellation, backorderSummary, cancelBackorderWait, createPurchaseOrder, executePlatformWrite, getCommercePlatformFor, importOrder, mockCommerceFor, orderBackorders, orderLineStock, orderListWhere, parseOrderFilters, processDuePlatformWrites, receivePurchaseOrder, recheckOpenBackorders, replaceOrder, resetMockPlatforms, transitionPurchaseOrder, variantStock, type PlatformTenant, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: PlatformTenant;
let mock: MockCommercePlatform;
let owner = "";
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: owner } }), pools.app);
const sys = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const hour = 36e5;

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.harbor;
  owner = seed.userIds["owner@harborhome.demo"]!;
  const [t] = await pools.admin.select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  tenant = t!;
  resetMockPlatforms();
  await run((s) => getCommercePlatformFor(s, tenant));
  mock = mockCommerceFor(tenantId)!;
});
afterAll(() => pools.close());

/** A fresh catalogue variant (own product, no PO), its stock set to `available` at the default location, read an hour ago (new orders are not reflected). */
let seq = 0;
async function variantWithStock(available: number) {
  seq++;
  return run(async (s) => {
    const [loc] = await s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1);
    const [p] = await s.tx.insert(schema.products).values({ tenantId, externalId: `bo-p-${seq}`, title: `Backorder test ${seq}`, options: [{ name: "Finish", values: ["Oak"] }] }).returning();
    const [v] = await s.tx.insert(schema.productVariants).values({ tenantId, productId: p!.id, externalId: `bo-v-${seq}`, inventoryItemExternalId: `bo-i-${seq}`, sku: `BO-${seq}`, title: "Oak", optionValues: { Finish: "Oak" }, priceMinor: 4900, costMinor: 2000 }).returning();
    await s.tx.insert(schema.inventoryLevels).values({ tenantId, variantId: v!.id, locationId: loc!.id, available, onHand: available, committed: 0, syncedAt: new Date(Date.now() - hour) });
    return v!;
  });
}

async function incomingPo(variantId: string, quantity: number, expectedAt: Date) {
  const supplier = await run(async (s) => (await s.tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).limit(1))[0]!);
  const location = await run(async (s) => (await s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1))[0]!);
  const poId = await run((s) => createPurchaseOrder(s, { supplierId: supplier.id, destinationLocationId: location.id, currency: "USD", expectedAt, lines: [{ variantId, quantity, unitCostMinor: 1500 }] }));
  await run((s) => transitionPurchaseOrder(s, poId, "sent"));
  return { poId, supplier, confirm: () => run((s) => transitionPurchaseOrder(s, poId, "confirmed")), lineId: async () => (await run((s) => s.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId))))[0]!.id };
}

/** An order placed on the (mock) store for one variant, imported like a webhook would. */
async function placeOrder(variantExternalId: string, quantity: number): Promise<{ id: string; order: NormalizedOrder }> {
  const order = await mock.createOrder({ lines: [{ variantExternalId, sku: null, title: "x", quantity, unitPriceMinor: 4900 }], currency: "USD", email: "buyer@example.com", phone: null, customerExternalId: null, shippingAddress: { name: "Ann Lee", address1: "500 Congress Ave", city: "Austin", province: "TX", zip: "78701", country: "US" }, billingAddress: null, shippingMinor: 0, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: null, payment: { method: "card", status: "paid", gateways: ["shopify_payments"] } });
  const r = await sys((s) => importOrder(s, order, { country: "US", source: "webhook" }));
  return { id: r.id, order };
}
const orderRow = (id: string) => run(async (s) => (await s.tx.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]!);
const backordersOf = (id: string) => run((s) => s.tx.select().from(schema.backorders).where(eq(schema.backorders.orderId, id)));
const eventsOf = (id: string) => run((s) => s.tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, id)).orderBy(schema.orderEvents.createdAt));
const inView = (id: string, stock: "awaiting" | "ready") => run(async (s) => (await s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(orderListWhere({ tenantId, userId: owner, orderNumberPrefix: "" }, parseOrderFilters({ stock })), eq(schema.orders.id, id)))).length === 1);

describe("backorders end to end", () => {
  it("an order for an out-of-stock variant with an incoming PO is held with the PO and ETA; receiving the PO releases it, notifies and lifts the store hold", async () => {
    const v = await variantWithStock(0);
    const eta = new Date("2026-10-20T12:00:00Z");
    const po = await incomingPo(v.id, 10, eta);
    await po.confirm();
    const { id, order } = await placeOrder(v.externalId!, 2);

    const [b] = await backordersOf(id);
    expect(b).toMatchObject({ quantity: 2, status: "covered", purchaseOrderLineId: await po.lineId(), variantId: v.id });
    expect(await orderRow(id)).toMatchObject({ status: "on_hold", statusReason: AWAITING_STOCK_REASON });
    const types = (await eventsOf(id)).map((e) => e.type);
    expect(types).toContain("backorder_created");
    expect(types).toContain("status_changed");
    // the card: PO number, supplier and ETA
    const card = await run((s) => orderBackorders(s, id));
    expect(card[0]!.po).toMatchObject({ id: po.poId, supplierName: po.supplier.name, expectedAt: eta });
    expect(await inView(id, "awaiting")).toBe(true);
    expect(await inView(id, "ready")).toBe(false);
    // the fulfillment hold reaches the store through the outbox
    expect(await processDuePlatformWrites(sys, tenant)).toMatchObject({ succeeded: expect.any(Number) });
    expect(mock.fulfillmentHoldOf(order.externalId)).toMatchObject({ reason: "awaiting_stock" });

    const r = await run((s) => receivePurchaseOrder(s, { poId: po.poId, lines: [{ lineId: b!.purchaseOrderLineId!, quantity: 10 }] }));
    expect(r.releasedOrders).toEqual([id]);
    expect((await backordersOf(id))[0]).toMatchObject({ status: "fulfilled" });
    const released = await orderRow(id);
    expect(released.status).not.toBe("on_hold");
    expect((await eventsOf(id)).some((e) => e.type === "hold_released" && (e.metadata as { reason?: string }).reason === "stock_available")).toBe(true);
    const notes = await run((s) => s.tx.select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, tenantId), eq(schema.notifications.type, "stock_available"), eq(schema.notifications.link, `/orders/${id}`))));
    expect(notes.length).toBeGreaterThan(0);
    expect(r.platformWrites.map((w) => w.kind)).toEqual(["order.fulfillment_release"]);
    expect((await executePlatformWrite(sys, tenant, r.platformWrites[0]!.id)).status).toBe("succeeded");
    expect(mock.fulfillmentHoldOf(order.externalId)).toBeUndefined();
    expect(await inView(id, "awaiting")).toBe(false);
    expect(await inView(id, "ready")).toBe(true);
  });

  it("partial stock: only the missing units wait; a PO confirmed later covers them; cancel wait releases the order", async () => {
    const v = await variantWithStock(1);
    const { id, order } = await placeOrder(v.externalId!, 3);
    const [b] = await backordersOf(id);
    expect(b).toMatchObject({ quantity: 2, status: "pending", purchaseOrderLineId: null });
    const stock = await run((s) => orderLineStock(s, id));
    expect(stock[0]).toMatchObject({ available: 1, incoming: 0, backordered: 2 });
    const po = await incomingPo(v.id, 5, new Date("2026-11-02T12:00:00Z"));
    // a sent PO is not incoming yet: confirming it links the waiting backorder
    expect((await backordersOf(id))[0]!.purchaseOrderLineId).toBeNull();
    await po.confirm();
    expect((await backordersOf(id))[0]).toMatchObject({ status: "covered", purchaseOrderLineId: await po.lineId() });
    expect((await run((s) => orderLineStock(s, id)))[0]!.pos[0]).toMatchObject({ id: po.poId, status: "confirmed", remaining: 5 });

    await processDuePlatformWrites(sys, tenant);
    expect(mock.fulfillmentHoldOf(order.externalId)).toBeDefined();
    const c = await run((s) => cancelBackorderWait(s, id, "ship from the showroom"));
    expect(c.cancelled).toBe(1);
    expect((await backordersOf(id))[0]!.status).toBe("cancelled");
    expect((await orderRow(id)).status).not.toBe("on_hold");
    const closed = (await eventsOf(id)).find((e) => e.type === "backorder_closed")!;
    expect(closed.actorUserId).toBe(owner);
    expect(closed.metadata).toMatchObject({ reason: "wait_cancelled", note: "ship from the showroom" });
    expect(c.write?.kind).toBe("order.fulfillment_release");
    // the same release is keyed by the hold: asking again does not write twice
    expect((await run((s) => cancelBackorderWait(s, id))).cancelled).toBe(0);
    await executePlatformWrite(sys, tenant, c.write!.id);
    expect(mock.fulfillmentHoldOf(order.externalId)).toBeUndefined();
  });

  it("earlier orders the level does not reflect yet are served first; the safety re-check releases what stock now covers", async () => {
    const v = await variantWithStock(2);
    const a = await placeOrder(v.externalId!, 2);
    const b = await placeOrder(v.externalId!, 1);
    expect(await backordersOf(a.id)).toHaveLength(0);
    expect((await backordersOf(b.id))[0]).toMatchObject({ quantity: 1, status: "pending" });
    // nothing changed: the re-check keeps it waiting (the two units are order A's)
    expect((await sys((s) => recheckOpenBackorders(s))).releasedOrders).not.toContain(b.id);
    // the store reports new stock (a sync reads it): the next re-check releases order B
    await run(async (s) => {
      const levels = await s.tx.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, v.id));
      await s.tx.update(schema.inventoryLevels).set({ available: 4, onHand: 4, syncedAt: new Date() }).where(eq(schema.inventoryLevels.id, levels[0]!.id));
    });
    expect((await sys((s) => recheckOpenBackorders(s))).releasedOrders).toContain(b.id);
    expect((await orderRow(b.id)).status).not.toBe("on_hold");
  });

  it("a cancelled order stops waiting", async () => {
    const v = await variantWithStock(0);
    const { id } = await placeOrder(v.externalId!, 1);
    expect((await backordersOf(id))[0]!.status).toBe("pending");
    await run((s) => applyCancellation(s, id, { reason: "customer", restock: true, refund: true }));
    expect((await backordersOf(id))[0]!.status).toBe("cancelled");
    expect(await inView(id, "awaiting")).toBe(false);
  });

  it("an order edit that adds units beyond stock holds the replacement order", async () => {
    const v = await variantWithStock(1);
    const { id } = await placeOrder(v.externalId!, 1);
    expect(await backordersOf(id)).toHaveLength(0);
    const [line] = await run((s) => s.tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, id)));
    const r = await run((s) => replaceOrder(s, mock, { orderId: id, lines: [{ lineId: line!.id, quantity: 3 }] }, { country: "US" }));
    expect(r.backorders).toBe(1);
    const [b] = await backordersOf(r.newOrderId);
    expect(b).toMatchObject({ quantity: 2, status: "pending" });
    expect(await orderRow(r.newOrderId)).toMatchObject({ status: "on_hold", statusReason: AWAITING_STOCK_REASON });
    expect(r.holdWrite?.kind).toBe("order.fulfillment_hold");
  });

  it("the option grid of a product adds up to its inventory levels", async () => {
    const [product] = await run((s) => s.tx.select().from(schema.products).where(eq(schema.products.tenantId, tenantId)).limit(1));
    const settings = parseTenantSettings({});
    const rows = await run((s) => variantStock(s, settings, { productIds: [product!.id] }));
    const variants = await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product!.id)));
    const grid = optionStockGrid(product!.options as { name: string; values: string[] }[], variants.map((v) => { const r = rows.find((x) => x.variantId === v.id)!; return { id: v.id, optionValues: v.optionValues as Record<string, string>, available: r.available, incoming: r.incoming, committed: r.committed }; }));
    const [levels] = await run((s) => s.tx.select({ available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}),0)::int`, committed: sql<number>`coalesce(sum(${schema.inventoryLevels.committed}),0)::int` }).from(schema.inventoryLevels).where(inArray(schema.inventoryLevels.variantId, variants.map((v) => v.id))));
    expect(grid.total.available).toBe(levels!.available);
    expect(grid.total.committed).toBe(levels!.committed);
    expect(grid.total.incoming).toBe(rows.reduce((s, r) => s + r.incoming, 0));
    expect(grid.cells.flat().reduce((s, c) => s + c.available, 0)).toBe(levels!.available);
    expect(grid.cells.flat().reduce((s, c) => s + c.variantIds.length, 0)).toBe(variants.length);
  });

  it("dashboard tile: orders holding stock and low-stock best sellers", async () => {
    const v = await variantWithStock(0);
    await placeOrder(v.externalId!, 2);
    const s = await run((ctx) => backorderSummary(ctx, { lowStockThreshold: 5 }));
    expect(s.holdingOrders).toBeGreaterThan(0);
    expect(s.holdingUnits).toBeGreaterThanOrEqual(s.holdingOrders);
    expect(s.lowStockBestSellers.every((x) => x.available <= 5)).toBe(true);
  });
});

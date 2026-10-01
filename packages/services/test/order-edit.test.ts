import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { MockCommercePlatform, type NormalizedOrder } from "@keel/integrations";
import { parseTenantSettings } from "@keel/core";
import { OrderEditError, applyOrderDiscount, customerOrderHistory, editOrder, editOrderDetails, importOrder, orderLineage, orderMergeCandidates, pnlForPeriod, recomputeOrderStatus, replaceOrder, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let harbor = "";
let northwind = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  harbor = ctx.tenantIds.harbor;
  northwind = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());

const as = (tenant: () => string, email: string) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenant(), (tx) => fn({ tenantId: tenant(), tx, actor: { type: "user", userId: ctx.userIds[email]! } }), pools.app);
const ops = as(() => harbor, "ops@harborhome.demo");
const platform = () => new MockCommercePlatform({ currency: "USD", country: "US", orderNumberPrefix: "HH-", variants: [], locations: [], customers: [], startOrderNumber: 880000 });
const order = (id: string) => ops((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.id, id)).then((r) => r[0]!));

/** Puts n Harbor Home orders of distinct customers back into an open, paid, unfulfilled card state. */
async function openCardOrders(n: number, placedAt = new Date()) {
  const rows = await ops((s) => s.tx.select({ id: schema.orders.id, customerId: schema.orders.customerId }).from(schema.orders).where(and(eq(schema.orders.tenantId, harbor), eq(schema.orders.paymentMethod, "card"))).orderBy(schema.orders.orderNumber).limit(60));
  const picked: string[] = [];
  const customers = new Set<string>();
  for (const r of rows) {
    if (picked.length >= n) break;
    if (!r.customerId || customers.has(r.customerId)) continue;
    customers.add(r.customerId);
    picked.push(r.id);
  }
  await ops(async (s) => {
    await s.tx.update(schema.orders).set({ status: "confirmed", statusSource: "rules", manualStatus: null, cancelledAt: null, cancelReason: null, placedAt, paymentStatus: "paid", financialStatusRaw: "paid", fulfillmentStatusRaw: null, replacedByOrderId: null, replacesOrderId: null, lineageRootOrderId: null, returnedFraction: 0, refundedMinor: 0, holdReason: null }).where(inArray(schema.orders.id, picked));
    await s.tx.delete(schema.shipments).where(inArray(schema.shipments.orderId, picked));
    for (const id of picked) await recomputeOrderStatus(s, id);
  });
  return picked;
}

describe("core order edit: contact and address (no add-on, prepaid card)", () => {
  it("writes the address to the platform first and records the diff with the author", async () => {
    const [id] = await openCardOrders(1);
    const p = platform();
    const r = await ops((s) => editOrderDetails(s, p, { orderId: id!, contact: { phone: "+1 512 555 0100", email: "new.address@example.com", shippingAddress: { name: "Ann Lee", address1: "500 Congress Ave", city: "Austin", province: "TX", zip: "78701", country: "us" }, note: "Leave at the door" } }, { country: "US" }));
    expect(r.changed.sort()).toEqual(["email", "note", "phone", "shippingAddress"]);
    expect(r.writtenToPlatform).toBe(true);
    const write = p.writeLog.find((w) => w.op === "updateOrderDetails")!;
    expect(write.args).toMatchObject({ patch: { email: "new.address@example.com", shippingAddress: { city: "Austin", zip: "78701", country: "US" } } });
    const row = await order(id!);
    expect(row).toMatchObject({ shippingCity: "Austin", shippingZip: "78701", shippingCountry: "US", phoneE164: "+15125550100", emailNormalized: "new.address@example.com", note: "Leave at the door", status: "confirmed", paymentMethod: "card" });
    const [ev] = await ops((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, id!), eq(schema.orderEvents.type, "modified"))));
    expect(ev!.actorUserId).toBe(ctx.userIds["ops@harborhome.demo"]);
    expect(ev!.actorType).toBe("user");
    expect(Object.keys(ev!.diff as object).sort()).toEqual(["email", "note", "phone", "shippingAddress"]);
    expect((ev!.diff as Record<string, { to: { city: string } }>).shippingAddress!.to.city).toBe("Austin");
    expect(ev!.metadata).toMatchObject({ source: "core", platform: "shopify" });
    // nothing changed → no write, no event
    const again = await ops((s) => editOrderDetails(s, p, { orderId: id!, contact: { email: "new.address@example.com" } }, { country: "US" }));
    expect(again.changed).toEqual([]);
    expect(p.writeLog.filter((w) => w.op === "updateOrderDetails")).toHaveLength(1);
  });

  it("rejects a malformed address and edits on fulfilled or cancelled orders, before any platform write", async () => {
    const [id] = await openCardOrders(1);
    const p = platform();
    await expect(ops((s) => editOrderDetails(s, p, { orderId: id!, contact: { shippingAddress: { name: "Ann Lee", address1: "1 Main St", city: "Austin", province: "TX", zip: "787", country: "US" } } }, { country: "US" }))).rejects.toMatchObject({ code: "invalid_address", detail: { issues: [{ field: "zip", code: "invalid_zip" }] } });
    await ops((s) => s.tx.update(schema.orders).set({ fulfillmentStatusRaw: "fulfilled" }).where(eq(schema.orders.id, id!)));
    await expect(ops((s) => editOrderDetails(s, p, { orderId: id!, contact: { note: "x" } }, { country: "US" }))).rejects.toMatchObject({ code: "not_editable", detail: { block: "fulfilled" } });
    await expect(ops((s) => applyOrderDiscount(s, p, { orderId: id!, type: "percentage", value: 1000 }))).rejects.toBeInstanceOf(OrderEditError);
    expect(p.writeLog).toHaveLength(0);
  });

  it("is tenant-isolated: another tenant's user cannot see or edit the order", async () => {
    const [id] = await openCardOrders(1);
    const nw = as(() => northwind, "ops@northwind.demo");
    await expect(nw((s) => editOrderDetails(s, platform(), { orderId: id!, contact: { note: "hijack" } }, { country: "IT" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(nw((s) => applyOrderDiscount(s, platform(), { orderId: id!, type: "fixed_amount", value: 100 }))).rejects.toMatchObject({ code: "not_found" });
    expect((await order(id!)).note).not.toBe("hijack");
  });
});

describe("core order edit: change lines (cancel and recreate)", () => {
  const settings = parseTenantSettings({});
  const tenant = (): AnalyticsTenant => ({ id: harbor, country: "US", currency: "USD", timezone: "America/New_York", settings });

  it("creates a linked paid replacement that inherits day and attribution; KPIs count one order", async () => {
    // isolated window so only this order is in the period
    const placedAt = new Date("2021-05-10T15:00:00Z");
    const period = { from: new Date("2021-05-01T00:00:00Z"), to: new Date("2021-06-01T00:00:00Z") };
    const [id] = await openCardOrders(1, placedAt);
    await ops((s) => s.tx.insert(schema.orderAttribution).values({ tenantId: harbor, orderId: id!, utmSource: "facebook", utmMedium: "paid", utmCampaign: "spring", channel: "paid_social", source: "seed" }).onConflictDoUpdate({ target: [schema.orderAttribution.orderId], set: { utmSource: "facebook", utmCampaign: "spring", channel: "paid_social" } }));
    const before = await ops((s) => pnlForPeriod(s, tenant(), period));
    expect(before.placedOrders).toBe(1);
    const lines = await ops((s) => s.tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, id!)));
    const open = lines.filter((l) => l.currentQuantity > 0);
    const p = platform();
    const r = await ops((s) => editOrder(s, p, { orderId: id!, lines: open.map((l, i) => ({ lineId: l.id, quantity: i === 0 ? l.currentQuantity + 1 : l.currentQuantity })) }, { country: "US" }));
    expect(r.kind).toBe("replaced");
    if (r.kind !== "replaced") return;
    expect(r.warning).toBeNull();
    expect(p.writeLog.map((w) => w.op)).toEqual(["createOrder", "cancelOrder"]);
    expect(p.writeLog[0]!.args).toMatchObject({ payment: { method: "card", status: "paid" } });
    const created = await order(r.newOrderId);
    const old = await order(id!);
    expect(created).toMatchObject({ replacesOrderId: id, lineageRootOrderId: id, paymentMethod: "card", paymentStatus: "paid", status: "confirmed" });
    expect(created.placedAt.toISOString()).toBe(placedAt.toISOString());
    // the mock creates orders without tax: the balance is new total minus what was paid
    expect(r.balanceMinor).toBe(created.totalMinor - (old.totalMinor - old.refundedMinor));
    expect(old).toMatchObject({ replacedByOrderId: r.newOrderId, lineageRootOrderId: id, status: "cancelled", statusReason: "override:replaced", cancelReason: "replaced", paymentStatus: "paid" });
    const [attr] = await ops((s) => s.tx.select().from(schema.orderAttribution).where(eq(schema.orderAttribution.orderId, r.newOrderId)));
    expect(attr).toMatchObject({ utmSource: "facebook", utmCampaign: "spring", channel: "paid_social" });
    const after = await ops((s) => pnlForPeriod(s, tenant(), period));
    expect(after.placedOrders).toBe(1);
    expect(after.cancelledOrders).toBe(0);
    expect(after.orders).toBe(1);
    const events = await ops((s) => s.tx.select().from(schema.orderEvents).where(inArray(schema.orderEvents.orderId, [id!, r.newOrderId])));
    expect(events.find((e) => e.type === "replaces" && e.orderId === r.newOrderId)?.actorUserId).toBe(ctx.userIds["ops@harborhome.demo"]);
    expect(events.find((e) => e.type === "replaced" && e.orderId === id)?.diff).toEqual({ replacedByOrderId: { from: null, to: r.newOrderId } });
    // lineage chain and customer history show one purchase
    const chain = await ops((s) => orderLineage(s, r.newOrderId));
    expect(chain.map((c) => c.id)).toEqual([id, r.newOrderId]);
    const history = await ops((s) => customerOrderHistory(s, r.newOrderId));
    expect(history.orders.map((o) => o.id)).not.toContain(id);
    // a later platform sync keeps the inherited day and attribution
    const platformCopy = (await p.fetchOrder(created.externalId!)) as NormalizedOrder;
    await ops((s) => importOrder(s, { ...platformCopy, platformUpdatedAt: new Date(Date.now() + 1000), landingSite: "https://shop.example/?utm_source=google" }, { country: "US", source: "reconcile" }));
    const resynced = await order(r.newOrderId);
    expect(resynced.placedAt.toISOString()).toBe(placedAt.toISOString());
    const [attr2] = await ops((s) => s.tx.select().from(schema.orderAttribution).where(eq(schema.orderAttribution.orderId, r.newOrderId)));
    expect(attr2!.utmSource).toBe("facebook");
    // the replaced order is final and cannot be edited again
    await expect(ops((s) => editOrderDetails(s, p, { orderId: id!, contact: { note: "x" } }, { country: "US" }))).rejects.toMatchObject({ code: "not_editable", detail: { block: "replaced" } });
  });

  it("merges two open orders of the same customer into one replacement", async () => {
    const [a, b] = await openCardOrders(2);
    const aRow = await order(a!);
    await ops((s) => s.tx.update(schema.orders).set({ customerId: aRow.customerId, emailNormalized: aRow.emailNormalized, currency: aRow.currency }).where(eq(schema.orders.id, b!)));
    const candidates = await ops((s) => orderMergeCandidates(s, a!));
    expect(candidates.map((c) => c.id)).toContain(b);
    const unitsOf = async (id: string) => (await ops((s) => s.tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, id)))).reduce((n, l) => n + l.currentQuantity, 0);
    const expected = (await unitsOf(a!)) + (await unitsOf(b!));
    const p = platform();
    const r = await ops((s) => replaceOrder(s, p, { orderId: a!, mergeOrderIds: [b!] }, { country: "US" }));
    expect(r.merged).toBe(1);
    expect(await unitsOf(r.newOrderId)).toBe(expected);
    expect(p.writeLog.filter((w) => w.op === "cancelOrder")).toHaveLength(2);
    for (const old of [a!, b!]) expect(await order(old)).toMatchObject({ replacedByOrderId: r.newOrderId, status: "cancelled" });
    const chain = await ops((s) => orderLineage(s, r.newOrderId));
    expect(chain.map((c) => c.id).sort()).toEqual([a!, b!, r.newOrderId].sort());
    // a different payment state cannot be merged
    const [c, d] = await openCardOrders(2);
    const cRow = await order(c!);
    await ops((s) => s.tx.update(schema.orders).set({ customerId: cRow.customerId, paymentStatus: "pending", financialStatusRaw: "pending" }).where(eq(schema.orders.id, d!)));
    await expect(ops((s) => replaceOrder(s, platform(), { orderId: c!, mergeOrderIds: [d!] }, { country: "US" }))).rejects.toMatchObject({ code: "merge_invalid", detail: { block: "payment" } });
  });
});

describe("core order edit: discount on an existing order", () => {
  it("applies a percentage through the adapter, updates totals and records the event", async () => {
    const [id] = await openCardOrders(1);
    const before = await order(id!);
    const p = platform();
    const r = await ops((s) => applyOrderDiscount(s, p, { orderId: id!, type: "percentage", value: 1000, reason: "late delivery" }));
    const expected = Math.round(((before.subtotalMinor - before.discountMinor) * 1000) / 10000);
    expect(r).toMatchObject({ code: "KEEL-10%", amountMinor: expected, totalMinor: before.totalMinor - expected, refundDueMinor: expected });
    expect(p.writeLog[0]).toMatchObject({ op: "applyOrderDiscount", args: { externalId: before.externalId, type: "percentage", value: 1000, amountMinor: expected, code: "KEEL-10%" } });
    const after = await order(id!);
    expect(after.discountMinor).toBe(before.discountMinor + expected);
    expect(after.totalMinor).toBe(before.totalMinor - expected);
    const discounts = await ops((s) => s.tx.select().from(schema.orderDiscounts).where(eq(schema.orderDiscounts.orderId, id!)));
    expect(discounts.some((d) => d.code === "KEEL-10%" && d.amountMinor === expected)).toBe(true);
    const [ev] = await ops((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, id!), eq(schema.orderEvents.type, "discount_applied"))));
    expect(ev!.diff).toEqual({ discountMinor: { from: before.discountMinor, to: before.discountMinor + expected }, totalMinor: { from: before.totalMinor, to: before.totalMinor - expected } });
    expect(ev!.actorUserId).toBe(ctx.userIds["ops@harborhome.demo"]);
    // a fixed amount with a custom code
    const fixed = await ops((s) => applyOrderDiscount(s, p, { orderId: id!, type: "fixed_amount", value: 250, code: "SORRY" }));
    expect(fixed).toMatchObject({ code: "SORRY", amountMinor: 250 });
    await expect(ops((s) => applyOrderDiscount(s, p, { orderId: id!, type: "percentage", value: 0 }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

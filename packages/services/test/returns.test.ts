import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings } from "@hullwise/core";
import { createDiscountCode, createDiscountPool, createReturn, DiscountError, discountDetail, listDiscounts, listReturns, orderReturnContext, ReturnError, returnDetail, returnsAnalytics, transitionReturn, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
const settings = parseTenantSettings({ returnWindowDays: 14, returnShippingFallbackDays: 5 });
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["ops@northwind.demo"]! } }), pools.app);

async function deliveredOrderWithoutReturns() {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select o.id from orders o join shipments s on s.order_id = o.id
      where o.tenant_id = ${tenantId} and o.status = 'delivered' and s.delivered_at > now() - interval '10 days' and s.delivered_at < now()
        and not exists (select 1 from return_requests r where r.order_id = o.id)
        and exists (select 1 from order_lines l where l.order_id = o.id and l.variant_id is not null and l.is_ancillary = false)
      order by s.delivered_at desc limit 1`);
    return rows.rows[0]!.id;
  }, pools.app);
}

describe("returns workflow", () => {
  it("opens a return inside the window, walks it to refunded, restocks and updates the order", async () => {
    const orderId = await deliveredOrderWithoutReturns();
    const context = await run((s) => orderReturnContext(s, settings, orderId));
    expect(context.eligibility.eligible).toBe(true);
    const line = context.lines.find((l) => l.returnable > 0 && l.variantId)!;
    expect(line).toBeTruthy();
    const location = await withTenant(tenantId, (tx) => tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1), pools.app);
    const locationId = location[0]!.id;
    const [before] = await withTenant(tenantId, (tx) => tx.select({ available: schema.inventoryLevels.available }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, line.variantId!), eq(schema.inventoryLevels.locationId, locationId))).limit(1), pools.app);

    const reasons = await withTenant(tenantId, (tx) => tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)), pools.app);
    const created = await run((s) => createReturn(s, settings, { orderId, reasonCode: reasons[0]!.code, resolution: "refund", lines: [{ orderLineId: line.id, quantity: 1 }], customerNote: "too small" }));
    expect(created.number).toBeGreaterThan(0);
    await expect(run((s) => createReturn(s, settings, { orderId, reasonCode: reasons[0]!.code, resolution: "refund", lines: [{ orderLineId: line.id, quantity: 99 }] }))).rejects.toMatchObject({ code: "quantity_exceeds" });
    await expect(run((s) => transitionReturn(s, { returnId: created.id, to: "refunded" }))).rejects.toMatchObject({ code: "bad_transition" });

    await run((s) => transitionReturn(s, { returnId: created.id, to: "approved" }));
    const detail1 = await run((s) => returnDetail(s, created.id));
    await run((s) => transitionReturn(s, { returnId: created.id, to: "received", restock: { locationId, lineIds: detail1!.lines.map((l) => l.id) } }));
    const [after] = await withTenant(tenantId, (tx) => tx.select({ available: schema.inventoryLevels.available }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, line.variantId!), eq(schema.inventoryLevels.locationId, locationId))).limit(1), pools.app);
    expect(after!.available).toBe((before?.available ?? 0) + 1);
    const movements = await withTenant(tenantId, (tx) => tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, created.id), eq(schema.inventoryMovements.reason, "return_restock"))), pools.app);
    expect(movements).toHaveLength(1);

    await run((s) => transitionReturn(s, { returnId: created.id, to: "inspected", inspection: detail1!.lines.map((l) => ({ lineId: l.id, outcome: "intact" as const, amountMinor: l.unitAmountMinor * l.quantity })) }));
    await run((s) => transitionReturn(s, { returnId: created.id, to: "refunded" }));
    const detail = await run((s) => returnDetail(s, created.id));
    expect(detail!.request.status).toBe("refunded");
    expect(detail!.request.refundedAmountMinor).toBe(line.unitNetMinor);
    expect(detail!.order.refundedMinor).toBeGreaterThanOrEqual(line.unitNetMinor);
    expect(detail!.order.returnedFraction).toBeGreaterThan(0);
    expect(["returned_partial", "returned"]).toContain(detail!.order.status);
    expect(detail!.events.some((e) => e.type === "return_requested")).toBe(true);
    expect(detail!.events.filter((e) => e.type === "return_updated").length).toBeGreaterThanOrEqual(4);
  });

  it("refuses out-of-window returns unless staff override with a note, and lists/aggregates", async () => {
    const old = await withTenant(tenantId, async (tx) => (await tx.execute<{ id: string }>(sql`select o.id from orders o join shipments s on s.order_id = o.id where o.tenant_id = ${tenantId} and o.status = 'delivered' and s.delivered_at < now() - interval '60 days' and not exists (select 1 from return_requests r where r.order_id = o.id) limit 1`)).rows[0]!.id, pools.app);
    const context = await run((s) => orderReturnContext(s, settings, old));
    expect(context.eligibility).toMatchObject({ eligible: false, reason: "expired" });
    const reasons = await withTenant(tenantId, (tx) => tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)), pools.app);
    // expired lines have nothing returnable now, but staff can still return up to maxQuantity with an override
    const line = context.lines.find((l) => l.maxQuantity > 0)!;
    expect(line.returnable).toBe(0);
    expect(line.block).toBe("expired");
    await expect(run((s) => createReturn(s, settings, { orderId: old, reasonCode: reasons[0]!.code, resolution: "voucher", lines: [{ orderLineId: line.id, quantity: 1 }] }))).rejects.toBeInstanceOf(ReturnError);
    const created = await run((s) => createReturn(s, settings, { orderId: old, reasonCode: reasons[0]!.code, resolution: "voucher", lines: [{ orderLineId: line.id, quantity: 1 }], overrideWindow: true, staffNote: "goodwill" }));
    const list = await run((s) => listReturns(s, { status: "requested" }));
    expect(list.rows.some((r) => r.id === created.id && r.outOfWindow)).toBe(true);
    const analytics = await run((s) => returnsAnalytics(s, { from: new Date(Date.now() - 365 * 864e5), to: new Date() }));
    expect(analytics.total).toBeGreaterThan(0);
    expect(analytics.byReason.length).toBeGreaterThan(0);
    expect(Math.abs(analytics.byReason.reduce((s, r) => s + r.share, 0) - 1)).toBeLessThan(0.001);
    expect(analytics.byProduct.length).toBeGreaterThan(0);
  });
});

describe("discounts", () => {
  it("lists codes with attributed sales and creates single codes and pools through the platform callback", async () => {
    const list = await run((s) => listDiscounts(s, tenant, { hidePoolCodes: true }));
    expect(list.rows.length).toBeGreaterThan(0);
    const used = list.rows.find((r) => r.orders > 0)!;
    expect(used.netRevenueMinor).toBeGreaterThan(0);
    const detail = await run((s) => discountDetail(s, tenant, used.id));
    expect(detail!.orders.length).toBeGreaterThan(0);

    const pushed: unknown[] = [];
    const id = await run((s) => createDiscountCode(s, { code: "e2e-test10", title: "Test 10%", type: "percentage", value: 1000 }, async (i) => (pushed.push(i), { externalId: "ext-1" })));
    expect(pushed).toHaveLength(1);
    expect(id).toBeTruthy();
    await expect(run((s) => createDiscountCode(s, { code: "E2E-TEST10", title: "dup", type: "percentage", value: 1000 }, async () => ({ externalId: "x" })))).rejects.toBeInstanceOf(DiscountError);

    const pool = await run((s) => createDiscountPool(s, { title: "Pool test", prefix: "PT", type: "percentage", value: 1500, size: 120 }, async (i) => ({ externalId: "pool-ext", imported: i.codes.slice(0, 118), failed: i.codes.slice(118) })));
    expect(pool).toMatchObject({ imported: 118, failed: 2 });
    const codes = await withTenant(tenantId, (tx) => tx.select().from(schema.discounts).where(eq(schema.discounts.poolId, pool.poolId)), pools.app);
    expect(codes).toHaveLength(120);
    expect(new Set(codes.map((c) => c.code)).size).toBe(120);
    expect(codes.filter((c) => !c.isActive)).toHaveLength(2);
    for (const c of codes) expect(c.code).toMatch(/^PT-[A-Z2-9]{8}$/);
  });
});

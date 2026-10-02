import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, type TenantSettings } from "@hullwise/core";
import { MockCommercePlatform, MockPaymentGuarantee } from "@hullwise/integrations";
import { captureOverdueGuarantees, createReturn, exchangeOptions, orderReturnContext, saveReturnPolicy, syncReturnToPlatform, transitionReturn, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let settings: TenantSettings;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
  settings = parseTenantSettings({ returnWindowDays: 3650 });
  await withTenant(tenantId, (tx) => saveReturnPolicy({ tenantId, tx, actor: { type: "system", userId: null } }, { creditBonusBps: 1000 }), pools.app);
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@northwind.demo"]! } }), pools.app);
const mock = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 95000 });
const row = (id: string) => run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, id)))[0]!);

/** A delivered order with a line whose product has another in-stock variant, and that variant with its price. */
async function exchangeCandidate(cheaper: boolean) {
  const rows = await run(async (s) => (await s.tx.execute<{ order_id: string; line_id: string }>(sql`
    select o.id as order_id, l.id as line_id from orders o join order_lines l on l.order_id = o.id
    where o.tenant_id = ${tenantId} and o.status = 'delivered' and l.is_ancillary = false and l.quantity = 1 and o.external_id is not null
      and not exists (select 1 from return_requests r where r.order_id = o.id)
      and exists (select 1 from shipments sh where sh.order_id = o.id and sh.delivered_at is not null)
    order by o.placed_at desc limit 40`)).rows);
  for (const r of rows) {
    const opts = (await run((s) => exchangeOptions(s, [r.line_id])))[r.line_id] ?? [];
    const ctxR = await run((s) => orderReturnContext(s, settings, r.order_id));
    const line = ctxR.lines.find((l) => l.id === r.line_id)!;
    if (line.returnable < 1) continue;
    const pick = opts.find((o) => (cheaper ? o.priceMinor < line.unitNetMinor : o.priceMinor > line.unitNetMinor));
    if (pick) return { orderId: r.order_id, lineId: r.line_id, unitNet: line.unitNetMinor, variant: pick };
  }
  return null;
}

describe("exchanges", () => {
  it("customer pays the difference through an invoice; the paid order links back", async () => {
    const c = await exchangeCandidate(false);
    expect(c, "an exchange to a pricier variant exists in the seed").not.toBeNull();
    const r = await run((s) => createReturn(s, settings, { orderId: c!.orderId, reasonCode: "wrong_size", resolution: "exchange", lines: [{ orderLineId: c!.lineId, quantity: 1 }], exchangeLines: [{ orderLineId: c!.lineId, variantId: c!.variant.variantId, quantity: 1 }] }));
    expect((await row(r.id)).exchangeDifferenceMinor).toBe(c!.variant.priceMinor - c!.unitNet);
    for (const to of ["approved", "received", "inspected", "exchanged"] as const) await run((s) => transitionReturn(s, { returnId: r.id, to }));
    const p = mock();
    const res = await run((s) => syncReturnToPlatform(s, p, settings, r.id, { country: "IT" }));
    expect(res.steps).toContain("exchange_invoice");
    const after = await row(r.id);
    expect(after.exchangeInvoiceUrl).toContain("/invoices/");
    expect(p.writeLog.find((w) => w.op === "createInvoiceOrder")?.args).toMatchObject({ discountMinor: c!.unitNet });
  });

  it("refunds the remainder when the new item is cheaper", async () => {
    const c = await exchangeCandidate(true);
    expect(c, "a cheaper in-stock variant exists in the seed").not.toBeNull();
    if (!c) return;
    const r = await run((s) => createReturn(s, settings, { orderId: c.orderId, reasonCode: "wrong_size", resolution: "exchange", lines: [{ orderLineId: c.lineId, quantity: 1 }], exchangeLines: [{ orderLineId: c.lineId, variantId: c.variant.variantId, quantity: 1 }] }));
    for (const to of ["approved", "received", "inspected", "exchanged"] as const) await run((s) => transitionReturn(s, { returnId: r.id, to }));
    const res = await run((s) => syncReturnToPlatform(s, mock(), settings, r.id, { country: "IT" }));
    expect(res.steps).toEqual(expect.arrayContaining(["exchange_order", "difference_refunded"]));
    expect((await row(r.id)).exchangeOrderId).toBeTruthy();
  });

  it("refuses a variant of another product", async () => {
    const c = await exchangeCandidate(false);
    const other = await run(async (s) => (await s.tx.execute<{ id: string }>(sql`select v.id from product_variants v join order_lines l on l.id = ${c!.lineId} where v.tenant_id = ${tenantId} and v.product_id <> l.product_id limit 1`)).rows[0]!);
    await expect(run((s) => createReturn(s, settings, { orderId: c!.orderId, reasonCode: "wrong_size", resolution: "exchange", lines: [{ orderLineId: c!.lineId, quantity: 1 }], exchangeLines: [{ orderLineId: c!.lineId, variantId: other.id, quantity: 1 }] }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("store credit", () => {
  it("adds the bonus to the voucher and creates a one-use code on the store", async () => {
    const c = await exchangeCandidate(false);
    const r = await run((s) => createReturn(s, settings, { orderId: c!.orderId, reasonCode: "changed_mind", resolution: "voucher", lines: [{ orderLineId: c!.lineId, quantity: 1 }] }));
    for (const to of ["approved", "received", "inspected", "voucher_issued"] as const) await run((s) => transitionReturn(s, { returnId: r.id, to }));
    const after = await row(r.id);
    expect(after.creditBonusMinor).toBe(Math.round(after.proposedAmountMinor * 0.1));
    expect(after.refundedAmountMinor).toBe(after.proposedAmountMinor + after.creditBonusMinor);
    const p = mock();
    const res = await run((s) => syncReturnToPlatform(s, p, settings, r.id, { country: "IT" }));
    expect(res.steps).toContain("voucher");
    expect(p.writeLog.find((w) => w.op === "createDiscountCode")?.args).toMatchObject({ code: after.voucherCode, type: "fixed_amount", value: after.refundedAmountMinor, usageLimit: 1 });
  });
});

describe("instant exchange", () => {
  it("holds a guarantee at approval, ships the exchange, releases on receipt or captures when overdue", async () => {
    await run((s) => saveReturnPolicy(s, { instantExchange: { enabled: true, days: 7 } }));
    const g = new MockPaymentGuarantee();
    const c1 = await exchangeCandidate(false);
    const r1 = await run((s) => createReturn(s, settings, { orderId: c1!.orderId, reasonCode: "wrong_size", resolution: "exchange", lines: [{ orderLineId: c1!.lineId, quantity: 1 }], exchangeLines: [{ orderLineId: c1!.lineId, variantId: c1!.variant.variantId, quantity: 1 }] }));
    await run((s) => transitionReturn(s, { returnId: r1.id, to: "approved" }));
    const first = await run((s) => syncReturnToPlatform(s, mock(), settings, r1.id, { guarantee: g, country: "IT" }));
    expect(first.steps).toEqual(expect.arrayContaining(["guarantee_authorized", "exchange_invoice"]));
    await run((s) => transitionReturn(s, { returnId: r1.id, to: "received" }));
    const second = await run((s) => syncReturnToPlatform(s, mock(), settings, r1.id, { guarantee: g, country: "IT" }));
    expect(second.steps).toContain("guarantee_voided");
    expect((await row(r1.id)).guaranteeStatus).toBe("voided");
    // overdue: never received
    const c2 = await exchangeCandidate(false);
    const r2 = await run((s) => createReturn(s, settings, { orderId: c2!.orderId, reasonCode: "wrong_size", resolution: "exchange", lines: [{ orderLineId: c2!.lineId, quantity: 1 }], exchangeLines: [{ orderLineId: c2!.lineId, variantId: c2!.variant.variantId, quantity: 1 }] }));
    await run((s) => transitionReturn(s, { returnId: r2.id, to: "approved" }));
    await run((s) => syncReturnToPlatform(s, mock(), settings, r2.id, { guarantee: g, country: "IT" }));
    const later = new Date(Date.now() + 8 * 864e5);
    const captured = await withTenant(tenantId, (tx) => captureOverdueGuarantees({ tenantId, tx, actor: { type: "system", userId: null }, now: later }, g), pools.app);
    expect(captured).toBeGreaterThanOrEqual(1);
    expect(await row(r2.id)).toMatchObject({ guaranteeStatus: "captured", needsReview: true });
    expect(g.calls.map((c) => c.op)).toEqual(expect.arrayContaining(["authorize", "void", "capture"]));
    await run((s) => saveReturnPolicy(s, { creditBonusBps: 1000 }));
  });
});

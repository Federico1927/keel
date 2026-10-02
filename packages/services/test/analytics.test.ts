import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings } from "@hullwise/core";
import { dashboardSummary, kpisForPeriod, pnlForPeriod, productPerformance, repurchaseCohorts, type AnalyticsTenant } from "../src";
import type { ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({ paymentFeeBps: { card: 180, wallet: 250, bank_transfer: 0, cod: 0, bnpl: 400, other: 0 }, paymentFeeFixedMinor: { card: 25, wallet: 25, bank_transfer: 0, cod: 0, bnpl: 30, other: 0 } }) };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);

describe("P/L for a period", () => {
  it("matches a hand calculation on three inserted orders", async () => {
    // Isolated window far in the past so seed data cannot interfere.
    const from = new Date("2020-03-01T00:00:00Z");
    const to = new Date("2020-04-01T00:00:00Z");
    const place = (n: number) => new Date(`2020-03-${String(n).padStart(2, "0")}T10:00:00Z`);
    await run(async (s) => {
      const base = { tenantId, currency: "EUR", shippingCountry: "IT", paymentGateways: [] as string[], platformTags: [] as string[] };
      const [a] = await s.tx.insert(schema.orders).values({ ...base, orderNumber: 900001, name: "#T-1", status: "delivered", paymentMethod: "card", paymentStatus: "paid", totalMinor: 12200, taxMinor: 2200, subtotalMinor: 10000, placedAt: place(5) }).returning({ id: schema.orders.id });
      const [b] = await s.tx.insert(schema.orders).values({ ...base, orderNumber: 900002, name: "#T-2", status: "cancelled", paymentMethod: "card", paymentStatus: "refunded", totalMinor: 9900, taxMinor: 1785, subtotalMinor: 9900, refundedMinor: 9900, placedAt: place(6), cancelledAt: place(6) }).returning({ id: schema.orders.id });
      const [c] = await s.tx.insert(schema.orders).values({ ...base, orderNumber: 900003, name: "#T-3", status: "returned_partial", paymentMethod: "wallet", paymentStatus: "partially_refunded", totalMinor: 10700, taxMinor: 700, subtotalMinor: 10000, refundedMinor: 2140, returnedFraction: 2000, shippingCountry: "US", placedAt: place(7) }).returning({ id: schema.orders.id });
      await s.tx.insert(schema.orderLines).values([
        { tenantId, orderId: a!.id, title: "A", quantity: 2, currentQuantity: 2, unitPriceMinor: 5000, totalMinor: 10000, unitCostMinor: 2000 },
        { tenantId, orderId: b!.id, title: "B", quantity: 1, currentQuantity: 1, unitPriceMinor: 9900, totalMinor: 9900, unitCostMinor: 3000 },
        { tenantId, orderId: c!.id, title: "C", quantity: 1, currentQuantity: 1, unitPriceMinor: 10000, totalMinor: 10000, unitCostMinor: null },
      ]);
      // US has no tax rate row for this tenant → falls back to the IT rate row (22%, prices include tax) only when taxMinor is 0; here taxMinor is 700 so the stored tax is used.
      await s.tx.insert(schema.costSettings).values([
        { tenantId, kind: "shipping_per_order", amountMinor: 650, validFrom: "2020-03-01", validTo: "2020-03-06" },
        { tenantId, kind: "shipping_per_order", amountMinor: 895, validFrom: "2020-03-07", validTo: "2020-03-31" },
        { tenantId, kind: "fixed_monthly", amountMinor: 3043, validFrom: "2020-01-01", validTo: null },
      ]);
      const [camp] = await s.tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, tenantId)).limit(1);
      await s.tx.insert(schema.adMetricsDaily).values({ tenantId, campaignId: camp!.id, date: "2020-03-10", spendMinor: 3000 });
    });
    const pnl = await run((s) => pnlForPeriod(s, tenant, { from, to }));
    // A: net 100.00, cogs 40.00, ship 6.50, fee 2.45 → 51.05 ; C: net 80.00, cogs 0 (incomplete), ship 8.95, fee 2.93 → 68.12
    expect(pnl.orders).toBe(2);
    expect(pnl.placedOrders).toBe(3);
    expect(pnl.cancelledOrders).toBe(1);
    expect(pnl.netRevenueMinor).toBe(18000);
    expect(pnl.cogsMinor).toBe(4000);
    expect(pnl.cogsIncompleteOrders).toBe(1);
    expect(pnl.shippingCostMinor).toBe(650 + 895);
    expect(pnl.paymentFeeMinor).toBe(245 + 293);
    expect(pnl.contributionMinor).toBe(5105 + 6812);
    expect(pnl.adSpendMinor).toBe(3000);
    // fixed: March is a whole month and has no period cost entry → the legacy monthly amount, 3043
    expect(pnl.fixedCostsMinor).toBe(3043);
    expect(pnl.costSources).toEqual({ fixed: "legacy", shipping: "estimate" });
    expect(pnl.operatingProfitMinor).toBe(5105 + 6812 - 3000 - 3043);
  });
  it("produces KPIs, dashboard, product performance and cohorts on the seed", async () => {
    const now = new Date();
    const kpis = await run((s) => kpisForPeriod(s, tenant, { from: new Date(now.getTime() - 30 * 864e5), to: now }));
    expect(kpis.current.placedOrders).toBeGreaterThan(0);
    const dash = await run((s) => dashboardSummary(s, tenant));
    expect(dash.series30d.length).toBeGreaterThan(0);
    const perf = await run((s) => productPerformance(s, { from: new Date(now.getTime() - 365 * 864e5), to: now }));
    expect(perf.length).toBeGreaterThan(0);
    expect(perf[0]!.grossRevenueMinor).toBeGreaterThanOrEqual(perf[perf.length - 1]!.grossRevenueMinor);
    const cohorts = await run((s) => repurchaseCohorts(s, tenant));
    expect(cohorts.length).toBeGreaterThan(0);
  });
});

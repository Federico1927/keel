import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { GRANULARITIES, UTM_DIMENSIONS, UTM_NONE, monthRange, parseTenantSettings } from "@hullwise/core";
import { adSpendForPeriod, orderEconomicsForPeriod, orderPnlDetail, orderPnlTable, pnlBreakdown, pnlForPeriod, productProfitTable, utmReport, type AnalyticsTenant } from "../src";
import type { ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
const now = new Date();
// the last complete month and the last 365 days of the seed
const lastMonth = monthRange(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7));
const year = { from: new Date(now.getTime() - 365 * 864e5), to: now };

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({ paymentFeeBps: { card: 180, wallet: 250, bank_transfer: 0, cod: 0, bnpl: 400, other: 0 }, paymentFeeFixedMinor: { card: 25, wallet: 25, bank_transfer: 0, cod: 0, bnpl: 30, other: 0 }, returnLabelCostMinor: 590, returnHandlingCostMinor: 210 }) };
  // a carrier invoice for last month: the P/L uses it instead of the per-order estimates
  await withTenant(tenantId, (tx) => tx.insert(schema.periodCosts).values({ tenantId, period: lastMonth.from.toISOString().slice(0, 7), kind: "shipping", label: "", estimateMinor: 0, actualMinor: 123_457 }).onConflictDoUpdate({ target: [schema.periodCosts.tenantId, schema.periodCosts.period, schema.periodCosts.kind, schema.periodCosts.label], set: { actualMinor: 123_457 } }), pools.app);
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);

describe("economics of one order", () => {
  it("matches a hand calculation, return costs included", async () => {
    const placedAt = new Date("2020-05-05T10:00:00Z");
    const id = await run(async (s) => {
      const [o] = await s.tx.insert(schema.orders).values({ tenantId, currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], orderNumber: 910001, name: "#P-1", status: "returned_partial", paymentMethod: "card", paymentStatus: "partially_refunded", totalMinor: 24400, taxMinor: 4400, subtotalMinor: 20000, refundedMinor: 6100, returnedFraction: 2500, placedAt }).returning({ id: schema.orders.id });
      await s.tx.insert(schema.orderLines).values([
        { tenantId, orderId: o!.id, title: "A", quantity: 2, currentQuantity: 2, unitPriceMinor: 6100, totalMinor: 12200, unitCostMinor: 2500 },
        { tenantId, orderId: o!.id, title: "B", quantity: 2, currentQuantity: 2, unitPriceMinor: 6100, totalMinor: 12200, unitCostMinor: 1500 },
      ]);
      await s.tx.insert(schema.returnRequests).values({ tenantId, orderId: o!.id, number: 910001, reasonCode: "size", status: "refunded", receivedAt: new Date("2020-05-20T10:00:00Z"), deductionMinor: 300 });
      return o!.id;
    });
    const d = await run((s) => orderPnlDetail(s, tenant, id));
    // gross 244.00, refunded 61.00, tax share 44/244 → net = 183.00 × 200/244 = 150.00
    // goods 2×25 + 2×15 = 80.00, 25 % returned → 60.00; shipping 6.50 (tenant default)
    // fee 1.80 % of 244.00 = 4.39 + 0.25 = 4.64; margin = 150 − 60 − 6.50 − 4.64 = 78.86
    // return: label 5.90 + handling 2.10 − deduction 3.00 = 5.00 → contribution 73.86
    expect(d!.replaced).toBe(false);
    expect(d!.pnl).toMatchObject({ inScope: true, grossRevenueMinor: 24400, refundedMinor: 6100, taxMinor: 4400, netRevenueMinor: 15000, cogsMinor: 6000, shippingCostMinor: 650, paymentFeeMinor: 464, marginMinor: 7886, returnCostMinor: 500, contributionMinor: 7386 });
    // same numbers as orderEconomics for that order through the period path
    const [eco] = await run((s) => orderEconomicsForPeriod(s, tenant, { from: new Date("2020-05-01T00:00:00Z"), to: new Date("2020-06-01T00:00:00Z") }, { orderIds: [id] }));
    expect(eco!.marginMinor).toBe(d!.pnl!.marginMinor);
  });
});

describe("reconciliations on the seeded data", () => {
  it("the per-order table adds up to the monthly P/L to the cent", async () => {
    const t = await run((s) => orderPnlTable(s, tenant, lastMonth, {}, 1, 50));
    const pnl = await run((s) => pnlForPeriod(s, tenant, lastMonth));
    expect(t.periodTotals.orders).toBe(pnl.orders);
    expect(t.total).toBe(pnl.orders);
    expect(t.rows.length).toBe(Math.min(50, pnl.orders));
    expect(t.periodTotals.grossRevenueMinor).toBe(pnl.grossRevenueMinor);
    expect(t.periodTotals.taxMinor).toBe(pnl.taxMinor);
    expect(t.periodTotals.netRevenueMinor).toBe(pnl.netRevenueMinor);
    expect(t.periodTotals.cogsMinor).toBe(pnl.cogsMinor);
    expect(t.periodTotals.paymentFeeMinor).toBe(pnl.paymentFeeMinor);
    // the carrier invoice replaces the estimates: the difference is a reconciliation line
    expect(pnl.shippingCostMinor).toBe(123_457);
    expect(t.periodTotals.shippingCostMinor + t.reconciliation.shippingAdjustmentMinor).toBe(pnl.shippingCostMinor);
    expect(t.periodTotals.returnCostMinor + t.reconciliation.returnTimingMinor).toBe(pnl.returnCostsMinor);
    expect(t.reconciliation.contributionMinor).toBe(pnl.contributionMinor);
    expect(t.reconciliation.operatingProfitMinor).toBe(pnl.operatingProfitMinor);
    // every row of every page, summed by hand
    const all = await run((s) => orderPnlTable(s, tenant, lastMonth, {}, 1, 0));
    expect(all.rows.reduce((s, r) => s + r.contributionMinor, 0)).toBe(t.periodTotals.contributionMinor);
    expect(all.rows.reduce((s, r) => s + r.netRevenueMinor, 0)).toBe(pnl.netRevenueMinor);
  });
  it("filters and sorts the per-order table", async () => {
    const loss = await run((s) => orderPnlTable(s, tenant, year, { loss: true, sort: "contribution_asc" }, 1, 0));
    expect(loss.rows.every((r) => r.contributionMinor < 0)).toBe(true);
    for (let i = 1; i < loss.rows.length; i++) expect(loss.rows[i]!.contributionMinor).toBeGreaterThanOrEqual(loss.rows[i - 1]!.contributionMinor);
    const missing = await run((s) => orderPnlTable(s, tenant, year, { missingCost: true }, 1, 0));
    expect(missing.total).toBe(missing.pnl.cogsIncompleteOrders);
    const card = await run((s) => orderPnlTable(s, tenant, year, { payment: "card" }, 2, 10));
    expect(card.page).toBe(2);
    expect(card.rows.every((r) => r.paymentMethod === "card")).toBe(true);
  });
  it("P/L buckets add up to the period P/L for every granularity", async () => {
    for (const g of GRANULARITIES) {
      const b = await run((s) => pnlBreakdown(s, tenant, year, g));
      const sum = (k: "netRevenueMinor" | "cogsMinor" | "shippingCostMinor" | "paymentFeeMinor" | "returnCostsMinor" | "adSpendMinor" | "fixedCostsMinor" | "contributionMinor" | "operatingProfitMinor" | "orders") => b.buckets.reduce((s, x) => s + x[k], 0);
      expect(sum("orders")).toBe(b.pnl.orders);
      expect(sum("netRevenueMinor")).toBe(b.pnl.netRevenueMinor);
      expect(sum("cogsMinor")).toBe(b.pnl.cogsMinor);
      expect(sum("shippingCostMinor")).toBe(b.pnl.shippingCostMinor);
      expect(sum("paymentFeeMinor")).toBe(b.pnl.paymentFeeMinor);
      expect(sum("returnCostsMinor")).toBe(b.pnl.returnCostsMinor);
      expect(sum("adSpendMinor")).toBe(b.pnl.adSpendMinor);
      expect(sum("fixedCostsMinor")).toBe(b.pnl.fixedCostsMinor);
      expect(sum("contributionMinor")).toBe(b.pnl.contributionMinor);
      expect(sum("operatingProfitMinor")).toBe(b.pnl.operatingProfitMinor);
      expect(b.buckets[b.buckets.length - 1]!.bucket.partial).toBe(true);
    }
  });
  it("product ad spend plus the unattributed row equals the period ad spend", async () => {
    // unlink one campaign so the unattributed row is not empty
    await run(async (s) => {
      const [l] = await s.tx.select().from(schema.campaignProductLinks).where(eq(schema.campaignProductLinks.tenantId, tenantId)).limit(1);
      if (l) await s.tx.delete(schema.campaignProductLinks).where(eq(schema.campaignProductLinks.campaignId, l.campaignId));
    });
    const t = await run((s) => productProfitTable(s, tenant, year, { pageSize: 0 }));
    const spend = await run((s) => adSpendForPeriod(s, year));
    expect(spend).toBeGreaterThan(0);
    expect(t.adSpendMinor).toBe(spend);
    expect(t.totals.adSpendMinor + t.unattributedMinor).toBe(spend);
    expect(t.rows.reduce((s, r) => s + r.adSpendMinor, 0)).toBe(t.totals.adSpendMinor);
    expect(t.unattributedMinor).toBeGreaterThan(0);
    const withAds = t.rows.filter((r) => r.adSpendMinor > 0);
    expect(withAds.length).toBeGreaterThan(0);
    for (const r of withAds) {
      expect(r.profitMinor).toBe(r.netRevenueMinor - r.cogsMinor - r.adSpendMinor);
      expect(r.light).not.toBe("none");
    }
    expect(t.rows.every((r) => r.action.length > 0)).toBe(true);
    // paging keeps the totals of every row
    const p2 = await run((s) => productProfitTable(s, tenant, year, { page: 2, pageSize: 5, sort: "profit_asc" }));
    expect(p2.rows.length).toBeLessThanOrEqual(5);
    expect(p2.totals).toEqual(t.totals);
  });
  it("UTM drill-down covers every sale order and narrows on a value", async () => {
    const pnl = await run((s) => pnlForPeriod(s, tenant, year));
    const top = await run((s) => utmReport(s, tenant, year, "source", {}, "month"));
    expect(top.orders).toBe(pnl.orders);
    expect(top.groups.reduce((s, g) => s + g.orders, 0)).toBe(pnl.orders);
    expect(top.grossRevenueMinor).toBe(pnl.grossRevenueMinor);
    expect(top.groups.some((g) => g.value === UTM_NONE)).toBe(true);
    const first = top.groups.find((g) => g.value !== UTM_NONE)!;
    const sub = await run((s) => utmReport(s, tenant, year, "medium", { source: first.value }, "month"));
    expect(sub.orders).toBe(first.orders);
    expect(sub.groups.reduce((s, g) => s + g.grossRevenueMinor, 0)).toBe(first.grossRevenueMinor);
    // channel trend: every sale order lands in one bucket and one channel
    const trendOrders = top.trend.points.reduce((s, p) => s + Object.values(p.values).reduce((a, v) => a + v.orders, 0), 0);
    expect(trendOrders).toBe(pnl.orders);
    expect(UTM_DIMENSIONS).toHaveLength(5);
  });
});

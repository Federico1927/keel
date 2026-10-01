import { describe, expect, it } from "vitest";
import { resolveFixedCosts, resolveShippingCosts } from "./costs";
import { orderEconomics, sumEconomics } from "./finance";
import { allocateMinor, bucketIndex, bucketPnl, defaultGranularity, isoWeek, orderPnl, periodBuckets, reconcileOrderPnl, sumOrderPnl, unitOf } from "./pnl-periods";

const d = (s: string) => new Date(s);

describe("periodBuckets", () => {
  it("cuts a period into months with partial first and last months", () => {
    const b = periodBuckets({ from: d("2026-01-15T00:00:00Z"), to: d("2026-04-10T00:00:00Z") }, "month");
    expect(b.map((x) => x.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(b.map((x) => x.partial)).toEqual([true, false, false, true]);
    expect(b[0]!.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(b[0]!.from.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(b[3]!.to.toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });
  it("weeks start on Monday and use ISO week numbers", () => {
    // 2026-01-01 is a Thursday: ISO week 1 of 2026 starts Monday 2025-12-29
    const b = periodBuckets({ from: d("2026-01-01T00:00:00Z"), to: d("2026-01-13T00:00:00Z") }, "week");
    expect(b.map((x) => x.key)).toEqual(["2026-W01", "2026-W02", "2026-W03"]);
    expect(b[0]!.start.toISOString().slice(0, 10)).toBe("2025-12-29");
    expect(b.map((x) => x.partial)).toEqual([true, false, true]);
    expect(isoWeek(d("2024-12-30T00:00:00Z"))).toEqual({ year: 2025, week: 1 });
    expect(isoWeek(d("2021-01-03T00:00:00Z"))).toEqual({ year: 2020, week: 53 });
  });
  it("quarters, years and days", () => {
    expect(periodBuckets({ from: d("2025-02-01T00:00:00Z"), to: d("2026-01-01T00:00:00Z") }, "quarter").map((x) => `${x.key}${x.partial ? "*" : ""}`)).toEqual(["2025-Q1*", "2025-Q2", "2025-Q3", "2025-Q4"]);
    expect(periodBuckets({ from: d("2025-01-01T00:00:00Z"), to: d("2026-03-01T00:00:00Z") }, "year").map((x) => `${x.key}${x.partial ? "*" : ""}`)).toEqual(["2025", "2026*"]);
    const days = periodBuckets({ from: d("2026-09-01T13:00:00Z"), to: d("2026-09-04T00:00:00Z") }, "day");
    expect(days.map((x) => `${x.key}${x.partial ? "*" : ""}`)).toEqual(["2026-09-01*", "2026-09-02", "2026-09-03"]);
  });
  it("buckets partition the period without gaps and cap their number", () => {
    const p = { from: d("2025-10-01T09:30:00Z"), to: d("2026-10-01T10:00:00Z") };
    for (const g of ["day", "week", "month", "quarter", "year"] as const) {
      const b = periodBuckets(p, g);
      expect(b[0]!.from).toEqual(p.from);
      expect(b[b.length - 1]!.to).toEqual(p.to);
      for (let i = 1; i < b.length; i++) expect(b[i]!.from).toEqual(b[i - 1]!.to);
    }
    expect(periodBuckets(p, "day", 10)).toHaveLength(10);
    expect(unitOf(d("2026-09-20T23:00:00Z"), "week").start.toISOString().slice(0, 10)).toBe("2026-09-14");
  });
  it("finds the bucket of a date and picks a sensible default", () => {
    const b = periodBuckets({ from: d("2026-01-01T00:00:00Z"), to: d("2026-04-01T00:00:00Z") }, "month");
    expect(bucketIndex(b, d("2026-02-28T23:59:59Z"))).toBe(1);
    expect(bucketIndex(b, d("2026-03-01T00:00:00Z"))).toBe(2);
    expect(bucketIndex(b, d("2026-04-01T00:00:00Z"))).toBe(-1);
    expect(defaultGranularity({ from: d("2026-01-01"), to: d("2026-01-31") })).toBe("day");
    expect(defaultGranularity({ from: d("2026-01-01"), to: d("2026-03-31") })).toBe("week");
    expect(defaultGranularity({ from: d("2025-01-01"), to: d("2026-01-01") })).toBe("month");
    expect(defaultGranularity({ from: d("2022-01-01"), to: d("2026-01-01") })).toBe("quarter");
  });
});

describe("allocateMinor", () => {
  it("splits exactly by weight with the largest remainder", () => {
    expect(allocateMinor(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateMinor(1001, [2, 1, 0])).toEqual([667, 334, 0]);
    expect(allocateMinor(-100, [1, 3])).toEqual([-25, -75]);
    expect(allocateMinor(10, [0, 0])).toEqual([5, 5]);
    expect(allocateMinor(7, [])).toEqual([]);
  });
  it("always adds up to the total", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k++) {
      const total = Math.round((rnd() - 0.3) * 1e9);
      const w = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => (rnd() < 0.2 ? 0 : rnd() * 3e10));
      expect(allocateMinor(total, w).reduce((s, x) => s + x, 0)).toBe(total);
    }
  });
});

const eco = (status: string, total: number, ship: number, cost: number | null = 1000) => orderEconomics({ status, totalMinor: total, taxMinor: Math.round(total * 0.18), refundedMinor: 0, taxRateBps: 2200, pricesIncludeTax: true, lines: [{ quantity: 1, unitPriceMinor: total, unitCostMinor: cost }], paymentMethod: "card", paymentFeeBps: 150, paymentFeeFixedMinor: 25, shippingCostMinor: ship });

describe("bucketPnl", () => {
  const period = { from: d("2026-01-20T08:00:00Z"), to: d("2026-03-10T00:00:00Z") };
  const orders = [
    { ...eco("delivered", 12200, 650), placedAt: d("2026-01-21T10:00:00Z") },
    { ...eco("shipped", 9900, 650, null), placedAt: d("2026-01-31T23:59:00Z") },
    { ...eco("cancelled", 5000, 650), placedAt: d("2026-02-01T00:10:00Z") },
    { ...eco("confirmed", 30100, 700), placedAt: d("2026-02-14T12:00:00Z") },
    { ...eco("returned_partial", 8800, 700), placedAt: d("2026-03-02T09:00:00Z") },
  ];
  const entries = [
    { period: "2026-02", kind: "shipping" as const, label: "", estimateMinor: 0, actualMinor: 1999 },
    { period: "2026-01", kind: "fixed" as const, label: "rent", estimateMinor: 100000, actualMinor: 99999 },
    { period: "2026-03", kind: "fixed" as const, label: "rent", estimateMinor: 100000, actualMinor: null },
  ];
  const shipEst: Record<string, number> = {};
  for (const o of orders) if (o.inScope) shipEst[`${o.placedAt.getUTCFullYear()}-${String(o.placedAt.getUTCMonth() + 1).padStart(2, "0")}`] = (shipEst[`${o.placedAt.getUTCFullYear()}-${String(o.placedAt.getUTCMonth() + 1).padStart(2, "0")}`] ?? 0) + o.shippingCostMinor;
  const shipping = resolveShippingCosts(shipEst, entries, period.from, period.to);
  const fixed = resolveFixedCosts(entries, period.from, period.to, () => 5000);
  const ads = [{ date: "2026-01-20", spendMinor: 1234 }, { date: "2026-01-31", spendMinor: 1000 }, { date: "2026-02-28", spendMinor: 777 }, { date: "2026-03-09", spendMinor: 1 }];
  const returns = [{ at: d("2026-02-03T00:00:00Z"), costMinor: 600 }, { at: d("2026-03-05T00:00:00Z"), costMinor: 450 }];
  const input = { period, orders, adSpendByDay: ads, returns, returnCostsMinor: 1050, shippingByMonth: shipping.byMonth, fixedByMonth: fixed.byMonth };
  const total = sumEconomics(orders, ads.reduce((s, a) => s + a.spendMinor, 0), fixed.totalMinor, 1050);
  const periodContribution = total.grossMarginMinor - shipping.totalMinor - total.paymentFeeMinor - 1050;
  const periodOperating = periodContribution - total.adSpendMinor - fixed.totalMinor;

  for (const g of ["day", "week", "month", "quarter", "year"] as const) {
    it(`${g} buckets add up to the period P/L to the cent`, () => {
      const rows = bucketPnl(periodBuckets(period, g), input);
      const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + (r[k] as number), 0);
      expect(sum("orders")).toBe(total.orders);
      expect(sum("netRevenueMinor")).toBe(total.netRevenueMinor);
      expect(sum("cogsMinor")).toBe(total.cogsMinor);
      expect(sum("paymentFeeMinor")).toBe(total.paymentFeeMinor);
      expect(sum("shippingCostMinor")).toBe(shipping.totalMinor);
      expect(sum("returnCostsMinor")).toBe(1050);
      expect(sum("adSpendMinor")).toBe(total.adSpendMinor);
      expect(sum("fixedCostsMinor")).toBe(fixed.totalMinor);
      expect(sum("contributionMinor")).toBe(periodContribution);
      expect(sum("operatingProfitMinor")).toBe(periodOperating);
    });
  }
  it("puts each amount in the right month", () => {
    const rows = bucketPnl(periodBuckets(period, "month"), input);
    expect(rows.map((r) => r.orders)).toEqual([2, 1, 1]);
    expect(rows.map((r) => r.adSpendMinor)).toEqual([2234, 777, 1]);
    // February shipping comes from the carrier invoice; January and March from the per-order estimates
    expect(rows.map((r) => r.shippingCostMinor)).toEqual([1300, 1999, 700]);
    expect(rows.map((r) => r.returnCostsMinor)).toEqual([0, 600, 450]);
    expect(rows[0]!.cogsIncompleteOrders).toBe(1);
    expect(rows.map((r) => r.bucket.partial)).toEqual([true, false, true]);
  });
  it("ad spend of the first, partial day lands in the first bucket", () => {
    const rows = bucketPnl(periodBuckets(period, "day"), input);
    expect(rows[0]!.bucket.key).toBe("2026-01-20");
    expect(rows[0]!.adSpendMinor).toBe(1234);
  });
});

describe("per-order P/L", () => {
  it("contribution is the order margin minus its return costs, and reconciles to the period", () => {
    const a = orderPnl(eco("delivered", 12200, 650), 900);
    const b = orderPnl(eco("returned_partial", 8800, 700), 0);
    const c = orderPnl(eco("cancelled", 5000, 650), 300);
    expect(a.contributionMinor).toBe(a.marginMinor - 900);
    expect(c.returnCostMinor).toBe(0);
    const t = sumOrderPnl([a, b, c]);
    expect(t.orders).toBe(2);
    expect(t.contributionMinor).toBe(a.contributionMinor + b.contributionMinor);
    const pnl = { shippingCostMinor: 2000, returnCostsMinor: 1200, adSpendMinor: 500, fixedCostsMinor: 100 };
    const r = reconcileOrderPnl(t, pnl);
    expect(r.shippingAdjustmentMinor).toBe(2000 - 1350);
    expect(r.returnTimingMinor).toBe(300);
    // the period contribution, computed the P/L way
    expect(r.contributionMinor).toBe(t.netRevenueMinor - t.cogsMinor - 2000 - t.paymentFeeMinor - 1200);
    expect(r.operatingProfitMinor).toBe(r.contributionMinor - 600);
  });
});

import { describe, expect, it } from "vitest";
import { allocateAdSpend, productProfit, productSales, productStockAction, type ProductStockActionInput } from "./product-profit";
import { keyTrend, nextUtmDimension, utmGroups, UTM_NONE } from "./utm-report";
import { periodBuckets } from "./pnl-periods";

describe("productSales", () => {
  it("aggregates units, orders, net revenue and cost of goods kept", () => {
    const m = productSales([
      { orderId: "o1", productId: "p1", quantity: 2, lineGrossMinor: 12200, unitCostMinor: 2000, netRatio: 10000 / 12200, keep: 1 },
      { orderId: "o2", productId: "p1", quantity: 1, lineGrossMinor: 6100, unitCostMinor: 2000, netRatio: 0.5, keep: 0.5 },
      { orderId: "o2", productId: "p2", quantity: 1, lineGrossMinor: 5000, unitCostMinor: null, netRatio: 0.8, keep: 1 },
    ]);
    expect(m.get("p1")).toEqual({ productId: "p1", units: 3, orders: 2, grossRevenueMinor: 18300, netRevenueMinor: 10000 + 3050, cogsMinor: 4000 + 1000, unitsWithoutCost: 0 });
    expect(m.get("p2")).toMatchObject({ units: 1, netRevenueMinor: 4000, cogsMinor: 0, unitsWithoutCost: 1 });
  });
});

describe("allocateAdSpend", () => {
  it("splits linked spend by revenue and keeps unlinked spend apart, adding up to the total", () => {
    const weights: Record<string, number> = { a: 300, b: 100, c: 0 };
    const r = allocateAdSpend(
      [
        { campaignId: "c1", spendMinor: 1001, productIds: ["a", "b"] },
        { campaignId: "c2", spendMinor: 500, productIds: [] },
        { campaignId: "c3", spendMinor: 99, productIds: ["c"] },
        { campaignId: "c4", spendMinor: 0, productIds: ["a"] },
        { campaignId: "c5", spendMinor: 10, productIds: ["b", "c"] },
      ],
      (p) => weights[p] ?? 0,
    );
    expect(r.byProduct.get("a")).toBe(751);
    expect(r.byProduct.get("b")).toBe(250 + 10);
    expect(r.byProduct.get("c")).toBe(99);
    expect(r.unattributedMinor).toBe(500);
    expect(r.unlinkedCampaigns).toBe(1);
    expect([...r.byProduct.values()].reduce((s, x) => s + x, 0) + r.unattributedMinor).toBe(1001 + 500 + 99 + 10);
  });
});

describe("productProfit", () => {
  it("profit, ROAS, ROI and a light only with ad spend", () => {
    expect(productProfit({ netRevenueMinor: 10000, cogsMinor: 4000, adSpendMinor: 2000 }, { roiGood: 1, roiMedium: 0 })).toEqual({ grossMarginMinor: 6000, profitMinor: 4000, roas: 5, roi: 2, light: "good" });
    expect(productProfit({ netRevenueMinor: 10000, cogsMinor: 4000, adSpendMinor: 7000 }, { roiGood: 1, roiMedium: 0 }).light).toBe("bad");
    expect(productProfit({ netRevenueMinor: 10000, cogsMinor: 4000, adSpendMinor: 0 }, { roiGood: 1, roiMedium: 0 })).toMatchObject({ roas: null, roi: null, light: "none", profitMinor: 6000 });
  });
});

describe("productStockAction", () => {
  const base: ProductStockActionInput = { available: 100, incoming: 0, coverDays: 40, risk: "ok", suggestedReorder: 0, repurchasable: true, adSpendMinor: 0, light: "none", excessCoverDays: 120 };
  it("pauses ads when nothing is left to sell", () => {
    expect(productStockAction({ ...base, available: 0, coverDays: 0, risk: "critical", adSpendMinor: 500, suggestedReorder: 30 })).toEqual({ action: "pause_ads", reorderUnits: 30 });
  });
  it("reorders a running-out product that can be bought again", () => {
    expect(productStockAction({ ...base, available: 5, coverDays: 3, risk: "critical", suggestedReorder: 40 })).toEqual({ action: "reorder", reorderUnits: 40 });
  });
  it("last units of a one-off product: pause ads if they still run", () => {
    expect(productStockAction({ ...base, available: 5, coverDays: 3, risk: "critical", repurchasable: false, adSpendMinor: 100 }).action).toBe("pause_ads");
    expect(productStockAction({ ...base, available: 5, coverDays: 10, risk: "warning", repurchasable: false }).action).toBe("last_units");
  });
  it("clears excess cover or dead stock, scales profitable healthy products", () => {
    expect(productStockAction({ ...base, coverDays: 400 }).action).toBe("clear_excess");
    expect(productStockAction({ ...base, coverDays: null, risk: "no_sales" }).action).toBe("clear_excess");
    expect(productStockAction({ ...base, light: "good", adSpendMinor: 100 }).action).toBe("scale_ads");
    expect(productStockAction(base).action).toBe("ok");
  });
});

describe("UTM drill-down", () => {
  const o = (source: string | null, medium: string | null, campaign: string | null, gross: number) => ({ utm: { source, medium, campaign, content: null, term: null }, grossRevenueMinor: gross, netRevenueMinor: Math.round(gross * 0.8) });
  const orders = [o("Facebook", "paid", "spring", 1000), o("facebook", "paid", "summer", 3000), o("google", "cpc", "brand", 2000), o(null, null, null, 500), o("", null, null, 500)];
  it("groups case-insensitively with a (none) bucket", () => {
    const r = utmGroups(orders, "source");
    expect(r.groups.map((g) => [g.value, g.orders, g.grossRevenueMinor])).toEqual([["facebook", 2, 4000], ["google", 1, 2000], [UTM_NONE, 2, 1000]]);
    expect(r.orders).toBe(5);
    expect(r.groups[0]!.aovMinor).toBe(2000);
    expect(r.groups[0]!.revenueShare).toBeCloseTo(4000 / 7000);
  });
  it("drills down with the parent value fixed", () => {
    const r = utmGroups(orders, "campaign", { source: "FACEBOOK", medium: "paid" });
    expect(r.groups.map((g) => g.value)).toEqual(["summer", "spring"]);
    expect(utmGroups(orders, "medium", { source: UTM_NONE }).groups).toEqual([expect.objectContaining({ value: UTM_NONE, orders: 2 })]);
    expect(nextUtmDimension("source")).toBe("medium");
    expect(nextUtmDimension("term")).toBeNull();
  });
  it("channel trend folds small channels into other", () => {
    const buckets = periodBuckets({ from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-03-01T00:00:00Z") }, "month");
    const items = [
      { at: new Date("2026-01-05T00:00:00Z"), key: "a", netRevenueMinor: 500 },
      { at: new Date("2026-02-05T00:00:00Z"), key: "b", netRevenueMinor: 300 },
      { at: new Date("2026-02-06T00:00:00Z"), key: "c", netRevenueMinor: 100 },
      { at: new Date("2026-02-07T00:00:00Z"), key: "d", netRevenueMinor: 50 },
    ];
    const t = keyTrend(buckets, items, 3);
    expect(t.keys).toEqual(["a", "b", "other"]);
    expect(t.points[1]!.values.other).toEqual({ orders: 2, netRevenueMinor: 150 });
    expect(t.points[0]!.values.a).toEqual({ orders: 1, netRevenueMinor: 500 });
  });
});

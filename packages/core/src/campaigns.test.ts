import { describe, expect, it } from "vitest";
import { campaignMetrics, recommendAction, suggestProductsForCampaign, trafficLight } from "./campaigns";

const th = { roiGood: 0.8, roiMedium: 0.2 };

describe("campaign metrics and traffic light", () => {
  it("computes profit, ROAS, ROI, CPA from margin and spend", () => {
    const m = campaignMetrics({ spendMinor: 10000, clicks: 500, impressions: 40000, attributedOrders: 10, netRevenueMinor: 60000, marginMinor: 25000 });
    expect(m.profitMinor).toBe(15000);
    expect(m.roas).toBe(6);
    expect(m.roi).toBe(1.5);
    expect(m.cpaMinor).toBe(1000);
    expect(m.cpcMinor).toBe(20);
    expect(trafficLight(m, th)).toBe("good");
  });
  it("classifies medium, bad and no-spend", () => {
    expect(trafficLight({ spendMinor: 100, roi: 0.5, profitMinor: 50 }, th)).toBe("medium");
    expect(trafficLight({ spendMinor: 100, roi: -0.3, profitMinor: -30 }, th)).toBe("bad");
    expect(trafficLight({ spendMinor: 0, roi: null, profitMinor: 10 }, th)).toBe("medium");
    expect(trafficLight({ spendMinor: 0, roi: null, profitMinor: 0 }, th)).toBe("none");
  });
});

describe("recommendAction", () => {
  const base = { repurchasable: true, stock: 100, incoming: 0, stockThreshold: 30 };
  it("follows performance when stock is fine", () => {
    expect(recommendAction({ ...base, status: "active", light: "bad" }).action).toBe("pause");
    expect(recommendAction({ ...base, status: "paused", light: "good" }).action).toBe("resume");
    expect(recommendAction({ ...base, status: "active", light: "medium" }).action).toBe("consider_pause");
    expect(recommendAction({ ...base, status: "paused", light: "medium" }).action).toBe("consider_resume");
    expect(recommendAction({ ...base, status: "active", light: "good" }).action).toBe("ok");
  });
  it("stock below threshold beats performance for an active campaign", () => {
    expect(recommendAction({ ...base, status: "active", light: "good", stock: 0 })).toMatchObject({ action: "pause_stock", reason: "stock_below_threshold" });
    expect(recommendAction({ ...base, status: "active", light: "good", stock: 10, repurchasable: false })).toMatchObject({ action: "pause_stock" });
    expect(recommendAction({ ...base, status: "active", light: "good", stock: 10 })).toMatchObject({ action: "consider_stock", restock: "reorder" });
    expect(recommendAction({ ...base, status: "active", light: "good", stock: 10, incoming: 50 })).toMatchObject({ action: "consider_stock", reason: "stock_below_threshold_incoming" });
  });
  it("suggests a reorder only for performing campaigns with repurchasable products", () => {
    expect(recommendAction({ ...base, status: "paused", light: "bad", stock: 5 }).restock).toBe("ok");
    expect(recommendAction({ ...base, status: "paused", light: "good", stock: 5 }).restock).toBe("reorder");
    expect(recommendAction({ ...base, status: "active", light: "good", stock: null }).restock).toBe("unknown");
  });
});

describe("suggestProductsForCampaign", () => {
  const products = [
    { id: "p1", title: "Linen Shirt", handle: "linen-shirt" },
    { id: "p2", title: "Oxford Shirt", handle: "oxford-shirt" },
    { id: "p3", title: "Wool Coat", handle: "wool-coat" },
  ];
  it("prefers URL handles, then exact, prefix, contains", () => {
    expect(suggestProductsForCampaign("Spring Linen Shirt – Conversions", ["https://shop.example/products/wool-coat?utm=1"], products).map((s) => [s.productId, s.kind])).toEqual([["p3", "url"], ["p1", "contains"]]);
    expect(suggestProductsForCampaign("Oxford Shirt", [], products)[0]).toMatchObject({ productId: "p2", kind: "exact" });
    expect(suggestProductsForCampaign("Wool Coat Retargeting", [], products)[0]).toMatchObject({ productId: "p3", kind: "prefix" });
  });
  it("returns nothing for catalog campaigns", () => {
    expect(suggestProductsForCampaign("Always-on Brand – Sales", [], products)).toEqual([]);
  });
});

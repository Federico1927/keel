import { describe, expect, it } from "vitest";
import { WIDGETS, canWritePage } from "@hullwise/config";
import { DATA_HEALTH_CHECKS, DATA_HEALTH_DEFINITIONS, DATA_HEALTH_PAGES, dataHealthForRole, dataHealthHref, evaluateDataHealth, lastClosedMonth, ordersOnDefaultShipping, summarizeDataHealth, type DataHealthInput } from "./data-health";

const all: DataHealthInput[] = [
  { id: "commerce_connection", count: 0, sample: 1 },
  { id: "product_costs", count: 15, sample: 1348, affectedOrders: 137, totalOrders: 3855, affectedRevenueMinor: 40_000, totalRevenueMinor: 10_000_000 },
  { id: "tax_rates", count: 1, sample: 2, affectedOrders: 119, totalOrders: 2203, params: { countries: ["CA"], homeCountryMissing: 0 } },
  { id: "campaign_links", count: 11, sample: 36, affectedRevenueMinor: 2_129_767, totalRevenueMinor: 9_324_989 },
  { id: "payment_fees", count: 2, sample: 5, affectedOrders: 462, params: { methods: ["bank_transfer", "card"] } },
  { id: "suppliers", count: 0, sample: 4, applicable: false },
  { id: "state_rules", count: 0, sample: 300 },
];

describe("data health evaluation", () => {
  it("turns counts into gaps, passes and skips, most serious first", () => {
    const r = evaluateDataHealth(all);
    expect(r.items.map((i) => [i.id, i.severity])).toEqual([
      ["product_costs", "warning"],
      ["tax_rates", "warning"],
      ["campaign_links", "warning"],
      ["payment_fees", "info"],
    ]);
    expect(r.passed).toEqual(["commerce_connection", "state_rules"]);
    expect(r.skipped).toEqual(["suppliers"]);
    expect(r.items.find((i) => i.id === "product_costs")!.share).toBeCloseTo(0.004);
    // the campaign gap's share is spend over spend: 22.8 % of the window's spend has no product
    expect(r.items[2]!.share).toBeCloseTo(0.2284, 3);
  });
  it("severity follows how much the gap touches", () => {
    const sev = (i: DataHealthInput) => evaluateDataHealth([i]).items[0]!.severity;
    expect(sev({ id: "product_costs", count: 3, sample: 100, affectedRevenueMinor: 600, totalRevenueMinor: 10_000 })).toBe("critical");
    expect(sev({ id: "product_costs", count: 3, sample: 100, affectedRevenueMinor: 400, totalRevenueMinor: 10_000 })).toBe("warning");
    expect(sev({ id: "tax_rates", count: 1, sample: 1, params: { countries: ["IT"], homeCountryMissing: 1 } })).toBe("critical");
    expect(sev({ id: "shipping_costs", count: 900, sample: 1000, affectedOrders: 900, totalOrders: 1000 })).toBe("critical");
    expect(sev({ id: "shipping_costs", count: 90, sample: 1000, affectedOrders: 90, totalOrders: 1000 })).toBe("warning");
    expect(sev({ id: "campaign_links", count: 1, sample: 10, affectedRevenueMinor: 100, totalRevenueMinor: 10_000 })).toBe("info");
    expect(sev({ id: "state_rules", count: 40, sample: 100, affectedOrders: 40, totalOrders: 100 })).toBe("warning");
    expect(sev({ id: "state_rules", count: 4, sample: 100, affectedOrders: 4, totalOrders: 100 })).toBe("info");
    expect(sev({ id: "commerce_connection", count: 1, sample: 1 })).toBe("critical");
  });
  it("scores 100 when nothing is missing and takes points off per gap", () => {
    expect(evaluateDataHealth([{ id: "product_costs", count: 0, sample: 10 }]).summary).toEqual({ score: 100, status: "all_set", critical: 0, warning: 0, info: 0 });
    expect(summarizeDataHealth([{ severity: "info" }])).toMatchObject({ score: 97, status: "good" });
    expect(summarizeDataHealth([{ severity: "critical" }, { severity: "warning" }, { severity: "info" }])).toEqual({ score: 57, status: "critical", critical: 1, warning: 1, info: 1 });
    expect(summarizeDataHealth(Array.from({ length: 5 }, () => ({ severity: "critical" as const }))).score).toBe(0);
  });
  it("links every gap to its fix with the check's filter and any extra query", () => {
    const r = evaluateDataHealth([{ id: "product_costs", count: 1, sample: 1 }, { id: "campaign_links", count: 1, sample: 1, query: { preset: "30d" } }, { id: "state_rules", count: 1, sample: 9 }]);
    expect(r.items.map(dataHealthHref)).toEqual(["products/quality?issue=missing_cost", "campaigns?links=none&preset=30d", "settings/order-states"]);
  });
});

describe("data health per role", () => {
  const report = evaluateDataHealth(all);
  it("owners see every gap; other roles only the ones they can fix", () => {
    expect(dataHealthForRole(report, (p) => canWritePage("owner", p)).items).toHaveLength(4);
    const ops = dataHealthForRole(report, (p) => canWritePage("operations", p));
    expect(ops.items.map((i) => i.id)).toEqual(["product_costs"]);
    expect(ops.summary).toMatchObject({ warning: 1, critical: 0, info: 0 });
    expect(dataHealthForRole(report, (p) => canWritePage("marketing", p)).items.map((i) => i.id)).toEqual(["campaign_links"]);
    expect(dataHealthForRole(report, (p) => canWritePage("viewer", p)).items).toHaveLength(0);
  });
  it("every fix page is one the widget's visibility rule knows", () => {
    expect([...DATA_HEALTH_PAGES].sort()).toEqual([...(WIDGETS.setup_health.actPages ?? [])].sort());
    expect(Object.keys(DATA_HEALTH_DEFINITIONS).sort()).toEqual([...DATA_HEALTH_CHECKS].sort());
  });
});

describe("cost helpers", () => {
  it("the last closed month is the calendar month before now", () => {
    expect(lastClosedMonth(new Date("2026-10-03T08:00:00Z"))).toBe("2026-09");
    expect(lastClosedMonth(new Date("2026-01-15T08:00:00Z"))).toBe("2025-12");
  });
  it("counts orders whose shipping cost is the generic default", () => {
    const days = [{ day: "2026-08-31", orders: 5 }, { day: "2026-09-01", orders: 7 }, { day: "2026-09-02", orders: 3 }, { day: "2026-10-01", orders: 4 }];
    const settings = [{ validFrom: "2026-08-01", validTo: "2026-08-31" }];
    // September has neither a per-order setting nor a carrier invoice; October has the invoice
    expect(ordersOnDefaultShipping(days, settings, new Set(["2026-10"]), false)).toBe(10);
    expect(ordersOnDefaultShipping(days, [{ validFrom: "2026-01-01", validTo: null }], new Set(), false)).toBe(0);
    // a shop that set its own default is never on Hullwise's
    expect(ordersOnDefaultShipping(days, [], new Set(), true)).toBe(0);
  });
});

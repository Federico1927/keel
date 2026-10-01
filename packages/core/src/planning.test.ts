import { describe, expect, it } from "vitest";
import { addMonthsKey, allocateLandedCost, bundleAvailability, cashOutByMonth, cashOutSchedule, explodeBom, forecastDemand, planFromRevenueTarget, reorderPlan, safetyStock, seasonalityIndices, stockAnalysis, stockoutDate, transferSuggestions, wape, zForServiceLevel } from "./planning";

const year = (units: number[], start = "2025-01") => units.map((u, i) => ({ month: addMonthsKey(start, i), units: u }));

describe("forecast", () => {
  it("learns seasonality with mean 1 and projects it", () => {
    const hist = year([80, 80, 100, 100, 100, 100, 100, 100, 100, 100, 160, 200]);
    const s = seasonalityIndices(hist);
    const mean = Object.values(s).reduce((a, b) => a + b, 0) / 12;
    expect(mean).toBeCloseTo(1, 2);
    expect(s[12]).toBeGreaterThan(s[1]!);
    const f = forecastDemand([...hist, ...year([84, 82, 104, 105, 103, 104, 102, 105, 103, 104, 166, 208], "2026-01")], "2027-01");
    expect(f).toHaveLength(12);
    expect(f[11]!.units).toBeGreaterThan(f[0]!.units * 1.8);
  });
  it("applies event uplifts and manual overrides; flat without history", () => {
    const hist = year(Array(12).fill(100));
    const f = forecastDemand(hist, "2026-01", { events: [{ month: "2026-11", uplift: 0.5, label: "Black Friday" }], overrides: { "2026-03": 42 } });
    expect(f.find((p) => p.month === "2026-11")!.units).toBe(150);
    expect(f.find((p) => p.month === "2026-03")).toMatchObject({ units: 42, overridden: true });
    expect(forecastDemand([], "2026-01")[0]!.units).toBe(0);
    expect(wape([100, 100], [90, 120])).toBeCloseTo(0.15, 5);
  });
});

describe("replenishment", () => {
  it("service-level z and safety stock", () => {
    expect(zForServiceLevel(0.95)).toBeCloseTo(1.645, 2);
    expect(zForServiceLevel(0.5)).toBeCloseTo(0, 5);
    expect(safetyStock({ dailyMean: 10, dailySd: 4, leadTimeDays: 16, serviceLevel: 0.95 })).toBe(Math.ceil(1.6449 * 16));
  });
  it("orders up to target when below the reorder point, rounding to MOQ and multiples", () => {
    const p = reorderPlan({ available: 50, incoming: 0, dailyMean: 10, dailySd: 3, leadTimeDays: 14, serviceLevel: 0.95, coverDays: 30, moq: 200, multiple: 12, unitCostMinor: 1000 });
    expect(p.shouldOrder).toBe(true);
    expect(p.reorderPoint).toBeGreaterThan(140);
    expect(p.quantity % 12).toBe(0);
    expect(p.quantity).toBeGreaterThanOrEqual(200);
    expect(p.costMinor).toBe(p.quantity * 1000);
    expect(reorderPlan({ available: 1000, incoming: 0, dailyMean: 10, dailySd: 3, leadTimeDays: 14, serviceLevel: 0.95, coverDays: 30 }).shouldOrder).toBe(false);
    expect(stockoutDate(25, 10, new Date("2026-10-01T00:00:00Z")).date!.toISOString().slice(0, 10)).toBe("2026-10-03");
  });
});

describe("landed cost and cash", () => {
  it("allocates charges by value, quantity or weight without losing cents", () => {
    const lines = [{ id: "a", quantity: 10, unitCostMinor: 1000, weightGrams: 500 }, { id: "b", quantity: 30, unitCostMinor: 500, weightGrams: 100 }];
    const r = allocateLandedCost(lines, [{ kind: "freight", amountMinor: 10_001, basis: "weight" }, { kind: "duty", amountMinor: 2500 }]);
    expect(r.reduce((s, x) => s + x.extraMinor, 0)).toBe(12_501);
    expect(r.find((x) => x.id === "a")!.landedUnitCostMinor).toBeGreaterThan(1000);
  });
  it("schedules deposit and balance and sums by month", () => {
    const s = cashOutSchedule([{ ref: "PO1", orderDate: new Date("2026-10-01T00:00:00Z"), leadTimeDays: 30, totalMinor: 100_000, terms: { depositShare: 0.3, balanceDaysAfterReceipt: 30 } }]);
    expect(s).toEqual([{ date: "2026-10-01", amountMinor: 30_000, kind: "deposit", ref: "PO1" }, { date: "2026-11-30", amountMinor: 70_000, kind: "balance", ref: "PO1" }]);
    expect(cashOutByMonth(s).map((m) => m.cumulativeMinor)).toEqual([30_000, 100_000]);
  });
});

describe("stock analysis, transfers, plans, bundles", () => {
  it("classifies ABC/XYZ and finds excess and slow movers", () => {
    const rows = stockAnalysis([
      { id: "top", revenueMinor: 800, periodUnits: [10, 11, 9, 10], onHand: 40, unitCostMinor: 10, dailyMean: 1.4 },
      { id: "mid", revenueMinor: 150, periodUnits: [3, 6, 2, 7], onHand: 100, unitCostMinor: 10, dailyMean: 0.5 },
      { id: "dead", revenueMinor: 50, periodUnits: [0, 0, 1, 0], onHand: 300, unitCostMinor: 10, dailyMean: 0 },
    ]);
    expect(rows.map((r) => r.abc)).toEqual(["A", "B", "C"]);
    expect(rows[0]!.xyz).toBe("X");
    expect(rows[1]!.xyz).toBe("Y");
    expect(rows[2]!.slowMover).toBe(true);
    expect(rows[2]!.excessUnits).toBe(300);
  });
  it("suggests transfers from surplus to short locations", () => {
    expect(transferSuggestions([{ locationId: "A", available: 2, dailyMean: 1 }, { locationId: "B", available: 200, dailyMean: 1 }])).toEqual([{ from: "B", to: "A", units: 12 }]);
    // a move below the minimum is not worth the handling
    expect(transferSuggestions([{ locationId: "A", available: 13, dailyMean: 1 }, { locationId: "B", available: 200, dailyMean: 1 }], { minUnits: 3 })).toEqual([]);
  });
  it("plans units from a revenue target, derives bundle stock and explodes nested BOMs", () => {
    const plan = planFromRevenueTarget(200_000, [{ id: "x", forecastUnits: 50, priceMinor: 1000 }, { id: "y", forecastUnits: 50, priceMinor: 1000 }]);
    expect(plan.map((p) => p.units)).toEqual([100, 100]);
    expect(bundleAvailability([{ available: 10, quantityPerUnit: 2 }, { available: 7, quantityPerUnit: 1 }])).toBe(5);
    const bom = new Map([["kit", [{ componentId: "sub", quantity: 2 }, { componentId: "box", quantity: 1 }]], ["sub", [{ componentId: "screw", quantity: 4 }]]]);
    expect(Object.fromEntries(explodeBom("kit", 3, bom))).toEqual({ screw: 24, box: 3 });
  });
});

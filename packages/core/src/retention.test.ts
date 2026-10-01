import { describe, expect, it } from "vitest";
import { campaignUplift, minimumDetectableUplift, renderMessage, type CustomerOutcome } from "./retention";

const group = (n: number, converters: number, marginEach: number): CustomerOutcome[] => Array.from({ length: n }, (_, i) => (i < converters ? { orders: 1, revenueMinor: 5000, marginMinor: marginEach } : { orders: 0, revenueMinor: 0, marginMinor: 0 }));

describe("campaignUplift", () => {
  it("computes conversion uplift, incremental margin scaled to the treated group, cost and ROI", () => {
    const r = campaignUplift(group(1000, 100, 2000), group(200, 10, 2000), 50_000);
    expect(r.measurable).toBe(true);
    expect(r.treated.conversionRate).toBeCloseTo(0.1);
    expect(r.holdout.conversionRate).toBeCloseTo(0.05);
    expect(r.conversion!.diff).toBeCloseTo(0.05);
    expect(r.significant).toBe(true);
    // margin per customer: 200 vs 100 → +100 × 1000 treated
    expect(r.incrementalMarginMinor).toBe(100_000);
    expect(r.incrementalOrders).toBeCloseTo(50);
    expect(r.incrementalRevenueMinor).toBe(250_000);
    expect(r.netIncrementalMarginMinor).toBe(50_000);
    expect(r.roi).toBeCloseTo(1);
    expect(r.incrementalMarginCi95![0]).toBeLessThan(100_000);
    expect(r.incrementalMarginCi95![1]).toBeGreaterThan(100_000);
  });
  it("does not call noise significant", () => {
    const r = campaignUplift(group(300, 31, 1500), group(40, 4, 1500));
    expect(r.significant).toBe(false);
    expect(r.marginPerCustomerDiff!.ci95![0]).toBeLessThan(0);
    expect(r.roi).toBeNull();
  });
  it("is not measurable without a control group", () => {
    const r = campaignUplift(group(100, 10, 1000), []);
    expect(r.measurable).toBe(false);
    expect(r.incrementalMarginMinor).toBeNull();
    expect(r.treated.converters).toBe(10);
  });
});

describe("minimumDetectableUplift", () => {
  it("shrinks with bigger groups and is null when undefined", () => {
    const small = minimumDetectableUplift(0.08, 900, 100)!;
    const big = minimumDetectableUplift(0.08, 9000, 1000)!;
    expect(small).toBeGreaterThan(big);
    expect(small).toBeCloseTo(0.0801, 3);
    expect(minimumDetectableUplift(0.08, 100, 0)).toBeNull();
  });
});

describe("renderMessage", () => {
  it("replaces known placeholders only", () => {
    expect(renderMessage("Hi {first_name}, use {code} {unknown}", { first_name: "Ada", code: "BACK10" })).toBe("Hi Ada, use BACK10 {unknown}");
  });
});

import { describe, expect, it } from "vitest";
import { change, orderEconomics, previousPeriod, prorateMonthlyCost, runningWindows, sumEconomics } from "./finance";

/**
 * Hand-calculated check (CLAUDE.md phase 5 exit criterion): three orders of a month.
 *  A) IT, prices include 22% VAT: total 122.00 (tax 22.00), 2 units at cost 20.00, card 1.80% + 0.25, shipping 6.50
 *     net = 100.00; cogs = 40.00; fee = 2.20 + 0.25 = 2.45; margin = 100 − 40 − 6.50 − 2.45 = 51.05
 *  B) cancelled: out of scope, contributes nothing
 *  C) US, tax added: total 107.00 (tax 7.00), 1 unit without cost, wallet 2.50% + 0.25, shipping 8.95, refunded 21.40 (20%)
 *     net = (107 − 21.40) × (1 − 7/107) = 85.60 × 0.934579 = 80.00; cogs unknown (0, incomplete); fee = 2.675→2.68 + 0.25 = 2.93
 *     margin = 80.00 − 0 − 8.95 − 2.93 = 68.12
 *  Period: ad spend 30.00, fixed costs 10.00 → operating profit = 51.05 + 68.12 − 30 − 10 = 79.17
 */
const A = orderEconomics({ status: "delivered", totalMinor: 12200, taxMinor: 2200, refundedMinor: 0, taxRateBps: 2200, pricesIncludeTax: true, lines: [{ quantity: 2, unitPriceMinor: 5000, unitCostMinor: 2000 }], paymentMethod: "card", paymentFeeBps: 180, paymentFeeFixedMinor: 25, shippingCostMinor: 650 });
const B = orderEconomics({ status: "cancelled", totalMinor: 9900, taxMinor: 1785, refundedMinor: 9900, taxRateBps: 2200, pricesIncludeTax: true, lines: [{ quantity: 1, unitPriceMinor: 9900, unitCostMinor: 3000 }], paymentMethod: "card", paymentFeeBps: 180, paymentFeeFixedMinor: 25, shippingCostMinor: 650 });
const C = orderEconomics({ status: "returned_partial", totalMinor: 10700, taxMinor: 700, refundedMinor: 2140, returnedFraction: 0.2, taxRateBps: 0, pricesIncludeTax: false, lines: [{ quantity: 1, unitPriceMinor: 10000, unitCostMinor: null }], paymentMethod: "wallet", paymentFeeBps: 250, paymentFeeFixedMinor: 25, shippingCostMinor: 895 });

describe("orderEconomics", () => {
  it("order A matches the hand calculation", () => {
    expect(A).toMatchObject({ inScope: true, netRevenueMinor: 10000, cogsMinor: 4000, paymentFeeMinor: 245, shippingCostMinor: 650, marginMinor: 5105, cogsComplete: true });
  });
  it("cancelled orders are out of scope", () => {
    expect(B.inScope).toBe(false);
    expect(B.marginMinor).toBe(0);
    expect(B.netRevenueMinor).toBe(0);
  });
  it("order C nets refunds and flags missing costs", () => {
    expect(C.netRevenueMinor).toBe(8000);
    expect(C.cogsComplete).toBe(false);
    expect(C.paymentFeeMinor).toBe(293);
    expect(C.marginMinor).toBe(6812);
  });
  it("derives tax from the rate when the platform reports none", () => {
    const r = orderEconomics({ status: "confirmed", totalMinor: 12200, taxMinor: 0, refundedMinor: 0, taxRateBps: 2200, pricesIncludeTax: true, lines: [], paymentMethod: "card", paymentFeeBps: 0, paymentFeeFixedMinor: 0, shippingCostMinor: 0 });
    expect(r.taxMinor).toBe(2200);
    expect(r.netRevenueMinor).toBe(10000);
  });
  it("sums the period P/L to the hand result", () => {
    const t = sumEconomics([A, B, C], 3000, 1000);
    expect(t.orders).toBe(2);
    expect(t.netRevenueMinor).toBe(18000);
    expect(t.cogsMinor).toBe(4000);
    expect(t.cogsIncompleteOrders).toBe(1);
    expect(t.contributionMinor).toBe(5105 + 6812);
    expect(t.operatingProfitMinor).toBe(7917);
    expect(t.aovMinor).toBe(Math.round((12200 + 10700) / 2));
  });
});

describe("period helpers", () => {
  it("prorates monthly costs by days in the window", () => {
    const v = prorateMonthlyCost(304375, "2026-01-01", null, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-11T00:00:00Z"));
    expect(v).toBe(100000);
    expect(prorateMonthlyCost(1000, "2026-05-01", "2026-05-31", new Date("2026-03-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z"))).toBe(0);
  });
  it("previous period and change", () => {
    const p = previousPeriod({ from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") });
    expect(p.from.toISOString()).toBe("2026-08-02T00:00:00.000Z");
    expect(change(120, 100)).toBeCloseTo(0.2);
    expect(change(5, 0)).toBeNull();
  });
  it("running windows start at local midnight", () => {
    const w = runningWindows(new Date("2026-06-15T10:30:00Z"), "Europe/Rome");
    expect(w.today.from.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    expect(w.yesterday.to.toISOString()).toBe("2026-06-14T10:30:00.000Z");
    expect(w.lastWeek.from.toISOString()).toBe("2026-06-07T22:00:00.000Z");
  });
});

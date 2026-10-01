import { describe, expect, it } from "vitest";
import { canTransitionReturn, returnEligibility, returnableLines, returnedFractionBps } from "./returns";
import { discountAmount, discountState, generateUniqueCodes } from "./discounts";

const now = new Date("2026-10-01T12:00:00Z");
const d = (days: number) => new Date(now.getTime() - days * 864e5);

describe("return eligibility", () => {
  it("uses delivered_at, falls back to shipped + fallback days, and expires after the window", () => {
    expect(returnEligibility({ orderStatus: "delivered", deliveredAt: d(3), shippedAt: d(6), now, windowDays: 14, shippingFallbackDays: 5 })).toMatchObject({ eligible: true, daysLeft: 11 });
    expect(returnEligibility({ orderStatus: "shipped", deliveredAt: null, shippedAt: d(2), now, windowDays: 14, shippingFallbackDays: 5 })).toMatchObject({ eligible: false, reason: "not_delivered" });
    expect(returnEligibility({ orderStatus: "shipped", deliveredAt: null, shippedAt: d(10), now, windowDays: 14, shippingFallbackDays: 5 })).toMatchObject({ eligible: true, daysLeft: 9 });
    expect(returnEligibility({ orderStatus: "delivered", deliveredAt: d(20), shippedAt: d(25), now, windowDays: 14, shippingFallbackDays: 5 })).toMatchObject({ eligible: false, reason: "expired" });
    expect(returnEligibility({ orderStatus: "cancelled", deliveredAt: null, shippedAt: null, now, windowDays: 14, shippingFallbackDays: 5 })).toMatchObject({ eligible: false, reason: "cancelled" });
  });
  it("allocates the order discount pro rata and nets previous returns", () => {
    const lines = returnableLines(
      [{ id: "a", quantity: 2, unitPriceMinor: 5000, totalMinor: 10000, productType: "Shoes" }, { id: "b", quantity: 1, unitPriceMinor: 10000, totalMinor: 10000, productType: "Gift card" }, { id: "s", quantity: 1, unitPriceMinor: 500, totalMinor: 500, productType: null, isAncillary: true }],
      2000,
      { a: 1 },
      ["gift card"],
    );
    expect(lines[0]).toMatchObject({ returnable: 1, alreadyReturned: 1, unitNetMinor: 4500, excluded: false });
    expect(lines[1]).toMatchObject({ returnable: 0, excluded: true });
    expect(lines[2]).toMatchObject({ returnable: 0, excluded: true });
  });
  it("transitions and returned fraction", () => {
    expect(canTransitionReturn("requested", "approved")).toBe(true);
    expect(canTransitionReturn("requested", "refunded")).toBe(false);
    expect(canTransitionReturn("inspected", "voucher_issued")).toBe(true);
    expect(canTransitionReturn("refunded", "rejected")).toBe(false);
    expect(returnedFractionBps([{ id: "a", quantity: 2 }, { id: "b", quantity: 2 }], { a: 2 })).toBe(5000);
    expect(returnedFractionBps([{ id: "a", quantity: 1 }], { a: 5 })).toBe(10000);
  });
});

describe("discounts", () => {
  it("generates distinct, prefixed codes without ambiguous characters and skips taken ones", () => {
    let i = 0;
    const rnd = () => ((i++ * 7919) % 1000) / 1000;
    const codes = generateUniqueCodes("nw", 50, rnd, 8, ["NW-AAAAAAAA"]);
    expect(codes).toHaveLength(50);
    expect(new Set(codes).size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^NW-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
  it("computes state and amount", () => {
    expect(discountState({ type: "percentage", value: 1000, endsAt: d(1) }, now)).toBe("expired");
    expect(discountState({ type: "percentage", value: 1000, startsAt: d(-1) }, now)).toBe("scheduled");
    expect(discountState({ type: "percentage", value: 1000, usageLimit: 1, usedCount: 1 }, now)).toBe("exhausted");
    expect(discountAmount({ type: "percentage", value: 1500 }, 10000, 500, now)).toMatchObject({ amountMinor: 1500, applicable: true });
    expect(discountAmount({ type: "fixed_amount", value: 20000 }, 10000, 500, now).amountMinor).toBe(10000);
    expect(discountAmount({ type: "free_shipping", value: 0, minimumAmountMinor: 20000 }, 10000, 500, now)).toMatchObject({ applicable: false, reason: "minimum" });
  });
});

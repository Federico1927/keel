import { describe, expect, it } from "vitest";
import { adjustmentEventId, decideConversionAdjustment, isOrderWithdrawn, purchaseStillDue, restatedValueMinor, type AdjustmentDecisionInput } from "./conversions";

const order = { status: "delivered", cancelled: false, paymentStatus: "paid", totalMinor: 10000, refundedMinor: 0 };
const both = { retraction: true, restatement: true };
const none = { retraction: false, restatement: false };
const base: AdjustmentDecisionInput = { purchase: { status: "sent", valueMinor: 10000 }, order, retracted: false, restatedValueMinor: null, support: both };

describe("withdrawn orders", () => {
  it("cancelled, non-sale statuses, refunded or voided payments and full refunds withdraw the sale", () => {
    expect(isOrderWithdrawn(order)).toBe(false);
    expect(isOrderWithdrawn({ ...order, cancelled: true })).toBe(true);
    expect(isOrderWithdrawn({ ...order, status: "returned" })).toBe(true);
    expect(isOrderWithdrawn({ ...order, status: "refunded" })).toBe(true);
    expect(isOrderWithdrawn({ ...order, paymentStatus: "refunded" })).toBe(true);
    expect(isOrderWithdrawn({ ...order, paymentStatus: "voided" })).toBe(true);
    expect(isOrderWithdrawn({ ...order, refundedMinor: 10000 })).toBe(true);
    expect(isOrderWithdrawn({ ...order, refundedMinor: 4000, paymentStatus: "partially_refunded", status: "returned_partial" })).toBe(false);
    // a free order is never "fully refunded" by a zero refund
    expect(isOrderWithdrawn({ ...order, totalMinor: 0 })).toBe(false);
  });
  it("a queued purchase is dropped once the order is withdrawn", () => {
    expect(purchaseStillDue(order)).toBe(true);
    expect(purchaseStillDue({ ...order, cancelled: true })).toBe(false);
  });
  it("restated value never goes below zero", () => {
    expect(restatedValueMinor(10000, 2500)).toBe(7500);
    expect(restatedValueMinor(10000, 12000)).toBe(0);
    expect(restatedValueMinor(10000, -5)).toBe(10000);
  });
});

describe("decideConversionAdjustment", () => {
  it("does nothing unless the purchase reached the platform", () => {
    expect(decideConversionAdjustment({ ...base, purchase: null, order: { ...order, cancelled: true } })).toEqual({ kind: "none", why: "purchase_not_sent" });
    expect(decideConversionAdjustment({ ...base, purchase: { status: "pending", valueMinor: 10000 }, order: { ...order, cancelled: true } })).toEqual({ kind: "none", why: "purchase_not_sent" });
    expect(decideConversionAdjustment({ ...base, purchase: { status: "skipped", valueMinor: null }, order: { ...order, cancelled: true } }).kind).toBe("none");
  });
  it("retracts a cancelled or fully refunded order once, or marks it unsupported", () => {
    expect(decideConversionAdjustment({ ...base, order: { ...order, cancelled: true } })).toEqual({ kind: "retraction", send: true, reason: null });
    expect(decideConversionAdjustment({ ...base, order: { ...order, refundedMinor: 10000, paymentStatus: "refunded" } })).toEqual({ kind: "retraction", send: true, reason: null });
    expect(decideConversionAdjustment({ ...base, order: { ...order, cancelled: true }, support: none })).toEqual({ kind: "retraction", send: false, reason: "unsupported" });
    expect(decideConversionAdjustment({ ...base, order: { ...order, cancelled: true }, retracted: true })).toEqual({ kind: "none", why: "already_retracted" });
  });
  it("restates a partial refund to the remaining value, re-arming only when it changes", () => {
    const partial = { ...order, refundedMinor: 3000, paymentStatus: "partially_refunded" };
    expect(decideConversionAdjustment({ ...base, order: partial })).toEqual({ kind: "restatement", valueMinor: 7000, send: true, reason: null });
    expect(decideConversionAdjustment({ ...base, order: partial, restatedValueMinor: 7000 })).toEqual({ kind: "none", why: "unchanged" });
    expect(decideConversionAdjustment({ ...base, order: { ...partial, refundedMinor: 5000 }, restatedValueMinor: 7000 })).toEqual({ kind: "restatement", valueMinor: 5000, send: true, reason: null });
    expect(decideConversionAdjustment({ ...base, order: partial, support: { retraction: true, restatement: false } })).toEqual({ kind: "restatement", valueMinor: 7000, send: false, reason: "unsupported" });
  });
  it("restates from the value that was sent, not from today's total", () => {
    expect(decideConversionAdjustment({ ...base, purchase: { status: "sent", valueMinor: 8000 }, order: { ...order, refundedMinor: 1000 } })).toMatchObject({ kind: "restatement", valueMinor: 7000 });
    expect(decideConversionAdjustment({ ...base, purchase: { status: "sent", valueMinor: null }, order: { ...order, refundedMinor: 1000 } })).toMatchObject({ kind: "restatement", valueMinor: 9000 });
  });
  it("leaves a full sale alone", () => {
    expect(decideConversionAdjustment(base)).toEqual({ kind: "none", why: "still_full_sale" });
  });
  it("names adjustment rows after the purchase", () => {
    expect(adjustmentEventId("order-5001", "retraction")).toBe("order-5001:retraction");
  });
});

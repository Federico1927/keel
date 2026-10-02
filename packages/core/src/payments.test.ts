import { describe, expect, it } from "vitest";
import { orderEconomics, sumEconomics } from "./finance";
import { effectiveTaxRateBps, outstandingMinor, paymentMethodBreakdown, paymentStatusAfterRefund, payoutTotals, refundAmountForLines, refundableMinor, resolvePaymentFee, taxReport, validateManualPayment, validateRefund, manualPaymentInstant } from "./payments";

const base = { status: "delivered", taxMinor: 0, refundedMinor: 0, taxRateBps: 0, pricesIncludeTax: false, lines: [{ quantity: 1, unitPriceMinor: 10000, unitCostMinor: 4000 }], paymentMethod: "card", paymentFeeBps: 180, paymentFeeFixedMinor: 25, shippingCostMinor: 0 };

describe("payment fee: actual when known, estimate otherwise", () => {
  it("resolves the source", () => {
    expect(resolvePaymentFee(205, null)).toEqual({ feeMinor: 205, source: "estimate" });
    expect(resolvePaymentFee(205, undefined)).toEqual({ feeMinor: 205, source: "estimate" });
    expect(resolvePaymentFee(205, 0)).toEqual({ feeMinor: 0, source: "actual" });
    expect(resolvePaymentFee(205, 175)).toEqual({ feeMinor: 175, source: "actual" });
  });
  it("orderEconomics takes the payout fee and flags the estimate", () => {
    // 100.00 by card: estimate 1.80 % + 0.25 = 2.05; the payout says the gateway took 1.75
    const estimated = orderEconomics({ ...base, totalMinor: 10000 });
    const actual = orderEconomics({ ...base, totalMinor: 10000, actualPaymentFeeMinor: 175 });
    expect(estimated).toMatchObject({ paymentFeeMinor: 205, paymentFeeSource: "estimate", marginMinor: 10000 - 4000 - 205 });
    expect(actual).toMatchObject({ paymentFeeMinor: 175, paymentFeeSource: "actual", marginMinor: 10000 - 4000 - 175 });
    // out of scope (cancelled): no fee in the P/L whatever the gateway did
    expect(orderEconomics({ ...base, status: "cancelled", totalMinor: 10000, actualPaymentFeeMinor: 175 }).paymentFeeMinor).toBe(0);
  });
  it("the P/L sums actual and estimated fees separately", () => {
    const rows = [orderEconomics({ ...base, totalMinor: 10000, actualPaymentFeeMinor: 175 }), orderEconomics({ ...base, totalMinor: 20000, actualPaymentFeeMinor: 320 }), orderEconomics({ ...base, totalMinor: 10000, paymentMethod: "bank_transfer", paymentFeeBps: 0, paymentFeeFixedMinor: 0 }), orderEconomics({ ...base, totalMinor: 5000 })];
    const t = sumEconomics(rows, 0, 0);
    expect(t.paymentFeeActualMinor).toBe(495);
    expect(t.paymentFeeActualOrders).toBe(2);
    expect(t.paymentFeeEstimatedOrders).toBe(2);
    expect(t.paymentFeeEstimatedMinor).toBe(0 + 90 + 25);
    expect(t.paymentFeeMinor).toBe(t.paymentFeeActualMinor + t.paymentFeeEstimatedMinor);
  });
});

describe("partial refunds are capped by what remains refundable", () => {
  const order = { paymentStatus: "paid", totalMinor: 5000, refundedMinor: 0, subtotalMinor: 5000, discountMinor: 0 };
  const lines = [{ id: "l1", currentQuantity: 2, unitPriceMinor: 2000, refundedQuantity: 0 }, { id: "l2", currentQuantity: 1, unitPriceMinor: 1000, refundedQuantity: 0 }];
  it("accepts €10 on a €50 order and marks it partially refunded", () => {
    expect(validateRefund(order, lines, { amountMinor: 1000, lines: [] })).toEqual({ ok: true, refundableMinor: 5000, nextRefundedMinor: 1000, nextPaymentStatus: "partially_refunded" });
  });
  it("rejects more than what remains", () => {
    expect(validateRefund({ ...order, refundedMinor: 1000 }, lines, { amountMinor: 4001, lines: [] })).toEqual({ ok: false, error: "exceeds_refundable" });
    expect(validateRefund({ ...order, refundedMinor: 1000 }, lines, { amountMinor: 4000, lines: [] })).toMatchObject({ ok: true, nextRefundedMinor: 5000, nextPaymentStatus: "refunded" });
    expect(refundableMinor({ totalMinor: 5000, refundedMinor: 6000 })).toBe(0);
  });
  it("rejects unpaid orders, bad amounts and bad lines", () => {
    expect(validateRefund({ ...order, paymentStatus: "pending" }, lines, { amountMinor: 100, lines: [] })).toEqual({ ok: false, error: "not_paid" });
    expect(validateRefund({ ...order, replacedByOrderId: "x" }, lines, { amountMinor: 100, lines: [] })).toEqual({ ok: false, error: "replaced" });
    expect(validateRefund(order, lines, { amountMinor: 0, lines: [] })).toEqual({ ok: false, error: "amount_invalid" });
    expect(validateRefund(order, lines, { amountMinor: 10.5, lines: [] })).toEqual({ ok: false, error: "amount_invalid" });
    expect(validateRefund(order, lines, { amountMinor: 100, lines: [{ orderLineId: "l1", quantity: 3 }] })).toEqual({ ok: false, error: "line_invalid" });
    expect(validateRefund(order, [{ ...lines[0]!, refundedQuantity: 2 }], { amountMinor: 100, lines: [{ orderLineId: "l1", quantity: 1 }] })).toEqual({ ok: false, error: "line_invalid" });
    expect(validateRefund(order, lines, { amountMinor: 100, lines: [{ orderLineId: "zz", quantity: 1 }] })).toEqual({ ok: false, error: "line_invalid" });
    expect(validateRefund(order, lines, { amountMinor: 2000, lines: [{ orderLineId: "l1", quantity: 1 }] })).toMatchObject({ ok: true });
  });
  it("suggests the units' price less the order discount share, capped", () => {
    expect(refundAmountForLines({ ...order, subtotalMinor: 5000, discountMinor: 500 }, lines, [{ orderLineId: "l1", quantity: 1 }])).toBe(1800);
    expect(refundAmountForLines({ ...order, refundedMinor: 4500 }, lines, [{ orderLineId: "l1", quantity: 2 }])).toBe(500);
  });
  it("derives the payment status", () => {
    expect(paymentStatusAfterRefund({ totalMinor: 5000, paymentStatus: "paid" }, 0)).toBe("paid");
    expect(paymentStatusAfterRefund({ totalMinor: 5000, paymentStatus: "paid" }, 1)).toBe("partially_refunded");
    expect(paymentStatusAfterRefund({ totalMinor: 5000, paymentStatus: "partially_refunded" }, 5000)).toBe("refunded");
  });
});

describe("manual payments", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const order = { paymentStatus: "pending", totalMinor: 5000, cancelledAt: null };
  it("pays the order when the payments cover the total", () => {
    expect(validateManualPayment(order, 0, { amountMinor: 5000, occurredAt: now }, now)).toEqual({ ok: true, outstandingMinor: 0, fullyPaid: true });
    expect(validateManualPayment(order, 2000, { amountMinor: 1000, occurredAt: now }, now)).toEqual({ ok: true, outstandingMinor: 2000, fullyPaid: false });
    expect(outstandingMinor(order, 2000)).toBe(3000);
  });
  it("refuses what cannot be a manual payment", () => {
    expect(validateManualPayment({ ...order, paymentStatus: "paid" }, 0, { amountMinor: 100, occurredAt: now }, now)).toEqual({ ok: false, error: "not_pending" });
    expect(validateManualPayment({ ...order, cancelledAt: now }, 0, { amountMinor: 100, occurredAt: now }, now)).toEqual({ ok: false, error: "cancelled" });
    expect(validateManualPayment(order, 0, { amountMinor: 5001, occurredAt: now }, now)).toEqual({ ok: false, error: "exceeds_outstanding" });
    expect(validateManualPayment(order, 0, { amountMinor: -1, occurredAt: now }, now)).toEqual({ ok: false, error: "amount_invalid" });
    expect(validateManualPayment(order, 0, { amountMinor: 100, occurredAt: new Date(now.getTime() + 864e5) }, now)).toEqual({ ok: false, error: "date_invalid" });
  });
});

describe("payouts", () => {
  it("net = charges + refunds + adjustments − fees", () => {
    const t = payoutTotals([{ type: "charge", amountMinor: 10000, feeMinor: 175 }, { type: "charge", amountMinor: 5000, feeMinor: 100 }, { type: "refund", amountMinor: -2000, feeMinor: 0 }, { type: "adjustment", amountMinor: -300, feeMinor: 0 }]);
    expect(t).toEqual({ grossMinor: 15000, refundsMinor: -2000, adjustmentsMinor: -300, feesMinor: 275, netMinor: 12425, transactions: 4 });
  });
});

describe("tax report", () => {
  it("rates from the platform tax or the tenant rate", () => {
    // 122.00 incl. 22 % VAT on goods: base 100 → 2200 bps
    expect(effectiveTaxRateBps({ taxMinor: 2200, subtotalMinor: 12200, discountMinor: 0, pricesIncludeTax: true, platformTaxMinor: 2200, fallbackRateBps: 0 })).toBe(2200);
    // US sales tax added on top: 7.00 on 100.00
    expect(effectiveTaxRateBps({ taxMinor: 700, subtotalMinor: 10000, discountMinor: 0, pricesIncludeTax: false, platformTaxMinor: 700, fallbackRateBps: 0 })).toBe(700);
    // rounding noise stays on the 0.1 % grid
    expect(effectiveTaxRateBps({ taxMinor: 1803, subtotalMinor: 9999, discountMinor: 0, pricesIncludeTax: true, platformTaxMinor: 1803, fallbackRateBps: 0 })).toBe(2200);
    // tax computed by the P/L from the tenant rate
    expect(effectiveTaxRateBps({ taxMinor: 1785, subtotalMinor: 9900, discountMinor: 0, pricesIncludeTax: true, platformTaxMinor: 0, fallbackRateBps: 2200 })).toBe(2200);
    expect(effectiveTaxRateBps({ taxMinor: 0, subtotalMinor: 9900, discountMinor: 0, pricesIncludeTax: false, platformTaxMinor: 0, fallbackRateBps: 0 })).toBe(0);
  });
  it("groups sale orders by country and rate and adds up to the tax charged", () => {
    const r = taxReport([
      { inScope: true, country: "IT", rateBps: 2200, grossRevenueMinor: 12200, taxMinor: 2200, refundedMinor: 0 },
      { inScope: true, country: "IT", rateBps: 2200, grossRevenueMinor: 6100, taxMinor: 1100, refundedMinor: 6100 },
      { inScope: true, country: "DE", rateBps: 1900, grossRevenueMinor: 11900, taxMinor: 1900, refundedMinor: 0 },
      { inScope: false, country: "DE", rateBps: 1900, grossRevenueMinor: 11900, taxMinor: 1900, refundedMinor: 0 },
    ]);
    expect(r.rows.map((x) => [x.country, x.rateBps, x.orders, x.taxMinor])).toEqual([["DE", 1900, 1, 1900], ["IT", 2200, 2, 3300]]);
    expect(r.rows[1]).toMatchObject({ grossMinor: 18300, taxableMinor: 15000, refundedTaxMinor: 1100, netTaxMinor: 2200 });
    expect(r.totals).toMatchObject({ orders: 3, taxMinor: 5200, refundedTaxMinor: 1100, netTaxMinor: 4100 });
  });
});

describe("payment-method breakdown", () => {
  it("covers every canonical method and computes rates per method", () => {
    const rows = paymentMethodBreakdown([
      { paymentMethod: "card", status: "delivered", inScope: true, grossRevenueMinor: 10000, netRevenueMinor: 8000, paymentFeeMinor: 175, paymentFeeSource: "actual" },
      { paymentMethod: "card", status: "cancelled", inScope: false, grossRevenueMinor: 0, netRevenueMinor: 0, paymentFeeMinor: 0, paymentFeeSource: "estimate" },
      { paymentMethod: "bank_transfer", status: "returned", inScope: false, grossRevenueMinor: 0, netRevenueMinor: 0, paymentFeeMinor: 0, paymentFeeSource: "estimate" },
      { paymentMethod: "bank_transfer", status: "confirmed", inScope: true, grossRevenueMinor: 2000, netRevenueMinor: 2000, paymentFeeMinor: 0, paymentFeeSource: "estimate" },
      { paymentMethod: "paypal-ish", status: "confirmed", inScope: true, grossRevenueMinor: 1000, netRevenueMinor: 1000, paymentFeeMinor: 30, paymentFeeSource: "estimate" },
    ]);
    expect(rows.map((r) => r.method)).toEqual(["card", "wallet", "bank_transfer", "cod", "bnpl", "other"]);
    const card = rows[0]!;
    expect(card).toMatchObject({ placedOrders: 2, orders: 1, cancelledOrders: 1, cancelRate: 0.5, feesMinor: 175, actualFeesMinor: 175, estimatedFeeOrders: 0, feeRate: 0.0175, aovMinor: 10000 });
    expect(rows[2]).toMatchObject({ placedOrders: 2, orders: 1, returnedOrders: 1, returnRate: 0.5, estimatedFeeOrders: 1 });
    expect(rows[5]).toMatchObject({ orders: 1, estimatedFeesMinor: 30 });
    expect(rows[3]).toMatchObject({ placedOrders: 0, cancelRate: null, aovMinor: null });
    expect(rows.reduce((s, r) => s + (r.revenueShare ?? 0), 0)).toBeCloseTo(1);
  });
});

describe("manualPaymentInstant", () => {
  it("treats today in the tenant's time zone as now, even when UTC is still on the previous day", () => {
    const now = new Date("2026-10-02T22:27:00Z"); // 00:27 on 3 October in Rome
    expect(manualPaymentInstant("2026-10-03", "Europe/Rome", now)).toBe(now);
    expect(manualPaymentInstant("2026-10-02", "Europe/Rome", now).toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(validateManualPayment({ paymentStatus: "pending", totalMinor: 1000, cancelledAt: null }, 0, { amountMinor: 1000, occurredAt: manualPaymentInstant("2026-10-03", "Europe/Rome", now) }, now).ok).toBe(true);
  });
  it("behind UTC: the local day is still today while UTC has moved on", () => {
    const now = new Date("2026-10-03T02:00:00Z"); // 22:00 on 2 October in New York
    expect(manualPaymentInstant("2026-10-02", "America/New_York", now)).toBe(now);
    expect(manualPaymentInstant("2026-10-01", "America/New_York", now).getTime()).toBeLessThan(now.getTime());
  });
});

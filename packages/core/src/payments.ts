import { safeDiv } from "./money";
import { PAYMENT_METHODS, type PaymentMethod } from "./tenant-settings";
import type { PaymentStatus } from "./domain";

/**
 * Money on an order after checkout (issue #27): manual payments, partial refunds, actual payment
 * fees from payouts, tax and payment-method reports. Every payment method is treated the same:
 * nothing here knows about cash on delivery.
 */

/* ---------- manual payment ---------- */

export type ManualPaymentError = "not_pending" | "cancelled" | "amount_invalid" | "exceeds_outstanding" | "date_invalid";

export interface ManualPaymentOrder {
  paymentStatus: PaymentStatus | string;
  totalMinor: number;
  cancelledAt: Date | null;
  replacedByOrderId?: string | null;
}

/** Amount still to collect on an order with payment pending, given the manual payments already recorded. */
export function outstandingMinor(order: { totalMinor: number }, paidSoFarMinor: number): number {
  return Math.max(0, order.totalMinor - Math.max(0, paidSoFarMinor));
}

/**
 * A manual payment (bank transfer received, cash, cheque…) on an order whose payment is pending.
 * Partial amounts are allowed; the order becomes paid when the payments cover the total.
 */
export function validateManualPayment(order: ManualPaymentOrder, paidSoFarMinor: number, input: { amountMinor: number; occurredAt: Date }, now: Date): { ok: true; outstandingMinor: number; fullyPaid: boolean } | { ok: false; error: ManualPaymentError } {
  if (order.cancelledAt || order.replacedByOrderId) return { ok: false, error: "cancelled" };
  if (order.paymentStatus !== "pending") return { ok: false, error: "not_pending" };
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return { ok: false, error: "amount_invalid" };
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()) || input.occurredAt.getTime() > now.getTime() + 60_000) return { ok: false, error: "date_invalid" };
  const outstanding = outstandingMinor(order, paidSoFarMinor);
  if (input.amountMinor > outstanding) return { ok: false, error: "exceeds_outstanding" };
  return { ok: true, outstandingMinor: outstanding - input.amountMinor, fullyPaid: input.amountMinor >= outstanding };
}

/* ---------- partial refund ---------- */

export type RefundError = "replaced" | "not_paid" | "amount_invalid" | "exceeds_refundable" | "line_invalid";

export interface RefundOrder {
  paymentStatus: PaymentStatus | string;
  totalMinor: number;
  refundedMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  replacedByOrderId?: string | null;
}
export interface RefundableLine {
  id: string;
  currentQuantity: number;
  unitPriceMinor: number;
  /** Units of the line already refunded by Keel. */
  refundedQuantity: number;
}
export interface RefundLineRequest {
  orderLineId: string;
  quantity: number;
}

const REFUNDABLE_PAYMENT: readonly string[] = ["paid", "partially_refunded"];

/** Money that can still go back to the customer: what was charged less what was refunded. */
export function refundableMinor(order: { totalMinor: number; refundedMinor: number }): number {
  return Math.max(0, order.totalMinor - Math.max(0, order.refundedMinor));
}

/** Suggested refund for some units: their price less the order-level discount share, capped by what is refundable. */
export function refundAmountForLines(order: RefundOrder, lines: readonly RefundableLine[], requests: readonly RefundLineRequest[]): number {
  const gross = requests.reduce((s, r) => s + (lines.find((l) => l.id === r.orderLineId)?.unitPriceMinor ?? 0) * Math.max(0, r.quantity), 0);
  const keep = order.subtotalMinor > 0 ? Math.max(0, order.subtotalMinor - order.discountMinor) / order.subtotalMinor : 1;
  return Math.min(refundableMinor(order), Math.round(gross * keep));
}

/** Payment status once `refundedMinor` in total went back on an order that was paid. */
export function paymentStatusAfterRefund(order: { totalMinor: number; paymentStatus: PaymentStatus | string }, refundedMinor: number): PaymentStatus {
  if (refundedMinor <= 0) return order.paymentStatus as PaymentStatus;
  return refundedMinor >= order.totalMinor ? "refunded" : "partially_refunded";
}

/** A money refund (goodwill, price adjustment, optionally on some units): never more than what remains refundable. */
export function validateRefund(order: RefundOrder, lines: readonly RefundableLine[], input: { amountMinor: number; lines: readonly RefundLineRequest[] }): { ok: true; refundableMinor: number; nextRefundedMinor: number; nextPaymentStatus: PaymentStatus } | { ok: false; error: RefundError } {
  if (order.replacedByOrderId) return { ok: false, error: "replaced" };
  if (!REFUNDABLE_PAYMENT.includes(order.paymentStatus)) return { ok: false, error: "not_paid" };
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return { ok: false, error: "amount_invalid" };
  const refundable = refundableMinor(order);
  if (input.amountMinor > refundable) return { ok: false, error: "exceeds_refundable" };
  const seen = new Set<string>();
  for (const r of input.lines) {
    const line = lines.find((l) => l.id === r.orderLineId);
    if (!line || seen.has(r.orderLineId) || !Number.isInteger(r.quantity) || r.quantity <= 0 || r.quantity > line.currentQuantity - line.refundedQuantity) return { ok: false, error: "line_invalid" };
    seen.add(r.orderLineId);
  }
  const next = order.refundedMinor + input.amountMinor;
  return { ok: true, refundableMinor: refundable, nextRefundedMinor: next, nextPaymentStatus: paymentStatusAfterRefund(order, next) };
}

/* ---------- payment fees: actual when known ---------- */

export type PaymentFeeSource = "actual" | "estimate";

/** The fee the gateway actually charged (from payouts) when known, else the tenant's estimate. */
export function resolvePaymentFee(estimateMinor: number, actualMinor: number | null | undefined): { feeMinor: number; source: PaymentFeeSource } {
  return actualMinor === null || actualMinor === undefined ? { feeMinor: estimateMinor, source: "estimate" } : { feeMinor: actualMinor, source: "actual" };
}

/* ---------- payouts ---------- */

export const PAYOUT_STATUSES = ["scheduled", "in_transit", "paid", "failed", "canceled"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const BALANCE_TRANSACTION_TYPES = ["charge", "refund", "adjustment", "dispute", "reserve", "other"] as const;
export type BalanceTransactionType = (typeof BALANCE_TRANSACTION_TYPES)[number];

export interface PayoutTotals {
  grossMinor: number;
  refundsMinor: number;
  adjustmentsMinor: number;
  feesMinor: number;
  netMinor: number;
  transactions: number;
}

/**
 * What a deposit is made of: charges (gross), refunds and adjustments (negative amounts), fees.
 * net = Σ amount − Σ fee, which is what reaches the bank.
 */
export function payoutTotals(txns: readonly { type: string; amountMinor: number; feeMinor: number }[]): PayoutTotals {
  const t: PayoutTotals = { grossMinor: 0, refundsMinor: 0, adjustmentsMinor: 0, feesMinor: 0, netMinor: 0, transactions: txns.length };
  for (const x of txns) {
    if (x.type === "charge") t.grossMinor += x.amountMinor;
    else if (x.type === "refund") t.refundsMinor += x.amountMinor;
    else t.adjustmentsMinor += x.amountMinor;
    t.feesMinor += x.feeMinor;
    t.netMinor += x.amountMinor - x.feeMinor;
  }
  return t;
}

/* ---------- tax report ---------- */

/**
 * Effective tax rate of an order in basis points, rounded to 0.1 %. With the tax the platform
 * reported, the base is the goods after discounts (net of tax when prices include it); with no
 * tax reported, the rate the P/L applied (tenant rate for the country, or 0).
 */
export function effectiveTaxRateBps(o: { taxMinor: number; subtotalMinor: number; discountMinor: number; pricesIncludeTax: boolean; platformTaxMinor: number; fallbackRateBps: number }): number {
  if (o.platformTaxMinor <= 0) return o.taxMinor > 0 ? Math.max(0, o.fallbackRateBps) : 0;
  const goods = Math.max(0, o.subtotalMinor - o.discountMinor);
  const base = o.pricesIncludeTax ? goods - o.platformTaxMinor : goods;
  if (base <= 0) return Math.max(0, o.fallbackRateBps);
  return Math.round((o.platformTaxMinor * 10_000) / base / 10) * 10;
}

export interface TaxReportInput {
  inScope: boolean;
  country: string | null;
  rateBps: number;
  grossRevenueMinor: number;
  taxMinor: number;
  refundedMinor: number;
}
export interface TaxReportRow {
  country: string | null;
  rateBps: number;
  orders: number;
  grossMinor: number;
  /** Sales net of tax (the taxable base, shipping included as it is in the gross). */
  taxableMinor: number;
  taxMinor: number;
  /** Tax share of the refunds on these orders (informative: the P/L tax line is the tax charged). */
  refundedTaxMinor: number;
  netTaxMinor: number;
}

/**
 * Tax by country and rate over the sale orders of a period. Built from the same economics rows as
 * the P/L, so the tax column adds up to the P/L tax line by construction.
 */
export function taxReport(rows: readonly TaxReportInput[]): { rows: TaxReportRow[]; totals: Omit<TaxReportRow, "country" | "rateBps"> } {
  const acc = new Map<string, TaxReportRow>();
  const totals = { orders: 0, grossMinor: 0, taxableMinor: 0, taxMinor: 0, refundedTaxMinor: 0, netTaxMinor: 0 };
  for (const r of rows) {
    if (!r.inScope) continue;
    const key = `${r.country ?? ""}|${r.rateBps}`;
    const cur = acc.get(key) ?? { country: r.country, rateBps: r.rateBps, orders: 0, grossMinor: 0, taxableMinor: 0, taxMinor: 0, refundedTaxMinor: 0, netTaxMinor: 0 };
    const refundedTax = r.grossRevenueMinor > 0 ? Math.round((Math.min(r.refundedMinor, r.grossRevenueMinor) * r.taxMinor) / r.grossRevenueMinor) : 0;
    for (const target of [cur, totals]) {
      target.orders++;
      target.grossMinor += r.grossRevenueMinor;
      target.taxableMinor += r.grossRevenueMinor - r.taxMinor;
      target.taxMinor += r.taxMinor;
      target.refundedTaxMinor += refundedTax;
      target.netTaxMinor += r.taxMinor - refundedTax;
    }
    acc.set(key, cur);
  }
  const out = [...acc.values()].sort((a, b) => (a.country ?? "~").localeCompare(b.country ?? "~") || b.rateBps - a.rateBps);
  return { rows: out, totals };
}

/* ---------- payment-method breakdown ---------- */

export interface MethodBreakdownInput {
  paymentMethod: string;
  status: string;
  inScope: boolean;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  paymentFeeMinor: number;
  paymentFeeSource: PaymentFeeSource;
}
export interface MethodBreakdownRow {
  method: PaymentMethod;
  placedOrders: number;
  orders: number;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  aovMinor: number | null;
  cancelledOrders: number;
  returnedOrders: number;
  cancelRate: number | null;
  returnRate: number | null;
  feesMinor: number;
  actualFeesMinor: number;
  estimatedFeesMinor: number;
  /** Sale orders whose fee is still the estimate. */
  estimatedFeeOrders: number;
  feeRate: number | null;
  revenueShare: number | null;
}

const RETURNED: readonly string[] = ["returned", "returned_partial", "refunded"];

/**
 * Orders, revenue, cancel and return rates and fees per normalized payment method. Every canonical
 * method gets a row in the canonical order, so no method is singled out; rates use the same
 * definitions as the KPI dashboard (cancelled / placed, returned / (sales + returned)).
 */
export function paymentMethodBreakdown(rows: readonly MethodBreakdownInput[]): MethodBreakdownRow[] {
  const out = new Map<string, MethodBreakdownRow>(PAYMENT_METHODS.map((m) => [m, { method: m, placedOrders: 0, orders: 0, grossRevenueMinor: 0, netRevenueMinor: 0, aovMinor: null, cancelledOrders: 0, returnedOrders: 0, cancelRate: null, returnRate: null, feesMinor: 0, actualFeesMinor: 0, estimatedFeesMinor: 0, estimatedFeeOrders: 0, feeRate: null, revenueShare: null }]));
  for (const r of rows) {
    const row = out.get((PAYMENT_METHODS as readonly string[]).includes(r.paymentMethod) ? r.paymentMethod : "other")!;
    row.placedOrders++;
    if (r.status === "cancelled") row.cancelledOrders++;
    if (RETURNED.includes(r.status)) row.returnedOrders++;
    if (!r.inScope) continue;
    row.orders++;
    row.grossRevenueMinor += r.grossRevenueMinor;
    row.netRevenueMinor += r.netRevenueMinor;
    row.feesMinor += r.paymentFeeMinor;
    if (r.paymentFeeSource === "actual") row.actualFeesMinor += r.paymentFeeMinor;
    else {
      row.estimatedFeesMinor += r.paymentFeeMinor;
      row.estimatedFeeOrders++;
    }
  }
  const totalNet = [...out.values()].reduce((s, r) => s + r.netRevenueMinor, 0);
  for (const row of out.values()) {
    row.aovMinor = row.orders ? Math.round(row.grossRevenueMinor / row.orders) : null;
    row.cancelRate = safeDiv(row.cancelledOrders, row.placedOrders);
    row.returnRate = safeDiv(row.returnedOrders, row.orders + row.returnedOrders);
    row.feeRate = safeDiv(row.feesMinor, row.grossRevenueMinor);
    row.revenueShare = safeDiv(row.netRevenueMinor, totalNet);
  }
  return [...out.values()];
}

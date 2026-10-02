import { NON_SALE_STATUSES, type OrderStatus } from "./domain";

/**
 * Server-side conversions after the purchase (issue #82): when an order whose purchase was sent to
 * an ad platform is cancelled or refunded, the platform is told, once per order, platform and kind.
 * A retraction withdraws the conversion; a restatement replaces its value after a partial refund.
 * Which of the two a platform accepts is the sink's business (`ConversionAdjustmentSupport`).
 */
export const CONVERSION_KINDS = ["purchase", "retraction", "restatement"] as const;
export type ConversionKind = (typeof CONVERSION_KINDS)[number];
export type ConversionAdjustmentKind = Exclude<ConversionKind, "purchase">;

export interface ConversionAdjustmentSupport {
  retraction: boolean;
  restatement: boolean;
}

/** What the order looks like now. */
export interface OrderConversionFacts {
  status: OrderStatus | string;
  cancelled: boolean;
  paymentStatus: string;
  totalMinor: number;
  refundedMinor: number;
}

/** The order no longer counts as a sale: cancelled, fully refunded or fully returned. */
export function isOrderWithdrawn(o: OrderConversionFacts): boolean {
  if (o.cancelled) return true;
  if ((NON_SALE_STATUSES as readonly string[]).includes(o.status)) return true;
  if (o.paymentStatus === "refunded" || o.paymentStatus === "voided") return true;
  return o.totalMinor > 0 && o.refundedMinor >= o.totalMinor;
}

/** A queued purchase that has not reached the platform yet is dropped when the order stopped being a sale. */
export function purchaseStillDue(o: OrderConversionFacts): boolean {
  return !isOrderWithdrawn(o);
}

/** The conversion value after refunds: what the platform should hold for a partially refunded order. */
export function restatedValueMinor(sentValueMinor: number, refundedMinor: number): number {
  return Math.max(0, sentValueMinor - Math.max(0, refundedMinor));
}

export interface AdjustmentDecisionInput {
  /** The purchase row of this order and platform, if any; only a `sent` purchase can be adjusted. */
  purchase: { status: string; valueMinor: number | null } | null;
  order: OrderConversionFacts;
  /** A retraction already exists for this order and platform (any status): retractions are final. */
  retracted: boolean;
  /** Value of the restatement already queued or sent, if any. */
  restatedValueMinor: number | null;
  support: ConversionAdjustmentSupport;
}

export type AdjustmentDecision =
  | { kind: "none"; why: "purchase_not_sent" | "already_retracted" | "still_full_sale" | "unchanged" }
  | { kind: "retraction"; send: boolean; reason: "unsupported" | null }
  | { kind: "restatement"; valueMinor: number; send: boolean; reason: "unsupported" | null };

/**
 * One decision per (order, platform). A withdrawn order gets a retraction (skipped as `unsupported`
 * when the platform has no such mechanism); a partial refund gets a restatement to the remaining
 * value, re-armed only when that value changes; anything else needs nothing.
 */
export function decideConversionAdjustment(input: AdjustmentDecisionInput): AdjustmentDecision {
  if (!input.purchase || input.purchase.status !== "sent") return { kind: "none", why: "purchase_not_sent" };
  if (input.retracted) return { kind: "none", why: "already_retracted" };
  if (isOrderWithdrawn(input.order)) return { kind: "retraction", send: input.support.retraction, reason: input.support.retraction ? null : "unsupported" };
  if (input.order.refundedMinor <= 0) return { kind: "none", why: "still_full_sale" };
  const sent = input.purchase.valueMinor ?? input.order.totalMinor;
  const value = restatedValueMinor(sent, input.order.refundedMinor);
  if (value >= sent) return { kind: "none", why: "still_full_sale" };
  if (input.restatedValueMinor !== null && input.restatedValueMinor === value) return { kind: "none", why: "unchanged" };
  return { kind: "restatement", valueMinor: value, send: input.support.restatement, reason: input.support.restatement ? null : "unsupported" };
}

/** Event id of an adjustment row: the purchase's id plus the kind, so the delivery log is unique per (order, platform, kind). */
export function adjustmentEventId(purchaseEventId: string, kind: ConversionAdjustmentKind): string {
  return `${purchaseEventId}:${kind}`;
}

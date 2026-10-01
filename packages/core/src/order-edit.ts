import { OPEN_STATUSES, type OrderStatus } from "./domain";

/**
 * Order editing rules (issue #22): what can change on an existing order, how a discount is
 * computed, how replacement lines are built, which orders can be merged. Pure, no I/O; the
 * service in `packages/services/src/orders/edit.ts` applies them. Payment-method agnostic.
 */

export type OrderEditBlock = "cancelled" | "replaced" | "fulfilled" | "closed";

export interface EditableOrderFacts {
  status: OrderStatus | string;
  cancelledAt: Date | null;
  replacedByOrderId?: string | null;
  fulfillmentStatusRaw: string | null;
  /** Shipments known for the order (any source). */
  shipmentCount: number;
}

/** Raw fulfillment statuses that still mean "nothing left the warehouse". */
const UNFULFILLED_RAW = new Set(["", "null", "unfulfilled", "pending", "scheduled", "on_hold", "open"]);

/**
 * An order can be edited while nothing has been fulfilled: not cancelled, not already replaced,
 * no shipment, no fulfillment on the platform, and in an open canonical status.
 */
export function orderEditBlock(o: EditableOrderFacts): OrderEditBlock | null {
  if (o.replacedByOrderId) return "replaced";
  if (o.cancelledAt || o.status === "cancelled") return "cancelled";
  if (o.shipmentCount > 0 || !UNFULFILLED_RAW.has((o.fulfillmentStatusRaw ?? "").toLowerCase())) return "fulfilled";
  if (!(OPEN_STATUSES as readonly string[]).includes(o.status) || o.status === "fulfilling") return "closed";
  return null;
}

export const isOrderEditable = (o: EditableOrderFacts): boolean => orderEditBlock(o) === null;

/** A replaced order is lineage, not demand: it never counts in KPIs, P/L or customer history. */
export function isReplacedOrder(o: { replacedByOrderId?: string | null }): boolean {
  return Boolean(o.replacedByOrderId);
}

/* ---------- discount on an existing order ---------- */

export type OrderDiscountKind = "percentage" | "fixed_amount";
export interface OrderDiscountInput {
  type: OrderDiscountKind;
  /** Percentage in basis points (1000 = 10%) or a fixed amount in minor units. */
  value: number;
}
export interface OrderAmounts {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

/**
 * Amount of a discount applied on top of the existing ones. A percentage applies to the items
 * still due after earlier discounts (shipping excluded); a fixed amount is capped there, so the
 * items never go below zero. Rounded half up to the minor unit.
 */
export function orderDiscountAmount(order: OrderAmounts, d: OrderDiscountInput): number {
  const base = Math.max(0, order.subtotalMinor - order.discountMinor);
  if (!Number.isFinite(d.value) || d.value <= 0 || base === 0) return 0;
  if (d.type === "percentage") return Math.min(base, Math.round((base * Math.min(d.value, 10_000)) / 10_000));
  return Math.min(base, Math.round(d.value));
}

/** Order totals after a discount: discount added, total reduced by the same amount. */
export function applyDiscountToAmounts(order: OrderAmounts, amountMinor: number): OrderAmounts {
  const amount = Math.max(0, Math.min(amountMinor, Math.max(0, order.subtotalMinor - order.discountMinor)));
  return { ...order, discountMinor: order.discountMinor + amount, totalMinor: Math.max(0, order.totalMinor - amount) };
}

/** Code shown on the platform and in Keel for a manual discount, e.g. `KEEL-10%` or `KEEL-5.00`. */
export function orderDiscountCode(d: OrderDiscountInput, code?: string | null): string {
  const custom = (code ?? "").trim();
  if (custom) return custom.slice(0, 60);
  return d.type === "percentage" ? `KEEL-${+(d.value / 100).toFixed(2)}%` : `KEEL-${(d.value / 100).toFixed(2)}`;
}

/* ---------- replacement lines and merges ---------- */

export interface EditLine {
  variantId: string | null;
  quantity: number;
  unitPriceMinor: number;
  title: string;
  sku: string | null;
}

const lineKey = (xs: readonly { variantId: string | null; quantity: number }[]) => JSON.stringify(xs.filter((x) => x.quantity > 0).map((x) => [x.variantId, x.quantity]).sort());

/** Whether the desired lines differ from the current ones (by variant and quantity). */
export function linesDiffer(current: readonly { variantId: string | null; quantity: number }[], desired: readonly { variantId: string | null; quantity: number }[]): boolean {
  return lineKey(current) !== lineKey(desired);
}

/**
 * Lines of a replacement order: the desired lines of the edited order, plus the open lines of the
 * merged orders. Same variant at the same price is folded into one line; anything else is kept.
 */
export function mergeLines(base: readonly EditLine[], extra: readonly EditLine[]): EditLine[] {
  const out = base.filter((l) => l.quantity > 0).map((l) => ({ ...l }));
  for (const l of extra) {
    if (l.quantity <= 0) continue;
    const hit = out.find((x) => x.variantId && x.variantId === l.variantId && x.unitPriceMinor === l.unitPriceMinor);
    if (hit) hit.quantity += l.quantity;
    else out.push({ ...l });
  }
  return out;
}

export interface MergeFacts extends EditableOrderFacts {
  id: string;
  customerId: string | null;
  emailNormalized: string | null;
  phoneE164: string | null;
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
}

export type MergeBlock = "same_order" | "not_editable" | "other_customer" | "currency" | "payment";

/**
 * Whether `other` can be folded into `target`: both editable, same person (customer, email or
 * phone), same currency, and the same payment method and status, so the replacement can carry one
 * payment state without moving money.
 */
export function mergeBlock(target: MergeFacts, other: MergeFacts): MergeBlock | null {
  if (other.id === target.id) return "same_order";
  if (!isOrderEditable(other) || !isOrderEditable(target)) return "not_editable";
  const same = (target.customerId && other.customerId === target.customerId) || (target.emailNormalized && other.emailNormalized === target.emailNormalized) || (target.phoneE164 && other.phoneE164 === target.phoneE164);
  if (!same) return "other_customer";
  if (other.currency !== target.currency) return "currency";
  if (other.paymentMethod !== target.paymentMethod || other.paymentStatus !== target.paymentStatus) return "payment";
  return null;
}

/**
 * Money to settle after a replacement of a paid order: positive when the customer owes more (new
 * total above what was paid), negative when part of the payment is due back. Zero for unpaid orders.
 */
export function replacementBalance(paid: boolean, paidTotalMinor: number, newTotalMinor: number): number {
  return paid ? newTotalMinor - paidTotalMinor : 0;
}

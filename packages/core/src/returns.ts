import { RETURN_STATUSES, type ReturnStatus } from "./domain";

/** Workflow: requested → approved → received → inspected → (refunded | exchanged | voucher_issued); rejected from any open state. */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  requested: ["approved", "rejected"],
  approved: ["received", "rejected"],
  received: ["inspected", "rejected"],
  inspected: ["refunded", "exchanged", "voucher_issued", "rejected"],
  refunded: [],
  exchanged: [],
  voucher_issued: [],
  rejected: [],
};
export const RETURN_CLOSED_STATUSES: readonly ReturnStatus[] = ["refunded", "exchanged", "voucher_issued", "rejected"];
export const RETURN_GOODS_BACK_STATUSES: readonly ReturnStatus[] = ["received", "inspected", "refunded", "exchanged", "voucher_issued"];

export function canTransitionReturn(from: string, to: string): boolean {
  return (RETURN_TRANSITIONS[from as ReturnStatus] ?? []).includes(to as ReturnStatus);
}
export function isReturnClosed(status: string): boolean {
  return RETURN_CLOSED_STATUSES.includes(status as ReturnStatus);
}
export function isReturnStatus(s: string): s is ReturnStatus {
  return (RETURN_STATUSES as readonly string[]).includes(s);
}

export interface EligibilityInput {
  orderStatus: string;
  deliveredAt: Date | null;
  shippedAt: Date | null;
  now: Date;
  windowDays: number;
  shippingFallbackDays: number;
}
export interface Eligibility {
  eligible: boolean;
  /** cancelled | not_delivered | expired */
  reason: "cancelled" | "not_delivered" | "expired" | null;
  deliveryDate: Date | null;
  deadline: Date | null;
  daysLeft: number | null;
}

/** Delivery = delivered_at, or shipped_at + fallback days; deadline = delivery + window. Staff can override with a note. */
export function returnEligibility(i: EligibilityInput): Eligibility {
  if (i.orderStatus === "cancelled" || i.orderStatus === "refunded") return { eligible: false, reason: "cancelled", deliveryDate: null, deadline: null, daysLeft: null };
  const delivery = i.deliveredAt ?? (i.shippedAt ? new Date(i.shippedAt.getTime() + i.shippingFallbackDays * 864e5) : null);
  if (!delivery || delivery.getTime() > i.now.getTime()) return { eligible: false, reason: "not_delivered", deliveryDate: delivery, deadline: null, daysLeft: null };
  const deadline = new Date(delivery.getTime() + i.windowDays * 864e5);
  const daysLeft = Math.floor((deadline.getTime() - i.now.getTime()) / 864e5);
  if (deadline.getTime() < i.now.getTime()) return { eligible: false, reason: "expired", deliveryDate: delivery, deadline, daysLeft };
  return { eligible: true, reason: null, deliveryDate: delivery, deadline, daysLeft };
}

export interface ReturnableLineInput {
  id: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  productType: string | null;
  isAncillary?: boolean;
}
export interface ReturnableLine extends ReturnableLineInput {
  alreadyReturned: number;
  returnable: number;
  /** Unit amount net of the order discount, allocated pro rata over the line totals. */
  unitNetMinor: number;
  excluded: boolean;
}

/** Returnable quantity net of previous non-rejected returns; unit refund value shares the order discount pro rata. */
export function returnableLines(lines: ReturnableLineInput[], orderDiscountMinor: number, previouslyReturned: Record<string, number>, excludedProductTypes: string[] = []): ReturnableLine[] {
  const base = lines.filter((l) => !l.isAncillary).reduce((s, l) => s + l.totalMinor, 0);
  const ratio = base > 0 ? Math.min(orderDiscountMinor / base, 1) : 0;
  const excluded = new Set(excludedProductTypes.map((x) => x.toLowerCase()));
  return lines.map((l) => {
    const already = previouslyReturned[l.id] ?? 0;
    const ex = l.isAncillary === true || (l.productType !== null && excluded.has(l.productType.toLowerCase()));
    return { ...l, alreadyReturned: already, returnable: ex ? 0 : Math.max(0, l.quantity - already), unitNetMinor: Math.round(l.unitPriceMinor * (1 - ratio)), excluded: ex };
  });
}

/** Share of the order's goods that came back, in basis points, from returned quantities over ordered quantities. */
export function returnedFractionBps(orderLines: { id: string; quantity: number }[], returnedQty: Record<string, number>): number {
  const ordered = orderLines.reduce((s, l) => s + l.quantity, 0);
  if (ordered <= 0) return 0;
  const returned = orderLines.reduce((s, l) => s + Math.min(l.quantity, returnedQty[l.id] ?? 0), 0);
  return Math.min(10000, Math.round((returned / ordered) * 10000));
}

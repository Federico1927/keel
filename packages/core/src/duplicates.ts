/** Duplicate order detection: same person, close in time, overlapping products (CLAUDE.md §7.1). */
export interface DuplicateCandidateLine {
  variantId: string | null;
  productId: string | null;
  sku: string | null;
  title: string;
  isAncillary: boolean;
}
export interface DuplicateCandidateOrder {
  id: string;
  placedAt: Date;
  customerId: string | null;
  emailNormalized: string | null;
  phoneE164: string | null;
  cancelledAt: Date | null;
  status: string;
  replacesOrderId?: string | null;
  replacedByOrderId?: string | null;
  lines: DuplicateCandidateLine[];
}

export type DuplicateMatch = { orderId: string; matchType: "same_variant" | "same_product"; identityVia: ("customer" | "email" | "phone")[] };

export function findDuplicateOrders(target: DuplicateCandidateOrder, candidates: readonly DuplicateCandidateOrder[], windowDays: number): DuplicateMatch[] {
  const windowMs = windowDays * 864e5;
  const out: DuplicateMatch[] = [];
  const targetLines = target.lines.filter((l) => !l.isAncillary);
  for (const c of candidates) {
    if (c.id === target.id) continue;
    if (c.id === target.replacesOrderId || c.id === target.replacedByOrderId || c.replacedByOrderId) continue;
    if (Math.abs(c.placedAt.getTime() - target.placedAt.getTime()) > windowMs) continue;
    if (c.cancelledAt || ["cancelled", "refunded", "returned"].includes(c.status)) continue;
    const identityVia: DuplicateMatch["identityVia"] = [];
    if (target.customerId && c.customerId === target.customerId) identityVia.push("customer");
    if (target.emailNormalized && c.emailNormalized === target.emailNormalized) identityVia.push("email");
    if (target.phoneE164 && c.phoneE164 === target.phoneE164) identityVia.push("phone");
    if (identityVia.length === 0) continue;
    const lines = c.lines.filter((l) => !l.isAncillary);
    const sameVariant = targetLines.some((a) => lines.some((b) => (a.variantId && a.variantId === b.variantId) || (a.sku && a.sku === b.sku)));
    const sameProduct = sameVariant || targetLines.some((a) => lines.some((b) => (a.productId && a.productId === b.productId) || a.title.trim().toLowerCase() === b.title.trim().toLowerCase()));
    if (!sameProduct) continue;
    out.push({ orderId: c.id, matchType: sameVariant ? "same_variant" : "same_product", identityVia });
  }
  return out;
}

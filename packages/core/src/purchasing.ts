/** Purchase order rules: what can be edited or deleted, inspection at receipt, supplier link state. */

/** Lines and header of a PO can be replaced while the goods are not on their way. */
export const PO_EDITABLE_STATUSES = ["draft", "sent"] as const;
/** Only POs that never moved stock or money can disappear. */
export const PO_DELETABLE_STATUSES = ["draft", "cancelled"] as const;

export const canEditPo = (status: string) => (PO_EDITABLE_STATUSES as readonly string[]).includes(status);
export const canDeletePo = (status: string) => (PO_DELETABLE_STATUSES as readonly string[]).includes(status);

export interface InspectionInput {
  /** Units still expected on the line (ordered − already arrived). */
  remaining: number;
  /** Units that arrived now (good + damaged + rejected). */
  received: number;
  damaged?: number;
  rejected?: number;
}

export interface InspectionResult {
  received: number;
  damaged: number;
  rejected: number;
  /** Units that go to stock and update the cost. */
  good: number;
}

/**
 * Inspection of one line at receipt. Arrived units are capped at what is still expected; damaged
 * and rejected units are part of what arrived (never more), and only the rest goes to stock.
 */
export function inspectReceipt(i: InspectionInput): InspectionResult {
  const int = (n: number | undefined) => Math.max(0, Math.floor(Number.isFinite(n) ? (n as number) : 0));
  const received = Math.min(int(i.received), int(i.remaining));
  const damaged = Math.min(int(i.damaged), received);
  const rejected = Math.min(int(i.rejected), received - damaged);
  return { received, damaged, rejected, good: received - damaged - rejected };
}

export interface PoLineSnapshot {
  variantId: string | null;
  description: string | null;
  quantity: number;
  unitCostMinor: number;
}

/** Line changes of an edit, keyed by variant id or free-text description, for the audit diff. */
export function poLinesDiff(before: readonly PoLineSnapshot[], after: readonly PoLineSnapshot[]): { added: PoLineSnapshot[]; removed: PoLineSnapshot[]; changed: { key: string; from: { quantity: number; unitCostMinor: number }; to: { quantity: number; unitCostMinor: number } }[] } {
  const keyOf = (l: PoLineSnapshot) => (l.variantId ? `v:${l.variantId}` : `t:${(l.description ?? "").trim().toLowerCase()}`);
  const sum = (lines: readonly PoLineSnapshot[]) => {
    const m = new Map<string, PoLineSnapshot>();
    for (const l of lines) {
      const cur = m.get(keyOf(l));
      m.set(keyOf(l), cur ? { ...cur, quantity: cur.quantity + l.quantity } : { ...l });
    }
    return m;
  };
  const a = sum(before);
  const b = sum(after);
  const added = [...b].filter(([k]) => !a.has(k)).map(([, l]) => l);
  const removed = [...a].filter(([k]) => !b.has(k)).map(([, l]) => l);
  const changed = [...b]
    .filter(([k, l]) => a.has(k) && (a.get(k)!.quantity !== l.quantity || a.get(k)!.unitCostMinor !== l.unitCostMinor))
    .map(([k, l]) => ({ key: k, from: { quantity: a.get(k)!.quantity, unitCostMinor: a.get(k)!.unitCostMinor }, to: { quantity: l.quantity, unitCostMinor: l.unitCostMinor } }));
  return { added, removed, changed };
}

export type SupplierLinkState = "active" | "expired" | "revoked";

/** A supplier link is revoked once revoked, expired after its expiry, active otherwise. */
export function supplierLinkState(link: { expiresAt: Date; revokedAt: Date | null }, now: Date): SupplierLinkState {
  if (link.revokedAt) return "revoked";
  return link.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

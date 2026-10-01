/** Inventory maths (CLAUDE.md §7.6). Formulas from the reference platform, parameters from tenant settings. */
export type StockRisk = "critical" | "warning" | "ok" | "no_sales";

export interface VelocityInput {
  unitsSold: number;
  lookbackDays: number;
  available: number;
  incoming: number;
  criticalDays: number;
  warningDays: number;
}
export interface VelocityResult {
  velocityPerDay: number;
  effectiveStock: number;
  daysOfCover: number | null;
  risk: StockRisk;
}

export function stockVelocity(i: VelocityInput): VelocityResult {
  const lookback = Math.max(1, i.lookbackDays);
  const velocityPerDay = i.unitsSold / lookback;
  const effectiveStock = Math.max(0, i.available) + Math.max(0, i.incoming);
  if (i.unitsSold <= 0) {
    return { velocityPerDay: 0, effectiveStock, daysOfCover: null, risk: effectiveStock > 0 ? "no_sales" : "critical" };
  }
  const daysOfCover = effectiveStock / velocityPerDay;
  const risk: StockRisk = effectiveStock <= 0 || daysOfCover <= i.criticalDays ? "critical" : daysOfCover <= i.warningDays ? "warning" : "ok";
  return { velocityPerDay, effectiveStock, daysOfCover, risk };
}

/** Units to reorder to reach `targetDays` of cover, rounded up to the pack size when one exists. */
export function reorderSuggestion(velocityPerDay: number, effectiveStock: number, targetDays: number, packSize?: number | null): number {
  if (velocityPerDay <= 0) return 0;
  const needed = Math.max(0, Math.ceil(velocityPerDay * targetDays - effectiveStock));
  if (!packSize || packSize <= 1) return needed;
  return Math.ceil(needed / packSize) * packSize;
}

export const RISK_ORDER: Record<StockRisk, number> = { critical: 0, warning: 1, ok: 2, no_sales: 3 };
export function worstRisk(risks: readonly StockRisk[]): StockRisk {
  return risks.reduce<StockRisk>((w, r) => (RISK_ORDER[r] < RISK_ORDER[w] ? r : w), "no_sales");
}

/** Stock, incoming, committed and backorders for one variant; `cap` is what an order can still take. */
export interface CapacityInput {
  available: number;
  incoming: number;
  committedOpen: number;
  backorderOpen: number;
  originalInOrder?: number;
}
export function variantCapacity(c: CapacityInput) {
  const cap = Math.max(c.available + c.incoming + (c.originalInOrder ?? 0), 0);
  return { ...c, cap, netAvailable: c.available - c.committedOpen - c.backorderOpen };
}

/** Moving average cost after a receipt. Null previous cost → the receipt cost. */
export function movingAverageCost(prevAverage: number | null, prevQty: number, receivedQty: number, unitCost: number): number {
  if (receivedQty <= 0) return prevAverage ?? unitCost;
  if (prevAverage === null || prevQty <= 0) return unitCost;
  return Math.round((prevAverage * prevQty + unitCost * receivedQty) / (prevQty + receivedQty));
}

/** Backorder status after a stock change: fulfilled when on hand covers it, covered when incoming does. */
export function backorderStatus(quantity: number, available: number, incoming: number): "fulfilled" | "covered" | "pending" {
  if (available >= quantity) return "fulfilled";
  if (incoming > 0) return "covered";
  return "pending";
}

/** Allowed purchase order transitions. */
export const PO_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["sent", "cancelled"],
  sent: ["confirmed", "cancelled", "draft"],
  confirmed: ["in_transit", "partially_received", "received", "cancelled"],
  in_transit: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "partially_received"],
  received: [],
  cancelled: [],
};
export function canTransitionPo(from: string, to: string): boolean {
  return (PO_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Inventory control (issue #30): stock adjustments with a reason, stock-take review, unexplained
 * losses from the drift log, and markdown suggestions that never go below a minimum-margin floor.
 * Pure functions; the services in `packages/services/src/inventory/control.ts` apply them.
 */

/* ---------- adjustments ---------- */

/** Reason codes of a manual stock adjustment (`inventory_movements.reason_code`, reason `adjustment`). */
export const ADJUSTMENT_REASONS = ["damaged", "lost", "found", "count_correction", "other"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export function isAdjustmentReason(v: unknown): v is AdjustmentReason {
  return typeof v === "string" && (ADJUSTMENT_REASONS as readonly string[]).includes(v);
}

export type AdjustmentError = "zero" | "sign" | "negative_stock" | "note_required";

/**
 * Checks an adjustment before it is written: damaged and lost units leave stock, found units come
 * back, a count correction goes either way, "other" needs a note. Stock never goes below zero.
 */
export function validateAdjustment(input: { reason: AdjustmentReason; delta: number; current: number; note?: string | null }): { ok: true; next: number } | { ok: false; error: AdjustmentError } {
  const delta = Math.trunc(input.delta);
  if (!delta) return { ok: false, error: "zero" };
  if ((input.reason === "damaged" || input.reason === "lost") && delta > 0) return { ok: false, error: "sign" };
  if (input.reason === "found" && delta < 0) return { ok: false, error: "sign" };
  if (input.reason === "other" && !input.note?.trim()) return { ok: false, error: "note_required" };
  const next = input.current + delta;
  if (next < 0) return { ok: false, error: "negative_stock" };
  return { ok: true, next };
}

/* ---------- stock-take ---------- */

export type StockTakeLineStatus = "match" | "missing" | "surplus" | "unknown";

export interface StockTakeCount {
  /** Count row id. */
  id: string;
  /** Null when the scanned code matched no variant. */
  variantId: string | null;
  counted: number;
}

export interface StockTakeReviewRow extends StockTakeCount {
  /** Units Hullwise has at the location (null for an unknown code). */
  expected: number | null;
  /** counted − expected (0 for an unknown code: nothing to apply). */
  delta: number;
  status: StockTakeLineStatus;
}

export interface StockTakeReview {
  rows: StockTakeReviewRow[];
  summary: { match: number; missing: number; surplus: number; unknown: number; unitsMissing: number; unitsSurplus: number };
}

/**
 * Compares counted quantities with the levels at the location. Only counted variants are reviewed
 * (a partial count leaves the others alone): fewer units than expected are missing, more are
 * surplus, a code that matched no variant is unknown and never applied.
 */
export function reviewStockTake(counts: readonly StockTakeCount[], expected: ReadonlyMap<string, number>): StockTakeReview {
  const summary = { match: 0, missing: 0, surplus: 0, unknown: 0, unitsMissing: 0, unitsSurplus: 0 };
  const rows = counts.map((c): StockTakeReviewRow => {
    if (!c.variantId) {
      summary.unknown++;
      return { ...c, expected: null, delta: 0, status: "unknown" };
    }
    const exp = expected.get(c.variantId) ?? 0;
    const delta = c.counted - exp;
    const status: StockTakeLineStatus = delta === 0 ? "match" : delta < 0 ? "missing" : "surplus";
    summary[status]++;
    if (delta < 0) summary.unitsMissing -= delta;
    if (delta > 0) summary.unitsSurplus += delta;
    return { ...c, expected: exp, delta, status };
  });
  return { rows, summary };
}

/** A typed or scanned code, normalized for matching against SKU and barcode (case-insensitive). */
export function normalizeScanCode(code: string): string {
  return code.trim().replace(/\s+/g, " ").toLowerCase();
}

/* ---------- unexplained losses ---------- */

/**
 * Units lost according to one drift row: an unexplained fall, or a level the platform stopped
 * reporting. Increases and clamped negatives are not losses.
 */
export function driftLossUnits(kind: string, delta: number): number {
  return (kind === "unexplained" || kind === "not_reported") && delta < 0 ? -delta : 0;
}

/* ---------- markdowns ---------- */

/** Target markdown depth by situation (basis points of the regular price). */
export const MARKDOWN_DEPTHS_BPS = { excess: 1500, slow: 3000 } as const;

export interface PriceTax {
  taxRateBps: number;
  pricesIncludeTax: boolean;
}

/** Lowest price (in the store's price convention) whose margin on the net-of-tax price is at least `minMarginBps`. */
export function marginFloorPrice(costMinor: number, minMarginBps: number, tax: PriceTax): number {
  const m = Math.min(Math.max(0, Math.trunc(minMarginBps)), 9_999);
  const net = Math.ceil((Math.max(0, costMinor) * 10_000) / (10_000 - m));
  return tax.pricesIncludeTax ? Math.ceil((net * (10_000 + tax.taxRateBps)) / 10_000) : net;
}

/** Gross margin on the net-of-tax price, basis points (floored). Null for a zero price. */
export function marginBpsAt(priceMinor: number, costMinor: number, tax: PriceTax): number | null {
  if (priceMinor <= 0) return null;
  const den = tax.pricesIncludeTax ? 10_000 + tax.taxRateBps : 10_000;
  // net = price × 10000 / den; margin = (net − cost) / net
  return Math.floor(((priceMinor * 10_000 - costMinor * den) * 10_000) / (priceMinor * 10_000));
}

export interface MarkdownInput extends PriceTax {
  priceMinor: number;
  compareAtMinor: number | null;
  costMinor: number | null;
  available: number;
  unitsSold: number;
  /** Days of cover at the current pace (null: no sales in the window). */
  daysOfCover: number | null;
  minMarginBps: number;
  excessCoverDays: number;
  slowCoverDays: number;
  depths?: { excess: number; slow: number };
}

export type MarkdownSkipReason = "no_stock" | "not_excess" | "no_cost" | "floor" | "already_marked_down";
export type MarkdownReason = "no_sales" | "slow" | "excess";

export type MarkdownSuggestion =
  | {
      kind: "suggest";
      reason: MarkdownReason;
      /** Price before any markdown: the compare-at price when the variant is already marked down. */
      regularPriceMinor: number;
      priceMinor: number;
      compareAtMinor: number;
      targetDepthBps: number;
      discountBps: number;
      floorPriceMinor: number;
      marginBps: number | null;
      /** The target depth would have gone below the floor: the price stops at the floor. */
      clampedByFloor: boolean;
    }
  | { kind: "skip"; reason: MarkdownSkipReason; floorPriceMinor: number | null };

/**
 * Compare-at markdown for slow or excess stock. No sales or cover beyond `slowCoverDays` → the
 * deep markdown, cover beyond `excessCoverDays` → the light one. The new price never goes below the
 * minimum-margin floor computed from the variant cost; without a cost there is no suggestion.
 */
export function suggestMarkdown(i: MarkdownInput): MarkdownSuggestion {
  if (i.available <= 0) return { kind: "skip", reason: "no_stock", floorPriceMinor: null };
  const reason: MarkdownReason | null = i.unitsSold <= 0 || i.daysOfCover === null ? "no_sales" : i.daysOfCover >= i.slowCoverDays ? "slow" : i.daysOfCover > i.excessCoverDays ? "excess" : null;
  if (!reason) return { kind: "skip", reason: "not_excess", floorPriceMinor: null };
  if (i.costMinor === null || i.costMinor <= 0) return { kind: "skip", reason: "no_cost", floorPriceMinor: null };
  const tax = { taxRateBps: i.taxRateBps, pricesIncludeTax: i.pricesIncludeTax };
  const floor = marginFloorPrice(i.costMinor, i.minMarginBps, tax);
  const regular = i.compareAtMinor !== null && i.compareAtMinor > i.priceMinor ? i.compareAtMinor : i.priceMinor;
  const depths = i.depths ?? MARKDOWN_DEPTHS_BPS;
  const depth = reason === "excess" ? depths.excess : depths.slow;
  const target = Math.floor((regular * (10_000 - depth)) / 10_000);
  const price = Math.max(target, floor);
  if (price >= i.priceMinor) return { kind: "skip", reason: floor >= i.priceMinor ? "floor" : "already_marked_down", floorPriceMinor: floor };
  return { kind: "suggest", reason, regularPriceMinor: regular, priceMinor: price, compareAtMinor: regular, targetDepthBps: depth, discountBps: Math.round(((regular - price) * 10_000) / regular), floorPriceMinor: floor, marginBps: marginBpsAt(price, i.costMinor, tax), clampedByFloor: target < floor };
}

/**
 * The line a scanned code belongs to (#49: receiving a purchase order or a return by scanning):
 * the first candidate whose SKU or barcode equals the code, case and spacing ignored; the first
 * one still needing units when several lines share the code. Null when nothing matches.
 */
export function matchScanCode<T extends { codes: readonly (string | null | undefined)[]; open?: boolean }>(code: string, lines: readonly T[]): T | null {
  const norm = normalizeScanCode(code);
  if (!norm) return null;
  const hits = lines.filter((l) => l.codes.some((c) => c && normalizeScanCode(c) === norm));
  return hits.find((l) => l.open !== false) ?? hits[0] ?? null;
}

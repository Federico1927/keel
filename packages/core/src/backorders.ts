/**
 * Backorders (issue #26): an order line that stock cannot serve waits for an incoming purchase
 * order line. Pure rules only; the services read stock and write the rows.
 *
 * Stock model. `available` is the platform's number (units free for new orders, already net of
 * the units committed to orders the platform knows about), summed over locations as Hullwise last read
 * it. A level read before an order was placed does not reflect that order yet ("unreflected"), so
 * the units of earlier unreflected orders are taken off first. A level read after the order was
 * placed already took the order's units out; the only trace of a shortfall left there is
 * `committed > onHand` (platforms that report both).
 */

/** Backorder statuses that still hold an order. */
export const OPEN_BACKORDER_STATUSES = ["pending", "covered"] as const;
export const BACKORDER_STATUSES = ["pending", "covered", "fulfilled", "cancelled"] as const;
export type BackorderStatus = (typeof BACKORDER_STATUSES)[number];
export const isBackorderOpen = (s: string) => (OPEN_BACKORDER_STATUSES as readonly string[]).includes(s);

/** Reason the state engine records when an order is held for stock. */
export const AWAITING_STOCK_REASON = "hold:awaiting_stock";

export interface ShortageInput {
  quantity: number;
  /** Σ available over locations, as last read (plus units credited back, e.g. by a replaced order). */
  available: number;
  /** Units of earlier orders the level does not reflect yet (and that are not backordered themselves). */
  aheadUnits?: number;
  /** The level was read after this order was placed: its units are already out of `available`. */
  reflected?: boolean;
  /** For a reflected order: committed − on hand, minus units other backorders already account for. */
  overcommitted?: number;
}

/** Units of an order line stock cannot serve (0..quantity). */
export function lineShortage(i: ShortageInput): number {
  const q = Math.max(0, Math.floor(i.quantity));
  if (q === 0) return 0;
  if (i.reflected) return Math.min(q, Math.max(0, Math.floor(i.overcommitted ?? 0)));
  const free = Math.max(0, i.available - Math.max(0, i.aheadUnits ?? 0));
  return Math.min(q, Math.max(0, q - free));
}

export interface IncomingLine {
  id: string;
  /** Units still to arrive on the line (ordered − received). */
  remaining: number;
  /** Units already promised to other open backorders. */
  claimed: number;
  expectedAt: Date | null;
}

/**
 * The incoming PO line a backorder waits for: the earliest expected one whose unclaimed units
 * cover the whole shortage (lines without a date come last, then input order). None → the backorder
 * waits without a PO (status pending) until a purchase order can cover it.
 */
export function pickIncomingLine<T extends IncomingLine>(lines: readonly T[], quantity: number): T | null {
  const sorted = lines.map((l, i) => ({ l, i })).sort((a, b) => (a.l.expectedAt?.getTime() ?? Infinity) - (b.l.expectedAt?.getTime() ?? Infinity) || a.i - b.i);
  return sorted.find(({ l }) => l.remaining - l.claimed >= quantity)?.l ?? null;
}

/**
 * Which open backorders of one variant the free stock now covers: first fit in age order (oldest
 * first; one that does not fit does not block a smaller, younger one). Returns the ids released.
 */
export function allocateRelease(backorders: readonly { id: string; quantity: number }[], free: number): Set<string> {
  const out = new Set<string>();
  let left = Math.max(0, free);
  for (const b of backorders) {
    if (b.quantity <= left) {
      out.add(b.id);
      left -= b.quantity;
    }
  }
  return out;
}

/** Status of an open backorder after a re-check: covered while a PO line is waiting for it. */
export function openBackorderStatus(linkedToIncoming: boolean): "covered" | "pending" {
  return linkedToIncoming ? "covered" : "pending";
}

/* ---------- option × option stock grid ---------- */

export interface GridVariant {
  id: string;
  optionValues: Record<string, string>;
  available: number;
  incoming: number;
  committed: number;
}
export interface GridCell {
  available: number;
  incoming: number;
  committed: number;
  variantIds: string[];
}
export interface StockGrid {
  /** Option shown on rows / columns; null when the product has fewer options. */
  rowOption: string | null;
  colOption: string | null;
  rows: string[];
  cols: string[];
  /** cells[row][col]; a missing combination has no variant ids. */
  cells: GridCell[][];
  rowTotals: GridCell[];
  colTotals: GridCell[];
  total: GridCell;
  /** Options summed inside each cell (a product with three or more options). */
  folded: string[];
}

const emptyCell = (): GridCell => ({ available: 0, incoming: 0, committed: 0, variantIds: [] });
const addTo = (c: GridCell, v: GridVariant) => {
  c.available += v.available;
  c.incoming += v.incoming;
  c.committed += v.committed;
  c.variantIds.push(v.id);
};

/**
 * Stock of a product laid out by two of its options, whatever their names (size × colour, material ×
 * length, …). Other options are summed inside each cell. Values follow the product's option order,
 * then any value only the variants carry. Totals add up to the variants' levels by construction.
 */
export function optionStockGrid(options: readonly { name: string; values: readonly string[] }[], variants: readonly GridVariant[], pick: { rows?: string | null; cols?: string | null } = {}): StockGrid {
  const names = [...new Set([...options.map((o) => o.name), ...variants.flatMap((v) => Object.keys(v.optionValues))])];
  const rowOption = pick.rows && names.includes(pick.rows) ? pick.rows : (names[0] ?? null);
  const colOption = pick.cols && names.includes(pick.cols) && pick.cols !== rowOption ? pick.cols : (names.find((n) => n !== rowOption) ?? null);
  const valuesOf = (name: string | null) => {
    if (!name) return [""];
    const declared = options.find((o) => o.name === name)?.values ?? [];
    const seen = variants.map((v) => v.optionValues[name] ?? "").filter((x) => x !== "");
    const all = [...new Set([...declared, ...seen])];
    if (variants.some((v) => !v.optionValues[name])) all.push("");
    return all.length ? all : [""];
  };
  const rows = valuesOf(rowOption);
  const cols = valuesOf(colOption);
  const cells = rows.map(() => cols.map(emptyCell));
  const rowTotals = rows.map(emptyCell);
  const colTotals = cols.map(emptyCell);
  const total = emptyCell();
  for (const v of variants) {
    const r = rows.indexOf(rowOption ? (v.optionValues[rowOption] ?? "") : "");
    const c = cols.indexOf(colOption ? (v.optionValues[colOption] ?? "") : "");
    addTo(cells[r]![c]!, v);
    addTo(rowTotals[r]!, v);
    addTo(colTotals[c]!, v);
    addTo(total, v);
  }
  return { rowOption, colOption, rows, cols, cells, rowTotals, colTotals, total, folded: names.filter((n) => n !== rowOption && n !== colOption) };
}

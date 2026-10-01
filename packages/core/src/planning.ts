/**
 * Demand planning and replenishment. Pure functions over monthly / daily sales histories:
 * - `forecastDemand`: 12-month SKU forecast = level × trend × seasonality index, with event
 *   uplifts (Black Friday, promotions) and manual overrides per month;
 * - `safetyStock` / `reorderPlan`: service-level safety stock on lead-time demand, reorder point,
 *   order quantity rounded to MOQ and multiples;
 * - `allocateLandedCost`: duties, freight and fees spread over PO lines by value, quantity or weight;
 * - `cashOutSchedule`: when the money of a purchase plan leaves, from supplier payment terms;
 * - `abcXyz`: value class (ABC by cumulative share) × variability class (XYZ by coefficient of variation);
 * - `stockoutDate`: predicted day the stock runs out.
 */

/* ---------- forecast ---------- */

export interface MonthlySales {
  /** YYYY-MM */
  month: string;
  units: number;
}

export interface DemandEvent {
  /** YYYY-MM the event falls in */
  month: string;
  /** Multiplicative uplift, 0.35 = +35 % */
  uplift: number;
  label?: string;
}

export interface ForecastOptions {
  horizon?: number;
  /** Seasonality indices by calendar month (1..12 → factor around 1), e.g. from the category or tenant history. */
  seasonality?: Readonly<Record<number, number>>;
  events?: readonly DemandEvent[];
  /** Manual overrides: month → units, replacing the model. */
  overrides?: Readonly<Record<string, number>>;
  /** Cap the monthly trend (default ±8 %/month). */
  maxTrend?: number;
}

export interface ForecastPoint {
  month: string;
  units: number;
  base: number;
  seasonality: number;
  uplift: number;
  overridden: boolean;
}

const monthIndex = (m: string) => Number(m.slice(5, 7));
export function addMonthsKey(m: string, n: number): string {
  const y = Number(m.slice(0, 4));
  const mm = Number(m.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, mm, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Seasonality indices (mean 1) from a monthly history of at least 12 months; flat when shorter. */
export function seasonalityIndices(history: readonly MonthlySales[]): Record<number, number> {
  const flat = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1]));
  if (history.length < 12) return flat;
  const byMonth = new Map<number, number[]>();
  for (const h of history) {
    const arr = byMonth.get(monthIndex(h.month)) ?? [];
    arr.push(h.units);
    byMonth.set(monthIndex(h.month), arr);
  }
  const avg = history.reduce((s, h) => s + h.units, 0) / history.length;
  if (avg <= 0) return flat;
  const raw = Array.from({ length: 12 }, (_, i) => {
    const vals = byMonth.get(i + 1);
    return vals?.length ? vals.reduce((s, v) => s + v, 0) / vals.length / avg : 1;
  });
  const mean = raw.reduce((s, v) => s + v, 0) / 12;
  return Object.fromEntries(raw.map((v, i) => [i + 1, Math.round((v / mean) * 1000) / 1000]));
}

/**
 * Level = deseasonalised average of the last 3 months; trend = slope of the deseasonalised last
 * 6 months relative to the level, capped. Forecast month k = level × (1 + trend)^k × season × (1 + uplift).
 */
export function forecastDemand(history: readonly MonthlySales[], from: string, opts: ForecastOptions = {}): ForecastPoint[] {
  const horizon = opts.horizon ?? 12;
  const season = opts.seasonality ?? seasonalityIndices(history);
  const sorted = [...history].sort((a, b) => (a.month < b.month ? -1 : 1));
  const deseason = sorted.map((h) => h.units / (season[monthIndex(h.month)] || 1));
  const last3 = deseason.slice(-3);
  const level = last3.length ? last3.reduce((s, v) => s + v, 0) / last3.length : 0;
  const last6 = deseason.slice(-6);
  let trend = 0;
  if (last6.length >= 4 && level > 0) {
    const n = last6.length;
    const xMean = (n - 1) / 2;
    const yMean = last6.reduce((s, v) => s + v, 0) / n;
    const slope = last6.reduce((s, v, i) => s + (i - xMean) * (v - yMean), 0) / last6.reduce((s, _, i) => s + (i - xMean) ** 2, 0);
    const cap = opts.maxTrend ?? 0.08;
    trend = Math.max(-cap, Math.min(cap, slope / level));
  }
  const out: ForecastPoint[] = [];
  for (let k = 0; k < horizon; k++) {
    const month = addMonthsKey(from, k);
    const s = season[monthIndex(month)] ?? 1;
    const uplift = (opts.events ?? []).filter((e) => e.month === month).reduce((acc, e) => acc + e.uplift, 0);
    const base = level * Math.pow(1 + trend, k + 1);
    const model = Math.max(0, base * s * (1 + uplift));
    const override = opts.overrides?.[month];
    out.push({ month, units: Math.round(override ?? model), base: Math.round(base * 100) / 100, seasonality: s, uplift, overridden: override !== undefined });
  }
  return out;
}

/** Forecast accuracy on a holdout: weighted absolute percentage error (WAPE). */
export function wape(actual: readonly number[], forecast: readonly number[]): number | null {
  const den = actual.reduce((s, v) => s + Math.abs(v), 0);
  if (!den) return null;
  return actual.reduce((s, v, i) => s + Math.abs(v - (forecast[i] ?? 0)), 0) / den;
}

/* ---------- replenishment ---------- */

/** Inverse standard normal (Acklam) for service-level z values. */
export function zForServiceLevel(p: number): number {
  const q = Math.min(0.9999, Math.max(0.5, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (q > 1 - pl) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0]! * s + a[1]!) * s + a[2]!) * s + a[3]!) * s + a[4]!) * s + a[5]!) * r) / (((((b[0]! * s + b[1]!) * s + b[2]!) * s + b[3]!) * s + b[4]!) * s + 1);
}

/** Safety stock = z × sqrt(LT × σd² + d² × σLT²). Daily demand mean/sd, lead time mean/sd in days. */
export function safetyStock(i: { dailyMean: number; dailySd: number; leadTimeDays: number; leadTimeSdDays?: number; serviceLevel: number }): number {
  const z = zForServiceLevel(i.serviceLevel);
  const ltSd = i.leadTimeSdDays ?? 0;
  return Math.ceil(z * Math.sqrt(i.leadTimeDays * i.dailySd ** 2 + i.dailyMean ** 2 * ltSd ** 2));
}

export interface ReorderInput {
  available: number;
  incoming: number;
  /** Units already promised to open orders not yet allocated (backorders). */
  backordered?: number;
  dailyMean: number;
  dailySd: number;
  leadTimeDays: number;
  leadTimeSdDays?: number;
  serviceLevel: number;
  /** Days of demand to cover after the order arrives (review period / order cycle). */
  coverDays: number;
  moq?: number | null;
  multiple?: number | null;
  unitCostMinor?: number | null;
}

export interface ReorderPlan {
  safetyStock: number;
  reorderPoint: number;
  position: number;
  shouldOrder: boolean;
  quantity: number;
  costMinor: number | null;
  /** Days until stock-out at the current pace, ignoring incoming. */
  daysOfCover: number | null;
}

/** Order when position (on hand + incoming − backorders) falls to the reorder point; quantity covers lead time + cover days + safety. */
export function reorderPlan(i: ReorderInput): ReorderPlan {
  const ss = safetyStock({ dailyMean: i.dailyMean, dailySd: i.dailySd, leadTimeDays: i.leadTimeDays, leadTimeSdDays: i.leadTimeSdDays, serviceLevel: i.serviceLevel });
  const rop = Math.ceil(i.dailyMean * i.leadTimeDays + ss);
  const position = i.available + i.incoming - (i.backordered ?? 0);
  const target = Math.ceil(i.dailyMean * (i.leadTimeDays + i.coverDays) + ss);
  let qty = position <= rop ? Math.max(0, target - position) : 0;
  if (qty > 0) {
    if (i.moq && qty < i.moq) qty = i.moq;
    if (i.multiple && i.multiple > 1) qty = Math.ceil(qty / i.multiple) * i.multiple;
  }
  return { safetyStock: ss, reorderPoint: rop, position, shouldOrder: qty > 0, quantity: qty, costMinor: i.unitCostMinor != null ? qty * i.unitCostMinor : null, daysOfCover: i.dailyMean > 0 ? Math.max(0, i.available) / i.dailyMean : null };
}

/** Day index (from today) when stock runs out, and the date. */
export function stockoutDate(available: number, dailyMean: number, today: Date): { days: number | null; date: Date | null } {
  if (dailyMean <= 0) return { days: null, date: null };
  const days = Math.max(0, Math.floor(Math.max(0, available) / dailyMean));
  return { days, date: new Date(today.getTime() + days * 864e5) };
}

/* ---------- landed cost ---------- */

export interface LandedLine {
  id: string;
  quantity: number;
  unitCostMinor: number;
  weightGrams?: number | null;
}
export interface LandedCharge {
  kind: "duty" | "freight" | "fee" | "other";
  amountMinor: number;
  /** value (default) | quantity | weight */
  basis?: "value" | "quantity" | "weight";
}

/** Spreads each charge over the lines on its basis; returns the landed unit cost per line (rounding remainder on the largest line). */
export function allocateLandedCost(lines: readonly LandedLine[], charges: readonly LandedCharge[]): { id: string; extraMinor: number; landedUnitCostMinor: number }[] {
  const extra = new Map(lines.map((l) => [l.id, 0]));
  for (const ch of charges) {
    const basis = ch.basis ?? "value";
    const weightOf = (l: LandedLine) => (basis === "quantity" ? l.quantity : basis === "weight" ? (l.weightGrams ?? 0) * l.quantity : l.quantity * l.unitCostMinor);
    const total = lines.reduce((s, l) => s + weightOf(l), 0);
    if (total <= 0) continue;
    let given = 0;
    const shares = lines.map((l) => {
      const v = Math.floor((ch.amountMinor * weightOf(l)) / total);
      given += v;
      return v;
    });
    const rest = ch.amountMinor - given;
    const biggest = lines.reduce((bi, l, i) => (weightOf(l) > weightOf(lines[bi]!) ? i : bi), 0);
    shares[biggest]! += rest;
    lines.forEach((l, i) => extra.set(l.id, (extra.get(l.id) ?? 0) + shares[i]!));
  }
  return lines.map((l) => ({ id: l.id, extraMinor: extra.get(l.id) ?? 0, landedUnitCostMinor: l.quantity > 0 ? Math.round(l.unitCostMinor + (extra.get(l.id) ?? 0) / l.quantity) : l.unitCostMinor }));
}

/* ---------- cash flow ---------- */

export interface PaymentTerms {
  /** Share paid when the order is placed (deposit), 0..1 */
  depositShare: number;
  /** Days after receipt for the balance (e.g. 30, 60). */
  balanceDaysAfterReceipt: number;
}

export interface CashOut {
  date: string;
  amountMinor: number;
  kind: "deposit" | "balance";
  ref: string;
}

/** Cash leaving for each planned purchase: deposit on the order date, balance N days after expected receipt. */
export function cashOutSchedule(orders: readonly { ref: string; orderDate: Date; leadTimeDays: number; totalMinor: number; terms: PaymentTerms }[]): CashOut[] {
  const out: CashOut[] = [];
  for (const o of orders) {
    const deposit = Math.round(o.totalMinor * o.terms.depositShare);
    if (deposit > 0) out.push({ date: o.orderDate.toISOString().slice(0, 10), amountMinor: deposit, kind: "deposit", ref: o.ref });
    const balanceAt = new Date(o.orderDate.getTime() + (o.leadTimeDays + o.terms.balanceDaysAfterReceipt) * 864e5);
    if (o.totalMinor - deposit > 0) out.push({ date: balanceAt.toISOString().slice(0, 10), amountMinor: o.totalMinor - deposit, kind: "balance", ref: o.ref });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Cash out summed by month (YYYY-MM), with the running total. */
export function cashOutByMonth(items: readonly CashOut[]): { month: string; amountMinor: number; cumulativeMinor: number }[] {
  const map = new Map<string, number>();
  for (const i of items) map.set(i.date.slice(0, 7), (map.get(i.date.slice(0, 7)) ?? 0) + i.amountMinor);
  let cum = 0;
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, amountMinor]) => ((cum += amountMinor), { month, amountMinor, cumulativeMinor: cum }));
}

/* ---------- stock analysis ---------- */

export interface StockItem {
  id: string;
  /** Sales value over the analysis window (e.g. 12 months). */
  revenueMinor: number;
  /** Weekly or monthly unit sales for variability. */
  periodUnits: readonly number[];
  onHand: number;
  unitCostMinor: number;
  dailyMean: number;
}

export interface StockAnalysisRow {
  id: string;
  abc: "A" | "B" | "C";
  xyz: "X" | "Y" | "Z";
  cv: number | null;
  stockValueMinor: number;
  coverDays: number | null;
  /** Annualised turnover = COGS / average stock value, approximated with current stock. */
  turnover: number | null;
  excessUnits: number;
  slowMover: boolean;
}

/** ABC on cumulative revenue (80/15/5), XYZ on the coefficient of variation (≤0.5 / ≤1 / >1), excess beyond `maxCoverDays`. */
export function stockAnalysis(items: readonly StockItem[], opts: { maxCoverDays?: number; slowCoverDays?: number } = {}): StockAnalysisRow[] {
  const maxCover = opts.maxCoverDays ?? 120;
  const slowCover = opts.slowCoverDays ?? 180;
  const total = items.reduce((s, i) => s + Math.max(0, i.revenueMinor), 0);
  const ranked = [...items].sort((a, b) => b.revenueMinor - a.revenueMinor);
  const cls = new Map<string, "A" | "B" | "C">();
  let cum = 0;
  for (const i of ranked) {
    const share = total > 0 ? cum / total : 1;
    cls.set(i.id, share < 0.8 ? "A" : share < 0.95 ? "B" : "C");
    cum += Math.max(0, i.revenueMinor);
  }
  return items.map((i) => {
    const n = i.periodUnits.length;
    const mean = n ? i.periodUnits.reduce((s, v) => s + v, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(i.periodUnits.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
    const cv = mean > 0 ? sd / mean : null;
    const xyz = cv === null ? "Z" : cv <= 0.5 ? "X" : cv <= 1 ? "Y" : "Z";
    const value = Math.max(0, i.onHand) * i.unitCostMinor;
    const cover = i.dailyMean > 0 ? Math.max(0, i.onHand) / i.dailyMean : i.onHand > 0 ? Infinity : null;
    const annualCogs = i.dailyMean * 365 * i.unitCostMinor;
    return {
      id: i.id,
      abc: cls.get(i.id) ?? "C",
      xyz,
      cv: cv === null ? null : Math.round(cv * 100) / 100,
      stockValueMinor: value,
      coverDays: cover === null ? null : cover === Infinity ? Infinity : Math.round(cover),
      turnover: value > 0 ? Math.round((annualCogs / value) * 10) / 10 : null,
      excessUnits: i.dailyMean > 0 ? Math.max(0, Math.floor(i.onHand - i.dailyMean * maxCover)) : Math.max(0, i.onHand),
      slowMover: cover === Infinity || (cover !== null && cover > slowCover),
    };
  });
}

/* ---------- multi-location ---------- */

export interface LocationStock {
  locationId: string;
  available: number;
  dailyMean: number;
}

/** Moves from locations with cover above `surplusDays` to those below `shortDays`, never leaving the source under `surplusDays`. */
export function transferSuggestions(stocks: readonly LocationStock[], opts: { shortDays?: number; surplusDays?: number; minUnits?: number } = {}): { from: string; to: string; units: number }[] {
  const minUnits = Math.max(1, opts.minUnits ?? 1);
  const shortDays = opts.shortDays ?? 14;
  const surplusDays = opts.surplusDays ?? 45;
  const need = stocks.filter((s) => s.dailyMean > 0 && s.available / s.dailyMean < shortDays).map((s) => ({ id: s.locationId, units: Math.ceil(s.dailyMean * shortDays - s.available) }));
  const spare = stocks.map((s) => ({ id: s.locationId, units: Math.floor(s.available - s.dailyMean * surplusDays) })).filter((s) => s.units > 0).sort((a, b) => b.units - a.units);
  const moves: { from: string; to: string; units: number }[] = [];
  for (const n of need.sort((a, b) => b.units - a.units)) {
    let left = n.units;
    for (const sp of spare) {
      if (left <= 0) break;
      if (sp.id === n.id || sp.units <= 0) continue;
      const u = Math.min(left, sp.units);
      if (u < minUnits) continue;
      moves.push({ from: sp.id, to: n.id, units: u });
      sp.units -= u;
      left -= u;
    }
  }
  return moves;
}

/* ---------- revenue target → stock plan ---------- */

/** Splits a revenue target across SKUs by their share of forecast revenue and converts it to units. */
export function planFromRevenueTarget(targetMinor: number, skus: readonly { id: string; forecastUnits: number; priceMinor: number }[]): { id: string; units: number; revenueMinor: number }[] {
  const base = skus.reduce((s, k) => s + k.forecastUnits * k.priceMinor, 0);
  if (base <= 0) return skus.map((k) => ({ id: k.id, units: 0, revenueMinor: 0 }));
  const factor = targetMinor / base;
  return skus.map((k) => {
    const units = Math.ceil(k.forecastUnits * factor);
    return { id: k.id, units, revenueMinor: units * k.priceMinor };
  });
}

/* ---------- bundles and BOM ---------- */

/** Units of a bundle / finished good available from its components (min over component stock / quantity per unit). */
export function bundleAvailability(components: readonly { available: number; quantityPerUnit: number }[]): number {
  if (!components.length) return 0;
  return Math.max(0, Math.min(...components.map((c) => (c.quantityPerUnit > 0 ? Math.floor(c.available / c.quantityPerUnit) : Infinity))));
}

/** Component demand generated by selling or producing `units` of a parent, recursively through nested BOMs. */
export function explodeBom(parentId: string, units: number, bom: ReadonlyMap<string, readonly { componentId: string; quantity: number }[]>, depth = 0): Map<string, number> {
  const out = new Map<string, number>();
  if (depth > 6) return out;
  for (const line of bom.get(parentId) ?? []) {
    const need = units * line.quantity;
    if (bom.has(line.componentId)) for (const [k, v] of explodeBom(line.componentId, need, bom, depth + 1)) out.set(k, (out.get(k) ?? 0) + v);
    else out.set(line.componentId, (out.get(line.componentId) ?? 0) + need);
  }
  return out;
}

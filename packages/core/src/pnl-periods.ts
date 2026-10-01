import { monthKey, monthRange, type MonthCostUse } from "./costs";
import { sumEconomics, type OrderEconomics, type Period } from "./finance";
import { safeDiv } from "./money";

/**
 * P/L over time: half-open [from, to) periods cut into day / week / month / quarter / year
 * buckets (UTC, like period costs and ad spend days), with every period-level amount allocated
 * to the buckets so that the buckets add up to the period P/L to the cent.
 */
export const GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export interface PeriodBucket {
  /** day `2026-09-14`, week `2026-W38`, month `2026-09`, quarter `2026-Q3`, year `2026`. */
  key: string;
  /** Start of the natural unit (a week starts on Monday). */
  start: Date;
  /** Clipped to the period. */
  from: Date;
  to: Date;
  /** The bucket covers only part of its unit: clipped by the period, or still running. */
  partial: boolean;
}

export const MAX_BUCKETS = 400;

export function isGranularity(v: unknown): v is Granularity {
  return typeof v === "string" && (GRANULARITIES as readonly string[]).includes(v);
}

/** A readable default: days up to a month, weeks up to a quarter, months up to two years, then quarters. */
export function defaultGranularity(p: Period): Granularity {
  const days = (p.to.getTime() - p.from.getTime()) / 864e5;
  if (days <= 35) return "day";
  if (days <= 120) return "week";
  if (days <= 750) return "month";
  return "quarter";
}

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Start of the unit containing `d`, and the start of the next one. */
export function unitOf(d: Date, g: Granularity): { start: Date; end: Date } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (g) {
    case "day": {
      const start = dayStart(d);
      return { start, end: new Date(start.getTime() + 864e5) };
    }
    case "week": {
      const day = dayStart(d);
      const start = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 864e5);
      return { start, end: new Date(start.getTime() + 7 * 864e5) };
    }
    case "month":
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    case "quarter": {
      const q = Math.floor(m / 3) * 3;
      return { start: new Date(Date.UTC(y, q, 1)), end: new Date(Date.UTC(y, q + 3, 1)) };
    }
    case "year":
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
}

/** ISO 8601 week number and week-year of a (UTC) date. */
export function isoWeek(d: Date): { year: number; week: number } {
  const t = dayStart(d);
  const thursday = new Date(t.getTime() + (3 - ((t.getUTCDay() + 6) % 7)) * 864e5);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 864e5));
  return { year, week };
}

export function bucketKey(start: Date, g: Granularity): string {
  const y = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  switch (g) {
    case "day":
      return start.toISOString().slice(0, 10);
    case "week": {
      const w = isoWeek(start);
      return `${w.year}-W${String(w.week).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${mm}`;
    case "quarter":
      return `${y}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
    case "year":
      return String(y);
  }
}

/** Buckets partitioning the period, oldest first; at most `max` (the last ones are dropped beyond it). */
export function periodBuckets(p: Period, g: Granularity, max = MAX_BUCKETS): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  let cursor = p.from;
  while (cursor < p.to && out.length < max) {
    const u = unitOf(cursor, g);
    const to = u.end < p.to ? u.end : p.to;
    out.push({ key: bucketKey(u.start, g), start: u.start, from: cursor, to, partial: cursor.getTime() > u.start.getTime() || to.getTime() < u.end.getTime() });
    cursor = to;
  }
  return out;
}

/** Index of the bucket containing `at`, -1 when outside every bucket. */
export function bucketIndex(buckets: readonly PeriodBucket[], at: Date): number {
  const t = at.getTime();
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (t < b.from.getTime()) hi = mid - 1;
    else if (t >= b.to.getTime()) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Splits an integer amount in proportion to the weights (largest remainder), so the parts add
 * up exactly to the total. All-zero weights split evenly; a negative total is split the same way.
 */
export function allocateMinor(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (!n) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(total));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((s, x) => s + x, 0);
  const shares = sum > 0 ? w.map((x) => x / sum) : w.map(() => 1 / n);
  const raw = shares.map((s) => abs * s);
  const parts = raw.map((r) => Math.floor(r));
  let rest = abs - parts.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r), eligible: shares[i]! > 0 })).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest !== 0 && k < order.length * 2 + Math.abs(rest); k++) {
    const idx = order[k % order.length]!.i;
    if (rest > 0) {
      parts[idx]!++;
      rest--;
    } else if (parts[idx]! > 0) {
      parts[idx]!--;
      rest++;
    }
  }
  return parts.map((x) => (x === 0 ? 0 : sign * x));
}

/** Milliseconds of overlap between a bucket and [from, to). */
function overlap(b: PeriodBucket, from: Date, to: Date): number {
  return Math.max(0, Math.min(b.to.getTime(), to.getTime()) - Math.max(b.from.getTime(), from.getTime()));
}

export interface BucketPnlInput {
  period: Period;
  /** Economics of every order placed in the period (out-of-scope rows are ignored). */
  orders: readonly (OrderEconomics & { placedAt: Date })[];
  /** Ad spend per UTC day (`YYYY-MM-DD`), as the period P/L reads it. */
  adSpendByDay: readonly { date: string; spendMinor: number }[];
  /** Cost of each return received in the period (label + handling − deduction) and the period total actually used. */
  returns: readonly { at: Date; costMinor: number }[];
  returnCostsMinor: number;
  /** The month-by-month amounts the period P/L used for shipping and fixed costs. */
  shippingByMonth: readonly MonthCostUse[];
  fixedByMonth: readonly MonthCostUse[];
}

export interface BucketPnl {
  bucket: PeriodBucket;
  orders: number;
  grossRevenueMinor: number;
  refundedMinor: number;
  taxMinor: number;
  netRevenueMinor: number;
  cogsMinor: number;
  cogsIncompleteOrders: number;
  grossMarginMinor: number;
  shippingCostMinor: number;
  paymentFeeMinor: number;
  returnCostsMinor: number;
  contributionMinor: number;
  adSpendMinor: number;
  fixedCostsMinor: number;
  operatingProfitMinor: number;
  contributionRate: number | null;
}

/**
 * The period P/L cut into buckets. Order amounts go to the bucket of the order date; ad spend
 * to the bucket of its day; return costs to the bucket of the receipt; shipping month by month
 * in proportion to the per-order estimates (time when the month has no order), fixed costs in
 * proportion to time. Every allocation is exact, so the buckets add up to the period P/L.
 */
export function bucketPnl(buckets: readonly PeriodBucket[], i: BucketPnlInput): BucketPnl[] {
  const n = buckets.length;
  const ordersBy: (OrderEconomics & { placedAt: Date })[][] = buckets.map(() => []);
  for (const o of i.orders) {
    const k = bucketIndex(buckets, o.placedAt);
    if (k >= 0) ordersBy[k]!.push(o);
  }
  const ads = new Array<number>(n).fill(0);
  for (const a of i.adSpendByDay) {
    const day = new Date(`${a.date}T00:00:00Z`);
    const k = bucketIndex(buckets, day < i.period.from ? i.period.from : day);
    if (k >= 0) ads[k]! += a.spendMinor;
  }
  const timeWeights = (from: Date, to: Date) => buckets.map((b) => overlap(b, from, to));
  const add = (acc: number[], parts: number[]) => parts.forEach((v, k) => (acc[k]! += v));
  const shipping = new Array<number>(n).fill(0);
  for (const m of i.shippingByMonth) {
    const r = monthRange(m.period);
    const est = buckets.map((_, k) => ordersBy[k]!.filter((o) => o.inScope && monthKey(o.placedAt) === m.period).reduce((s, o) => s + o.shippingCostMinor, 0));
    add(shipping, allocateMinor(m.usedMinor, est.some((x) => x > 0) ? est : timeWeights(r.from > i.period.from ? r.from : i.period.from, r.to < i.period.to ? r.to : i.period.to)));
  }
  const fixed = new Array<number>(n).fill(0);
  for (const m of i.fixedByMonth) {
    const r = monthRange(m.period);
    add(fixed, allocateMinor(m.usedMinor, timeWeights(r.from > i.period.from ? r.from : i.period.from, r.to < i.period.to ? r.to : i.period.to)));
  }
  const retWeights = new Array<number>(n).fill(0);
  for (const r of i.returns) {
    const k = bucketIndex(buckets, r.at);
    if (k >= 0) retWeights[k]! += Math.max(0, r.costMinor);
  }
  const returns = allocateMinor(i.returnCostsMinor, retWeights.some((x) => x > 0) ? retWeights : timeWeights(i.period.from, i.period.to));
  return buckets.map((bucket, k) => {
    const t = sumEconomics(ordersBy[k]!, ads[k]!, fixed[k]!, returns[k]!);
    const contribution = t.grossMarginMinor - shipping[k]! - t.paymentFeeMinor - returns[k]!;
    return {
      bucket,
      orders: t.orders,
      grossRevenueMinor: t.grossRevenueMinor,
      refundedMinor: t.refundedMinor,
      taxMinor: t.taxMinor,
      netRevenueMinor: t.netRevenueMinor,
      cogsMinor: t.cogsMinor,
      cogsIncompleteOrders: t.cogsIncompleteOrders,
      grossMarginMinor: t.grossMarginMinor,
      shippingCostMinor: shipping[k]!,
      paymentFeeMinor: t.paymentFeeMinor,
      returnCostsMinor: returns[k]!,
      contributionMinor: contribution,
      adSpendMinor: ads[k]!,
      fixedCostsMinor: fixed[k]!,
      operatingProfitMinor: contribution - ads[k]! - fixed[k]!,
      contributionRate: safeDiv(contribution, t.netRevenueMinor),
    };
  });
}

/* ---------- per-order P/L ---------- */

export interface OrderPnl extends OrderEconomics {
  /** Labels and handling of the order's returns whose goods came back, net of deductions charged to the customer. */
  returnCostMinor: number;
  /** Order margin (revenue − goods − shipping − payment fee) minus return costs. */
  contributionMinor: number;
}

export function orderPnl(eco: OrderEconomics, returnCostMinor: number): OrderPnl {
  const rc = eco.inScope ? Math.max(0, returnCostMinor) : 0;
  return { ...eco, returnCostMinor: rc, contributionMinor: eco.marginMinor - rc };
}

export interface OrderPnlTotals {
  orders: number;
  grossRevenueMinor: number;
  refundedMinor: number;
  taxMinor: number;
  netRevenueMinor: number;
  cogsMinor: number;
  shippingCostMinor: number;
  paymentFeeMinor: number;
  returnCostMinor: number;
  contributionMinor: number;
}

export function sumOrderPnl(rows: readonly OrderPnl[]): OrderPnlTotals {
  const t: OrderPnlTotals = { orders: 0, grossRevenueMinor: 0, refundedMinor: 0, taxMinor: 0, netRevenueMinor: 0, cogsMinor: 0, shippingCostMinor: 0, paymentFeeMinor: 0, returnCostMinor: 0, contributionMinor: 0 };
  for (const r of rows) {
    if (!r.inScope) continue;
    t.orders++;
    t.grossRevenueMinor += r.grossRevenueMinor;
    t.refundedMinor += r.refundedMinor;
    t.taxMinor += r.taxMinor;
    t.netRevenueMinor += r.netRevenueMinor;
    t.cogsMinor += r.cogsMinor;
    t.shippingCostMinor += r.shippingCostMinor;
    t.paymentFeeMinor += r.paymentFeeMinor;
    t.returnCostMinor += r.returnCostMinor;
    t.contributionMinor += r.contributionMinor;
  }
  return t;
}

export interface OrderPnlReconciliation {
  ordersContributionMinor: number;
  /** Carrier invoice entered for the period minus the per-order shipping estimates (positive = more cost). */
  shippingAdjustmentMinor: number;
  /** Return costs by receipt date in the period minus the return costs of the period's orders. */
  returnTimingMinor: number;
  contributionMinor: number;
  adSpendMinor: number;
  fixedCostsMinor: number;
  operatingProfitMinor: number;
}

/** From the sum of the per-order table to the period P/L: the period-level items, each on its own line. */
export function reconcileOrderPnl(t: OrderPnlTotals, pnl: { shippingCostMinor: number; returnCostsMinor: number; adSpendMinor: number; fixedCostsMinor: number }): OrderPnlReconciliation {
  const shippingAdjustmentMinor = pnl.shippingCostMinor - t.shippingCostMinor;
  const returnTimingMinor = pnl.returnCostsMinor - t.returnCostMinor;
  const contributionMinor = t.contributionMinor - shippingAdjustmentMinor - returnTimingMinor;
  return { ordersContributionMinor: t.contributionMinor, shippingAdjustmentMinor, returnTimingMinor, contributionMinor, adSpendMinor: pnl.adSpendMinor, fixedCostsMinor: pnl.fixedCostsMinor, operatingProfitMinor: contributionMinor - pnl.adSpendMinor - pnl.fixedCostsMinor };
}

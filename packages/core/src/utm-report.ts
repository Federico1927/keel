import { bucketIndex, type PeriodBucket } from "./pnl-periods";

/** UTM drill-down: sale orders grouped by one UTM parameter at a time, with the parent values fixed. */
export const UTM_DIMENSIONS = ["source", "medium", "campaign", "content", "term"] as const;
export type UtmDimension = (typeof UTM_DIMENSIONS)[number];
/** Value used in URLs and groups for orders without the parameter. */
export const UTM_NONE = "(none)";

export function isUtmDimension(v: unknown): v is UtmDimension {
  return typeof v === "string" && (UTM_DIMENSIONS as readonly string[]).includes(v);
}

/** The next dimension to open when a value is clicked; null after the last one. */
export function nextUtmDimension(d: UtmDimension): UtmDimension | null {
  return UTM_DIMENSIONS[UTM_DIMENSIONS.indexOf(d) + 1] ?? null;
}

export interface UtmOrder {
  utm: Record<UtmDimension, string | null>;
  grossRevenueMinor: number;
  netRevenueMinor: number;
}

export interface UtmGroup {
  value: string;
  orders: number;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  aovMinor: number | null;
  /** Share of the filtered orders' gross revenue. */
  revenueShare: number | null;
}

const norm = (v: string | null | undefined) => (v === null || v === undefined || v.trim() === "" ? UTM_NONE : v.trim().toLowerCase());

/** Groups the orders matching `filter` by `dim`, biggest revenue first. Values compare case-insensitively. */
export function utmGroups(orders: readonly UtmOrder[], dim: UtmDimension, filter: Partial<Record<UtmDimension, string>> = {}): { groups: UtmGroup[]; orders: number; grossRevenueMinor: number; netRevenueMinor: number } {
  const fixed = Object.entries(filter).filter(([, v]) => v !== undefined) as [UtmDimension, string][];
  const acc = new Map<string, { orders: number; gross: number; net: number }>();
  let n = 0;
  let gross = 0;
  let net = 0;
  for (const o of orders) {
    if (!fixed.every(([d, v]) => norm(o.utm[d]) === norm(v === UTM_NONE ? null : v))) continue;
    const k = norm(o.utm[dim]);
    const cur = acc.get(k) ?? { orders: 0, gross: 0, net: 0 };
    cur.orders++;
    cur.gross += o.grossRevenueMinor;
    cur.net += o.netRevenueMinor;
    acc.set(k, cur);
    n++;
    gross += o.grossRevenueMinor;
    net += o.netRevenueMinor;
  }
  const groups = [...acc.entries()].map(([value, v]) => ({ value, orders: v.orders, grossRevenueMinor: v.gross, netRevenueMinor: v.net, aovMinor: v.orders ? Math.round(v.gross / v.orders) : null, revenueShare: gross ? v.gross / gross : null })).sort((a, b) => b.grossRevenueMinor - a.grossRevenueMinor || b.orders - a.orders || a.value.localeCompare(b.value));
  return { groups, orders: n, grossRevenueMinor: gross, netRevenueMinor: net };
}

export interface TrendPoint {
  bucket: PeriodBucket;
  /** Per key: orders and net revenue in the bucket. */
  values: Record<string, { orders: number; netRevenueMinor: number }>;
}

/** Orders and revenue per key (channel) per bucket; keys beyond `maxKeys` (by revenue) fold into `other`. */
export function keyTrend(buckets: readonly PeriodBucket[], items: readonly { at: Date; key: string; netRevenueMinor: number }[], maxKeys = 6, otherKey = "other"): { keys: string[]; points: TrendPoint[] } {
  const totals = new Map<string, number>();
  for (const it of items) totals.set(it.key, (totals.get(it.key) ?? 0) + it.netRevenueMinor);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const kept = ranked.length > maxKeys ? ranked.slice(0, maxKeys - 1) : ranked;
  const keys = ranked.length > maxKeys ? [...kept, otherKey] : kept;
  const keepSet = new Set(kept);
  const points: TrendPoint[] = buckets.map((bucket) => ({ bucket, values: Object.fromEntries(keys.map((k) => [k, { orders: 0, netRevenueMinor: 0 }])) }));
  for (const it of items) {
    const b = bucketIndex(buckets, it.at);
    if (b < 0) continue;
    const v = points[b]!.values[keepSet.has(it.key) ? it.key : otherKey]!;
    v.orders++;
    v.netRevenueMinor += it.netRevenueMinor;
  }
  return { keys, points };
}

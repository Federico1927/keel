/**
 * Customer lifetime value by cohort: cumulative net revenue and margin per customer at fixed
 * windows after the first order, only for customers whose window has fully elapsed ("matured"),
 * so young cohorts never look worse than old ones for lack of time. Pure, tested, used by the
 * LTV tab and by the CAC payback computation.
 */
export const LTV_WINDOWS = [30, 60, 90, 180, 365] as const;
export type LtvWindow = (typeof LTV_WINDOWS)[number];

export interface CustomerTimeline {
  customerId: string;
  /** Cohort keys this customer belongs to (first-order month, channel, first product). */
  keys: Record<string, string>;
  orders: { at: Date; netMinor: number; marginMinor: number }[];
}

export interface LtvWindowStat {
  window: LtvWindow;
  /** Customers old enough for this window. */
  matured: number;
  /** Average cumulative net revenue per matured customer. */
  avgNetMinor: number | null;
  avgMarginMinor: number | null;
  /** Share of matured customers with at least two orders inside the window. */
  repeatRate: number | null;
}

export interface LtvCohortRow {
  key: string;
  customers: number;
  windows: LtvWindowStat[];
  /** Median days between the first and the second order, among repeaters. */
  medianDaysToSecond: number | null;
  firstOrderAvgNetMinor: number | null;
}

const DAY = 864e5;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Cumulative net revenue, margin and order count of one customer within `days` of the first order. */
export function cumulativeAt(c: CustomerTimeline, days: number): { netMinor: number; marginMinor: number; orders: number } {
  const sorted = [...c.orders].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = sorted[0];
  if (!first) return { netMinor: 0, marginMinor: 0, orders: 0 };
  const limit = first.at.getTime() + days * DAY;
  let net = 0;
  let margin = 0;
  let n = 0;
  for (const o of sorted) {
    if (o.at.getTime() >= limit) break;
    net += o.netMinor;
    margin += o.marginMinor;
    n++;
  }
  return { netMinor: net, marginMinor: margin, orders: n };
}

export function cohortLtv(customers: readonly CustomerTimeline[], by: string, asOf: Date, windows: readonly LtvWindow[] = LTV_WINDOWS): LtvCohortRow[] {
  const groups = new Map<string, CustomerTimeline[]>();
  for (const c of customers) {
    if (!c.orders.length) continue;
    const key = c.keys[by] ?? "unknown";
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const rows: LtvCohortRow[] = [];
  for (const [key, members] of groups) {
    const firstAt = (c: CustomerTimeline) => Math.min(...c.orders.map((o) => o.at.getTime()));
    const stats: LtvWindowStat[] = windows.map((w) => {
      const matured = members.filter((c) => firstAt(c) + w * DAY <= asOf.getTime());
      if (!matured.length) return { window: w, matured: 0, avgNetMinor: null, avgMarginMinor: null, repeatRate: null };
      const cums = matured.map((c) => cumulativeAt(c, w));
      return {
        window: w,
        matured: matured.length,
        avgNetMinor: Math.round(cums.reduce((s, x) => s + x.netMinor, 0) / matured.length),
        avgMarginMinor: Math.round(cums.reduce((s, x) => s + x.marginMinor, 0) / matured.length),
        repeatRate: cums.filter((x) => x.orders >= 2).length / matured.length,
      };
    });
    const gaps: number[] = [];
    const firstNets: number[] = [];
    for (const c of members) {
      const sorted = [...c.orders].sort((a, b) => a.at.getTime() - b.at.getTime());
      firstNets.push(sorted[0]!.netMinor);
      if (sorted[1]) gaps.push(Math.round((sorted[1].at.getTime() - sorted[0]!.at.getTime()) / DAY));
    }
    rows.push({ key, customers: members.length, windows: stats, medianDaysToSecond: median(gaps), firstOrderAvgNetMinor: firstNets.length ? Math.round(firstNets.reduce((s, v) => s + v, 0) / firstNets.length) : null });
  }
  return rows.sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Months until the cumulative average margin per customer covers the acquisition cost.
 * `marginByWindow` is the row's matured average margin per window; the curve is interpolated
 * linearly between windows. Null when never reached inside the longest window.
 */
export function cacPaybackDays(windows: readonly LtvWindowStat[], cacMinor: number | null): number | null {
  if (cacMinor === null || cacMinor <= 0) return null;
  let prevDay = 0;
  let prevMargin = 0;
  for (const w of windows) {
    if (w.avgMarginMinor === null) continue;
    if (w.avgMarginMinor >= cacMinor) {
      const span = w.avgMarginMinor - prevMargin;
      if (span <= 0) return w.window;
      return Math.round(prevDay + ((cacMinor - prevMargin) / span) * (w.window - prevDay));
    }
    prevDay = w.window;
    prevMargin = w.avgMarginMinor;
  }
  return null;
}

/* ---------- product analysis ---------- */

/** Lift of a product pair: how much more often they are bought together than chance would give. */
export function pairLift(ordersWithA: number, ordersWithB: number, ordersWithBoth: number, totalOrders: number): number | null {
  if (!totalOrders || !ordersWithA || !ordersWithB) return null;
  return Math.round(((ordersWithBoth * totalOrders) / (ordersWithA * ordersWithB)) * 1000) / 1000;
}

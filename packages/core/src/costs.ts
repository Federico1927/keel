/**
 * Period costs for the P/L: fixed lines and shipping, each with an estimate and, once the
 * invoice is in, an actual figure. The P/L uses the actual when present, otherwise the
 * estimate, and says which one it used. Months are 'YYYY-MM' strings; periods are half-open
 * [from, to) UTC dates.
 */
export type CostKind = "fixed" | "shipping" | "other";
export type CostSource = "actual" | "estimate" | "legacy" | "none" | "mixed";

export interface PeriodCostEntry {
  period: string;
  kind: CostKind;
  label: string;
  estimateMinor: number;
  actualMinor: number | null;
}

export interface MonthCostUse {
  period: string;
  usedMinor: number;
  source: CostSource;
  /** Share of the month inside the requested period (1 = whole month). */
  coverage: number;
}


export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(period: string): { from: Date; to: Date } {
  const [y, m] = period.split("-").map(Number);
  return { from: new Date(Date.UTC(y!, m! - 1, 1)), to: new Date(Date.UTC(y!, m!, 1)) };
}

/** Months overlapping [from, to), oldest first. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor < to && out.length < 120) {
    out.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** Fraction of a month's days that fall inside [from, to). */
export function monthCoverage(period: string, from: Date, to: Date): number {
  const r = monthRange(period);
  const start = Math.max(r.from.getTime(), from.getTime());
  const end = Math.min(r.to.getTime(), to.getTime());
  if (end <= start) return 0;
  return (end - start) / (r.to.getTime() - r.from.getTime());
}

export const usedAmount = (e: Pick<PeriodCostEntry, "estimateMinor" | "actualMinor">): { minor: number; source: "actual" | "estimate" } => (e.actualMinor !== null ? { minor: e.actualMinor, source: "actual" } : { minor: e.estimateMinor, source: "estimate" });

function combineSources(sources: CostSource[]): CostSource {
  const s = new Set(sources.filter((x) => x !== "none"));
  if (s.size === 0) return "none";
  if (s.size === 1) return [...s][0]!;
  return "mixed";
}

/**
 * Fixed and other costs of a period. Months with entries use actual ?? estimate per line;
 * months without any entry fall back to `legacyMonthly(period)` (the old flat monthly setting),
 * so an existing tenant keeps its P/L until it enters period costs.
 */
export function resolveFixedCosts(entries: readonly PeriodCostEntry[], from: Date, to: Date, legacyMonthly: (period: string) => number = () => 0): { totalMinor: number; byMonth: MonthCostUse[]; source: CostSource } {
  const byMonth: MonthCostUse[] = [];
  for (const period of monthsBetween(from, to)) {
    const coverage = monthCoverage(period, from, to);
    const lines = entries.filter((e) => e.period === period && e.kind !== "shipping");
    if (!lines.length) {
      const legacy = legacyMonthly(period);
      byMonth.push({ period, usedMinor: Math.round(legacy * coverage), source: legacy ? "legacy" : "none", coverage });
      continue;
    }
    const used = lines.map(usedAmount);
    byMonth.push({ period, usedMinor: Math.round(used.reduce((s, u) => s + u.minor, 0) * coverage), source: combineSources(used.map((u) => u.source)), coverage });
  }
  return { totalMinor: byMonth.reduce((s, m) => s + m.usedMinor, 0), byMonth, source: combineSources(byMonth.map((m) => m.source)) };
}

/**
 * Shipping costs of a period: the per-order estimate summed from the orders, replaced month by
 * month by the carrier invoice when an actual figure exists for that month.
 */
export function resolveShippingCosts(perOrderEstimateByMonth: Readonly<Record<string, number>>, entries: readonly PeriodCostEntry[], from: Date, to: Date): { totalMinor: number; byMonth: MonthCostUse[]; source: CostSource } {
  const byMonth: MonthCostUse[] = [];
  for (const period of monthsBetween(from, to)) {
    const coverage = monthCoverage(period, from, to);
    const actual = entries.filter((e) => e.period === period && e.kind === "shipping" && e.actualMinor !== null).reduce((s, e) => s + (e.actualMinor ?? 0), 0);
    const hasActual = entries.some((e) => e.period === period && e.kind === "shipping" && e.actualMinor !== null);
    if (hasActual) byMonth.push({ period, usedMinor: Math.round(actual * coverage), source: "actual", coverage });
    else {
      const est = perOrderEstimateByMonth[period] ?? 0;
      byMonth.push({ period, usedMinor: est, source: est ? "estimate" : "none", coverage });
    }
  }
  return { totalMinor: byMonth.reduce((s, m) => s + m.usedMinor, 0), byMonth, source: combineSources(byMonth.map((m) => m.source)) };
}

/* ---------- blended metrics ---------- */

export interface BlendedInput {
  netRevenueMinor: number;
  adSpendMinor: number;
  orders: number;
  newCustomers: number;
  newCustomerRevenueMinor: number;
  contributionMinor: number;
  /** Spend and new customers per channel/platform for CAC by channel. */
  byChannel?: { channel: string; spendMinor: number; newCustomers: number }[];
}
export interface BlendedMetrics {
  /** Marketing efficiency ratio: net revenue / total ad spend. */
  mer: number | null;
  /** New-customer ROAS: revenue of first orders / ad spend. */
  ncRoas: number | null;
  /** Blended CAC: ad spend / new customers. */
  cacMinor: number | null;
  /** Profit on ad spend: contribution margin / ad spend. */
  poas: number | null;
  /** Ad spend as a share of net revenue. */
  spendShare: number | null;
  cacByChannel: { channel: string; cacMinor: number | null; spendMinor: number; newCustomers: number }[];
}

export function blendedMetrics(i: BlendedInput): BlendedMetrics {
  const div = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    mer: div(i.netRevenueMinor, i.adSpendMinor),
    ncRoas: div(i.newCustomerRevenueMinor, i.adSpendMinor),
    cacMinor: i.newCustomers > 0 && i.adSpendMinor > 0 ? Math.round(i.adSpendMinor / i.newCustomers) : null,
    poas: div(i.contributionMinor, i.adSpendMinor),
    spendShare: div(i.adSpendMinor, i.netRevenueMinor),
    cacByChannel: (i.byChannel ?? []).map((c) => ({ channel: c.channel, spendMinor: c.spendMinor, newCustomers: c.newCustomers, cacMinor: c.newCustomers > 0 && c.spendMinor > 0 ? Math.round(c.spendMinor / c.newCustomers) : null })),
  };
}

/* ---------- month-end forecast ---------- */

export interface ForecastInput {
  /** Values of the current month, one per elapsed day (index 0 = day 1), today included. */
  dailyToDate: readonly number[];
  daysInMonth: number;
  /** Average share of a week's total per weekday (0 = Sunday), from history; omitted = flat. */
  weekdayProfile?: readonly number[];
  /** UTC weekday of the first day of the month, needed with a weekday profile. */
  firstWeekday?: number;
}
export interface Forecast {
  toDate: number;
  projected: number;
  low: number;
  high: number;
  dailyRunRate: number;
  remainingDays: number;
}

/**
 * Run-rate projection with an optional weekday profile: the remaining days are weighted by
 * their weekday share so a month ending on a weekend is not over-projected. The band is one
 * standard deviation of the daily values scaled by the square root of the remaining days.
 */
export function forecastMonthEnd(i: ForecastInput): Forecast {
  const elapsed = i.dailyToDate.length;
  const toDate = i.dailyToDate.reduce((s, v) => s + v, 0);
  const remainingDays = Math.max(0, i.daysInMonth - elapsed);
  if (elapsed === 0) return { toDate: 0, projected: 0, low: 0, high: 0, dailyRunRate: 0, remainingDays };
  const profile = i.weekdayProfile && i.weekdayProfile.length === 7 && i.weekdayProfile.some((p) => p > 0) ? i.weekdayProfile : null;
  const weightOf = (dayIndex: number) => (profile ? profile[((i.firstWeekday ?? 0) + dayIndex) % 7]! * 7 : 1);
  const elapsedWeight = Array.from({ length: elapsed }, (_, d) => weightOf(d)).reduce((s, w) => s + w, 0);
  const remainingWeight = Array.from({ length: remainingDays }, (_, d) => weightOf(elapsed + d)).reduce((s, w) => s + w, 0);
  const perWeight = elapsedWeight > 0 ? toDate / elapsedWeight : 0;
  const projected = Math.round(toDate + perWeight * remainingWeight);
  const mean = toDate / elapsed;
  const variance = i.dailyToDate.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, elapsed - 1);
  const band = Math.round(Math.sqrt(variance) * Math.sqrt(remainingDays));
  return { toDate, projected, low: Math.max(toDate, projected - band), high: projected + band, dailyRunRate: Math.round(mean), remainingDays };
}

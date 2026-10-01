import { and, eq, gte, lt, lte, schema, sql } from "@keel/db";
import { blendedMetrics, forecastMonthEnd, monthKey, monthRange, monthsBetween, type BlendedMetrics, type Forecast, type Period } from "@keel/core";
import type { ServiceContext } from "../context";
import { dailySeries, orderEconomicsForPeriod, pnlForPeriod, type AnalyticsTenant } from "./index";

/* ---------- period costs (estimate vs actual) ---------- */

export interface PeriodCostRow {
  id: string;
  period: string;
  kind: "fixed" | "shipping" | "other";
  label: string;
  estimateMinor: number;
  actualMinor: number | null;
  note: string | null;
}

/** Entries for a list of months, plus the per-order shipping estimate computed from the orders of each month. */
export async function listPeriodCosts(ctx: ServiceContext, tenant: AnalyticsTenant, months: string[]): Promise<{ rows: PeriodCostRow[]; shippingEstimateByMonth: Record<string, number>; ordersByMonth: Record<string, number> }> {
  if (!months.length) return { rows: [], shippingEstimateByMonth: {}, ordersByMonth: {} };
  const sorted = [...months].sort();
  const rows = await ctx.tx.select().from(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, ctx.tenantId), gte(schema.periodCosts.period, sorted[0]!), lte(schema.periodCosts.period, sorted[sorted.length - 1]!))).orderBy(schema.periodCosts.period, schema.periodCosts.kind, schema.periodCosts.label);
  const from = monthRange(sorted[0]!).from;
  const to = monthRange(sorted[sorted.length - 1]!).to;
  const econ = await orderEconomicsForPeriod(ctx, tenant, { from, to });
  const shippingEstimateByMonth: Record<string, number> = {};
  const ordersByMonth: Record<string, number> = {};
  for (const r of econ) {
    if (!r.inScope) continue;
    const k = monthKey(r.placedAt);
    shippingEstimateByMonth[k] = (shippingEstimateByMonth[k] ?? 0) + r.shippingCostMinor;
    ordersByMonth[k] = (ordersByMonth[k] ?? 0) + 1;
  }
  return { rows: rows.map((r) => ({ id: r.id, period: r.period, kind: r.kind as PeriodCostRow["kind"], label: r.label, estimateMinor: r.estimateMinor, actualMinor: r.actualMinor, note: r.note })), shippingEstimateByMonth, ordersByMonth };
}

export async function upsertPeriodCost(ctx: ServiceContext, input: { period: string; kind: "fixed" | "shipping" | "other"; label: string; estimateMinor: number; actualMinor: number | null; note?: string | null }): Promise<{ id: string; before: PeriodCostRow | null }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new Error("invalid_period");
  const label = input.kind === "shipping" ? "" : input.label.trim();
  const [before] = await ctx.tx.select().from(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, ctx.tenantId), eq(schema.periodCosts.period, input.period), eq(schema.periodCosts.kind, input.kind), eq(schema.periodCosts.label, label))).limit(1);
  const values = { tenantId: ctx.tenantId, period: input.period, kind: input.kind, label, estimateMinor: Math.max(0, Math.round(input.estimateMinor)), actualMinor: input.actualMinor === null ? null : Math.max(0, Math.round(input.actualMinor)), note: input.note ?? null, updatedAt: ctx.now ?? new Date() };
  const [row] = await ctx.tx.insert(schema.periodCosts).values(values).onConflictDoUpdate({ target: [schema.periodCosts.tenantId, schema.periodCosts.period, schema.periodCosts.kind, schema.periodCosts.label], set: { estimateMinor: values.estimateMinor, actualMinor: values.actualMinor, note: values.note, updatedAt: values.updatedAt } }).returning({ id: schema.periodCosts.id });
  return { id: row!.id, before: before ? { id: before.id, period: before.period, kind: before.kind as PeriodCostRow["kind"], label: before.label, estimateMinor: before.estimateMinor, actualMinor: before.actualMinor, note: before.note } : null };
}

export async function deletePeriodCost(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.tx.delete(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, ctx.tenantId), eq(schema.periodCosts.id, id)));
}

/* ---------- blended metrics ---------- */

export interface BlendedReport extends BlendedMetrics {
  period: Period;
  newCustomers: number;
  newCustomerRevenueMinor: number;
  adSpendMinor: number;
  netRevenueMinor: number;
}

/** First orders in the period (the customer's earliest non-cancelled order), with their attribution channel. */
async function firstOrdersInPeriod(ctx: ServiceContext, period: Period): Promise<{ orderId: string; channel: string }[]> {
  const rows = await ctx.tx.execute<{ order_id: string; channel: string | null }>(sql`
    with firsts as (
      select distinct on (customer_id) id, customer_id from orders
      where tenant_id = ${ctx.tenantId} and customer_id is not null and status not in ('cancelled') and replaced_by_order_id is null
      order by customer_id, placed_at asc, id asc
    )
    select f.id as order_id, a.channel from firsts f
    join orders o on o.id = f.id
    left join order_attribution a on a.order_id = f.id
    where o.placed_at >= ${period.from} and o.placed_at < ${period.to}`);
  return rows.rows.map((r) => ({ orderId: r.order_id, channel: r.channel ?? "unknown" }));
}

const PLATFORM_CHANNEL: Record<string, string> = { meta: "paid_social", google: "paid_search" };

export async function blendedForPeriod(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<BlendedReport> {
  const [pnl, firsts, econ] = [await pnlForPeriod(ctx, tenant, period), await firstOrdersInPeriod(ctx, period), await orderEconomicsForPeriod(ctx, tenant, period)];
  const firstIds = new Map(firsts.map((f) => [f.orderId, f.channel]));
  let newCustomers = 0;
  let newCustomerRevenueMinor = 0;
  const newByChannel = new Map<string, number>();
  for (const r of econ) {
    if (!r.inScope || !firstIds.has(r.orderId)) continue;
    newCustomers++;
    newCustomerRevenueMinor += r.netRevenueMinor;
    const ch = firstIds.get(r.orderId)!;
    newByChannel.set(ch, (newByChannel.get(ch) ?? 0) + 1);
  }
  const spendRows = await ctx.tx.select({ platform: schema.campaigns.platform, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adMetricsDaily.campaignId)).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, period.from.toISOString().slice(0, 10)), lt(schema.adMetricsDaily.date, period.to.toISOString().slice(0, 10)))).groupBy(schema.campaigns.platform);
  const byChannel = spendRows.map((s) => {
    const channel = PLATFORM_CHANNEL[s.platform] ?? s.platform;
    return { channel, spendMinor: s.spend, newCustomers: newByChannel.get(channel) ?? 0 };
  });
  const m = blendedMetrics({ netRevenueMinor: pnl.netRevenueMinor, adSpendMinor: pnl.adSpendMinor, orders: pnl.orders, newCustomers, newCustomerRevenueMinor, contributionMinor: pnl.contributionMinor, byChannel });
  return { ...m, period, newCustomers, newCustomerRevenueMinor, adSpendMinor: pnl.adSpendMinor, netRevenueMinor: pnl.netRevenueMinor };
}

/* ---------- month-end forecast ---------- */

export interface MonthForecast {
  month: string;
  daysInMonth: number;
  elapsedDays: number;
  revenue: Forecast;
  orders: Forecast;
  spend: Forecast;
}

/** Projects the current month (tenant timezone) from the days elapsed, with a weekday profile learnt from the previous 8 weeks. */
export async function monthEndForecast(ctx: ServiceContext, tenant: AnalyticsTenant, now = ctx.now ?? new Date()): Promise<MonthForecast> {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tenant.timezone }));
  const month = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(Date.UTC(local.getFullYear(), local.getMonth() + 1, 0)).getUTCDate();
  const elapsedDays = local.getDate();
  const range = monthRange(month);
  const firstWeekday = range.from.getUTCDay();
  const [series, history, spendRows] = [await dailySeries(ctx, tenant, { from: range.from, to: now }), await dailySeries(ctx, tenant, { from: new Date(range.from.getTime() - 56 * 864e5), to: range.from }), await ctx.tx.select({ date: schema.adMetricsDaily.date, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, `${month}-01`), lt(schema.adMetricsDaily.date, now.toISOString().slice(0, 10)))).groupBy(schema.adMetricsDaily.date)];
  const byDay = new Map(series.map((s) => [s.day, s]));
  const spendByDay = new Map(spendRows.map((s) => [s.date, s.spend]));
  const dayKeys = Array.from({ length: elapsedDays }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const revenueToDate = dayKeys.map((d) => byDay.get(d)?.grossRevenueMinor ?? 0);
  const ordersToDate = dayKeys.map((d) => byDay.get(d)?.orders ?? 0);
  // spend series stops yesterday: platforms restate today
  const spendToDate = dayKeys.slice(0, Math.max(0, elapsedDays - 1)).map((d) => spendByDay.get(d) ?? 0);
  const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const h of history) {
    const dow = new Date(`${h.day}T00:00:00Z`).getUTCDay();
    weekdayTotals[dow] = (weekdayTotals[dow] ?? 0) + h.grossRevenueMinor;
  }
  const sum = weekdayTotals.reduce((s, v) => s + v, 0);
  const weekdayProfile = sum > 0 ? weekdayTotals.map((v) => v / sum) : undefined;
  return {
    month,
    daysInMonth,
    elapsedDays,
    revenue: forecastMonthEnd({ dailyToDate: revenueToDate, daysInMonth, weekdayProfile, firstWeekday }),
    orders: forecastMonthEnd({ dailyToDate: ordersToDate, daysInMonth, weekdayProfile, firstWeekday }),
    spend: forecastMonthEnd({ dailyToDate: spendToDate, daysInMonth }),
  };
}

/** Months to show on the costs page: the last `back` months and the next one, newest first. */
export function costMonths(now: Date, back = 12): string[] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  return monthsBetween(start, end).reverse();
}



import { and, eq, gte, isNull, lt, schema, sql } from "@hullwise/db";
import { dashboardPeriod, orderPnl, previousPeriod, projectMonthEnd, type Granularity, type Period } from "@hullwise/core";
import { AD_PLATFORMS, WIDGETS, WIDGET_SETTINGS, isCustomMetricRef, isWidgetAvailable, isWidgetVisible, metricDefinition, type DashboardWidget, type MetricFormat, type TenantRole, type WidgetSettings, type WidgetType } from "@hullwise/config";
import type { ServiceContext } from "../context";
import { dashboardSummary, productPerformance, orderEconomicsForPeriod, type AnalyticsTenant, type DashboardSummary } from "../analytics";
import { monthEndForecast, type MonthForecast } from "../analytics/depth";
import { recentAlertEvents } from "../analytics/advanced";
import { returnCostsByOrder } from "../analytics/pnl-depth";
import { campaignsWithEconomics } from "../campaigns";
import { adRows, keywordRows, topSearchTerms } from "../ads/analysis";
import { countLateToShip } from "../fulfilment";
import { shipmentCaseCounts } from "../fulfilment/cases";
import { backorderSummary, type BackorderSummary } from "../backorders";
import { catalogQualityReport } from "../catalog/costs";
import { currentTarget, customMetricBases, isSeriesRef, tenantMetricSeries, tenantMetricValues, type CustomMetricRow, type Memo, type MetricSeries, type TenantMetricValue } from "./metrics";

/**
 * Widget loaders (issue #43): one service function per widget type, each over an existing tested
 * query. `loadWidgetData` checks the tenant's modules and the viewer's role before any loader runs,
 * and turns a failing loader into an error result so one widget never breaks the page.
 */

export interface WidgetEnv {
  tenant: AnalyticsTenant;
  role: TenantRole;
  activeAddons: readonly string[];
  userId: string | null;
  locale?: string;
  /** The tenant's custom metrics (loaded once per page). */
  customs: CustomMetricRow[];
  memo?: Memo;
  now?: Date;
}

export type WidgetLoader = (ctx: ServiceContext, env: WidgetEnv, input: { settings: Record<string, unknown>; period: Period }) => Promise<unknown>;

const direct: Memo = (_k, fn) => fn();
const memoOf = (env: WidgetEnv) => env.memo ?? direct;
const minuteKey = (env: WidgetEnv) => Math.floor((env.now ?? new Date()).getTime() / 60_000);
const day = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** `from` / `to` search params (inclusive local days) of the order list for a period. */
export function periodQuery(p: Period, tz: string): string {
  return `from=${day(p.from, tz)}&to=${day(new Date(p.to.getTime() - 1), tz)}`;
}

/* ---------- data shapes (renderers in apps/web read these) ---------- */

export interface KpiData { value: TenantMetricValue; spark: (number | null)[] | null }
export interface BreakdownRow { key: string; label: string | null; value: number | null; path: string | null }
export interface BreakdownData { rows: BreakdownRow[]; total: number; format: MetricFormat }
export interface TopListRow { id: string; label: string; value: number | null; secondary: number | null; path: string }
export interface TopListData { rows: TopListRow[]; format: MetricFormat; secondaryFormat: MetricFormat }
export interface TargetData { value: TenantMetricValue; target: number | null; targetMonth: string; projected: number | null; elapsedDays: number; daysInMonth: number }
export interface AlertsData { rows: { id: string; name: string; metric: string; reason: string; value: string | null; firedAt: Date }[] }
export interface QueueData { count: number; path: string; parts?: Record<string, number> }
export interface WorkQueueData { open: DashboardSummary["open"]; lateToShip: number; catalogIssues: number; catalogMissingCost: number }

const summaryOf = (ctx: ServiceContext, env: WidgetEnv) => memoOf(env)(`summary|${ctx.tenantId}|${minuteKey(env)}`, () => dashboardSummary(ctx, env.tenant, env.now));
const backordersOf = (ctx: ServiceContext, env: WidgetEnv) => memoOf(env)(`backorders|${ctx.tenantId}|${minuteKey(env)}`, () => backorderSummary(ctx, { lowStockThreshold: env.tenant.settings.lowStockThreshold }));
const forecastOf = (ctx: ServiceContext, env: WidgetEnv) => memoOf(env)(`forecast|${ctx.tenantId}|${minuteKey(env)}`, () => monthEndForecast(ctx, env.tenant, env.now));

/** Granularity of a sparkline: days up to three months, weeks beyond. */
const sparkGranularity = (p: Period): Granularity => (p.to.getTime() - p.from.getTime() > 93 * 864e5 ? "week" : "day");

const kpi: WidgetLoader = async (ctx, env, { settings, period }) => {
  const s = settings as WidgetSettings<"kpi">;
  const memo = memoOf(env);
  const [value] = await tenantMetricValues(ctx, env.tenant, period, s.compare === "previous" ? previousPeriod(period) : null, [s.metric], { memo, customs: env.customs, locale: env.locale });
  const spark = s.sparkline && value!.kind === "period" && isSeriesRef(s.metric, env.customs) ? (await tenantMetricSeries(ctx, env.tenant, period, sparkGranularity(period), [s.metric], { memo, customs: env.customs })).series[0]!.values : null;
  return { value: value!, spark } satisfies KpiData;
};

const timeseries: WidgetLoader = async (ctx, env, { settings, period }) => {
  const s = settings as WidgetSettings<"timeseries">;
  return (await tenantMetricSeries(ctx, env.tenant, period, s.granularity, s.metrics, { memo: memoOf(env), customs: env.customs, locale: env.locale })) satisfies MetricSeries;
};

const breakdown: WidgetLoader = async (ctx, env, { settings, period }) => {
  const s = settings as WidgetSettings<"breakdown">;
  const q = periodQuery(period, env.tenant.timezone);
  const format: MetricFormat = s.metric === "orders" ? "number" : "money";
  let rows: BreakdownRow[] = [];
  if (s.by === "campaign" || s.by === "platform") {
    const camps = await memoOf(env)(`campaigns|${ctx.tenantId}|${period.from.toISOString()}|${period.to.toISOString()}`, () => campaignsWithEconomics(ctx, env.tenant, period));
    const pick = (c: (typeof camps)[number]) => (s.metric === "orders" ? c.metrics.attributedOrders : s.metric === "contribution" ? c.metrics.marginMinor : s.metric === "ad_spend" ? c.metrics.spendMinor : c.metrics.netRevenueMinor);
    if (s.by === "campaign") rows = camps.map((c) => ({ key: c.id, label: c.name, value: pick(c), path: `campaigns/${c.id}` }));
    else {
      const by = new Map<string, number>();
      for (const c of camps) by.set(c.platform, (by.get(c.platform) ?? 0) + pick(c));
      rows = [...by].map(([platform, value]) => ({ key: platform, label: null, value, path: `campaigns?platform=${encodeURIComponent(platform)}` }));
    }
  } else if (s.by === "product") {
    const perf = await productPerformance(ctx, period, 200);
    rows = perf.map((p) => ({ key: p.productId, label: p.title, value: s.metric === "orders" ? p.orders : s.metric === "contribution" ? p.marginMinor : s.metric === "ad_spend" ? null : p.grossRevenueMinor, path: `products/${p.productId}` }));
  } else {
    // channel, country, payment method: the period's sale orders, valued like the per-order P/L
    const econ = (await orderEconomicsForPeriod(ctx, env.tenant, period)).filter((e) => e.inScope);
    const rc = s.metric === "contribution" ? await returnCostsByOrder(ctx, env.tenant, econ.map((e) => e.orderId)) : new Map<string, number>();
    const channels = s.by === "channel" ? new Map((await ctx.tx.select({ orderId: schema.orderAttribution.orderId, channel: schema.orderAttribution.channel }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to)))).map((r) => [r.orderId, r.channel])) : new Map<string, string>();
    const by = new Map<string, number>();
    for (const e of econ) {
      const key = s.by === "channel" ? (channels.get(e.orderId) ?? "unknown") : s.by === "country" ? (e.shippingCountry ?? "unknown") : e.paymentMethod;
      const v = s.metric === "orders" ? 1 : s.metric === "contribution" ? orderPnl(e, rc.get(e.orderId) ?? 0).contributionMinor : s.metric === "ad_spend" ? 0 : e.netRevenueMinor;
      by.set(key, (by.get(key) ?? 0) + v);
    }
    const param = s.by === "channel" ? "attrChannel" : s.by === "country" ? "country" : "payment";
    rows = [...by].map(([key, value]) => ({ key, label: null, value: s.metric === "ad_spend" ? null : value, path: key === "unknown" ? `orders?${q}` : `orders?${q}&${param}=${encodeURIComponent(key)}` }));
  }
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  return { rows: rows.slice(0, s.limit), total: rows.reduce((t, r) => t + (r.value ?? 0), 0), format } satisfies BreakdownData;
};

const topList: WidgetLoader = async (ctx, env, { settings, period }) => {
  const s = settings as WidgetSettings<"top_list">;
  if (s.entity === "products") {
    const perf = await productPerformance(ctx, period, s.limit);
    return { rows: perf.map((p) => ({ id: p.productId, label: p.title, value: p.grossRevenueMinor, secondary: p.units, path: `products/${p.productId}` })), format: "money", secondaryFormat: "number" } satisfies TopListData;
  }
  // ads below the campaign (issue #40): search terms by spend with Hullwise orders, ads and keywords by Hullwise profit
  if (s.entity === "search_terms") {
    const terms = await topSearchTerms(ctx, env.tenant, period, s.limit);
    return { rows: terms.map((t) => ({ id: t.id, label: t.text, value: t.metrics.spendMinor, secondary: t.hullwiseMatchable ? t.economics.attributedOrders : null, path: `campaigns/keywords?tab=search_terms&q=${encodeURIComponent(t.text)}` })), format: "money", secondaryFormat: "number" } satisfies TopListData;
  }
  if (s.entity === "ads") {
    const { rows } = await adRows(ctx, env.tenant, period, {});
    const top = rows.filter((r) => r.metrics.spendMinor > 0 || r.economics.attributedOrders > 0).sort((a, b) => b.economics.profitMinor - a.economics.profitMinor).slice(0, s.limit);
    return { rows: top.map((r) => ({ id: r.id, label: r.name, value: r.economics.profitMinor, secondary: r.economics.roas, path: `campaigns/${r.campaignId}/ads/${r.id}` })), format: "money", secondaryFormat: "ratio" } satisfies TopListData;
  }
  if (s.entity === "keywords") {
    const { rows } = await keywordRows(ctx, env.tenant, period, { sort: "profit" });
    return { rows: rows.slice(0, s.limit).map((k) => ({ id: k.id, label: k.text, value: k.economics.profitMinor, secondary: k.economics.roas, path: `campaigns/keywords?q=${encodeURIComponent(k.text)}` })), format: "money", secondaryFormat: "ratio" } satisfies TopListData;
  }
  if (s.entity === "campaigns") {
    const camps = await memoOf(env)(`campaigns|${ctx.tenantId}|${period.from.toISOString()}|${period.to.toISOString()}`, () => campaignsWithEconomics(ctx, env.tenant, period));
    const top = camps.filter((c) => c.metrics.spendMinor > 0 || c.metrics.attributedOrders > 0).sort((a, b) => b.metrics.profitMinor - a.metrics.profitMinor).slice(0, s.limit);
    return { rows: top.map((c) => ({ id: c.id, label: c.name, value: c.metrics.profitMinor, secondary: c.metrics.roas, path: `campaigns/${c.id}` })), format: "money", secondaryFormat: "ratio" } satisfies TopListData;
  }
  const rows = await ctx.tx
    .select({ id: schema.customers.id, name: sql<string>`trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, ''))`, email: schema.customers.email, value: sql<number>`coalesce(sum(${schema.orders.totalMinor} - ${schema.orders.refundedMinor}), 0)::bigint`, orders: sql<number>`count(*)::int` })
    .from(schema.orders)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), isNull(schema.orders.replacedByOrderId), sql`${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial')`))
    .groupBy(schema.customers.id)
    .orderBy(sql`4 desc`)
    .limit(s.limit);
  return { rows: rows.map((r) => ({ id: r.id, label: r.name || r.email || "—", value: Number(r.value), secondary: r.orders, path: `customers/${r.id}` })), format: "money", secondaryFormat: "number" } satisfies TopListData;
};

/** Metrics that add up over days (a month-end projection grows them); rates, ratios and averages do not. */
const ADDITIVE = new Set(["net_revenue", "gross_revenue", "orders", "ad_spend", "cogs", "gross_margin", "shipping", "fees", "fixed_costs", "contribution", "operating_profit", "refunds", "new_customers", "return_cost", ...AD_PLATFORMS.map((p) => `${p}_spend`)]);

const target: WidgetLoader = async (ctx, env, { settings }) => {
  const s = settings as WidgetSettings<"target">;
  const now = env.now ?? new Date();
  const mtd = dashboardPeriod("mtd", now, env.tenant.timezone);
  const [value] = await tenantMetricValues(ctx, env.tenant, mtd, null, [s.metric], { memo: memoOf(env), customs: env.customs, locale: env.locale });
  const t = await currentTarget(ctx, env.tenant, s.metric, now);
  const f: MonthForecast = await forecastOf(ctx, env);
  const cm = isCustomMetricRef(s.metric) ? env.customs.find((c) => `custom:${c.key}` === s.metric) : null;
  const additive = cm ? !cm.formula.includes("/") && customMetricBases(cm).every((b) => ADDITIVE.has(b)) : ADDITIVE.has(s.metric);
  // the month-end forecast's weekday-weighted run rate: orders and spend have their own, the rest follows revenue
  const curve = s.metric === "orders" ? f.orders : s.metric.endsWith("ad_spend") || s.metric.endsWith("_spend") ? f.spend : f.revenue;
  const projected = additive && value!.value !== null && curve.toDate > 0 ? (value!.value * curve.projected) / curve.toDate : projectMonthEnd(value!.value, additive, f.elapsedDays, f.daysInMonth);
  return { value: value!, target: t?.target ?? null, targetMonth: t?.month ?? f.month, projected, elapsedDays: f.elapsedDays, daysInMonth: f.daysInMonth } satisfies TargetData;
};

const alerts: WidgetLoader = async (ctx, _env, { settings }) => {
  const s = settings as WidgetSettings<"alerts">;
  const rows = await recentAlertEvents(ctx, s.limit);
  return { rows: rows.map((r) => ({ id: r.e.id, name: r.name, metric: r.metric, reason: r.e.reason, value: r.e.value, firedAt: r.e.firedAt })) } satisfies AlertsData;
};

const queueReview: WidgetLoader = async (ctx) => {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.status, "pending_review")));
  return { count: r?.n ?? 0, path: "orders?status=pending_review" } satisfies QueueData;
};
const queueLate: WidgetLoader = async (ctx, env) => ({ count: await countLateToShip(ctx, { timezone: env.tenant.timezone, settings: env.tenant.settings, now: env.now }), path: "fulfilment?view=late" }) satisfies QueueData;
const queueAwaiting: WidgetLoader = async (ctx, env) => ({ count: (await backordersOf(ctx, env)).holdingOrders, path: "orders?stock=awaiting" }) satisfies QueueData;
const queueExceptions: WidgetLoader = async (ctx) => ({ count: (await shipmentCaseCounts(ctx)).exceptionsOpen, path: "fulfilment/exceptions" }) satisfies QueueData;
/** Integration health from what Hullwise records today: connections in error, sync sources in error, failed webhooks (the #32 watchdog will add more sources). */
const queueIntegrations: WidgetLoader = async (ctx) => {
  const [i] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.status, "error")));
  const [h] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), eq(schema.integrationHealth.status, "error")));
  const [w] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.status, "failed")));
  const parts = { connections: i?.n ?? 0, sources: h?.n ?? 0, webhooks: w?.n ?? 0 };
  return { count: parts.connections + parts.sources + parts.webhooks, path: "integrations", parts } satisfies QueueData;
};

const workQueue: WidgetLoader = async (ctx, env) => {
  const [summary, late, quality] = [await summaryOf(ctx, env), await countLateToShip(ctx, { timezone: env.tenant.timezone, settings: env.tenant.settings, now: env.now }), await catalogQualityReport(ctx)];
  return { open: summary.open, lateToShip: late, catalogIssues: quality.rows.filter((r) => r.issues.some((x) => x === "missing_cost" || x === "missing_sku" || x === "duplicate_sku")).length, catalogMissingCost: quality.counts.missing_cost } satisfies WorkQueueData;
};

export const CORE_WIDGET_LOADERS: Partial<Record<WidgetType, WidgetLoader>> = {
  kpi,
  timeseries,
  breakdown,
  top_list: topList,
  target,
  alerts,
  note: async () => null,
  queue_review: queueReview,
  queue_late: queueLate,
  queue_awaiting_stock: queueAwaiting,
  queue_exceptions: queueExceptions,
  queue_integrations: queueIntegrations,
  today_kpis: (ctx, env) => summaryOf(ctx, env),
  sales_30d: (ctx, env) => summaryOf(ctx, env),
  today_by_status: (ctx, env) => summaryOf(ctx, env),
  month_forecast: (ctx, env) => forecastOf(ctx, env),
  work_queue: workQueue,
  stock_backorders: (ctx, env): Promise<BackorderSummary> => backordersOf(ctx, env),
};

export type WidgetResult = { ok: true; data: unknown } | { ok: false; reason: "unknown" | "module_disabled" | "forbidden" | "invalid_settings" | "failed"; message?: string };

/** A custom metric's bases, for page checks (null when the metric does not exist). */
export function basesLookup(customs: Pick<CustomMetricRow, "key" | "formula" | "filters">[]) {
  return (key: string) => {
    const cm = customs.find((c) => c.key === key);
    return cm ? customMetricBases(cm) : null;
  };
}

/**
 * Loads one widget's data after the server-side checks: the tenant must have the widget's module or
 * add-on (refused otherwise, whatever the stored layout says) and the viewer's role must open its page
 * and metrics. A loader that throws gives `{ ok: false, reason: "failed" }`.
 */
export async function loadWidgetData(ctx: ServiceContext, env: WidgetEnv, widget: Pick<DashboardWidget, "type" | "settings">, period: Period, loaders: Partial<Record<WidgetType, WidgetLoader>> = CORE_WIDGET_LOADERS): Promise<WidgetResult> {
  if (!WIDGETS[widget.type]) return { ok: false, reason: "unknown" };
  if (!isWidgetAvailable(widget.type, env.activeAddons)) return { ok: false, reason: "module_disabled" };
  const parsed = WIDGET_SETTINGS[widget.type].safeParse(widget.settings ?? {});
  if (!parsed.success) return { ok: false, reason: "invalid_settings" };
  const settings = parsed.data as Record<string, unknown>;
  if (!isWidgetVisible({ type: widget.type, settings }, env.role, env.activeAddons, basesLookup(env.customs))) return { ok: false, reason: "forbidden" };
  const loader = loaders[widget.type];
  if (!loader) return { ok: false, reason: "unknown" };
  try {
    return { ok: true, data: await loader(ctx, env, { settings, period }) };
  } catch (e) {
    return { ok: false, reason: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Format of a metric reference for renderers and editors. */
export function metricFormatOf(ref: string, customs: Pick<CustomMetricRow, "key" | "format">[]): MetricFormat {
  if (isCustomMetricRef(ref)) return (customs.find((c) => `custom:${c.key}` === ref)?.format as MetricFormat) ?? "number";
  return metricDefinition(ref)?.format ?? "number";
}

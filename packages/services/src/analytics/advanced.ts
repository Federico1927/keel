import { and, desc, eq, gte, inArray, lt, schema, sql } from "@keel/db";
import { ATTRIBUTION_MODELS, compileFormula, creativeFatigue, creditBy, evaluateAlert, evaluateFormula, parseCreativeName, type AlertCondition, type AttributedOrder, type AttributionModel, type FatigueResult, type Period, type Touchpoint } from "@keel/core";
import type { ServiceContext } from "../context";
import { countLateToShip } from "../fulfilment";
import { getSurveySettings, surveyChannelsFor } from "../tracking/survey";
import { getNotificationSinks } from "../integrations/factory";
import { notifyUsers } from "../notifications";
import { blendedForPeriod } from "./depth";
import { orderEconomicsForPeriod, pnlForPeriod, type AnalyticsTenant } from "./index";

const SALE = "('confirmed','fulfilling','shipped','delivered','returned_partial')";

/* ---------- multi-touch attribution ---------- */

export interface AttributionReportRow {
  key: string;
  label: string;
  platform: string | null;
  orders: number;
  netMinor: number;
  marginMinor: number;
  spendMinor: number | null;
  roas: number | null;
  /** Same key under last-click and under the platform's own claim, for comparison. */
  lastClick: { orders: number; netMinor: number };
  platformClaim: { orders: number; netMinor: number };
  declared: { purchases: number; valueMinor: number } | null;
}

/**
 * Credits the period's sale orders to channels or campaigns under the chosen model. Touchpoints
 * come from `touchpoints` (order landing + earlier visits); orders with none fall back to their
 * attribution row as a single touch, so a tenant without the pixel still gets last-click.
 */
export async function attributionReport(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, model: AttributionModel, by: "channel" | "campaign", opts: { lookbackDays?: number } = {}): Promise<AttributionReportRow[]> {
  const econ = (await orderEconomicsForPeriod(ctx, tenant, period)).filter((e) => e.inScope);
  if (!econ.length) return [];
  const ids = econ.map((e) => e.orderId);
  const tps: { orderId: string | null; at: Date; channel: string; campaignId: string | null; paid: boolean }[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const rows = await ctx.tx.select({ orderId: schema.touchpoints.orderId, at: schema.touchpoints.occurredAt, channel: schema.touchpoints.channel, campaignId: schema.touchpoints.campaignId, paid: schema.touchpoints.paid }).from(schema.touchpoints).where(and(eq(schema.touchpoints.tenantId, ctx.tenantId), inArray(schema.touchpoints.orderId, chunk)));
    tps.push(...rows);
  }
  const byOrder = new Map<string, Touchpoint[]>();
  for (const t of tps) {
    if (!t.orderId) continue;
    const arr = byOrder.get(t.orderId) ?? [];
    arr.push({ at: t.at, channel: t.channel, campaignId: t.campaignId, paid: t.paid });
    byOrder.set(t.orderId, arr);
  }
  const missing = ids.filter((id) => !byOrder.has(id));
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 5000) {
      const rows = await ctx.tx.select({ orderId: schema.orderAttribution.orderId, channel: schema.orderAttribution.channel, campaignId: schema.orderAttribution.campaignId }).from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.orderId, missing.slice(i, i + 5000))));
      for (const r of rows) {
        const placed = econ.find((e) => e.orderId === r.orderId)!.placedAt;
        byOrder.set(r.orderId, [{ at: placed, channel: r.channel, campaignId: r.campaignId, paid: r.channel === "paid_social" || r.channel === "paid_search" }]);
      }
    }
  }
  // survey blend: the customer's own answer takes a share of the order (post-purchase survey)
  const survey = model === "survey_blend" ? await surveyChannelsFor(ctx, ids) : new Map<string, string>();
  const surveyBlend = model === "survey_blend" ? (await getSurveySettings(ctx)).config.blendBps / 10_000 : undefined;
  const orders: AttributedOrder[] = econ.map((e) => ({ orderId: e.orderId, at: e.placedAt, netMinor: e.netRevenueMinor, marginMinor: e.marginMinor, touches: byOrder.get(e.orderId) ?? [], surveyChannel: survey.get(e.orderId) ?? null }));
  const keyOf = (t: Touchpoint) => (by === "channel" ? t.channel : t.campaignId);
  const o = { lookbackDays: opts.lookbackDays ?? 30, surveyBlend };
  const main = creditBy(model, orders, keyOf, o);
  const last = new Map(creditBy("last_click", orders, keyOf, o).map((r) => [r.key, r]));
  const claim = new Map(creditBy("last_platform_click", orders, keyOf, o).map((r) => [r.key, r]));
  const keys = [...new Set([...main.map((r) => r.key), ...last.keys(), ...claim.keys()])];
  const since = period.from.toISOString().slice(0, 10);
  const until = period.to.toISOString().slice(0, 10);
  const spendRows = await ctx.tx.select({ campaignId: schema.adMetricsDaily.campaignId, platform: schema.campaigns.platform, name: schema.campaigns.name, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}),0)::int`, purchases: sql<number>`coalesce(sum(${schema.adMetricsDaily.purchases}),0)::int`, value: sql<number>`coalesce(sum(${schema.adMetricsDaily.purchaseValueMinor}),0)::int` }).from(schema.adMetricsDaily).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adMetricsDaily.campaignId)).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, since), lt(schema.adMetricsDaily.date, until))).groupBy(schema.adMetricsDaily.campaignId, schema.campaigns.platform, schema.campaigns.name);
  const names = by === "campaign" ? new Map((await ctx.tx.select({ id: schema.campaigns.id, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, ctx.tenantId))).map((c) => [c.id, c])) : new Map();
  const channelSpend = new Map<string, { spend: number; purchases: number; value: number }>();
  for (const s of spendRows) {
    const ch = s.platform === "meta" ? "paid_social" : "paid_search";
    const cur = channelSpend.get(ch) ?? { spend: 0, purchases: 0, value: 0 };
    channelSpend.set(ch, { spend: cur.spend + s.spend, purchases: cur.purchases + s.purchases, value: cur.value + s.value });
  }
  return keys
    .map((key) => {
      const m = main.find((r) => r.key === key) ?? { key, orders: 0, netMinor: 0, marginMinor: 0 };
      const sp = by === "campaign" ? spendRows.find((s) => s.campaignId === key) : null;
      const chSp = by === "channel" ? channelSpend.get(key) : null;
      const spendMinor = sp ? sp.spend : chSp ? chSp.spend : null;
      const declared = sp ? { purchases: sp.purchases, valueMinor: sp.value } : chSp ? { purchases: chSp.purchases, valueMinor: chSp.value } : null;
      const camp = by === "campaign" ? names.get(key) : null;
      return {
        key,
        label: camp?.name ?? key,
        platform: camp?.platform ?? null,
        orders: m.orders,
        netMinor: m.netMinor,
        marginMinor: m.marginMinor,
        spendMinor,
        roas: spendMinor ? m.netMinor / spendMinor : null,
        lastClick: { orders: last.get(key)?.orders ?? 0, netMinor: last.get(key)?.netMinor ?? 0 },
        platformClaim: { orders: claim.get(key)?.orders ?? 0, netMinor: claim.get(key)?.netMinor ?? 0 },
        declared,
      };
    })
    .sort((a, b) => b.netMinor - a.netMinor);
}

export { ATTRIBUTION_MODELS };

/* ---------- creatives ---------- */

export interface CreativeRow {
  key: string;
  label: string;
  creativeId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  platform: string | null;
  format: string | null;
  hook: string | null;
  angle: string | null;
  status: string | null;
  creatives: number;
  spendMinor: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpcMinor: number | null;
  thumbStopRate: number | null;
  declaredPurchases: number;
  declaredValueMinor: number;
  /** Real sale orders whose landing touch carried this creative. */
  orders: number;
  netMinor: number;
  roas: number | null;
  fatigue: FatigueResult | null;
}

/** Ad-level performance, by creative or grouped by format / hook / angle, with real attributed revenue and fatigue. */
export async function creativePerformance(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, groupBy: "creative" | "format" | "hook" | "angle", opts: { campaignId?: string; platform?: string } = {}): Promise<CreativeRow[]> {
  const since = period.from.toISOString().slice(0, 10);
  const until = period.to.toISOString().slice(0, 10);
  const conds = [eq(schema.adCreatives.tenantId, ctx.tenantId)];
  if (opts.campaignId) conds.push(eq(schema.adCreatives.campaignId, opts.campaignId));
  if (opts.platform) conds.push(eq(schema.adCreatives.platform, opts.platform));
  const creatives = await ctx.tx.select({ c: schema.adCreatives, campaignName: schema.campaigns.name }).from(schema.adCreatives).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adCreatives.campaignId)).where(and(...conds));
  if (!creatives.length) return [];
  const ids = creatives.map((c) => c.c.id);
  const days = await ctx.tx.select().from(schema.adCreativeMetricsDaily).where(and(eq(schema.adCreativeMetricsDaily.tenantId, ctx.tenantId), inArray(schema.adCreativeMetricsDaily.creativeId, ids), gte(schema.adCreativeMetricsDaily.date, since), lt(schema.adCreativeMetricsDaily.date, until))).orderBy(schema.adCreativeMetricsDaily.date);
  const econ = (await orderEconomicsForPeriod(ctx, tenant, period)).filter((e) => e.inScope);
  const econById = new Map(econ.map((e) => [e.orderId, e]));
  const landing = await ctx.tx.select({ orderId: schema.touchpoints.orderId, creativeId: schema.touchpoints.creativeId }).from(schema.touchpoints).where(and(eq(schema.touchpoints.tenantId, ctx.tenantId), eq(schema.touchpoints.origin, "order_landing"), inArray(schema.touchpoints.creativeId, ids), gte(schema.touchpoints.occurredAt, period.from), lt(schema.touchpoints.occurredAt, period.to)));
  const ordersByCreative = new Map<string, { orders: number; net: number }>();
  for (const l of landing) {
    const e = l.orderId ? econById.get(l.orderId) : undefined;
    if (!e || !l.creativeId) continue;
    const cur = ordersByCreative.get(l.creativeId) ?? { orders: 0, net: 0 };
    ordersByCreative.set(l.creativeId, { orders: cur.orders + 1, net: cur.net + e.netRevenueMinor });
  }
  const tagsOf = (c: (typeof creatives)[number]["c"]) => {
    const parsed = parseCreativeName(c.name);
    return { format: c.format ?? parsed.format, hook: c.hook ?? parsed.hook, angle: c.angle ?? parsed.angle };
  };
  const groups = new Map<string, { label: string; members: (typeof creatives)[number][] }>();
  for (const c of creatives) {
    const tags = tagsOf(c.c);
    const key = groupBy === "creative" ? c.c.id : (tags[groupBy] ?? "—");
    const g = groups.get(key) ?? { label: groupBy === "creative" ? c.c.name : key, members: [] };
    g.members.push(c);
    groups.set(key, g);
  }
  const rows: CreativeRow[] = [];
  for (const [key, g] of groups) {
    const memberIds = new Set(g.members.map((m) => m.c.id));
    const ds = days.filter((d) => memberIds.has(d.creativeId));
    const spend = ds.reduce((s, d) => s + d.spendMinor, 0);
    const impressions = ds.reduce((s, d) => s + d.impressions, 0);
    const clicks = ds.reduce((s, d) => s + d.clicks, 0);
    const v3 = ds.reduce((s, d) => s + d.videoViews3s, 0);
    const real = [...memberIds].reduce((acc, id) => {
      const r = ordersByCreative.get(id);
      return { orders: acc.orders + (r?.orders ?? 0), net: acc.net + (r?.net ?? 0) };
    }, { orders: 0, net: 0 });
    const one = g.members.length === 1 ? g.members[0]! : null;
    const tags = one ? tagsOf(one.c) : { format: groupBy === "format" ? key : null, hook: groupBy === "hook" ? key : null, angle: groupBy === "angle" ? key : null };
    const perDay = new Map<string, { date: string; impressions: number; clicks: number; spendMinor: number; reach: number }>();
    for (const d of ds) {
      const cur = perDay.get(d.date) ?? { date: d.date, impressions: 0, clicks: 0, spendMinor: 0, reach: 0 };
      perDay.set(d.date, { date: d.date, impressions: cur.impressions + d.impressions, clicks: cur.clicks + d.clicks, spendMinor: cur.spendMinor + d.spendMinor, reach: cur.reach + d.reach });
    }
    rows.push({
      key,
      label: g.label,
      creativeId: one?.c.id ?? null,
      campaignId: one?.c.campaignId ?? null,
      campaignName: one?.campaignName ?? null,
      platform: one?.c.platform ?? null,
      format: tags.format,
      hook: tags.hook,
      angle: tags.angle,
      status: one?.c.status ?? null,
      creatives: g.members.length,
      spendMinor: spend,
      impressions,
      clicks,
      ctr: impressions ? clicks / impressions : null,
      cpcMinor: clicks ? Math.round(spend / clicks) : null,
      thumbStopRate: impressions && v3 ? v3 / impressions : null,
      declaredPurchases: ds.reduce((s, d) => s + d.purchases, 0),
      declaredValueMinor: ds.reduce((s, d) => s + d.purchaseValueMinor, 0),
      orders: real.orders,
      netMinor: real.net,
      roas: spend ? real.net / spend : null,
      fatigue: one ? creativeFatigue([...perDay.values()]) : null,
    });
  }
  return rows.filter((r) => r.spendMinor > 0 || r.orders > 0).sort((a, b) => b.spendMinor - a.spendMinor);
}

/** Daily series of one creative for the detail chart. */
export async function creativeDaily(ctx: ServiceContext, creativeId: string, period: Period) {
  return ctx.tx.select().from(schema.adCreativeMetricsDaily).where(and(eq(schema.adCreativeMetricsDaily.tenantId, ctx.tenantId), eq(schema.adCreativeMetricsDaily.creativeId, creativeId), gte(schema.adCreativeMetricsDaily.date, period.from.toISOString().slice(0, 10)), lt(schema.adCreativeMetricsDaily.date, period.to.toISOString().slice(0, 10)))).orderBy(schema.adCreativeMetricsDaily.date);
}

/* ---------- base metrics, custom metrics, dashboards ---------- */

export const BASE_METRICS = ["net_revenue", "gross_revenue", "orders", "aov", "ad_spend", "cogs", "gross_margin", "shipping", "fees", "fixed_costs", "contribution", "operating_profit", "refunds", "new_customers", "mer", "nc_roas", "cac", "poas"] as const;
export type BaseMetric = (typeof BASE_METRICS)[number];
export const MONEY_METRICS = new Set<string>(["net_revenue", "gross_revenue", "aov", "ad_spend", "cogs", "gross_margin", "shipping", "fees", "fixed_costs", "contribution", "operating_profit", "refunds", "cac"]);
export const RATIO_METRICS = new Set<string>(["mer", "nc_roas", "poas"]);

/** Base metric values for a period, in minor units for money. */
export async function baseMetricValues(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<Record<BaseMetric, number | null>> {
  const pnl = await pnlForPeriod(ctx, tenant, period);
  const b = await blendedForPeriod(ctx, tenant, period);
  return {
    net_revenue: pnl.netRevenueMinor,
    gross_revenue: pnl.grossRevenueMinor,
    orders: pnl.orders,
    aov: pnl.aovMinor,
    ad_spend: pnl.adSpendMinor,
    cogs: pnl.cogsMinor,
    gross_margin: pnl.grossMarginMinor,
    shipping: pnl.shippingCostMinor,
    fees: pnl.paymentFeeMinor,
    fixed_costs: pnl.fixedCostsMinor,
    contribution: pnl.contributionMinor,
    operating_profit: pnl.operatingProfitMinor,
    refunds: pnl.refundedMinor,
    new_customers: b.newCustomers,
    mer: b.mer,
    nc_roas: b.ncRoas,
    cac: b.cacMinor,
    poas: b.poas,
  };
}

export async function listCustomMetrics(ctx: ServiceContext) {
  return ctx.tx.select().from(schema.customMetrics).where(eq(schema.customMetrics.tenantId, ctx.tenantId)).orderBy(schema.customMetrics.label);
}

export class MetricError extends Error {}

export async function saveCustomMetric(ctx: ServiceContext, input: { key: string; label: string; formula: string; format: "money" | "ratio" | "percent" | "number"; description?: string | null }) {
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  if (!key || (BASE_METRICS as readonly string[]).includes(key)) throw new MetricError("invalid_key");
  const compiled = compileFormula(input.formula, BASE_METRICS);
  if (!compiled.ok) throw new MetricError(compiled.error);
  const [row] = await ctx.tx.insert(schema.customMetrics).values({ tenantId: ctx.tenantId, key, label: input.label.trim().slice(0, 80), formula: input.formula.trim(), format: input.format, description: input.description ?? null, createdBy: ctx.actor.userId }).onConflictDoUpdate({ target: [schema.customMetrics.tenantId, schema.customMetrics.key], set: { label: input.label.trim().slice(0, 80), formula: input.formula.trim(), format: input.format, description: input.description ?? null, updatedAt: ctx.now ?? new Date() } }).returning();
  return row!;
}

export async function deleteCustomMetric(ctx: ServiceContext, id: string) {
  await ctx.tx.delete(schema.customMetrics).where(and(eq(schema.customMetrics.tenantId, ctx.tenantId), eq(schema.customMetrics.id, id)));
}

export interface MetricValue {
  metric: string;
  label: string | null;
  format: "money" | "ratio" | "percent" | "number";
  value: number | null;
  previous: number | null;
}

/** Values for a list of metric keys (`net_revenue`, `custom:profit_per_order`) with the previous period for comparison. */
export async function metricValues(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, previous: Period, keys: string[]): Promise<MetricValue[]> {
  const [cur, prev, customs] = [await baseMetricValues(ctx, tenant, period), await baseMetricValues(ctx, tenant, previous), await listCustomMetrics(ctx)];
  return keys.map((k) => {
    if (k.startsWith("custom:")) {
      const cm = customs.find((c) => c.key === k.slice(7));
      if (!cm) return { metric: k, label: null, format: "number", value: null, previous: null };
      const compiled = compileFormula(cm.formula, BASE_METRICS);
      const val = (v: Record<string, number | null>) => (compiled.ok ? evaluateFormula(compiled.node, v) : null);
      return { metric: k, label: cm.label, format: cm.format as MetricValue["format"], value: val(cur), previous: val(prev) };
    }
    const fmt: MetricValue["format"] = MONEY_METRICS.has(k) ? "money" : RATIO_METRICS.has(k) ? "ratio" : "number";
    return { metric: k, label: null, format: fmt, value: cur[k as BaseMetric] ?? null, previous: prev[k as BaseMetric] ?? null };
  });
}

export interface DashboardWidget {
  metric: string;
}

export async function userDashboard(ctx: ServiceContext, userId: string) {
  const [row] = await ctx.tx.select().from(schema.dashboards).where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.userId, userId))).orderBy(desc(schema.dashboards.isDefault)).limit(1);
  return row ?? null;
}

export async function saveUserDashboard(ctx: ServiceContext, userId: string, widgets: DashboardWidget[], name = "Dashboard") {
  const clean = widgets.filter((w) => typeof w.metric === "string" && w.metric.length <= 60).slice(0, 24);
  const existing = await userDashboard(ctx, userId);
  if (existing) await ctx.tx.update(schema.dashboards).set({ widgets: clean, updatedAt: ctx.now ?? new Date() }).where(eq(schema.dashboards.id, existing.id));
  else await ctx.tx.insert(schema.dashboards).values({ tenantId: ctx.tenantId, userId, name, widgets: clean, isDefault: true });
}

/* ---------- alerts ---------- */

export const ALERT_METRIC_OPTIONS = ["revenue", "orders", "ad_spend", "mer", "aov", "cancel_rate", "stockouts", "late_to_ship", "roas"] as const;

/** Daily series (oldest → newest, today excluded) for an alert metric over `days` days in the tenant timezone. */
export async function alertSeries(ctx: ServiceContext, tenant: AnalyticsTenant, metric: string, days: number, opts: { campaignId?: string | null } = {}): Promise<(number | null)[]> {
  const now = ctx.now ?? new Date();
  const end = new Date(now.toLocaleString("en-US", { timeZone: tenant.timezone }));
  end.setHours(0, 0, 0, 0);
  const dayKeys: string[] = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(end.getTime() - i * 864e5);
    dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  // snapshot metric: orders ready to ship past the tenant's working-day threshold right now (issue #28)
  if (metric === "late_to_ship") return [await countLateToShip(ctx, { timezone: tenant.timezone, settings: tenant.settings, now })];
  if (metric === "stockouts") {
    const [r] = await ctx.tx.select({ n: sql<number>`count(distinct ${schema.inventoryLevels.variantId})::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), sql`${schema.inventoryLevels.available} <= 0`));
    return [r?.n ?? 0];
  }
  const from = new Date(`${dayKeys[0]}T00:00:00Z`).getTime() - 2 * 864e5;
  const orderRows = await ctx.tx.execute<{ day: string; placed: number; sales: number; cancelled: number; gross: number }>(sql`
    select to_char((placed_at at time zone ${tenant.timezone})::date, 'YYYY-MM-DD') as day, count(*)::int as placed,
           count(*) filter (where status in ${sql.raw(SALE)})::int as sales, count(*) filter (where status = 'cancelled')::int as cancelled,
           coalesce(sum(total_minor - refunded_minor) filter (where status in ${sql.raw(SALE)}), 0)::int as gross
    from orders where tenant_id = ${ctx.tenantId} and placed_at >= ${new Date(from)} and replaced_by_order_id is null group by 1`);
  const spendConds = [eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, dayKeys[0]!)];
  if (opts.campaignId) spendConds.push(eq(schema.adMetricsDaily.campaignId, opts.campaignId));
  const spendRows = await ctx.tx.select({ day: schema.adMetricsDaily.date, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}),0)::int`, value: sql<number>`coalesce(sum(${schema.adMetricsDaily.purchaseValueMinor}),0)::int` }).from(schema.adMetricsDaily).where(and(...spendConds)).groupBy(schema.adMetricsDaily.date);
  const o = new Map(orderRows.rows.map((r) => [r.day, r]));
  const sp = new Map(spendRows.map((r) => [r.day, r]));
  return dayKeys.map((d) => {
    const r = o.get(d);
    const s = sp.get(d);
    switch (metric) {
      case "revenue":
        return r ? Number(r.gross) : 0;
      case "orders":
        return r ? Number(r.sales) : 0;
      case "ad_spend":
        return s ? s.spend : 0;
      case "mer":
        return s && s.spend > 0 ? Number(r?.gross ?? 0) / s.spend : null;
      case "roas":
        return s && s.spend > 0 ? s.value / s.spend : null;
      case "aov":
        return r && Number(r.sales) > 0 ? Math.round(Number(r.gross) / Number(r.sales)) : null;
      case "cancel_rate":
        return r && Number(r.placed) > 0 ? Number(r.cancelled) / Number(r.placed) : null;
      default:
        return null;
    }
  });
}

export async function listAlertRules(ctx: ServiceContext) {
  return ctx.tx.select().from(schema.alertRules).where(eq(schema.alertRules.tenantId, ctx.tenantId)).orderBy(schema.alertRules.name);
}

export async function recentAlertEvents(ctx: ServiceContext, limit = 30) {
  return ctx.tx.select({ e: schema.alertEvents, name: schema.alertRules.name, metric: schema.alertRules.metric }).from(schema.alertEvents).innerJoin(schema.alertRules, eq(schema.alertRules.id, schema.alertEvents.ruleId)).where(eq(schema.alertEvents.tenantId, ctx.tenantId)).orderBy(desc(schema.alertEvents.firedAt)).limit(limit);
}

export async function saveAlertRule(ctx: ServiceContext, input: { id?: string; name: string; metric: string; condition: AlertCondition; channels: string[]; recipients: string[]; cooldownHours: number; isActive: boolean; scopeId?: string | null }) {
  if (!(ALERT_METRIC_OPTIONS as readonly string[]).includes(input.metric)) throw new MetricError("invalid_metric");
  const values = { name: input.name.trim().slice(0, 120), metric: input.metric, condition: input.condition, channels: input.channels.filter((c) => ["in_app", "email", "slack"].includes(c)), recipients: input.recipients, cooldownHours: Math.max(1, Math.min(168, input.cooldownHours)), isActive: input.isActive, scope: input.scopeId ? "campaign" : "tenant", scopeId: input.scopeId ?? null, updatedAt: ctx.now ?? new Date() };
  if (input.id) {
    await ctx.tx.update(schema.alertRules).set(values).where(and(eq(schema.alertRules.tenantId, ctx.tenantId), eq(schema.alertRules.id, input.id)));
    return input.id;
  }
  const [row] = await ctx.tx.insert(schema.alertRules).values({ tenantId: ctx.tenantId, ...values, createdBy: ctx.actor.userId }).returning({ id: schema.alertRules.id });
  return row!.id;
}

export async function deleteAlertRule(ctx: ServiceContext, id: string) {
  await ctx.tx.delete(schema.alertRules).where(and(eq(schema.alertRules.tenantId, ctx.tenantId), eq(schema.alertRules.id, id)));
}

/**
 * Evaluates every active rule (or one, when `ruleId`), writes an event and delivers it when it
 * fires outside the cooldown. Delivery: in-app always for the listed recipients, plus email and
 * Slack through the sinks (mock unless configured). Returns what fired.
 */
export async function evaluateAlertRules(ctx: ServiceContext, tenant: AnalyticsTenant, opts: { ruleId?: string; force?: boolean; appUrl?: string } = {}): Promise<{ evaluated: number; fired: { ruleId: string; name: string; reason: string }[] }> {
  const now = ctx.now ?? new Date();
  const conds = [eq(schema.alertRules.tenantId, ctx.tenantId), eq(schema.alertRules.isActive, true)];
  if (opts.ruleId) conds.push(eq(schema.alertRules.id, opts.ruleId));
  const rules = await ctx.tx.select().from(schema.alertRules).where(and(...conds));
  const fired: { ruleId: string; name: string; reason: string }[] = [];
  const sinks = rules.some((r) => (r.channels as string[]).some((c) => c !== "in_app")) ? await getNotificationSinks(ctx) : null;
  for (const r of rules) {
    const cond = r.condition as AlertCondition;
    const days = cond.kind === "threshold" ? Math.max(cond.days, 1) : cond.baselineDays + 1;
    const series = await alertSeries(ctx, tenant, r.metric, days, { campaignId: r.scopeId });
    const ev = evaluateAlert(cond, series);
    await ctx.tx.update(schema.alertRules).set({ lastEvaluatedAt: now }).where(eq(schema.alertRules.id, r.id));
    if (!ev.fired) continue;
    if (!opts.force && r.lastFiredAt && now.getTime() - r.lastFiredAt.getTime() < r.cooldownHours * 3600e3) continue;
    const channels = r.channels as string[];
    const recipients = (r.recipients as string[]).filter(Boolean);
    const delivered: Record<string, string> = {};
    const link = `/analytics/alerts`;
    const text = `${r.metric}: ${ev.value === null ? "—" : Number(ev.value.toFixed(2))} (${ev.reason === "threshold" ? `threshold ${ev.baseline}` : `baseline ${ev.baseline === null ? "—" : Number(ev.baseline.toFixed(2))}, z ${ev.score}`})`;
    if (channels.includes("in_app") && recipients.length) {
      await notifyUsers(ctx, { userIds: recipients, type: "alert", title: r.name, body: text, link, severity: "warning", metadata: { ruleId: r.id, reason: ev.reason } });
      delivered.in_app = "ok";
    }
    if (sinks && channels.includes("email") && recipients.length) {
      const users = await ctx.tx.select({ email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, recipients));
      try {
        await sinks.email.send(users.map((u) => u.email), { subject: `[Keel] ${r.name}`, text, url: opts.appUrl ? `${opts.appUrl}${link}` : undefined });
        delivered.email = sinks.mock.email ? "mock" : "ok";
      } catch (e) {
        delivered.email = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (sinks && channels.includes("slack")) {
      if (!sinks.slack) delivered.slack = "not_configured";
      else
        try {
          await sinks.slack.send([], { subject: r.name, text, url: opts.appUrl ? `${opts.appUrl}${link}` : undefined });
          delivered.slack = sinks.mock.slack ? "mock" : "ok";
        } catch (e) {
          delivered.slack = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
    await ctx.tx.insert(schema.alertEvents).values({ tenantId: ctx.tenantId, ruleId: r.id, firedAt: now, value: ev.value === null ? null : String(ev.value), baseline: ev.baseline === null ? null : String(ev.baseline), score: ev.score === null ? null : String(ev.score), reason: ev.reason, delivered });
    await ctx.tx.update(schema.alertRules).set({ lastFiredAt: now }).where(eq(schema.alertRules.id, r.id));
    fired.push({ ruleId: r.id, name: r.name, reason: ev.reason });
  }
  return { evaluated: rules.length, fired };
}

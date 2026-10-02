import { and, eq, gte, inArray, isNull, lt, recordAudit, schema, sql, type SQL } from "@keel/db";
import { compileFormula, diffRecords, evaluateFormula, formulaIdentifiers, localMonthKey, orderPnl, periodBuckets, bucketIndex, sumOrderPnl, targetForMonth, type Granularity, type Period } from "@keel/core";
import { AD_PLATFORMS, CUSTOM_METRIC_PREFIX, FILTERABLE_METRIC_KEYS, METRIC_KEYS, SERIES_METRIC_KEYS, isCustomMetricRef, metricDefinition, metricFiltersSchema, normalizeMetricFilters, type MetricFilters, type MetricFormat } from "@keel/config";
import type { ServiceContext } from "../context";
import type { AuditIdentity } from "../catalog/costs";
import { orderEconomicsForPeriod, pnlForPeriod, adSpendForPeriod, type AnalyticsTenant, type EconomicsRow } from "../analytics";
import { blendedForPeriod } from "../analytics/depth";
import { pnlBreakdown, returnCostsByOrder } from "../analytics/pnl-depth";
import { campaignsWithEconomics } from "../campaigns";
import { variantStock } from "../inventory";

/**
 * The tenant metric catalog (issue #43): base metrics computed by the existing analytics, inventory,
 * purchasing and campaign services, and custom metrics as formulas over them, optionally over a
 * filtered set of orders. Money is in minor units, rates are fractions.
 */

/** Shares one computation between widgets of the same request (and a short while after); identity by default. */
export type Memo = <T>(key: string, fn: () => Promise<T>) => Promise<T>;
const direct: Memo = (_key, fn) => fn();

export type MetricValues = Record<string, number | null>;
const div = (a: number, b: number | null | undefined) => (b ? a / b : null);
const iso = (d: Date) => d.toISOString();
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const PNL_KEYS = new Set(["net_revenue", "gross_revenue", "orders", "aov", "ad_spend", "cogs", "gross_margin", "shipping", "fees", "fixed_costs", "contribution", "operating_profit", "refunds", "mer", "poas", "cancel_rate", "returns_rate", "return_cost"]);
const BLENDED_KEYS = new Set(["new_customers", "nc_roas", "cac"]);
const STOCK_KEYS = new Set(["stock_value_cost", "coverage_days", "out_of_stock_variants"]);

/* ---------- unfiltered base metrics ---------- */

async function repeatCustomerRate(ctx: ServiceContext, period: Period): Promise<number | null> {
  const [r] = await ctx.tx
    .select({ total: sql<number>`count(distinct ${schema.orders.customerId})::int`, returning: sql<number>`count(distinct ${schema.orders.customerId}) filter (where ${schema.customers.firstOrderAt} < ${period.from})::int` })
    .from(schema.orders)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), isNull(schema.orders.replacedByOrderId), sql`${schema.orders.status} <> 'cancelled'`));
  return r && r.total ? r.returning / r.total : null;
}

/** Stock now: value at cost of the units on hand, aggregate days of cover, variants with nothing available. */
async function stockSnapshot(ctx: ServiceContext, tenant: AnalyticsTenant) {
  const rows = await variantStock(ctx, tenant.settings);
  let value = 0;
  let units = 0;
  let velocity = 0;
  let out = 0;
  for (const r of rows) {
    const on = Math.max(0, r.available);
    value += on * (r.costMinor ?? 0);
    units += on;
    velocity += r.velocityPerDay;
    if (r.available <= 0) out++;
  }
  return { stock_value_cost: value, coverage_days: velocity > 0 ? units / velocity : null, out_of_stock_variants: out };
}

/** Value at cost of the units still to arrive on open purchase orders (the incoming stock of the inventory page). */
async function incomingPoValue(ctx: ServiceContext): Promise<number> {
  const [r] = await ctx.tx
    .select({ v: sql<number>`coalesce(sum(greatest(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}, 0) * ${schema.purchaseOrderLines.unitCostMinor}), 0)::bigint` })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
    .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), inArray(schema.purchaseOrders.status, ["confirmed", "in_transit", "partially_received"])));
  return Number(r?.v ?? 0);
}

/** Spend, Keel-attributed ROAS, CPA and CTR of one ad platform, from the campaign economics the Campaigns page shows. */
async function platformAds(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, platform: string): Promise<MetricValues> {
  const rows = await campaignsWithEconomics(ctx, tenant, period, { platform });
  const t = rows.reduce((s, r) => ({ spend: s.spend + r.metrics.spendMinor, net: s.net + r.metrics.netRevenueMinor, orders: s.orders + r.metrics.attributedOrders, clicks: s.clicks + r.metrics.clicks, impressions: s.impressions + r.metrics.impressions }), { spend: 0, net: 0, orders: 0, clicks: 0, impressions: 0 });
  return { [`${platform}_spend`]: t.spend, [`${platform}_roas`]: div(t.net, t.spend), [`${platform}_cpa`]: t.orders ? Math.round(t.spend / t.orders) : null, [`${platform}_ctr`]: div(t.clicks, t.impressions) };
}

function pnlValues(p: Awaited<ReturnType<typeof pnlForPeriod>>): MetricValues {
  return {
    net_revenue: p.netRevenueMinor,
    gross_revenue: p.grossRevenueMinor,
    orders: p.orders,
    aov: p.aovMinor,
    ad_spend: p.adSpendMinor,
    cogs: p.cogsMinor,
    gross_margin: p.grossMarginMinor,
    shipping: p.shippingCostMinor,
    fees: p.paymentFeeMinor,
    fixed_costs: p.fixedCostsMinor,
    contribution: p.contributionMinor,
    operating_profit: p.operatingProfitMinor,
    refunds: p.refundedMinor,
    mer: div(p.netRevenueMinor, p.adSpendMinor),
    poas: div(p.contributionMinor, p.adSpendMinor),
    cancel_rate: div(p.cancelledOrders, p.placedOrders),
    returns_rate: div(p.returnedOrders, p.orders + p.returnedOrders),
    return_cost: p.returnCosts.totalMinor,
  };
}

/** Values of the requested base metrics over a period (whole store). Each source is computed once per memo key. */
export async function baseMetricsFor(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, keys: Iterable<string>, memo: Memo = direct): Promise<MetricValues> {
  const want = new Set(keys);
  const out: MetricValues = {};
  const pk = `${ctx.tenantId}|${iso(period.from)}|${iso(period.to)}`;
  const has = (set: Set<string>) => [...want].some((k) => set.has(k));
  if (has(PNL_KEYS)) Object.assign(out, pnlValues(await memo(`pnl|${pk}`, () => pnlForPeriod(ctx, tenant, period))));
  if (has(BLENDED_KEYS)) {
    const b = await memo(`blended|${pk}`, () => blendedForPeriod(ctx, tenant, period));
    Object.assign(out, { new_customers: b.newCustomers, nc_roas: b.ncRoas, cac: b.cacMinor });
  }
  if (want.has("repeat_customer_rate")) out.repeat_customer_rate = await memo(`repeat|${pk}`, () => repeatCustomerRate(ctx, period));
  if (has(STOCK_KEYS)) Object.assign(out, await memo(`stock|${ctx.tenantId}`, () => stockSnapshot(ctx, tenant)));
  if (want.has("incoming_po_value")) out.incoming_po_value = await memo(`incoming|${ctx.tenantId}`, () => incomingPoValue(ctx));
  for (const platform of AD_PLATFORMS) if ([...want].some((k) => k.startsWith(`${platform}_`))) Object.assign(out, await memo(`ads|${platform}|${pk}`, () => platformAds(ctx, tenant, period, platform)));
  return out;
}

/* ---------- filtered metrics ---------- */

/** Conditions selecting the orders of a filter set (the period bounds are applied by the economics query). */
function filterConditions(ctx: ServiceContext, f: MetricFilters): SQL[] {
  const conds: SQL[] = [];
  const o = schema.orders;
  const list = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
  if (f.channel?.length) conds.push(sql`exists (select 1 from order_attribution a where a.order_id = ${o.id} and a.channel in (${list(f.channel)}))`);
  if (f.country?.length) conds.push(inArray(o.shippingCountry, f.country));
  if (f.paymentMethod?.length) conds.push(inArray(o.paymentMethod, f.paymentMethod));
  if (f.productIds?.length) conds.push(sql`exists (select 1 from order_lines l where l.order_id = ${o.id} and l.product_id in (${sql.join(f.productIds.map((x) => sql`${x}::uuid`), sql`, `)}))`);
  if (f.productType?.length) conds.push(sql`exists (select 1 from order_lines l join products p on p.id = l.product_id where l.order_id = ${o.id} and p.product_type in (${list(f.productType)}))`);
  if (f.campaignIds?.length) conds.push(sql`exists (select 1 from order_attribution a where a.order_id = ${o.id} and a.campaign_id in (${sql.join(f.campaignIds.map((x) => sql`${x}::uuid`), sql`, `)}))`);
  if (f.platform?.length) conds.push(sql`exists (select 1 from order_attribution a join campaigns c on c.id = a.campaign_id where a.order_id = ${o.id} and c.platform in (${list(f.platform)}))`);
  if (f.customerType) {
    // the customer's first order (earliest non-cancelled, replacements excluded): same rule as new customers in Analytics
    const firsts = sql`(select distinct on (f.customer_id) f.id from orders f where f.tenant_id = ${ctx.tenantId} and f.customer_id is not null and f.status <> 'cancelled' and f.replaced_by_order_id is null order by f.customer_id, f.placed_at asc, f.id asc)`;
    conds.push(f.customerType === "new" ? sql`${o.id} in ${firsts}` : sql`(${o.customerId} is not null and ${o.id} not in ${firsts})`);
  }
  return conds;
}

/** Orders of the period matching the filters, and their economics (every status: rates need the cancelled ones). */
async function filteredEconomics(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, f: MetricFilters): Promise<EconomicsRow[]> {
  const ids = await ctx.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), isNull(schema.orders.replacedByOrderId), ...filterConditions(ctx, f)));
  return ids.length ? orderEconomicsForPeriod(ctx, tenant, period, { orderIds: ids.map((r) => r.id) }) : [];
}

/** Ad spend of the campaigns a filter names (campaigns, or every campaign of the platforms); null when the filter names none. */
async function filteredAdSpend(ctx: ServiceContext, period: Period, f: MetricFilters): Promise<number | null> {
  if (!f.campaignIds?.length && !f.platform?.length) return null;
  const conds = [eq(schema.campaigns.tenantId, ctx.tenantId)];
  if (f.campaignIds?.length) conds.push(inArray(schema.campaigns.id, f.campaignIds));
  if (f.platform?.length) conds.push(inArray(schema.campaigns.platform, f.platform));
  const ids = (await ctx.tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(...conds))).map((r) => r.id);
  return adSpendForPeriod(ctx, period, ids.length ? ids : [ZERO_UUID]);
}

/**
 * Base values over filtered orders, built like the per-order P/L table (Analytics → Orders P/L):
 * contribution = revenue − goods − shipping − payment fee − the order's own return costs, sale orders only.
 */
async function filteredValues(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, econ: EconomicsRow[], adSpend: number | null): Promise<MetricValues> {
  const sales = econ.filter((e) => e.inScope);
  const rc = await returnCostsByOrder(ctx, tenant, sales.map((e) => e.orderId));
  const t = sumOrderPnl(sales.map((e) => orderPnl(e, rc.get(e.orderId) ?? 0)));
  const placed = econ.length;
  const cancelled = econ.filter((e) => e.status === "cancelled").length;
  const returned = econ.filter((e) => e.status === "returned" || e.status === "refunded" || e.status === "returned_partial").length;
  return {
    net_revenue: t.netRevenueMinor,
    gross_revenue: t.grossRevenueMinor,
    orders: t.orders,
    aov: t.orders ? Math.round(t.grossRevenueMinor / t.orders) : null,
    cogs: t.cogsMinor,
    gross_margin: t.netRevenueMinor - t.cogsMinor,
    shipping: t.shippingCostMinor,
    fees: t.paymentFeeMinor,
    contribution: t.contributionMinor,
    refunds: t.refundedMinor,
    return_cost: t.returnCostMinor,
    cancel_rate: div(cancelled, placed),
    returns_rate: div(returned, t.orders + returned),
    ad_spend: adSpend,
    mer: adSpend === null ? null : div(t.netRevenueMinor, adSpend),
    poas: adSpend === null ? null : div(t.contributionMinor, adSpend),
  };
}

export async function filteredMetricsFor(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, filters: MetricFilters, memo: Memo = direct): Promise<MetricValues> {
  const key = `filtered|${ctx.tenantId}|${iso(period.from)}|${iso(period.to)}|${JSON.stringify(filters)}`;
  return memo(key, async () => filteredValues(ctx, tenant, period, await filteredEconomics(ctx, tenant, period, filters), await filteredAdSpend(ctx, period, filters)));
}

/* ---------- custom metrics ---------- */

export type CustomMetricRow = typeof schema.customMetrics.$inferSelect;

export class MetricDefinitionError extends Error {}

/** Bases a custom metric's formula uses (empty when it no longer parses). */
export function customMetricBases(cm: Pick<CustomMetricRow, "formula" | "filters">): string[] {
  const allowed = normalizeMetricFilters(cm.filters) ? FILTERABLE_METRIC_KEYS : METRIC_KEYS;
  const c = compileFormula(cm.formula, allowed);
  return c.ok ? [...formulaIdentifiers(c.node)] : [];
}

export interface TenantMetricInput {
  key: string;
  label: string;
  formula: string;
  format: "money" | "ratio" | "percent" | "number";
  description?: string | null;
  filters?: unknown;
  higherIsBetter?: boolean;
  translations?: Record<string, string>;
}

/** Validates a custom metric: key, formula over the allowed bases (fewer when filtered), filters. */
export function validateTenantMetric(input: TenantMetricInput): { key: string; filters: MetricFilters | null; bases: string[] } {
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!key || METRIC_KEYS.includes(key)) throw new MetricDefinitionError("invalid_key");
  if (input.filters !== undefined && input.filters !== null && !metricFiltersSchema.safeParse(input.filters).success) throw new MetricDefinitionError("invalid_filters");
  const filters = normalizeMetricFilters(input.filters);
  const compiled = compileFormula(input.formula, filters ? FILTERABLE_METRIC_KEYS : METRIC_KEYS);
  if (!compiled.ok) throw new MetricDefinitionError(filters && compileFormula(input.formula, METRIC_KEYS).ok ? "not_filterable" : compiled.error);
  return { key, filters, bases: [...formulaIdentifiers(compiled.node)] };
}

const identityOf = (ctx: ServiceContext, a?: AuditIdentity): AuditIdentity => a ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", impersonatedBy: null };

/** Creates or updates a custom metric (by key) and writes the change to the tenant audit log with a diff. */
export async function saveTenantMetric(ctx: ServiceContext, input: TenantMetricInput, opts: { audit?: AuditIdentity } = {}): Promise<CustomMetricRow> {
  const { key, filters } = validateTenantMetric(input);
  const translations = Object.fromEntries(Object.entries(input.translations ?? {}).map(([l, v]) => [l.slice(0, 10), String(v).trim().slice(0, 80)]).filter(([, v]) => v));
  const values = { label: input.label.trim().slice(0, 80), formula: input.formula.trim(), format: input.format, description: input.description ?? null, filters: filters ?? {}, higherIsBetter: input.higherIsBetter ?? true, translations };
  const [before] = await ctx.tx.select().from(schema.customMetrics).where(and(eq(schema.customMetrics.tenantId, ctx.tenantId), eq(schema.customMetrics.key, key))).limit(1);
  const [row] = before
    ? await ctx.tx.update(schema.customMetrics).set({ ...values, updatedAt: ctx.now ?? new Date() }).where(eq(schema.customMetrics.id, before.id)).returning()
    : await ctx.tx.insert(schema.customMetrics).values({ tenantId: ctx.tenantId, key, ...values, createdBy: ctx.actor.userId }).returning();
  const pick = (r: Partial<CustomMetricRow> | undefined) => (r ? { label: r.label, formula: r.formula, format: r.format, filters: r.filters, higherIsBetter: r.higherIsBetter, translations: r.translations, description: r.description } : {});
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: before ? "custom_metric.updated" : "custom_metric.created", entityType: "custom_metric", entityId: row!.id, diff: diffRecords(pick(before), pick(row)), metadata: { key } });
  return row!;
}

export async function deleteTenantMetric(ctx: ServiceContext, id: string, opts: { audit?: AuditIdentity } = {}): Promise<boolean> {
  const [gone] = await ctx.tx.delete(schema.customMetrics).where(and(eq(schema.customMetrics.tenantId, ctx.tenantId), eq(schema.customMetrics.id, id))).returning();
  if (!gone) return false;
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "custom_metric.deleted", entityType: "custom_metric", entityId: id, diff: { formula: { from: gone.formula, to: null } }, metadata: { key: gone.key } });
  return true;
}

export async function listTenantMetrics(ctx: ServiceContext): Promise<CustomMetricRow[]> {
  return ctx.tx.select().from(schema.customMetrics).where(eq(schema.customMetrics.tenantId, ctx.tenantId)).orderBy(schema.customMetrics.label);
}

/* ---------- values ---------- */

export interface TenantMetricValue {
  ref: string;
  /** Tenant label for custom metrics (translation for the locale when given), null for base metrics (labelled by i18n). */
  label: string | null;
  format: MetricFormat;
  kind: "period" | "snapshot";
  higherIsBetter: boolean;
  value: number | null;
  previous: number | null;
  filters: MetricFilters | null;
  /** The metric is unknown (deleted custom metric, base removed): rendered as "—". */
  missing: boolean;
}

export function customLabel(cm: Pick<CustomMetricRow, "label" | "translations">, locale?: string): string {
  const tr = (cm.translations ?? {}) as Record<string, string>;
  return (locale && (tr[locale] || tr[locale.slice(0, 2)])) || cm.label;
}

/** Evaluates metric references (`net_revenue`, `custom:contribution_per_order`) over a period and, optionally, the previous one. */
export async function tenantMetricValues(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, previous: Period | null, refs: string[], opts: { memo?: Memo; customs?: CustomMetricRow[]; locale?: string } = {}): Promise<TenantMetricValue[]> {
  const memo = opts.memo ?? direct;
  const customs = opts.customs ?? (refs.some(isCustomMetricRef) ? await listTenantMetrics(ctx) : []);
  const valuesFor = async (p: Period, bases: string[], filters: MetricFilters | null) => (filters ? filteredMetricsFor(ctx, tenant, p, filters, memo) : baseMetricsFor(ctx, tenant, p, bases, memo));
  const out: TenantMetricValue[] = [];
  for (const ref of refs) {
    if (isCustomMetricRef(ref)) {
      const cm = customs.find((c) => c.key === ref.slice(CUSTOM_METRIC_PREFIX.length));
      const filters = cm ? normalizeMetricFilters(cm.filters) : null;
      const compiled = cm ? compileFormula(cm.formula, filters ? FILTERABLE_METRIC_KEYS : METRIC_KEYS) : null;
      if (!cm || !compiled?.ok) {
        out.push({ ref, label: cm ? customLabel(cm, opts.locale) : null, format: (cm?.format as MetricFormat) ?? "number", kind: "period", higherIsBetter: cm?.higherIsBetter ?? true, value: null, previous: null, filters, missing: true });
        continue;
      }
      const bases = [...formulaIdentifiers(compiled.node)];
      const snapshot = bases.length > 0 && bases.every((b) => metricDefinition(b)?.kind === "snapshot");
      const cur = evaluateFormula(compiled.node, await valuesFor(period, bases, filters));
      const prev = previous && !snapshot ? evaluateFormula(compiled.node, await valuesFor(previous, bases, filters)) : null;
      out.push({ ref, label: customLabel(cm, opts.locale), format: cm.format as MetricFormat, kind: snapshot ? "snapshot" : "period", higherIsBetter: cm.higherIsBetter, value: cur, previous: prev, filters, missing: false });
      continue;
    }
    const def = metricDefinition(ref);
    if (!def) {
      out.push({ ref, label: null, format: "number", kind: "period", higherIsBetter: true, value: null, previous: null, filters: null, missing: true });
      continue;
    }
    const cur = (await valuesFor(period, [ref], null))[ref] ?? null;
    const prev = previous && def.kind === "period" ? ((await valuesFor(previous, [ref], null))[ref] ?? null) : null;
    out.push({ ref, label: null, format: def.format, kind: def.kind, higherIsBetter: def.higherIsBetter, value: cur, previous: prev, filters: null, missing: false });
  }
  return out;
}

/* ---------- series ---------- */

export interface MetricSeries {
  buckets: { key: string; from: Date; to: Date; partial: boolean }[];
  series: { ref: string; label: string | null; format: MetricFormat; values: (number | null)[] }[];
}

/** A metric reference can be drawn as a series when every base it uses has a value per bucket. */
export function isSeriesRef(ref: string, customs: Pick<CustomMetricRow, "key" | "formula" | "filters">[]): boolean {
  if (!isCustomMetricRef(ref)) return SERIES_METRIC_KEYS.includes(ref);
  const cm = customs.find((c) => c.key === ref.slice(CUSTOM_METRIC_PREFIX.length));
  if (!cm) return false;
  const bases = customMetricBases(cm);
  return bases.length > 0 && bases.every((b) => SERIES_METRIC_KEYS.includes(b));
}

/**
 * Metrics per day / week / month. Whole-store values come from the P/L by period (the buckets add up
 * to the period P/L); filtered custom metrics bucket their filtered orders the same way.
 */
export async function tenantMetricSeries(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, granularity: Granularity, refs: string[], opts: { memo?: Memo; customs?: CustomMetricRow[]; locale?: string } = {}): Promise<MetricSeries> {
  const memo = opts.memo ?? direct;
  const customs = opts.customs ?? (refs.some(isCustomMetricRef) ? await listTenantMetrics(ctx) : []);
  const buckets = periodBuckets(period, granularity, 120);
  const breakdown = await memo(`breakdown|${ctx.tenantId}|${iso(period.from)}|${iso(period.to)}|${granularity}`, () => pnlBreakdown(ctx, tenant, period, granularity));
  const statusBy = buckets.map(() => ({ placed: 0, cancelled: 0, returned: 0 }));
  for (const e of breakdown.economics) {
    const i = bucketIndex(buckets, e.placedAt);
    if (i < 0) continue;
    statusBy[i]!.placed++;
    if (e.status === "cancelled") statusBy[i]!.cancelled++;
    if (e.status === "returned" || e.status === "refunded" || e.status === "returned_partial") statusBy[i]!.returned++;
  }
  const whole: MetricValues[] = breakdown.buckets.slice(0, buckets.length).map((b, i) => ({
    net_revenue: b.netRevenueMinor,
    gross_revenue: b.grossRevenueMinor,
    orders: b.orders,
    aov: b.orders ? Math.round(b.grossRevenueMinor / b.orders) : null,
    ad_spend: b.adSpendMinor,
    cogs: b.cogsMinor,
    gross_margin: b.grossMarginMinor,
    shipping: b.shippingCostMinor,
    fees: b.paymentFeeMinor,
    fixed_costs: b.fixedCostsMinor,
    contribution: b.contributionMinor,
    operating_profit: b.operatingProfitMinor,
    refunds: b.refundedMinor,
    mer: div(b.netRevenueMinor, b.adSpendMinor),
    poas: div(b.contributionMinor, b.adSpendMinor),
    cancel_rate: div(statusBy[i]!.cancelled, statusBy[i]!.placed),
    returns_rate: div(statusBy[i]!.returned, b.orders + statusBy[i]!.returned),
    return_cost: b.returnCostsMinor,
  }));
  const series: MetricSeries["series"] = [];
  for (const ref of refs) {
    if (!isCustomMetricRef(ref)) {
      const def = metricDefinition(ref);
      series.push({ ref, label: null, format: def?.format ?? "number", values: def?.series ? whole.map((v) => v[ref] ?? null) : buckets.map(() => null) });
      continue;
    }
    const cm = customs.find((c) => c.key === ref.slice(CUSTOM_METRIC_PREFIX.length));
    const filters = cm ? normalizeMetricFilters(cm.filters) : null;
    const compiled = cm ? compileFormula(cm.formula, filters ? FILTERABLE_METRIC_KEYS : METRIC_KEYS) : null;
    if (!cm || !compiled?.ok || !isSeriesRef(ref, customs)) {
      series.push({ ref, label: cm ? customLabel(cm, opts.locale) : null, format: (cm?.format as MetricFormat) ?? "number", values: buckets.map(() => null) });
      continue;
    }
    let values: MetricValues[] = whole;
    if (filters) {
      const econ = await memo(`fecon|${ctx.tenantId}|${iso(period.from)}|${iso(period.to)}|${JSON.stringify(filters)}`, () => filteredEconomics(ctx, tenant, period, filters));
      const per = buckets.map(() => [] as EconomicsRow[]);
      for (const e of econ) {
        const i = bucketIndex(buckets, e.placedAt);
        if (i >= 0) per[i]!.push(e);
      }
      values = [];
      for (const [i, rows] of per.entries()) values.push(await filteredValues(ctx, tenant, buckets[i]!, rows, await filteredAdSpend(ctx, buckets[i]!, filters)));
    }
    series.push({ ref, label: customLabel(cm, opts.locale), format: cm.format as MetricFormat, values: values.map((v) => evaluateFormula(compiled.node, v)) });
  }
  return { buckets: buckets.map((b) => ({ key: b.key, from: b.from, to: b.to, partial: b.partial })), series };
}

/* ---------- targets ---------- */

export async function listMetricTargets(ctx: ServiceContext, metric?: string) {
  const conds = [eq(schema.metricTargets.tenantId, ctx.tenantId)];
  if (metric) conds.push(eq(schema.metricTargets.metric, metric));
  return ctx.tx.select().from(schema.metricTargets).where(and(...conds)).orderBy(schema.metricTargets.metric, schema.metricTargets.month);
}

/** Sets (or clears, with null) a metric's target for a month; audited with the diff. */
export async function setMetricTarget(ctx: ServiceContext, input: { metric: string; month: string; target: number | null }, opts: { audit?: AuditIdentity } = {}): Promise<void> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new MetricDefinitionError("invalid_month");
  if (!isCustomMetricRef(input.metric) && !metricDefinition(input.metric)) throw new MetricDefinitionError("unknown_metric");
  if (input.target !== null && !Number.isFinite(input.target)) throw new MetricDefinitionError("invalid_target");
  const where = and(eq(schema.metricTargets.tenantId, ctx.tenantId), eq(schema.metricTargets.metric, input.metric), eq(schema.metricTargets.month, input.month));
  const [before] = await ctx.tx.select().from(schema.metricTargets).where(where).limit(1);
  if (input.target === null) await ctx.tx.delete(schema.metricTargets).where(where);
  else if (before) await ctx.tx.update(schema.metricTargets).set({ target: input.target, updatedAt: ctx.now ?? new Date() }).where(eq(schema.metricTargets.id, before.id));
  else await ctx.tx.insert(schema.metricTargets).values({ tenantId: ctx.tenantId, metric: input.metric, month: input.month, target: input.target, createdBy: ctx.actor.userId });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "metric_target.set", entityType: "metric_target", entityId: before?.id, diff: { target: { from: before?.target ?? null, to: input.target } }, metadata: { metric: input.metric, month: input.month } });
}

/** The target that applies to the current month in the tenant time zone. */
export async function currentTarget(ctx: ServiceContext, tenant: AnalyticsTenant, metric: string, now = ctx.now ?? new Date()): Promise<{ month: string; target: number; ownMonth: boolean } | null> {
  const month = localMonthKey(now, tenant.timezone);
  const rows = await listMetricTargets(ctx, metric);
  const t = targetForMonth(rows, month);
  return t ? { month, target: t.target, ownMonth: t.month === month } : null;
}

/** Values the metric builder offers for each filter, read from the tenant's own data. */
export async function metricFilterOptions(ctx: ServiceContext) {
  const t = ctx.tenantId;
  const [channels, countries, methods, campaigns, products, types] = [
    await ctx.tx.selectDistinct({ v: schema.orderAttribution.channel }).from(schema.orderAttribution).where(eq(schema.orderAttribution.tenantId, t)).orderBy(schema.orderAttribution.channel),
    await ctx.tx.selectDistinct({ v: schema.orders.shippingCountry }).from(schema.orders).where(eq(schema.orders.tenantId, t)).orderBy(schema.orders.shippingCountry),
    await ctx.tx.selectDistinct({ v: schema.orders.paymentMethod }).from(schema.orders).where(eq(schema.orders.tenantId, t)).orderBy(schema.orders.paymentMethod),
    await ctx.tx.select({ id: schema.campaigns.id, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, t)).orderBy(schema.campaigns.platform, schema.campaigns.name),
    await ctx.tx.select({ id: schema.products.id, title: schema.products.title }).from(schema.products).where(eq(schema.products.tenantId, t)).orderBy(schema.products.title).limit(300),
    await ctx.tx.selectDistinct({ v: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, t)).orderBy(schema.products.productType),
  ];
  return {
    channels: channels.map((r) => r.v).filter(Boolean),
    countries: countries.map((r) => r.v).filter((v): v is string => Boolean(v)),
    paymentMethods: methods.map((r) => r.v).filter(Boolean),
    campaigns,
    platforms: [...new Set(campaigns.map((c) => c.platform))],
    products,
    productTypes: types.map((r) => r.v).filter((v): v is string => Boolean(v)),
  };
}

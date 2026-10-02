import { and, eq, gte, inArray, isNull, lt, lte, schema, sql } from "@keel/db";
import { change, costCoverage, effectiveTaxRateBps, monthKey, orderEconomics, returnCostsOfPeriod, previousPeriod, resolveFixedCosts, resolveShippingCosts, runningWindows, sumEconomics, type CostCoverage, type CostSource, type MonthCostUse, type OrderEconomics, type Period, type PeriodCostEntry, type PnlTotals, type TenantSettings } from "@keel/core";
import type { ServiceContext } from "../context";

export interface AnalyticsTenant {
  id: string;
  country: string;
  currency: string;
  timezone: string;
  settings: TenantSettings;
}

interface TaxRate { country: string; rateBps: number; pricesIncludeTax: boolean }

async function loadTaxRates(ctx: ServiceContext): Promise<TaxRate[]> {
  return ctx.tx.select({ country: schema.tenantTaxRates.country, rateBps: schema.tenantTaxRates.rateBps, pricesIncludeTax: schema.tenantTaxRates.pricesIncludeTax }).from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, ctx.tenantId));
}

async function shippingCostFor(ctx: ServiceContext, settings: TenantSettings, period: Period): Promise<(placedAt: Date) => number> {
  const rows = await ctx.tx.select().from(schema.costSettings).where(and(eq(schema.costSettings.tenantId, ctx.tenantId), eq(schema.costSettings.kind, "shipping_per_order")));
  return (placedAt: Date) => {
    const day = placedAt.toISOString().slice(0, 10);
    const hit = rows.find((r) => r.validFrom <= day && (!r.validTo || r.validTo >= day));
    void period;
    return hit?.amountMinor ?? settings.shippingCostMinor;
  };
}

export interface EconomicsRow extends OrderEconomics {
  orderId: string;
  name: string;
  placedAt: Date;
  status: string;
  customerId: string | null;
  paymentMethod: string;
  shippingCountry: string | null;
  /** Country and effective rate of the tax line (tax report). */
  taxCountry: string;
  taxRateBps: number;
}

/** Economics for every order placed in the period (in-scope flag included). Payment fees are the payout's actual fees when imported, the tenant's estimate otherwise. */
export async function orderEconomicsForPeriod(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, opts: { orderIds?: string[] } = {}): Promise<EconomicsRow[]> {
  // replaced orders (cancelled and recreated by an edit) are lineage, not demand: they never count
  const conds = [eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), isNull(schema.orders.replacedByOrderId)];
  if (opts.orderIds) conds.push(inArray(schema.orders.id, opts.orderIds.length ? opts.orderIds : ["00000000-0000-0000-0000-000000000000"]));
  const orders = await ctx.tx.select().from(schema.orders).where(and(...conds));
  if (!orders.length) return [];
  const lines = await ctx.tx.select({ orderId: schema.orderLines.orderId, quantity: schema.orderLines.currentQuantity, unitPriceMinor: schema.orderLines.unitPriceMinor, unitCostMinor: schema.orderLines.unitCostMinor, isAncillary: schema.orderLines.isAncillary }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), gte(schema.orderLines.createdAt, new Date(0)), inArray(schema.orderLines.orderId, orders.map((o) => o.id))));
  const byOrder = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = byOrder.get(l.orderId) ?? [];
    arr.push(l);
    byOrder.set(l.orderId, arr);
  }
  // actual fees: the balance transactions of the order (charge fee, plus any refund or dispute fee) once a charge was imported
  const feeRows = await ctx.tx
    .select({ orderId: schema.balanceTransactions.orderId, fee: sql<number>`coalesce(sum(${schema.balanceTransactions.feeMinor}), 0)::int`, charges: sql<number>`count(*) filter (where ${schema.balanceTransactions.type} = 'charge')::int` })
    .from(schema.balanceTransactions)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.balanceTransactions.orderId))
    .where(and(eq(schema.balanceTransactions.tenantId, ctx.tenantId), ...conds))
    .groupBy(schema.balanceTransactions.orderId);
  const actualFee = new Map(feeRows.filter((r) => r.charges > 0).map((r) => [r.orderId!, r.fee]));
  const rates = await loadTaxRates(ctx);
  const shipping = await shippingCostFor(ctx, tenant.settings, period);
  const rateFor = (country: string | null) => rates.find((r) => r.country === country) ?? rates.find((r) => r.country === tenant.country) ?? { country: tenant.country, rateBps: 0, pricesIncludeTax: true };
  return orders.map((o) => {
    const rate = rateFor(o.shippingCountry);
    const method = o.paymentMethod as keyof TenantSettings["paymentFeeBps"];
    const eco = orderEconomics({
      status: o.status,
      totalMinor: o.totalMinor,
      taxMinor: o.taxMinor,
      refundedMinor: o.refundedMinor,
      returnedFraction: o.returnedFraction / 10000,
      taxRateBps: rate.rateBps,
      pricesIncludeTax: rate.pricesIncludeTax,
      lines: (byOrder.get(o.id) ?? []).map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, unitCostMinor: l.unitCostMinor, isAncillary: l.isAncillary })),
      paymentMethod: o.paymentMethod,
      paymentFeeBps: tenant.settings.paymentFeeBps[method] ?? 0,
      paymentFeeFixedMinor: tenant.settings.paymentFeeFixedMinor[method] ?? 0,
      actualPaymentFeeMinor: actualFee.get(o.id) ?? null,
      shippingCostMinor: shipping(o.placedAt),
    });
    const taxRateBps = effectiveTaxRateBps({ taxMinor: eco.taxMinor, subtotalMinor: o.subtotalMinor, discountMinor: o.discountMinor, pricesIncludeTax: rate.pricesIncludeTax, platformTaxMinor: o.taxMinor, fallbackRateBps: rate.rateBps });
    return { ...eco, orderId: o.id, name: o.name, placedAt: o.placedAt, status: o.status, customerId: o.customerId, paymentMethod: o.paymentMethod, shippingCountry: o.shippingCountry, taxCountry: o.shippingCountry ?? tenant.country, taxRateBps };
  });
}

export async function adSpendForPeriod(ctx: ServiceContext, period: Period, campaignIds?: string[]): Promise<number> {
  const conds = [eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, period.from.toISOString().slice(0, 10)), lt(schema.adMetricsDaily.date, period.to.toISOString().slice(0, 10))];
  if (campaignIds) conds.push(inArray(schema.adMetricsDaily.campaignId, campaignIds.length ? campaignIds : ["00000000-0000-0000-0000-000000000000"]));
  const [r] = await ctx.tx.select({ spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(and(...conds));
  return r?.spend ?? 0;
}

/** Legacy flat monthly amounts (`cost_settings.fixed_monthly`) valid in a given month: the fallback when no period cost was entered. */
async function legacyFixedMonthly(ctx: ServiceContext): Promise<(period: string) => number> {
  const rows = await ctx.tx.select().from(schema.costSettings).where(and(eq(schema.costSettings.tenantId, ctx.tenantId), eq(schema.costSettings.kind, "fixed_monthly")));
  return (period: string) => {
    const day = `${period}-15`;
    return rows.filter((r) => r.validFrom <= day && (!r.validTo || r.validTo >= day)).reduce((s, r) => s + r.amountMinor, 0);
  };
}

/** Period cost entries (estimate / actual) for every month overlapping the period. */
export async function periodCostEntries(ctx: ServiceContext, period: Period): Promise<PeriodCostEntry[]> {
  const fromKey = monthKey(period.from);
  const toKey = monthKey(new Date(period.to.getTime() - 1));
  const rows = await ctx.tx.select().from(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, ctx.tenantId), gte(schema.periodCosts.period, fromKey), lte(schema.periodCosts.period, toKey)));
  return rows.map((r) => ({ period: r.period, kind: r.kind as PeriodCostEntry["kind"], label: r.label, estimateMinor: r.estimateMinor, actualMinor: r.actualMinor }));
}

export interface PnlReport extends PnlTotals {
  period: Period;
  placedOrders: number;
  cancelledOrders: number;
  returnedOrders: number;
  pendingOrders: number;
  /** Which figure the P/L used for fixed and shipping costs: actual, estimate, legacy setting, none, or mixed across months. */
  costSources: { fixed: CostSource; shipping: CostSource };
  costByMonth: { fixed: MonthCostUse[]; shipping: MonthCostUse[] };
  returnCosts: { labelsMinor: number; handlingMinor: number; recoveredMinor: number; totalMinor: number };
  /** How reliable the cost of goods is: sale line revenue by where its cost came from (`missing` when the line has none). */
  costCoverage: CostCoverage;
}

/** Line revenue of the given orders grouped by the variant's cost source and whether the line carries a cost. */
async function costCoverageOf(ctx: ServiceContext, orderIds: string[]): Promise<CostCoverage> {
  if (!orderIds.length) return costCoverage([]);
  const rows = await ctx.tx
    .select({ source: schema.productVariants.costSource, hasCost: sql<boolean>`${schema.orderLines.unitCostMinor} is not null`, revenue: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity} * ${schema.orderLines.unitPriceMinor}), 0)::bigint` })
    .from(schema.orderLines)
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
    .where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.isAncillary, false), inArray(schema.orderLines.orderId, orderIds)))
    .groupBy(schema.productVariants.costSource, sql`${schema.orderLines.unitCostMinor} is not null`);
  return costCoverage(rows.map((r) => ({ source: r.source, hasCost: r.hasCost, revenueMinor: Number(r.revenue) })));
}

export async function pnlForPeriod(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<PnlReport> {
  return pnlFromRows(ctx, tenant, period, await orderEconomicsForPeriod(ctx, tenant, period));
}

/** The period P/L from economics rows already loaded with `orderEconomicsForPeriod` for the same period. */
export async function pnlFromRows(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, rows: EconomicsRow[]): Promise<PnlReport> {
  const adSpend = await adSpendForPeriod(ctx, period);
  const entries = await periodCostEntries(ctx, period);
  const fixed = resolveFixedCosts(entries, period.from, period.to, await legacyFixedMonthly(ctx));
  const shipEstimateByMonth: Record<string, number> = {};
  for (const r of rows) if (r.inScope) shipEstimateByMonth[monthKey(r.placedAt)] = (shipEstimateByMonth[monthKey(r.placedAt)] ?? 0) + r.shippingCostMinor;
  const shipping = resolveShippingCosts(shipEstimateByMonth, entries, period.from, period.to);
  // returns whose goods came back in the period: labels and handling, net of deductions charged to customers
  const received = await ctx.tx.select({ returnless: schema.returnRequests.returnless, deductionMinor: schema.returnRequests.deductionMinor }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), gte(schema.returnRequests.receivedAt, period.from), lt(schema.returnRequests.receivedAt, period.to)));
  const returnCosts = returnCostsOfPeriod(received.map((r) => ({ goodsBack: true, returnless: r.returnless, deductionMinor: r.deductionMinor })), tenant.settings.returnLabelCostMinor, tenant.settings.returnHandlingCostMinor);
  const totals = sumEconomics(rows, adSpend, fixed.totalMinor, returnCosts.totalMinor);
  // the carrier invoice, when entered, replaces the per-order estimate month by month
  totals.shippingCostMinor = shipping.totalMinor;
  totals.contributionMinor = totals.grossMarginMinor - totals.shippingCostMinor - totals.paymentFeeMinor - totals.returnCostsMinor;
  totals.operatingProfitMinor = totals.contributionMinor - adSpend - fixed.totalMinor;
  totals.contributionRate = totals.netRevenueMinor ? totals.contributionMinor / totals.netRevenueMinor : null;
  return {
    ...totals,
    costSources: { fixed: fixed.source, shipping: shipping.source },
    returnCosts,
    costCoverage: await costCoverageOf(ctx, rows.filter((r) => r.inScope).map((r) => r.orderId)),
    costByMonth: { fixed: fixed.byMonth, shipping: shipping.byMonth },
    period,
    placedOrders: rows.length,
    cancelledOrders: rows.filter((r) => r.status === "cancelled").length,
    returnedOrders: rows.filter((r) => r.status === "returned" || r.status === "refunded" || r.status === "returned_partial").length,
    pendingOrders: rows.filter((r) => ["new", "pending_review", "on_hold"].includes(r.status)).length,
  };
}

export interface KpiSet {
  period: Period;
  previous: Period;
  current: PnlReport;
  before: PnlReport;
  newCustomers: number;
  returningCustomers: number;
  cancelRate: number | null;
  returnRate: number | null;
  changes: Record<"netRevenue" | "orders" | "aov" | "cancelRate" | "returnRate" | "contribution", number | null>;
}

export async function kpisForPeriod(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<KpiSet> {
  const previous = previousPeriod(period);
  const [current, before] = await Promise.all([pnlForPeriod(ctx, tenant, period), pnlForPeriod(ctx, tenant, previous)]);
  const [cust] = await ctx.tx
    .select({
      newCustomers: sql<number>`count(distinct ${schema.orders.customerId}) filter (where ${schema.customers.firstOrderAt} >= ${period.from} and ${schema.customers.firstOrderAt} < ${period.to})::int`,
      returning: sql<number>`count(distinct ${schema.orders.customerId}) filter (where ${schema.customers.firstOrderAt} < ${period.from})::int`,
    })
    .from(schema.orders)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), sql`${schema.orders.status} not in ('cancelled')`));
  const cancelRate = current.placedOrders ? current.cancelledOrders / current.placedOrders : null;
  const prevCancelRate = before.placedOrders ? before.cancelledOrders / before.placedOrders : null;
  const returnRate = current.orders + current.returnedOrders ? current.returnedOrders / (current.orders + current.returnedOrders) : null;
  const prevReturnRate = before.orders + before.returnedOrders ? before.returnedOrders / (before.orders + before.returnedOrders) : null;
  return {
    period,
    previous,
    current,
    before,
    newCustomers: cust?.newCustomers ?? 0,
    returningCustomers: cust?.returning ?? 0,
    cancelRate,
    returnRate,
    changes: {
      netRevenue: change(current.netRevenueMinor, before.netRevenueMinor),
      orders: change(current.orders, before.orders),
      aov: change(current.aovMinor ?? 0, before.aovMinor ?? 0),
      cancelRate: cancelRate !== null && prevCancelRate !== null && prevCancelRate > 0 ? (cancelRate - prevCancelRate) / prevCancelRate : null,
      returnRate: returnRate !== null && prevReturnRate !== null && prevReturnRate > 0 ? (returnRate - prevReturnRate) / prevReturnRate : null,
      contribution: change(current.contributionMinor, before.contributionMinor),
    },
  };
}

/** Daily net revenue and orders for charts, in the tenant timezone. */
export async function dailySeries(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<{ day: string; orders: number; grossRevenueMinor: number }[]> {
  const rows = await ctx.tx
    .select({ day: sql<string>`to_char((${schema.orders.placedAt} at time zone ${tenant.timezone})::date, 'YYYY-MM-DD')`, orders: sql<number>`count(*) filter (where ${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial'))::int`, gross: sql<number>`coalesce(sum(${schema.orders.totalMinor} - ${schema.orders.refundedMinor}) filter (where ${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial')), 0)::int` })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({ day: r.day, orders: r.orders, grossRevenueMinor: r.gross }));
}

export interface DashboardSummary {
  windows: ReturnType<typeof runningWindows>;
  today: { placed: number; sales: number; grossRevenueMinor: number; aovMinor: number | null; byStatus: Record<string, number> };
  yesterday: { placed: number; sales: number; grossRevenueMinor: number };
  lastWeek: { placed: number; sales: number; grossRevenueMinor: number };
  open: { pendingReview: number; onHold: number; fresh: number; shipmentExceptions: number; stuckShipments: number; returnsRequested: number; criticalVariants: number; failedWebhooks: number };
  series30d: { day: string; orders: number; grossRevenueMinor: number }[];
}

async function windowCounts(ctx: ServiceContext, p: Period) {
  const [r] = await ctx.tx
    .select({
      placed: sql<number>`count(*)::int`,
      sales: sql<number>`count(*) filter (where ${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial'))::int`,
      gross: sql<number>`coalesce(sum(${schema.orders.totalMinor} - ${schema.orders.refundedMinor}) filter (where ${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial')), 0)::int`,
    })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, p.from), lt(schema.orders.placedAt, p.to)));
  return { placed: r?.placed ?? 0, sales: r?.sales ?? 0, grossRevenueMinor: r?.gross ?? 0 };
}

export async function dashboardSummary(ctx: ServiceContext, tenant: AnalyticsTenant, now = ctx.now ?? new Date()): Promise<DashboardSummary> {
  const windows = runningWindows(now, tenant.timezone);
  const [today, yesterday, lastWeek] = await Promise.all([windowCounts(ctx, windows.today), windowCounts(ctx, windows.yesterday), windowCounts(ctx, windows.lastWeek)]);
  const byStatusRows = await ctx.tx.select({ status: schema.orders.status, n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, windows.today.from))).groupBy(schema.orders.status);
  const stuckCutoff = new Date(now.getTime() - tenant.settings.shipmentStuckDays * 864e5);
  const [openOrders] = await ctx.tx.select({ pendingReview: sql<number>`count(*) filter (where status = 'pending_review')::int`, onHold: sql<number>`count(*) filter (where status = 'on_hold')::int`, fresh: sql<number>`count(*) filter (where status = 'new')::int` }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenantId));
  const [ship] = await ctx.tx.select({ exceptions: sql<number>`count(*) filter (where status in ('exception','attempted','failed'))::int`, stuck: sql<number>`count(*) filter (where status not in ('delivered','returned','failed') and shipped_at < ${stuckCutoff})::int` }).from(schema.shipments).where(eq(schema.shipments.tenantId, ctx.tenantId));
  const [ret] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.status, "requested")));
  const [critical] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), sql`${schema.inventoryLevels.available} <= ${tenant.settings.lowStockThreshold}`));
  const [wh] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.status, "failed")));
  const series30d = await dailySeries(ctx, tenant, { from: new Date(windows.today.from.getTime() - 29 * 864e5), to: now });
  return {
    windows,
    today: { ...today, aovMinor: today.sales ? Math.round(today.grossRevenueMinor / today.sales) : null, byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r.n])) },
    yesterday,
    lastWeek,
    open: { pendingReview: openOrders?.pendingReview ?? 0, onHold: openOrders?.onHold ?? 0, fresh: openOrders?.fresh ?? 0, shipmentExceptions: ship?.exceptions ?? 0, stuckShipments: ship?.stuck ?? 0, returnsRequested: ret?.n ?? 0, criticalVariants: critical?.n ?? 0, failedWebhooks: wh?.n ?? 0 },
    series30d,
  };
}

export interface ProductPerformanceRow {
  productId: string;
  title: string;
  units: number;
  orders: number;
  grossRevenueMinor: number;
  cogsMinor: number;
  marginMinor: number;
  returnedUnits: number;
}

export async function productPerformance(ctx: ServiceContext, period: Period, limit = 50): Promise<ProductPerformanceRow[]> {
  const rows = await ctx.tx
    .select({
      productId: schema.orderLines.productId,
      title: sql<string>`max(${schema.orderLines.title})`,
      units: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity}), 0)::int`,
      orders: sql<number>`count(distinct ${schema.orderLines.orderId})::int`,
      gross: sql<number>`coalesce(sum(${schema.orderLines.totalMinor} - ${schema.orderLines.discountMinor}), 0)::int`,
      cogs: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity} * coalesce(${schema.orderLines.unitCostMinor}, 0)), 0)::int`,
      returned: sql<number>`coalesce((select sum(rl.quantity) from return_lines rl join return_requests rr on rr.id = rl.return_id where rl.order_line_id = any(array_agg(${schema.orderLines.id})) and rr.status in ('refunded','exchanged','voucher_issued')), 0)::int`,
    })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .where(and(eq(schema.orderLines.tenantId, ctx.tenantId), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), sql`${schema.orders.status} in ('confirmed','fulfilling','shipped','delivered','returned_partial')`, sql`${schema.orderLines.productId} is not null`))
    .groupBy(schema.orderLines.productId)
    .orderBy(sql`3 desc`)
    .limit(limit);
  return rows.map((r) => ({ productId: r.productId!, title: r.title, units: r.units, orders: r.orders, grossRevenueMinor: r.gross, cogsMinor: r.cogs, marginMinor: r.gross - r.cogs, returnedUnits: r.returned }));
}

export interface CohortRow {
  cohort: string;
  customers: number;
  /** Share of the cohort with at least one further sale order in month offset 1..6. */
  retention: (number | null)[];
}

/** Monthly repurchase cohorts: customers by first-order month, re-ordering in the following months. */
export async function repurchaseCohorts(ctx: ServiceContext, tenant: AnalyticsTenant, months = 12): Promise<CohortRow[]> {
  const rows = await ctx.tx.execute<{ cohort: string; offset: number; customers: number }>(sql`
    with firsts as (
      select customer_id, date_trunc('month', min(placed_at at time zone ${tenant.timezone})) as cohort
      from orders where tenant_id = ${ctx.tenantId} and customer_id is not null and status not in ('cancelled') group by customer_id
    ), activity as (
      select o.customer_id, f.cohort,
             (extract(year from date_trunc('month', o.placed_at at time zone ${tenant.timezone})) - extract(year from f.cohort)) * 12
             + (extract(month from date_trunc('month', o.placed_at at time zone ${tenant.timezone})) - extract(month from f.cohort)) as month_offset
      from orders o join firsts f on f.customer_id = o.customer_id
      where o.tenant_id = ${ctx.tenantId} and o.status in ('confirmed','fulfilling','shipped','delivered','returned_partial')
    )
    select to_char(cohort, 'YYYY-MM') as cohort, month_offset::int as offset, count(distinct customer_id)::int as customers
    from activity where cohort >= date_trunc('month', now() at time zone ${tenant.timezone}) - make_interval(months => ${months})
    group by 1, 2 order by 1, 2`);
  const byCohort = new Map<string, { base: number; offsets: Map<number, number> }>();
  for (const r of rows.rows) {
    const c = byCohort.get(r.cohort) ?? { base: 0, offsets: new Map() };
    if (r.offset === 0) c.base = r.customers;
    c.offsets.set(r.offset, r.customers);
    byCohort.set(r.cohort, c);
  }
  const nowMonth = new Date().toISOString().slice(0, 7);
  return [...byCohort.entries()].map(([cohort, c]) => ({
    cohort,
    customers: c.base,
    retention: [1, 2, 3, 4, 5, 6].map((k) => {
      const [y, m] = cohort.split("-").map(Number);
      const target = new Date(Date.UTC(y!, m! - 1 + k, 1)).toISOString().slice(0, 7);
      if (target > nowMonth) return null;
      return c.base ? (c.offsets.get(k) ?? 0) / c.base : null;
    }),
  }));
}

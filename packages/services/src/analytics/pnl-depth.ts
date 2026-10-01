import { and, eq, gte, inArray, isNotNull, lt, schema, sql } from "@keel/db";
import { allocateAdSpend, bucketPnl, keyTrend, orderPnl, periodBuckets, productProfit, productSales, productStockAction, reconcileOrderPnl, returnCostsOfPeriod, stockVelocity, sumOrderPnl, worstRisk, utmGroups, type BucketPnl, type Granularity, type OrderPnl, type OrderPnlReconciliation, type OrderPnlTotals, type Period, type ProductStockAction, type StockRisk, type TrafficLight, type TrendPoint, type UtmDimension, type UtmGroup } from "@keel/core";
import type { ServiceContext } from "../context";
import { variantStock, summarizeByProduct } from "../inventory";
import { orderEconomicsForPeriod, pnlFromRows, type AnalyticsTenant, type EconomicsRow, type PnlReport } from "./index";

const CHUNK = 5000;
async function chunked<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

/** Return costs per order: labels and handling of its returns whose goods came back, net of deductions. */
async function returnCostsByOrder(ctx: ServiceContext, tenant: AnalyticsTenant, orderIds: string[]): Promise<Map<string, number>> {
  const rows = await chunked(orderIds, (chunk) => ctx.tx.select({ orderId: schema.returnRequests.orderId, returnless: schema.returnRequests.returnless, deductionMinor: schema.returnRequests.deductionMinor }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), isNotNull(schema.returnRequests.receivedAt), inArray(schema.returnRequests.orderId, chunk))));
  const byOrder = new Map<string, { goodsBack: boolean; returnless: boolean; deductionMinor: number }[]>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), { goodsBack: true, returnless: r.returnless, deductionMinor: r.deductionMinor }]);
  return new Map([...byOrder].map(([id, list]) => [id, returnCostsOfPeriod(list, tenant.settings.returnLabelCostMinor, tenant.settings.returnHandlingCostMinor).totalMinor]));
}

async function attributionByOrder(ctx: ServiceContext, orderIds: string[]) {
  const rows = await chunked(orderIds, (chunk) => ctx.tx.select({ orderId: schema.orderAttribution.orderId, channel: schema.orderAttribution.channel, source: schema.orderAttribution.utmSource, medium: schema.orderAttribution.utmMedium, campaign: schema.orderAttribution.utmCampaign, content: schema.orderAttribution.utmContent, term: schema.orderAttribution.utmTerm }).from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.orderId, chunk))));
  return new Map(rows.map((r) => [r.orderId, r]));
}

/* ---------- economics of one order (order detail card) ---------- */

export interface OrderPnlDetail {
  name: string;
  placedAt: Date;
  pnl: OrderPnl | null;
  /** Replaced by an edit: lineage, never counted. */
  replaced: boolean;
  /** Payment fee from the tenant's rate per method, not from the gateway (actual fees arrive with payments). */
  paymentFeeSource: "estimated";
}

export async function orderPnlDetail(ctx: ServiceContext, tenant: AnalyticsTenant, orderId: string): Promise<OrderPnlDetail | null> {
  const [o] = await ctx.tx.select({ name: schema.orders.name, placedAt: schema.orders.placedAt, replacedBy: schema.orders.replacedByOrderId }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o) return null;
  if (o.replacedBy) return { name: o.name, placedAt: o.placedAt, pnl: null, replaced: true, paymentFeeSource: "estimated" };
  const [eco] = await orderEconomicsForPeriod(ctx, tenant, { from: o.placedAt, to: new Date(o.placedAt.getTime() + 1) }, { orderIds: [orderId] });
  if (!eco) return null;
  const rc = await returnCostsByOrder(ctx, tenant, [orderId]);
  return { name: o.name, placedAt: o.placedAt, pnl: orderPnl(eco, rc.get(orderId) ?? 0), replaced: false, paymentFeeSource: "estimated" };
}

/* ---------- per-order P/L table ---------- */

export const ORDER_PNL_SORTS = ["placed_desc", "placed_asc", "contribution_asc", "contribution_desc", "net_desc"] as const;
export type OrderPnlSort = (typeof ORDER_PNL_SORTS)[number];

export interface OrderPnlFilters {
  q?: string;
  payment?: string;
  channel?: string;
  status?: string;
  missingCost?: boolean;
  loss?: boolean;
  sort?: OrderPnlSort;
}

export interface OrderPnlRow extends OrderPnl {
  orderId: string;
  name: string;
  placedAt: Date;
  status: string;
  paymentMethod: string;
  channel: string;
}

export interface OrderPnlTable {
  rows: OrderPnlRow[];
  /** Rows matching the filters (all pages). */
  total: number;
  page: number;
  pageSize: number;
  /** Sums over the filtered rows. */
  totals: OrderPnlTotals;
  /** Sums over every sale order of the period, and the walk from them to the period P/L. */
  periodTotals: OrderPnlTotals;
  reconciliation: OrderPnlReconciliation;
  pnl: PnlReport;
  /** Orders placed in the period that are not sales (cancelled, pending, returned…). */
  outOfScope: number;
  channels: string[];
}

/** Sale orders of the period with their P/L, filtered, sorted and paginated; pageSize 0 returns every row. */
export async function orderPnlTable(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, f: OrderPnlFilters = {}, page = 1, pageSize = 50): Promise<OrderPnlTable> {
  const econ = await orderEconomicsForPeriod(ctx, tenant, period);
  const pnl = await pnlFromRows(ctx, tenant, period, econ);
  const sales = econ.filter((e) => e.inScope);
  const ids = sales.map((e) => e.orderId);
  const [rc, attr] = [await returnCostsByOrder(ctx, tenant, ids), await attributionByOrder(ctx, ids)];
  const all: OrderPnlRow[] = sales.map((e) => ({ ...orderPnl(e, rc.get(e.orderId) ?? 0), orderId: e.orderId, name: e.name, placedAt: e.placedAt, status: e.status, paymentMethod: e.paymentMethod, channel: attr.get(e.orderId)?.channel ?? "unknown" }));
  const periodTotals = sumOrderPnl(all);
  const q = f.q?.trim().toLowerCase().replace(/^#/, "");
  const rows = all.filter((r) => (!q || r.name.toLowerCase().replace(/^#/, "").includes(q)) && (!f.payment || r.paymentMethod === f.payment) && (!f.channel || r.channel === f.channel) && (!f.status || r.status === f.status) && (!f.missingCost || !r.cogsComplete) && (!f.loss || r.contributionMinor < 0));
  const sort = f.sort ?? "placed_desc";
  const cmp: Record<OrderPnlSort, (a: OrderPnlRow, b: OrderPnlRow) => number> = {
    placed_desc: (a, b) => b.placedAt.getTime() - a.placedAt.getTime(),
    placed_asc: (a, b) => a.placedAt.getTime() - b.placedAt.getTime(),
    contribution_asc: (a, b) => a.contributionMinor - b.contributionMinor,
    contribution_desc: (a, b) => b.contributionMinor - a.contributionMinor,
    net_desc: (a, b) => b.netRevenueMinor - a.netRevenueMinor,
  };
  rows.sort((a, b) => cmp[sort](a, b) || a.name.localeCompare(b.name));
  const size = pageSize > 0 ? pageSize : Math.max(1, rows.length);
  const p = Math.min(Math.max(1, page), Math.max(1, Math.ceil(rows.length / size)));
  return {
    rows: rows.slice((p - 1) * size, p * size),
    total: rows.length,
    page: p,
    pageSize: size,
    totals: sumOrderPnl(rows),
    periodTotals,
    reconciliation: reconcileOrderPnl(periodTotals, pnl),
    pnl,
    outOfScope: econ.length - sales.length,
    channels: [...new Set(all.map((r) => r.channel))].sort(),
  };
}

/* ---------- P/L by day / week / month / quarter / year ---------- */

/** The period P/L and the same P/L cut into buckets; the buckets add up to the period to the cent. */
export async function pnlBreakdown(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, granularity: Granularity): Promise<{ pnl: PnlReport; buckets: BucketPnl[]; granularity: Granularity; economics: EconomicsRow[] }> {
  const econ = await orderEconomicsForPeriod(ctx, tenant, period);
  const pnl = await pnlFromRows(ctx, tenant, period, econ);
  const ads = await ctx.tx.select({ date: schema.adMetricsDaily.date, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, period.from.toISOString().slice(0, 10)), lt(schema.adMetricsDaily.date, period.to.toISOString().slice(0, 10)))).groupBy(schema.adMetricsDaily.date);
  const received = await ctx.tx.select({ at: schema.returnRequests.receivedAt, returnless: schema.returnRequests.returnless, deductionMinor: schema.returnRequests.deductionMinor }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), gte(schema.returnRequests.receivedAt, period.from), lt(schema.returnRequests.receivedAt, period.to)));
  // same rule as returnCostsOfPeriod, per return: returnless ones cost nothing
  const one = (r: { returnless: boolean; deductionMinor: number }) => (r.returnless ? 0 : Math.max(0, tenant.settings.returnLabelCostMinor) + Math.max(0, tenant.settings.returnHandlingCostMinor) - Math.max(0, r.deductionMinor));
  const buckets = bucketPnl(periodBuckets(period, granularity), {
    period,
    orders: econ,
    adSpendByDay: ads.map((a) => ({ date: a.date, spendMinor: a.spend })),
    returns: received.map((r) => ({ at: r.at!, costMinor: one(r) })),
    returnCostsMinor: pnl.returnCostsMinor,
    shippingByMonth: pnl.costByMonth.shipping,
    fixedByMonth: pnl.costByMonth.fixed,
  });
  return { pnl, buckets, granularity, economics: econ };
}

/* ---------- product sales with ads and stock ---------- */

export const PRODUCT_PROFIT_SORTS = ["net_desc", "units_desc", "profit_desc", "profit_asc", "ad_spend_desc", "roas_asc", "cover_asc"] as const;
export type ProductProfitSort = (typeof PRODUCT_PROFIT_SORTS)[number];

export interface ProductProfitRow {
  productId: string;
  title: string;
  repurchasable: boolean;
  units: number;
  orders: number;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  cogsMinor: number;
  unitsWithoutCost: number;
  adSpendMinor: number;
  /** Campaigns linked to the product that spent in the period. */
  campaigns: number;
  grossMarginMinor: number;
  profitMinor: number;
  roas: number | null;
  roi: number | null;
  light: TrafficLight;
  available: number;
  incoming: number;
  coverDays: number | null;
  risk: StockRisk;
  action: ProductStockAction;
  reorderUnits: number;
}

export interface ProductProfitTable {
  rows: ProductProfitRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Sums over every product row (not only the page). */
  totals: { units: number; netRevenueMinor: number; cogsMinor: number; adSpendMinor: number; profitMinor: number };
  /** Spend of campaigns without a linked product: with the product spend it adds up to the period ad spend. */
  unattributedMinor: number;
  unlinkedCampaigns: number;
  adSpendMinor: number;
}

/**
 * Products sold in the period (sale orders) or advertised by a campaign that spent in it, with
 * the spend of their linked campaigns (split by net revenue across a campaign's products),
 * profit, ROAS/ROI, the campaign traffic light, stock, cover and a stock action.
 */
export async function productProfitTable(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, opts: { q?: string; action?: ProductStockAction; sort?: ProductProfitSort; page?: number; pageSize?: number } = {}): Promise<ProductProfitTable> {
  const econ = (await orderEconomicsForPeriod(ctx, tenant, period)).filter((e) => e.inScope);
  const ecoBy = new Map(econ.map((e) => [e.orderId, e]));
  const lines = await chunked(
    econ.map((e) => e.orderId),
    (chunk) => ctx.tx.select({ orderId: schema.orderLines.orderId, productId: schema.orderLines.productId, quantity: schema.orderLines.quantity, currentQuantity: schema.orderLines.currentQuantity, totalMinor: schema.orderLines.totalMinor, discountMinor: schema.orderLines.discountMinor, unitCostMinor: schema.orderLines.unitCostMinor, returnedFraction: schema.orders.returnedFraction }).from(schema.orderLines).innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId)).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.isAncillary, false), isNotNull(schema.orderLines.productId), inArray(schema.orderLines.orderId, chunk))),
  );
  const sales = productSales(
    lines.filter((l) => l.currentQuantity > 0).map((l) => {
      const e = ecoBy.get(l.orderId)!;
      return { orderId: l.orderId, productId: l.productId!, quantity: l.currentQuantity, lineGrossMinor: Math.round(((l.totalMinor - l.discountMinor) * l.currentQuantity) / Math.max(1, l.quantity)), unitCostMinor: l.unitCostMinor, netRatio: e.grossRevenueMinor > 0 ? e.netRevenueMinor / e.grossRevenueMinor : 0, keep: 1 - Math.min(1, Math.max(0, l.returnedFraction / 10_000)) };
    }),
  );
  // spend per campaign with exactly the day bounds of the period P/L
  const spend = await ctx.tx.select({ campaignId: schema.adMetricsDaily.campaignId, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}), 0)::int` }).from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, period.from.toISOString().slice(0, 10)), lt(schema.adMetricsDaily.date, period.to.toISOString().slice(0, 10)))).groupBy(schema.adMetricsDaily.campaignId);
  const campaignIds = spend.map((s) => s.campaignId);
  const links = campaignIds.length ? await ctx.tx.select({ campaignId: schema.campaignProductLinks.campaignId, productId: schema.campaignProductLinks.productId }).from(schema.campaignProductLinks).where(and(eq(schema.campaignProductLinks.tenantId, ctx.tenantId), inArray(schema.campaignProductLinks.campaignId, campaignIds))) : [];
  const alloc = allocateAdSpend(
    spend.map((s) => ({ campaignId: s.campaignId, spendMinor: s.spend, productIds: links.filter((l) => l.campaignId === s.campaignId).map((l) => l.productId) })),
    (p) => sales.get(p)?.netRevenueMinor ?? 0,
  );
  const adSpendMinor = spend.reduce((s, x) => s + x.spend, 0);
  const productIds = [...new Set([...sales.keys(), ...alloc.byProduct.keys()])];
  const products = productIds.length ? await chunked(productIds, (chunk) => ctx.tx.select({ id: schema.products.id, title: schema.products.title, repurchasable: schema.products.isRepurchasable }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), inArray(schema.products.id, chunk)))) : [];
  const stockRows = productIds.length ? await variantStock(ctx, tenant.settings, { productIds }) : [];
  const stock = summarizeByProduct(stockRows);
  const lookback = tenant.settings.salesVelocityLookbackDays;
  const thresholds = { roiGood: tenant.settings.roiGood, roiMedium: tenant.settings.roiMedium };
  const all: ProductProfitRow[] = products.map((p) => {
    const s = sales.get(p.id) ?? { units: 0, orders: 0, grossRevenueMinor: 0, netRevenueMinor: 0, cogsMinor: 0, unitsWithoutCost: 0 };
    const ad = alloc.byProduct.get(p.id) ?? 0;
    const prof = productProfit({ netRevenueMinor: s.netRevenueMinor, cogsMinor: s.cogsMinor, adSpendMinor: ad }, thresholds);
    const st = stock.get(p.id);
    const vel = stockVelocity({ unitsSold: st?.unitsSold ?? 0, lookbackDays: lookback, available: st?.available ?? 0, incoming: st?.incoming ?? 0, criticalDays: tenant.settings.coverageDaysCritical, warningDays: tenant.settings.coverageDaysWarning });
    // the worst variant decides the risk (a sold-out size is a stock problem even when other sizes are plentiful), as on campaigns
    const risk: StockRisk = st ? worstRisk([st.risk, vel.risk]) : vel.risk;
    const act = productStockAction({ available: st?.available ?? 0, incoming: st?.incoming ?? 0, coverDays: vel.daysOfCover, risk, suggestedReorder: st?.suggestedReorder ?? 0, repurchasable: p.repurchasable, adSpendMinor: ad, light: prof.light, excessCoverDays: tenant.settings.excessCoverDays });
    return { productId: p.id, title: p.title, repurchasable: p.repurchasable, units: s.units, orders: s.orders, grossRevenueMinor: s.grossRevenueMinor, netRevenueMinor: s.netRevenueMinor, cogsMinor: s.cogsMinor, unitsWithoutCost: s.unitsWithoutCost, adSpendMinor: ad, campaigns: alloc.byCampaignProduct.filter((c) => c.productId === p.id && c.spendMinor !== 0).length, ...prof, available: st?.available ?? 0, incoming: st?.incoming ?? 0, coverDays: vel.daysOfCover, risk, action: act.action, reorderUnits: act.reorderUnits };
  });
  const totals = all.reduce((t, r) => ({ units: t.units + r.units, netRevenueMinor: t.netRevenueMinor + r.netRevenueMinor, cogsMinor: t.cogsMinor + r.cogsMinor, adSpendMinor: t.adSpendMinor + r.adSpendMinor, profitMinor: t.profitMinor + r.profitMinor }), { units: 0, netRevenueMinor: 0, cogsMinor: 0, adSpendMinor: 0, profitMinor: 0 });
  const q = opts.q?.trim().toLowerCase();
  const rows = all.filter((r) => (!q || r.title.toLowerCase().includes(q)) && (!opts.action || r.action === opts.action));
  const nullsLast = (v: number | null, dir: 1 | -1) => (v === null ? Infinity : dir * v);
  const cmp: Record<ProductProfitSort, (a: ProductProfitRow, b: ProductProfitRow) => number> = {
    net_desc: (a, b) => b.netRevenueMinor - a.netRevenueMinor,
    units_desc: (a, b) => b.units - a.units,
    profit_desc: (a, b) => b.profitMinor - a.profitMinor,
    profit_asc: (a, b) => a.profitMinor - b.profitMinor,
    ad_spend_desc: (a, b) => b.adSpendMinor - a.adSpendMinor,
    roas_asc: (a, b) => nullsLast(a.roas, 1) - nullsLast(b.roas, 1),
    cover_asc: (a, b) => nullsLast(a.coverDays, 1) - nullsLast(b.coverDays, 1),
  };
  rows.sort((a, b) => cmp[opts.sort ?? "net_desc"](a, b) || a.title.localeCompare(b.title));
  const size = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : opts.pageSize === 0 ? Math.max(1, rows.length) : 25;
  const page = Math.min(Math.max(1, opts.page ?? 1), Math.max(1, Math.ceil(rows.length / size)));
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, page, pageSize: size, totals, unattributedMinor: alloc.unattributedMinor, unlinkedCampaigns: alloc.unlinkedCampaigns, adSpendMinor };
}

/* ---------- UTM drill-down and channel trend ---------- */

export interface UtmReport {
  dim: UtmDimension;
  groups: UtmGroup[];
  orders: number;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  /** Sale orders of the period without any attribution row. */
  unattributedOrders: number;
  trend: { keys: string[]; points: TrendPoint[] };
}

/** Sale orders of the period grouped by one UTM parameter (parents fixed by `filter`), and net revenue per channel over time. */
export async function utmReport(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, dim: UtmDimension, filter: Partial<Record<UtmDimension, string>>, granularity: Granularity): Promise<UtmReport> {
  const econ = (await orderEconomicsForPeriod(ctx, tenant, period)).filter((e) => e.inScope);
  const attr = await attributionByOrder(ctx, econ.map((e) => e.orderId));
  const res = utmGroups(econ.map((e) => {
    const a = attr.get(e.orderId);
    return { utm: { source: a?.source ?? null, medium: a?.medium ?? null, campaign: a?.campaign ?? null, content: a?.content ?? null, term: a?.term ?? null }, grossRevenueMinor: e.grossRevenueMinor, netRevenueMinor: e.netRevenueMinor };
  }), dim, filter);
  const trend = keyTrend(periodBuckets(period, granularity), econ.map((e) => ({ at: e.placedAt, key: attr.get(e.orderId)?.channel ?? "unknown", netRevenueMinor: e.netRevenueMinor })));
  return { dim, ...res, unattributedOrders: econ.filter((e) => !attr.has(e.orderId)).length, trend };
}

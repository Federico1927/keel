import { and, eq, gte, inArray, lt, schema, sql } from "@keel/db";
import { campaignMetrics, recommendAction, suggestProductsForCampaign, trafficLight, worstRisk, type CampaignAction, type CampaignMetrics, type Period, type RestockAdvice, type StockRisk, type TrafficLight } from "@keel/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";
import { variantStock } from "../inventory";

export interface CampaignRow {
  id: string;
  platform: string;
  externalId: string;
  name: string;
  status: string;
  dailyBudgetMinor: number | null;
  metrics: CampaignMetrics;
  light: TrafficLight;
  action: CampaignAction;
  restock: RestockAdvice;
  reason: string;
  products: { id: string; title: string; isPrimary: boolean; available: number; incoming: number; risk: StockRisk; repurchasable: boolean }[];
  stock: number | null;
  incoming: number;
  stockRisk: StockRisk | null;
}

/** Campaigns with economics over a period; profit counts only in-scope orders. */
export async function campaignsWithEconomics(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, opts: { platform?: string; status?: string; campaignIds?: string[] } = {}): Promise<CampaignRow[]> {
  const conds = [eq(schema.campaigns.tenantId, ctx.tenantId)];
  if (opts.platform) conds.push(eq(schema.campaigns.platform, opts.platform));
  if (opts.status) conds.push(eq(schema.campaigns.status, opts.status));
  if (opts.campaignIds) conds.push(inArray(schema.campaigns.id, opts.campaignIds.length ? opts.campaignIds : ["00000000-0000-0000-0000-000000000000"]));
  const campaigns = await ctx.tx.select().from(schema.campaigns).where(and(...conds)).orderBy(schema.campaigns.name);
  if (!campaigns.length) return [];
  const ids = campaigns.map((c) => c.id);
  const since = period.from.toISOString().slice(0, 10);
  const until = period.to.toISOString().slice(0, 10);
  const [spend, attribution, links] = await Promise.all([
    ctx.tx.select({ campaignId: schema.adMetricsDaily.campaignId, spend: sql<number>`coalesce(sum(${schema.adMetricsDaily.spendMinor}),0)::int`, clicks: sql<number>`coalesce(sum(${schema.adMetricsDaily.clicks}),0)::int`, impressions: sql<number>`coalesce(sum(${schema.adMetricsDaily.impressions}),0)::int` }).from(schema.adMetricsDaily).where(and(inArray(schema.adMetricsDaily.campaignId, ids), gte(schema.adMetricsDaily.date, since), lt(schema.adMetricsDaily.date, until))).groupBy(schema.adMetricsDaily.campaignId),
    ctx.tx.select({ orderId: schema.orderAttribution.orderId, campaignId: schema.orderAttribution.campaignId }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(inArray(schema.orderAttribution.campaignId, ids), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to))),
    ctx.tx.select({ campaignId: schema.campaignProductLinks.campaignId, productId: schema.campaignProductLinks.productId, isPrimary: schema.campaignProductLinks.isPrimary, title: schema.products.title, repurchasable: schema.products.isRepurchasable }).from(schema.campaignProductLinks).innerJoin(schema.products, eq(schema.products.id, schema.campaignProductLinks.productId)).where(inArray(schema.campaignProductLinks.campaignId, ids)),
  ]);
  const economics = attribution.length ? await orderEconomicsForPeriod(ctx, tenant, period, { orderIds: attribution.map((a) => a.orderId) }) : [];
  const ecoByOrder = new Map(economics.map((e) => [e.orderId, e]));
  const productIds = [...new Set(links.map((l) => l.productId))];
  const stockRows = productIds.length ? await variantStock(ctx, tenant.settings, { productIds }) : [];
  const stockByProduct = new Map<string, { available: number; incoming: number; risk: StockRisk }>();
  for (const r of stockRows) {
    const s = stockByProduct.get(r.productId) ?? { available: 0, incoming: 0, risk: "no_sales" as StockRisk };
    s.available += r.available;
    s.incoming += r.incoming;
    s.risk = worstRisk([s.risk, r.risk]);
    stockByProduct.set(r.productId, s);
  }
  return campaigns.map((c) => {
    const sp = spend.find((s) => s.campaignId === c.id);
    const orders = attribution.filter((a) => a.campaignId === c.id).map((a) => ecoByOrder.get(a.orderId)).filter((e): e is NonNullable<typeof e> => Boolean(e) && e!.inScope);
    const metrics = campaignMetrics({ spendMinor: sp?.spend ?? 0, clicks: sp?.clicks ?? 0, impressions: sp?.impressions ?? 0, attributedOrders: orders.length, netRevenueMinor: orders.reduce((s, e) => s + e.netRevenueMinor, 0), marginMinor: orders.reduce((s, e) => s + e.marginMinor, 0) });
    const light = trafficLight(metrics, { roiGood: tenant.settings.roiGood, roiMedium: tenant.settings.roiMedium });
    const products = links.filter((l) => l.campaignId === c.id).map((l) => ({ id: l.productId, title: l.title, isPrimary: l.isPrimary, available: stockByProduct.get(l.productId)?.available ?? 0, incoming: stockByProduct.get(l.productId)?.incoming ?? 0, risk: stockByProduct.get(l.productId)?.risk ?? "no_sales", repurchasable: l.repurchasable }));
    const stock = products.length ? products.reduce((s, p) => s + p.available, 0) : null;
    const incoming = products.reduce((s, p) => s + p.incoming, 0);
    const stockRisk = products.length ? worstRisk(products.map((p) => p.risk)) : null;
    const rec = recommendAction({ status: c.status, light, repurchasable: products.length ? products.some((p) => p.repurchasable) : true, stock, incoming, stockThreshold: tenant.settings.campaignStockThreshold, stockRisk });
    return { id: c.id, platform: c.platform, externalId: c.externalId, name: c.name, status: c.status, dailyBudgetMinor: c.dailyBudgetMinor, metrics, light, action: rec.action, restock: rec.restock, reason: rec.reason, products, stock, incoming, stockRisk };
  });
}

export interface LedgerRow {
  date: string;
  campaignId: string;
  campaignName: string;
  platform: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  orders: number;
  netRevenueMinor: number;
  marginMinor: number;
  profitMinor: number;
  roas: number | null;
  flags: ("no_ads_data" | "no_order_data")[];
}

/** Daily ledger date × campaign: spend from the ads platform, orders from attribution; never stores ratios. */
export async function campaignDailyLedger(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, campaignIds?: string[]): Promise<LedgerRow[]> {
  const conds = [eq(schema.campaigns.tenantId, ctx.tenantId)];
  if (campaignIds) conds.push(inArray(schema.campaigns.id, campaignIds.length ? campaignIds : ["00000000-0000-0000-0000-000000000000"]));
  const campaigns = await ctx.tx.select({ id: schema.campaigns.id, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(and(...conds));
  if (!campaigns.length) return [];
  const ids = campaigns.map((c) => c.id);
  const since = period.from.toISOString().slice(0, 10);
  const until = period.to.toISOString().slice(0, 10);
  const metrics = await ctx.tx.select().from(schema.adMetricsDaily).where(and(inArray(schema.adMetricsDaily.campaignId, ids), gte(schema.adMetricsDaily.date, since), lt(schema.adMetricsDaily.date, until)));
  const attribution = await ctx.tx.select({ orderId: schema.orderAttribution.orderId, campaignId: schema.orderAttribution.campaignId, day: sql<string>`to_char((${schema.orders.placedAt} at time zone ${tenant.timezone})::date, 'YYYY-MM-DD')` }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(inArray(schema.orderAttribution.campaignId, ids), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to)));
  const economics = attribution.length ? await orderEconomicsForPeriod(ctx, tenant, period, { orderIds: attribution.map((a) => a.orderId) }) : [];
  const ecoByOrder = new Map(economics.map((e) => [e.orderId, e]));
  const key = (d: string, c: string) => `${d}|${c}`;
  const rows = new Map<string, LedgerRow>();
  const ensure = (date: string, campaignId: string) => {
    const k = key(date, campaignId);
    let r = rows.get(k);
    if (!r) {
      const c = campaigns.find((x) => x.id === campaignId)!;
      r = { date, campaignId, campaignName: c.name, platform: c.platform, spendMinor: 0, impressions: 0, clicks: 0, orders: 0, netRevenueMinor: 0, marginMinor: 0, profitMinor: 0, roas: null, flags: [] };
      rows.set(k, r);
    }
    return r;
  };
  for (const m of metrics) {
    const r = ensure(m.date, m.campaignId);
    r.spendMinor += m.spendMinor;
    r.impressions += m.impressions;
    r.clicks += m.clicks;
  }
  for (const a of attribution) {
    const e = ecoByOrder.get(a.orderId);
    if (!e?.inScope || !a.campaignId) continue;
    const r = ensure(a.day, a.campaignId);
    r.orders++;
    r.netRevenueMinor += e.netRevenueMinor;
    r.marginMinor += e.marginMinor;
  }
  const metricKeys = new Set(metrics.map((m) => key(m.date, m.campaignId)));
  const orderKeys = new Set(attribution.map((a) => key(a.day, a.campaignId ?? "")));
  for (const [k, r] of rows) {
    r.profitMinor = r.marginMinor - r.spendMinor;
    r.roas = r.spendMinor ? r.netRevenueMinor / r.spendMinor : null;
    if (!metricKeys.has(k)) r.flags.push("no_ads_data");
    if (!orderKeys.has(k)) r.flags.push("no_order_data");
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date) || a.campaignName.localeCompare(b.campaignName));
}

/** Unlinked campaigns with product suggestions from name and attributed landing pages. */
export async function campaignLinkSuggestions(ctx: ServiceContext): Promise<{ campaignId: string; name: string; platform: string; suggestions: { productId: string; title: string; kind: string; confidence: number }[] }[]> {
  const campaigns = await ctx.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), sql`${schema.campaigns.status} <> 'archived'`, sql`not exists (select 1 from campaign_product_links l where l.campaign_id = ${schema.campaigns.id})`));
  if (!campaigns.length) return [];
  const products = await ctx.tx.select({ id: schema.products.id, title: schema.products.title, handle: schema.products.handle }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenantId));
  const landing = await ctx.tx.select({ campaignId: schema.orderAttribution.campaignId, landingSite: schema.orders.landingSite }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(inArray(schema.orderAttribution.campaignId, campaigns.map((c) => c.id)), sql`${schema.orders.landingSite} is not null`)).limit(2000);
  return campaigns
    .map((c) => {
      const urls = landing.filter((l) => l.campaignId === c.id).map((l) => l.landingSite!);
      const sugg = suggestProductsForCampaign(c.name, urls, products).slice(0, 3).map((s) => ({ ...s, title: products.find((p) => p.id === s.productId)?.title ?? "" }));
      return { campaignId: c.id, name: c.name, platform: c.platform, suggestions: sugg };
    })
    .filter((c) => c.suggestions.length > 0);
}

export async function linkCampaignProduct(ctx: ServiceContext, campaignId: string, productId: string, isPrimary: boolean, source: "manual" | "suggested" | "auto"): Promise<void> {
  if (isPrimary) await ctx.tx.update(schema.campaignProductLinks).set({ isPrimary: false }).where(and(eq(schema.campaignProductLinks.tenantId, ctx.tenantId), eq(schema.campaignProductLinks.campaignId, campaignId)));
  await ctx.tx.insert(schema.campaignProductLinks).values({ tenantId: ctx.tenantId, campaignId, productId, isPrimary, source, createdBy: ctx.actor.userId }).onConflictDoUpdate({ target: [schema.campaignProductLinks.campaignId, schema.campaignProductLinks.productId], set: { isPrimary, source } });
}

export async function unlinkCampaignProduct(ctx: ServiceContext, campaignId: string, productId: string): Promise<void> {
  await ctx.tx.delete(schema.campaignProductLinks).where(and(eq(schema.campaignProductLinks.tenantId, ctx.tenantId), eq(schema.campaignProductLinks.campaignId, campaignId), eq(schema.campaignProductLinks.productId, productId)));
}

/** Auto-link only high-confidence suggestions (URL or exact match), never overriding manual links. */
export async function autoLinkCampaigns(ctx: ServiceContext): Promise<number> {
  const suggestions = await campaignLinkSuggestions(ctx);
  let linked = 0;
  for (const s of suggestions) {
    const best = s.suggestions[0];
    if (best && best.confidence >= 0.95) {
      await linkCampaignProduct(ctx, s.campaignId, best.productId, true, "auto");
      linked++;
    }
  }
  return linked;
}

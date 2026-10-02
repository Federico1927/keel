import { and, eq, gte, inArray, lt, or, schema, sql, type SQL } from "@keel/db";
import {
  EMPTY_KEEL,
  OTHER_SEARCH_TERM,
  ZERO_METRICS,
  adEntityEconomics,
  adPauseSuggestions,
  addMetrics,
  allocateKeel,
  assetPauseSuggestions,
  checkUtmTemplate,
  creativeFatigue,
  negativeKeywordCandidates,
  ngramStats,
  normalizeSearchText,
  orderAdKeys,
  rankNgrams,
  reconcileSpend,
  type AdEntityEconomics,
  type AdMetricValues,
  type FatigueResult,
  type KeelNumbers,
  type NegativeReason,
  type NgramRow,
  type NgramSort,
  type PauseReason,
  type Period,
  type UtmCheck,
} from "@keel/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";

/**
 * Ads below the campaign (issue #40): platform numbers next to Keel's own for every level. An order
 * is tied to an ad by `utm_content` (Meta `{{ad.id}}`, Google `{creative}`), to a Meta ad set by
 * `utm_term` (`{{adset.id}}`) or through its ad, to a Google keyword by `utm_term` (`{keyword}`), and
 * to a search term when that keyword text is the term (exact-match traffic). Revenue, margin and
 * profit count only orders in the sale scope (`orderEconomics.inScope`, CLAUDE.md §7.5).
 */

const UUID0 = "00000000-0000-0000-0000-000000000000";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ids = (xs: readonly string[]) => (xs.length ? [...xs] : [UUID0]);

interface CampaignInfo { id: string; platform: string; externalId: string; name: string; status: string }

/** Keel numbers of the period's attributed orders, indexed by campaign, ad set, ad and keyword text. */
interface KeelIndex {
  campaigns: Map<string, CampaignInfo>;
  byCampaign: Map<string, KeelNumbers>;
  byAdSet: Map<string, KeelNumbers>;
  byAd: Map<string, KeelNumbers>;
  /** `<campaign id>|<normalized utm_term>` (Google). */
  byTerm: Map<string, KeelNumbers>;
  /** Campaign orders with no ad set / no ad resolved (missing UTM template). */
  noAdSet: Map<string, KeelNumbers>;
  noAd: Map<string, KeelNumbers>;
}

function addKeel(m: Map<string, KeelNumbers>, key: string, e: { inScope: boolean; netRevenueMinor: number; marginMinor: number }) {
  const cur = m.get(key) ?? { ...EMPTY_KEEL };
  cur.allOrders++;
  if (e.inScope) {
    cur.orders++;
    cur.netRevenueMinor += e.netRevenueMinor;
    cur.marginMinor += e.marginMinor;
  }
  m.set(key, cur);
}

async function campaignsOf(ctx: ServiceContext, scope: { campaignIds?: string[]; platform?: string }): Promise<CampaignInfo[]> {
  const conds: SQL[] = [eq(schema.campaigns.tenantId, ctx.tenantId)];
  if (scope.campaignIds) conds.push(inArray(schema.campaigns.id, ids(scope.campaignIds)));
  if (scope.platform) conds.push(eq(schema.campaigns.platform, scope.platform));
  return ctx.tx.select({ id: schema.campaigns.id, platform: schema.campaigns.platform, externalId: schema.campaigns.externalId, name: schema.campaigns.name, status: schema.campaigns.status }).from(schema.campaigns).where(and(...conds));
}

async function keelIndex(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, campaigns: CampaignInfo[]): Promise<KeelIndex> {
  const index: KeelIndex = { campaigns: new Map(campaigns.map((c) => [c.id, c])), byCampaign: new Map(), byAdSet: new Map(), byAd: new Map(), byTerm: new Map(), noAdSet: new Map(), noAd: new Map() };
  if (!campaigns.length) return index;
  const cids = campaigns.map((c) => c.id);
  const attribution = await ctx.tx
    .select({ orderId: schema.orderAttribution.orderId, campaignId: schema.orderAttribution.campaignId, utmContent: schema.orderAttribution.utmContent, utmTerm: schema.orderAttribution.utmTerm })
    .from(schema.orderAttribution)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId))
    .where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.campaignId, cids), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to)));
  if (!attribution.length) return index;
  const economics = new Map((await orderEconomicsForPeriod(ctx, tenant, period, { orderIds: attribution.map((a) => a.orderId) })).map((e) => [e.orderId, e]));
  const ads = await ctx.tx.select({ id: schema.adCreatives.id, ext: schema.adCreatives.externalId, campaignId: schema.adCreatives.campaignId, adSetId: schema.adCreatives.adSetId }).from(schema.adCreatives).where(and(eq(schema.adCreatives.tenantId, ctx.tenantId), inArray(schema.adCreatives.campaignId, cids)));
  const sets = await ctx.tx.select({ id: schema.adSets.id, ext: schema.adSets.externalId, campaignId: schema.adSets.campaignId }).from(schema.adSets).where(and(eq(schema.adSets.tenantId, ctx.tenantId), inArray(schema.adSets.campaignId, cids)));
  const adBy = new Map(ads.map((a) => [`${a.campaignId}|${a.ext}`, a]));
  const setBy = new Map(sets.map((s) => [`${s.campaignId}|${s.ext}`, s]));
  for (const a of attribution) {
    const e = economics.get(a.orderId);
    const c = a.campaignId ? index.campaigns.get(a.campaignId) : undefined;
    if (!e || !c) continue;
    addKeel(index.byCampaign, c.id, e);
    const keys = orderAdKeys(c.platform, a);
    const ad = keys.adExternalId ? adBy.get(`${c.id}|${keys.adExternalId}`) : undefined;
    const adSetId = ad?.adSetId ?? (keys.adSetExternalId ? setBy.get(`${c.id}|${keys.adSetExternalId}`)?.id : undefined);
    if (ad) addKeel(index.byAd, ad.id, e);
    else addKeel(index.noAd, c.id, e);
    if (adSetId) addKeel(index.byAdSet, adSetId, e);
    else addKeel(index.noAdSet, c.id, e);
    if (keys.termText) addKeel(index.byTerm, `${c.id}|${keys.termText}`, e);
  }
  return index;
}

/**
 * Sums of `ad_entity_metrics_daily` per entity: daily rows in the period plus monthly rows (older than
 * the retention) whose month starts inside it. A period within the retention window is exact (the
 * month row holding the days before the cutoff stays out); beyond it the precision is a month.
 */
async function entityMetrics(ctx: ServiceContext, entityType: string, period: Period, filter: { entityIds?: string[]; campaignIds?: string[] }): Promise<Map<string, AdMetricValues>> {
  const M = schema.adEntityMetricsDaily;
  const since = iso(period.from);
  const until = iso(period.to);
  const conds: SQL[] = [eq(M.tenantId, ctx.tenantId), eq(M.entityType, entityType), or(and(eq(M.grain, "day"), gte(M.date, since), lt(M.date, until)), and(eq(M.grain, "month"), gte(M.date, since), lt(M.date, until)))!];
  if (filter.entityIds) conds.push(inArray(M.entityId, ids(filter.entityIds)));
  if (filter.campaignIds) conds.push(inArray(M.campaignId, ids(filter.campaignIds)));
  const rows = await ctx.tx
    .select({ id: M.entityId, spendMinor: sql<number>`sum(${M.spendMinor})::int`, impressions: sql<number>`sum(${M.impressions})::int`, clicks: sql<number>`sum(${M.clicks})::int`, reach: sql<number>`sum(${M.reach})::int`, conversions: sql<number>`sum(${M.conversions})::float8`, conversionValueMinor: sql<number>`sum(${M.conversionValueMinor})::int`, videoViews3s: sql<number>`sum(${M.videoViews3s})::int`, videoCompletions: sql<number>`sum(${M.videoCompletions})::int` })
    .from(M)
    .where(and(...conds))
    .groupBy(M.entityId);
  return new Map(rows.map((r) => [r.id, { spendMinor: r.spendMinor, impressions: r.impressions, clicks: r.clicks, reach: r.reach, conversions: Number(r.conversions), conversionValueMinor: r.conversionValueMinor, videoViews3s: r.videoViews3s, videoCompletions: r.videoCompletions }]));
}

interface AdDay { creativeId: string; date: string; spendMinor: number; impressions: number; clicks: number; reach: number; purchases: number; purchaseValueMinor: number; videoViews3s: number }

async function adDays(ctx: ServiceContext, period: Period, creativeIds: string[]): Promise<AdDay[]> {
  if (!creativeIds.length) return [];
  const D = schema.adCreativeMetricsDaily;
  return ctx.tx.select({ creativeId: D.creativeId, date: D.date, spendMinor: D.spendMinor, impressions: D.impressions, clicks: D.clicks, reach: D.reach, purchases: D.purchases, purchaseValueMinor: D.purchaseValueMinor, videoViews3s: D.videoViews3s }).from(D).where(and(eq(D.tenantId, ctx.tenantId), inArray(D.creativeId, creativeIds), gte(D.date, iso(period.from)), lt(D.date, iso(period.to)))).orderBy(D.date);
}

const fromAdDay = (d: AdDay): AdMetricValues => ({ spendMinor: d.spendMinor, impressions: d.impressions, clicks: d.clicks, reach: d.reach, conversions: d.purchases, conversionValueMinor: d.purchaseValueMinor, videoViews3s: d.videoViews3s, videoCompletions: 0 });

/** Query parameters of the orders list behind a row (campaign + UTM value), dates added by the page. */
export type OrdersFilter = Record<string, string>;

export interface AdLevelRow {
  id: string;
  externalId: string;
  name: string;
  status: string;
  platform: string;
  campaignId: string;
  campaignName: string;
  metrics: AdMetricValues;
  economics: AdEntityEconomics;
  orders: OrdersFilter | null;
}

export interface AdSetRow extends AdLevelRow { ads: number; optimizationGoal: string | null; keywords: number }
export interface AdRow extends AdLevelRow {
  adSetId: string | null;
  adSetName: string | null;
  format: string;
  hook: string | null;
  angle: string | null;
  headline: string | null;
  body: string | null;
  finalUrl: string | null;
  utm: UtmCheck;
  fatigue: FatigueResult | null;
  frequency: number | null;
  suggestion: PauseReason | null;
}

export interface UnassignedRow { keel: KeelNumbers; economics: AdEntityEconomics }

const econ = (m: AdMetricValues, k: KeelNumbers | undefined) => adEntityEconomics(m, k ?? EMPTY_KEEL);

export interface SpendReconciliation { campaignMinor: number; childrenMinor: number; unallocatedMinor: number; days: { date: string; parentMinor: number; childrenMinor: number; unallocatedMinor: number }[] }

/** Campaign spend day by day against the sum of its ads: the gap is shown as "unallocated". */
export async function campaignSpendReconciliation(ctx: ServiceContext, campaignId: string, period: Period): Promise<SpendReconciliation> {
  const since = iso(period.from);
  const until = iso(period.to);
  const camp = await ctx.tx.select({ date: schema.adMetricsDaily.date, spend: schema.adMetricsDaily.spendMinor }).from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), eq(schema.adMetricsDaily.campaignId, campaignId), gte(schema.adMetricsDaily.date, since), lt(schema.adMetricsDaily.date, until)));
  const D = schema.adCreativeMetricsDaily;
  const ads = await ctx.tx.select({ date: D.date, spend: sql<number>`sum(${D.spendMinor})::int` }).from(D).innerJoin(schema.adCreatives, eq(schema.adCreatives.id, D.creativeId)).where(and(eq(D.tenantId, ctx.tenantId), eq(schema.adCreatives.campaignId, campaignId), gte(D.date, since), lt(D.date, until))).groupBy(D.date);
  const r = reconcileSpend(new Map(camp.map((c) => [c.date, c.spend])), new Map(ads.map((a) => [a.date, a.spend])));
  return { campaignMinor: r.parentMinor, childrenMinor: r.childrenMinor, unallocatedMinor: r.unallocatedMinor, days: r.rows.filter((d) => d.unallocatedMinor !== 0) };
}

const sumMetrics = (xs: Iterable<AdMetricValues>) => [...xs].reduce((a, b) => addMetrics(a, b), { ...ZERO_METRICS });

/** Ad sets (ad groups) of a campaign with platform and Keel numbers, the orders no ad set claims, and the spend reconciliation. */
export async function campaignAdSets(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, campaignId: string): Promise<{ rows: AdSetRow[]; unassigned: UnassignedRow | null; reconciliation: SpendReconciliation }> {
  const campaigns = await campaignsOf(ctx, { campaignIds: [campaignId] });
  const c = campaigns[0];
  if (!c) return { rows: [], unassigned: null, reconciliation: { campaignMinor: 0, childrenMinor: 0, unallocatedMinor: 0, days: [] } };
  const sets = await ctx.tx.select().from(schema.adSets).where(and(eq(schema.adSets.tenantId, ctx.tenantId), eq(schema.adSets.campaignId, campaignId))).orderBy(schema.adSets.name);
  const [keel, metrics, counts, kwCounts, reconciliation] = await Promise.all([
    keelIndex(ctx, tenant, period, campaigns),
    entityMetrics(ctx, "ad_set", period, { campaignIds: [campaignId] }),
    ctx.tx.select({ adSetId: schema.adCreatives.adSetId, n: sql<number>`count(*)::int` }).from(schema.adCreatives).where(and(eq(schema.adCreatives.tenantId, ctx.tenantId), eq(schema.adCreatives.campaignId, campaignId))).groupBy(schema.adCreatives.adSetId),
    ctx.tx.select({ adSetId: schema.adKeywords.adSetId, n: sql<number>`count(*)::int` }).from(schema.adKeywords).where(and(eq(schema.adKeywords.tenantId, ctx.tenantId), eq(schema.adKeywords.campaignId, campaignId))).groupBy(schema.adKeywords.adSetId),
    campaignSpendReconciliation(ctx, campaignId, period),
  ]);
  const rows: AdSetRow[] = sets.map((s) => {
    const m = metrics.get(s.id) ?? { ...ZERO_METRICS };
    return { id: s.id, externalId: s.externalId, name: s.name, status: s.status, platform: s.platform, campaignId: c.id, campaignName: c.name, metrics: m, economics: econ(m, keel.byAdSet.get(s.id)), orders: c.platform === "meta" ? { campaign: c.id, utmTerm: s.externalId } : null, ads: counts.find((x) => x.adSetId === s.id)?.n ?? 0, optimizationGoal: s.optimizationGoal, keywords: kwCounts.find((x) => x.adSetId === s.id)?.n ?? 0 };
  });
  const lost = keel.noAdSet.get(c.id);
  return { rows: rows.sort((a, b) => b.metrics.spendMinor - a.metrics.spendMinor), unassigned: lost ? { keel: lost, economics: econ({ ...ZERO_METRICS }, lost) } : null, reconciliation };
}

/** Ads with platform and Keel numbers, fatigue (frequency up while CTR falls), the UTM check and a pause suggestion. */
export async function adRows(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, scope: { campaignId?: string; adSetId?: string; platform?: string; adIds?: string[] } = {}): Promise<{ rows: AdRow[]; unassigned: UnassignedRow | null }> {
  const conds: SQL[] = [eq(schema.adCreatives.tenantId, ctx.tenantId)];
  if (scope.campaignId) conds.push(eq(schema.adCreatives.campaignId, scope.campaignId));
  if (scope.adSetId) conds.push(eq(schema.adCreatives.adSetId, scope.adSetId));
  if (scope.platform) conds.push(eq(schema.adCreatives.platform, scope.platform));
  if (scope.adIds) conds.push(inArray(schema.adCreatives.id, ids(scope.adIds)));
  const ads = await ctx.tx.select({ a: schema.adCreatives, adSetName: schema.adSets.name }).from(schema.adCreatives).leftJoin(schema.adSets, eq(schema.adSets.id, schema.adCreatives.adSetId)).where(and(...conds));
  const campaigns = await campaignsOf(ctx, { campaignIds: [...new Set(ads.map((a) => a.a.campaignId))] });
  const keel = await keelIndex(ctx, tenant, period, campaigns);
  const days = await adDays(ctx, period, ads.map((a) => a.a.id));
  const byAd = new Map<string, AdDay[]>();
  for (const d of days) byAd.set(d.creativeId, [...(byAd.get(d.creativeId) ?? []), d]);
  const pre = ads.map(({ a, adSetName }) => {
    const ds = byAd.get(a.id) ?? [];
    const m = sumMetrics(ds.map(fromAdDay));
    const c = keel.campaigns.get(a.campaignId)!;
    const fatigue = ds.length ? creativeFatigue(ds.map((d) => ({ date: d.date, impressions: d.impressions, clicks: d.clicks, spendMinor: d.spendMinor, reach: d.reach }))) : null;
    return { a, adSetName, m, c, fatigue, economics: econ(m, keel.byAd.get(a.id)) };
  });
  const suggestions = new Map(adPauseSuggestions(pre.map((p) => ({ id: p.a.id, status: p.a.status, spendMinor: p.m.spendMinor, economics: p.economics, fatigue: p.fatigue?.level ?? null })), { minSpendMinor: tenant.settings.adsMinSpendMinor, roiMedium: tenant.settings.roiMedium }).map((s) => [s.id, s.reason]));
  const rows: AdRow[] = pre.map(({ a, adSetName, m, c, fatigue, economics }) => ({
    id: a.id, externalId: a.externalId, name: a.name, status: a.status, platform: a.platform, campaignId: a.campaignId, campaignName: c?.name ?? "", metrics: m, economics,
    orders: { campaign: a.campaignId, utmContent: a.externalId },
    adSetId: a.adSetId, adSetName: adSetName ?? a.adsetName, format: a.format, hook: a.hook, angle: a.angle, headline: a.headline, body: a.body, finalUrl: a.finalUrl,
    utm: checkUtmTemplate(a.platform, a.urlTags, a.finalUrl), fatigue, frequency: m.reach ? m.impressions / m.reach : null, suggestion: suggestions.get(a.id) ?? null,
  }));
  let unassigned: UnassignedRow | null = null;
  if (scope.campaignId && !scope.adSetId) {
    const lost = keel.noAd.get(scope.campaignId);
    if (lost) unassigned = { keel: lost, economics: econ({ ...ZERO_METRICS }, lost) };
  }
  return { rows: rows.sort((x, y) => y.metrics.spendMinor - x.metrics.spendMinor), unassigned };
}

export interface AssetRow {
  id: string;
  /** Platform id (Google asset, Meta breakdown id, TikTok video id). */
  assetExternalId: string;
  type: string;
  fieldType: string;
  text: string | null;
  url: string | null;
  performanceLabel: string | null;
  metrics: AdMetricValues;
  /** The ad's Keel numbers spread by the asset's spend share within its field type. */
  economics: AdEntityEconomics;
  suggestion: PauseReason | null;
}

/** One ad with its assets (allocated Keel numbers, weak-asset suggestions) and its daily series. */
export async function adDetail(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, adId: string) {
  const { rows } = await adRows(ctx, tenant, period, { adIds: [adId] });
  const ad = rows[0];
  if (!ad) return null;
  const assets = await ctx.tx.select().from(schema.adAssets).where(and(eq(schema.adAssets.tenantId, ctx.tenantId), eq(schema.adAssets.creativeId, adId)));
  const metrics = await entityMetrics(ctx, "asset", period, { entityIds: assets.map((a) => a.id) });
  const keel = { orders: ad.economics.attributedOrders, netRevenueMinor: ad.economics.netRevenueMinor, marginMinor: ad.economics.marginMinor, allOrders: ad.economics.attributedOrders + ad.economics.excludedOrders };
  const allocated = new Map<string, KeelNumbers>();
  for (const field of new Set(assets.map((a) => a.fieldType))) {
    const group = assets.filter((a) => a.fieldType === field);
    for (const [id, k] of allocateKeel(keel, new Map(group.map((a) => [a.id, metrics.get(a.id)?.spendMinor ?? 0])))) allocated.set(id, k);
  }
  const weak = new Map(assetPauseSuggestions(assets.map((a) => ({ id: a.id, adId, fieldType: a.fieldType, performanceLabel: a.performanceLabel, impressions: metrics.get(a.id)?.impressions ?? 0, clicks: metrics.get(a.id)?.clicks ?? 0 })), { minImpressions: 200 }).map((s) => [s.id, s.reason]));
  const assetRows: AssetRow[] = assets.map((a) => {
    const m = metrics.get(a.id) ?? { ...ZERO_METRICS };
    return { id: a.id, assetExternalId: a.assetExternalId, type: a.type, fieldType: a.fieldType, text: a.textContent, url: a.url, performanceLabel: a.performanceLabel, metrics: m, economics: econ(m, allocated.get(a.id)), suggestion: weak.get(a.id) ?? null };
  }).sort((x, y) => x.fieldType.localeCompare(y.fieldType) || y.metrics.spendMinor - x.metrics.spendMinor);
  const days = await adDays(ctx, period, [adId]);
  return { ad, assets: assetRows, days };
}

export interface KeywordRow extends AdLevelRow { text: string; matchType: string; qualityScore: number | null; adSetId: string | null; adSetName: string | null }

const sorters = {
  spend: (r: { metrics: AdMetricValues }) => r.metrics.spendMinor,
  profit: (r: { economics: AdEntityEconomics }) => r.economics.profitMinor,
  roas: (r: { economics: AdEntityEconomics }) => r.economics.roas ?? -1,
  conversions: (r: { metrics: AdMetricValues }) => r.metrics.conversions,
};
export type AdsTableSort = keyof typeof sorters;
export const ADS_TABLE_SORTS = Object.keys(sorters) as AdsTableSort[];
export const ADS_PAGE_SIZE = 50;

function pageOf<T>(rows: T[], page: number, all = false) {
  if (all) return { rows, total: rows.length, page: 1, pages: 1 };
  const pages = Math.max(1, Math.ceil(rows.length / ADS_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * ADS_PAGE_SIZE, p * ADS_PAGE_SIZE), total: rows.length, page: p, pages };
}

/** Keywords (Google) with platform numbers and Keel's orders through `utm_term={keyword}`. */
export async function keywordRows(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, f: { campaignId?: string; adSetId?: string; q?: string; sort?: AdsTableSort; page?: number; all?: boolean } = {}) {
  const conds: SQL[] = [eq(schema.adKeywords.tenantId, ctx.tenantId), eq(schema.adKeywords.negative, false)];
  if (f.campaignId) conds.push(eq(schema.adKeywords.campaignId, f.campaignId));
  if (f.adSetId) conds.push(eq(schema.adKeywords.adSetId, f.adSetId));
  if (f.q) conds.push(sql`${schema.adKeywords.text} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`}`);
  const kws = await ctx.tx.select({ k: schema.adKeywords, adSetName: schema.adSets.name }).from(schema.adKeywords).leftJoin(schema.adSets, eq(schema.adSets.id, schema.adKeywords.adSetId)).where(and(...conds));
  const campaigns = await campaignsOf(ctx, { campaignIds: [...new Set(kws.map((k) => k.k.campaignId))] });
  const [keel, metrics] = await Promise.all([keelIndex(ctx, tenant, period, campaigns), entityMetrics(ctx, "keyword", period, { entityIds: kws.map((k) => k.k.id) })]);
  const rows: KeywordRow[] = kws.map(({ k, adSetName }) => {
    const m = metrics.get(k.id) ?? { ...ZERO_METRICS };
    const c = keel.campaigns.get(k.campaignId)!;
    return { id: k.id, externalId: k.externalId, name: k.text, text: k.text, status: k.status, platform: k.platform, campaignId: k.campaignId, campaignName: c?.name ?? "", metrics: m, economics: econ(m, keel.byTerm.get(`${k.campaignId}|${normalizeSearchText(k.text)}`)), orders: { campaign: k.campaignId, utmTerm: k.text }, matchType: k.matchType, qualityScore: k.qualityScore, adSetId: k.adSetId, adSetName };
  });
  const key = sorters[f.sort ?? "spend"];
  return pageOf(rows.sort((a, b) => key(b) - key(a) || a.text.localeCompare(b.text)), f.page ?? 1, f.all);
}

export interface SearchTermRow extends AdLevelRow {
  text: string;
  matchType: string | null;
  termStatus: string;
  isOther: boolean;
  keywordText: string | null;
  adSetId: string | null;
  adSetName: string | null;
  /** Keel sees this term's orders (it equals a keyword of the campaign). */
  keelMatchable: boolean;
  candidate: NegativeReason | null;
}

/** Search terms with platform numbers, Keel's orders where the term is a keyword, and negative-keyword candidates. */
export async function searchTermRows(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, f: { campaignId?: string; adSetId?: string; q?: string; sort?: AdsTableSort; page?: number; candidatesOnly?: boolean; minImpressions?: number } = {}) {
  const T = schema.adSearchTerms;
  const conds: SQL[] = [eq(T.tenantId, ctx.tenantId)];
  if (f.campaignId) conds.push(eq(T.campaignId, f.campaignId));
  if (f.adSetId) conds.push(eq(T.adSetId, f.adSetId));
  if (f.q) conds.push(sql`${T.text} ilike ${`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`}`);
  const terms = await ctx.tx.select({ t: T, adSetName: schema.adSets.name, keywordText: schema.adKeywords.text }).from(T).leftJoin(schema.adSets, eq(schema.adSets.id, T.adSetId)).leftJoin(schema.adKeywords, eq(schema.adKeywords.id, T.keywordId)).where(and(...conds));
  const campaignIds = [...new Set(terms.map((x) => x.t.campaignId))];
  const campaigns = await campaignsOf(ctx, { campaignIds });
  const [keel, metrics, keywords] = await Promise.all([
    keelIndex(ctx, tenant, period, campaigns),
    entityMetrics(ctx, "search_term", period, { campaignIds }),
    ctx.tx.select({ campaignId: schema.adKeywords.campaignId, text: schema.adKeywords.text }).from(schema.adKeywords).where(and(eq(schema.adKeywords.tenantId, ctx.tenantId), inArray(schema.adKeywords.campaignId, ids(campaignIds)), eq(schema.adKeywords.negative, false))),
  ]);
  const keywordTexts = new Set(keywords.map((k) => `${k.campaignId}|${normalizeSearchText(k.text)}`));
  const pre = terms.map(({ t, adSetName, keywordText }) => {
    const m = metrics.get(t.id) ?? { ...ZERO_METRICS };
    const key = `${t.campaignId}|${normalizeSearchText(t.text)}`;
    const keelMatchable = !t.isOther && keywordTexts.has(key);
    return { t, adSetName, keywordText, m, keelMatchable, keel: keelMatchable ? (keel.byTerm.get(key) ?? { ...EMPTY_KEEL }) : undefined };
  }).filter((p) => p.m.impressions >= (f.minImpressions ?? 0) || p.m.spendMinor > 0);
  const candidates = new Map(negativeKeywordCandidates(pre.map((p) => ({ id: p.t.id, text: p.t.text, status: p.t.status, isOther: p.t.isOther, spendMinor: p.m.spendMinor, clicks: p.m.clicks, conversions: p.m.conversions, keel: p.keel ?? { ...EMPTY_KEEL }, keelMatchable: p.keelMatchable })), { minSpendMinor: tenant.settings.adsMinSpendMinor, minClicks: 5 }).map((c) => [c.id, c.reason]));
  let rows: SearchTermRow[] = pre.map((p) => ({ id: p.t.id, externalId: p.t.externalId, name: p.t.text, text: p.t.text, status: p.t.status, platform: p.t.platform, campaignId: p.t.campaignId, campaignName: keel.campaigns.get(p.t.campaignId)?.name ?? "", metrics: p.m, economics: econ(p.m, p.keel), orders: p.keelMatchable ? { campaign: p.t.campaignId, utmTerm: p.t.text } : null, matchType: p.t.matchType, termStatus: p.t.status, isOther: p.t.isOther, keywordText: p.keywordText, adSetId: p.t.adSetId, adSetName: p.adSetName, keelMatchable: p.keelMatchable, candidate: candidates.get(p.t.id) ?? null }));
  if (f.candidatesOnly) rows = rows.filter((r) => r.candidate);
  const key = sorters[f.sort ?? "spend"];
  return pageOf(rows.sort((a, b) => key(b) - key(a) || a.text.localeCompare(b.text)), f.page ?? 1);
}

export const WORD_SOURCES = ["copy", "search_terms", "keywords"] as const;
export type WordSource = (typeof WORD_SOURCES)[number];

/** Winning and losing 1–3 word phrases from ad copy (both platforms), search terms or keywords, with Keel profit. */
export async function adsWords(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, f: { source?: WordSource; n?: 1 | 2 | 3 | null; sort?: NgramSort; platform?: string; langs: readonly string[]; limit?: number }): Promise<{ rows: NgramRow[]; winners: NgramRow[]; losers: NgramRow[]; items: number }> {
  const source = f.source ?? "copy";
  let items: { text: string; m: AdMetricValues; e: AdEntityEconomics }[] = [];
  if (source === "copy") {
    const { rows } = await adRows(ctx, tenant, period, { platform: f.platform });
    items = rows.map((r) => ({ text: [r.headline, r.body].filter(Boolean).join(". ") || r.name, m: r.metrics, e: r.economics }));
  } else if (source === "keywords") {
    const r = await keywordRows(ctx, tenant, period, { sort: "spend", all: true });
    items = r.rows.map((k) => ({ text: k.text, m: k.metrics, e: k.economics }));
  } else {
    const T = schema.adSearchTerms;
    const terms = await ctx.tx.select({ id: T.id, text: T.text, campaignId: T.campaignId, isOther: T.isOther }).from(T).where(eq(T.tenantId, ctx.tenantId));
    const campaigns = await campaignsOf(ctx, { campaignIds: [...new Set(terms.map((t) => t.campaignId))] });
    const [keel, metrics] = await Promise.all([keelIndex(ctx, tenant, period, campaigns), entityMetrics(ctx, "search_term", period, { campaignIds: campaigns.map((c) => c.id) })]);
    items = terms.filter((t) => !t.isOther && metrics.has(t.id)).map((t) => {
      const m = metrics.get(t.id)!;
      return { text: t.text, m, e: econ(m, keel.byTerm.get(`${t.campaignId}|${normalizeSearchText(t.text)}`)) };
    });
  }
  const all = ngramStats(items.filter((i) => i.m.spendMinor > 0 || i.e.attributedOrders > 0).map((i) => ({ text: i.text, spendMinor: i.m.spendMinor, impressions: i.m.impressions, clicks: i.m.clicks, conversions: i.m.conversions, orders: i.e.attributedOrders, netRevenueMinor: i.e.netRevenueMinor, marginMinor: i.e.marginMinor })), { langs: f.langs, minItems: 2, minSpendMinor: tenant.settings.adsMinSpendMinor / 2 });
  const rows = f.n ? all.filter((r) => r.n === f.n) : all;
  const ranked = rankNgrams(rows, f.sort ?? "profit", f.limit ?? 15);
  return { rows, ...ranked, items: items.length };
}

/** Campaigns whose ads do not carry the UTM template Keel needs, with how many ads miss it. */
export async function utmTemplateIssues(ctx: ServiceContext): Promise<{ campaignId: string; campaignName: string; platform: string; ads: number; missing: number; params: string[] }[]> {
  const ads = await ctx.tx.select({ campaignId: schema.adCreatives.campaignId, platform: schema.adCreatives.platform, urlTags: schema.adCreatives.urlTags, finalUrl: schema.adCreatives.finalUrl, status: schema.adCreatives.status, campaignName: schema.campaigns.name, campaignStatus: schema.campaigns.status }).from(schema.adCreatives).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adCreatives.campaignId)).where(and(eq(schema.adCreatives.tenantId, ctx.tenantId), sql`${schema.campaigns.status} <> 'archived'`));
  const by = new Map<string, { campaignId: string; campaignName: string; platform: string; ads: number; missing: number; params: Set<string> }>();
  for (const a of ads) {
    const cur = by.get(a.campaignId) ?? { campaignId: a.campaignId, campaignName: a.campaignName, platform: a.platform, ads: 0, missing: 0, params: new Set<string>() };
    cur.ads++;
    const check = checkUtmTemplate(a.platform, a.urlTags, a.finalUrl);
    if (!check.ok) {
      cur.missing++;
      check.missing.forEach((p) => cur.params.add(p));
    }
    by.set(a.campaignId, cur);
  }
  return [...by.values()].filter((c) => c.missing > 0).map((c) => ({ ...c, params: [...c.params] })).sort((a, b) => b.missing - a.missing || a.campaignName.localeCompare(b.campaignName));
}

/** Read-only suggestions a person acts on: negative keywords, ads and assets to pause, winning words, missing UTM templates. */
export async function adsRecommendations(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, opts: { langs: readonly string[] }) {
  const [negatives, ads, words, utm] = await Promise.all([
    searchTermRows(ctx, tenant, period, { candidatesOnly: true, sort: "spend" }),
    adRows(ctx, tenant, period, {}),
    adsWords(ctx, tenant, period, { source: "copy", sort: "profit", langs: opts.langs, limit: 8 }),
    utmTemplateIssues(ctx),
  ]);
  const toPause = ads.rows.filter((r) => r.suggestion).sort((a, b) => a.economics.profitMinor - b.economics.profitMinor).slice(0, 15);
  // weak assets of the ads that spend the most (Google labels LOW, or half the CTR of their siblings)
  const topAds = [...ads.rows].sort((a, b) => b.metrics.spendMinor - a.metrics.spendMinor).slice(0, 30);
  const details = await Promise.all(topAds.map((a) => adDetail(ctx, tenant, period, a.id)));
  const assets = details.flatMap((d) => (d ? d.assets.filter((x) => x.suggestion && x.metrics.spendMinor >= tenant.settings.adsMinSpendMinor / 4).map((x) => ({ ...x, adId: d.ad.id, adName: d.ad.name, campaignId: d.ad.campaignId, campaignName: d.ad.campaignName })) : [])).slice(0, 15);
  return { negatives: negatives.rows.slice(0, 20), negativeTotal: negatives.total, ads: toPause, assets, words: words.winners.slice(0, 8), utm };
}

/** Top search terms by spend for the dashboard widget, with Keel orders where visible. */
export async function topSearchTerms(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period, limit: number) {
  const r = await searchTermRows(ctx, tenant, period, { sort: "spend" });
  return r.rows.filter((x) => !x.isOther).slice(0, limit);
}

export { OTHER_SEARCH_TERM };

import type { AdPlatform } from "@hullwise/config";
import { campaignMetrics, type CampaignMetrics } from "./campaigns";

/**
 * Ads below the campaign (issue #40): ad sets / ad groups, ads, assets, keywords and search terms.
 * Pure rules shared by the sync, the analysis services and the seed: how orders are tied to an
 * entity, how spend reconciles across levels, which rows become suggestions, how old daily rows
 * are rolled up.
 */

export const AD_ENTITY_LEVELS = ["ad_set", "ad", "asset", "keyword", "search_term"] as const;
export type AdEntityLevel = (typeof AD_ENTITY_LEVELS)[number];
/** Levels stored in the generic `ad_entity_metrics_daily` table (ads keep `ad_creative_metrics_daily`). */
export const GENERIC_METRIC_LEVELS = ["ad_set", "asset", "keyword", "search_term"] as const;
export type GenericMetricLevel = (typeof GENERIC_METRIC_LEVELS)[number];

/** Label of the bucket that collects search terms under the minimum impressions. */
export const OTHER_SEARCH_TERM = "(other)";

/**
 * UTM templates that tie an order to an ad, ad set or keyword. Meta fills the dynamic parameters in
 * the ad's URL parameters; Google fills ValueTrack parameters in the tracking template; TikTok fills
 * its macros in the ad's URL (`__CAMPAIGN_ID__`, `__AID__` = ad group, `__CID__` = ad) [to verify:
 * macro names in TikTok Ads Manager].
 */
export const ADS_UTM_TEMPLATES: Readonly<Record<AdPlatform, string>> = {
  meta: "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}",
  google: "{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}",
  tiktok: "utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__&utm_term=__AID__",
};

const REQUIRED_PARAMS: Record<AdPlatform, { param: "utm_content" | "utm_term"; value: string }[]> = {
  meta: [{ param: "utm_content", value: "{{ad.id}}" }, { param: "utm_term", value: "{{adset.id}}" }],
  google: [{ param: "utm_content", value: "{creative}" }, { param: "utm_term", value: "{keyword}" }],
  tiktok: [{ param: "utm_content", value: "__CID__" }, { param: "utm_term", value: "__AID__" }],
};

export interface UtmCheck {
  ok: boolean;
  missing: ("utm_content" | "utm_term")[];
}

/** Whether an ad's URL parameters / tracking template / final URL carry the dynamic UTMs Hullwise needs. */
export function checkUtmTemplate(platform: string, ...sources: (string | null | undefined)[]): UtmCheck {
  const required = REQUIRED_PARAMS[platform as AdPlatform] as (typeof REQUIRED_PARAMS)[AdPlatform] | undefined;
  if (!required) return { ok: true, missing: [] };
  const text = sources.filter(Boolean).join("&").toLowerCase().replace(/\s+/g, "");
  const missing = required.filter((r) => !text.includes(`${r.param}=${r.value.toLowerCase()}`)).map((r) => r.param);
  return { ok: missing.length === 0, missing };
}

/** Search terms and keywords compared as Google shows them: lower case, single spaces, no match-type syntax. */
export function normalizeSearchText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/^[+"[\s]+|["\]\s]+$/g, "").replace(/\+/g, "").replace(/\s+/g, " ").trim();
}

export interface OrderAdKeys {
  adExternalId: string | null;
  adSetExternalId: string | null;
  /** Normalized `utm_term` on Google: the keyword (ValueTrack `{keyword}`), equal to the search term on exact-match traffic. */
  termText: string | null;
}

/** Keys an order's UTMs point to, per platform template (see `ADS_UTM_TEMPLATES`). */
export function orderAdKeys(platform: string, utm: { utmContent: string | null; utmTerm: string | null }): OrderAdKeys {
  const content = utm.utmContent?.trim() || null;
  const term = utm.utmTerm?.trim() || null;
  // Meta and TikTok carry the ad set / ad group id in utm_term ({{adset.id}}, __AID__)
  if (platform === "meta" || platform === "tiktok") return { adExternalId: content, adSetExternalId: term, termText: null };
  if (platform === "google") return { adExternalId: content, adSetExternalId: null, termText: term ? normalizeSearchText(term) : null };
  return { adExternalId: content, adSetExternalId: null, termText: null };
}

export interface HullwiseOrderRow {
  key: string;
  inScope: boolean;
  netRevenueMinor: number;
  marginMinor: number;
}

export interface HullwiseNumbers {
  /** Orders that count as a sale (not cancelled, not returned). */
  orders: number;
  netRevenueMinor: number;
  marginMinor: number;
  /** Every order tied to the entity, cancelled and returned included. */
  allOrders: number;
}

export const EMPTY_HULLWISE: HullwiseNumbers = { orders: 0, netRevenueMinor: 0, marginMinor: 0, allOrders: 0 };

/** Hullwise's numbers per key: revenue and margin only from orders in the sale scope (CLAUDE.md §7.5). */
export function hullwiseByKey(rows: readonly HullwiseOrderRow[]): Map<string, HullwiseNumbers> {
  const out = new Map<string, HullwiseNumbers>();
  for (const r of rows) {
    const cur = out.get(r.key) ?? { ...EMPTY_HULLWISE };
    cur.allOrders++;
    if (r.inScope) {
      cur.orders++;
      cur.netRevenueMinor += r.netRevenueMinor;
      cur.marginMinor += r.marginMinor;
    }
    out.set(r.key, cur);
  }
  return out;
}

export interface AdMetricValues {
  spendMinor: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  conversionValueMinor: number;
  videoViews3s: number;
  videoCompletions: number;
}

export const ZERO_METRICS: AdMetricValues = { spendMinor: 0, impressions: 0, clicks: 0, reach: 0, conversions: 0, conversionValueMinor: 0, videoViews3s: 0, videoCompletions: 0 };

export function addMetrics(a: AdMetricValues, b: Partial<AdMetricValues>): AdMetricValues {
  return { spendMinor: a.spendMinor + (b.spendMinor ?? 0), impressions: a.impressions + (b.impressions ?? 0), clicks: a.clicks + (b.clicks ?? 0), reach: a.reach + (b.reach ?? 0), conversions: a.conversions + (b.conversions ?? 0), conversionValueMinor: a.conversionValueMinor + (b.conversionValueMinor ?? 0), videoViews3s: a.videoViews3s + (b.videoViews3s ?? 0), videoCompletions: a.videoCompletions + (b.videoCompletions ?? 0) };
}

export interface AdEntityEconomics extends CampaignMetrics {
  /** What the platform claims. */
  platformConversions: number;
  platformValueMinor: number;
  ctr: number | null;
  /** Hullwise orders tied to the entity that do not count (cancelled, returned). */
  excludedOrders: number;
}

/** Platform numbers next to Hullwise's: the same definitions as the campaign list (profit = margin − spend). */
export function adEntityEconomics(m: Pick<AdMetricValues, "spendMinor" | "impressions" | "clicks" | "conversions" | "conversionValueMinor">, hullwise: HullwiseNumbers): AdEntityEconomics {
  const base = campaignMetrics({ spendMinor: m.spendMinor, clicks: m.clicks, impressions: m.impressions, attributedOrders: hullwise.orders, netRevenueMinor: hullwise.netRevenueMinor, marginMinor: hullwise.marginMinor });
  return { ...base, platformConversions: m.conversions, platformValueMinor: m.conversionValueMinor, ctr: m.impressions ? m.clicks / m.impressions : null, excludedOrders: hullwise.allOrders - hullwise.orders };
}

/** Splits an integer total by weights so the parts add up exactly (largest remainder). */
export function splitExact(total: number, weights: readonly number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const out = raw.map((x) => Math.floor(x));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k]![1]]! += 1;
  return out;
}

/** Hullwise numbers of an ad spread over its assets by spend share (within one field type, so the parts add up to the ad). */
export function allocateHullwise(total: HullwiseNumbers, spendByAsset: ReadonlyMap<string, number>): Map<string, HullwiseNumbers> {
  const ids = [...spendByAsset.keys()];
  const weights = ids.map((id) => spendByAsset.get(id) ?? 0);
  const orders = splitExact(total.orders, weights);
  const all = splitExact(total.allOrders, weights);
  const net = splitExact(total.netRevenueMinor, weights);
  const margin = splitExact(total.marginMinor, weights);
  return new Map(ids.map((id, i) => [id, { orders: orders[i]!, allOrders: all[i]!, netRevenueMinor: net[i]!, marginMinor: margin[i]! }]));
}

export interface SpendReconciliationRow {
  date: string;
  parentMinor: number;
  childrenMinor: number;
  /** Parent spend no child reports (deleted ads, rounding, a level synced later); negative when children report more. */
  unallocatedMinor: number;
}

/** Day by day: campaign spend vs the sum of its ads (or ad sets); the gap is shown as "unallocated", never hidden. */
export function reconcileSpend(parent: ReadonlyMap<string, number>, children: ReadonlyMap<string, number>): { rows: SpendReconciliationRow[]; parentMinor: number; childrenMinor: number; unallocatedMinor: number } {
  const dates = [...new Set([...parent.keys(), ...children.keys()])].sort();
  const rows = dates.map((date) => {
    const p = parent.get(date) ?? 0;
    const c = children.get(date) ?? 0;
    return { date, parentMinor: p, childrenMinor: c, unallocatedMinor: p - c };
  });
  const parentMinor = rows.reduce((s, r) => s + r.parentMinor, 0);
  const childrenMinor = rows.reduce((s, r) => s + r.childrenMinor, 0);
  return { rows, parentMinor, childrenMinor, unallocatedMinor: parentMinor - childrenMinor };
}

/* ---------- suggestions (read-only: a person acts on them) ---------- */

export type NegativeReason = "only_cancelled" | "no_orders" | "unprofitable_orders" | "no_conversions";

export interface SearchTermCandidateInput {
  id: string;
  text: string;
  status: string;
  isOther: boolean;
  spendMinor: number;
  clicks: number;
  conversions: number;
  hullwise: HullwiseNumbers;
  /** Hullwise can see this term's orders (the term equals a keyword, so `utm_term={keyword}` names it). */
  hullwiseMatchable: boolean;
}

export interface NegativeCandidate {
  id: string;
  text: string;
  reason: NegativeReason;
  spendMinor: number;
  clicks: number;
}

/**
 * Search terms that spend without profitable orders. When Hullwise can see the term's orders it judges
 * on them (only cancelled/returned ones, none, or a negative margin); otherwise on the platform's
 * conversions. Terms already excluded and the "(other)" bucket are never proposed.
 */
export function negativeKeywordCandidates(terms: readonly SearchTermCandidateInput[], opts: { minSpendMinor: number; minClicks: number }): NegativeCandidate[] {
  const out: NegativeCandidate[] = [];
  for (const t of terms) {
    if (t.isOther || t.status === "excluded" || t.spendMinor < opts.minSpendMinor || t.clicks < opts.minClicks) continue;
    let reason: NegativeReason | null = null;
    if (t.hullwiseMatchable) {
      if (t.hullwise.orders === 0) reason = t.hullwise.allOrders > 0 ? "only_cancelled" : t.conversions > 0 ? null : "no_orders";
      else if (t.hullwise.marginMinor <= 0) reason = "unprofitable_orders";
    } else if (t.conversions <= 0) reason = "no_conversions";
    if (reason) out.push({ id: t.id, text: t.text, reason, spendMinor: t.spendMinor, clicks: t.clicks });
  }
  return out.sort((a, b) => b.spendMinor - a.spendMinor || a.text.localeCompare(b.text));
}

export type PauseReason = "losing" | "fatigued" | "low_label" | "low_ctr";

export interface AdPauseInput {
  id: string;
  status: string;
  spendMinor: number;
  economics: Pick<AdEntityEconomics, "profitMinor" | "roi">;
  fatigue: "fresh" | "watch" | "fatigued" | "no_data" | null;
}

/** Active ads that lose money (ROI at or under the "bad" threshold) or that lose money while fatigued. */
export function adPauseSuggestions(ads: readonly AdPauseInput[], opts: { minSpendMinor: number; roiMedium: number }): { id: string; reason: PauseReason; profitMinor: number }[] {
  return ads
    .filter((a) => a.status === "active" && a.spendMinor >= opts.minSpendMinor && a.economics.profitMinor < 0)
    .map((a) => ({ a, reason: (a.economics.roi !== null && a.economics.roi <= opts.roiMedium ? "losing" : a.fatigue === "fatigued" ? "fatigued" : null) as PauseReason | null }))
    .filter((x): x is { a: AdPauseInput; reason: PauseReason } => x.reason !== null)
    .map(({ a, reason }) => ({ id: a.id, reason, profitMinor: a.economics.profitMinor }))
    .sort((x, y) => x.profitMinor - y.profitMinor);
}

export interface AssetPauseInput {
  id: string;
  adId: string | null;
  fieldType: string;
  performanceLabel: string | null;
  impressions: number;
  clicks: number;
}

/** Assets the platform rates LOW, or with a CTR under half of their siblings' (same ad, same field type). */
export function assetPauseSuggestions(assets: readonly AssetPauseInput[], opts: { minImpressions: number }): { id: string; reason: PauseReason; ctr: number | null; siblingsCtr: number | null }[] {
  const groups = new Map<string, AssetPauseInput[]>();
  for (const a of assets) {
    const k = `${a.adId ?? ""}|${a.fieldType}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: { id: string; reason: PauseReason; ctr: number | null; siblingsCtr: number | null }[] = [];
  for (const a of assets) {
    if (a.impressions < opts.minImpressions) continue;
    const ctr = a.impressions ? a.clicks / a.impressions : null;
    const sib = (groups.get(`${a.adId ?? ""}|${a.fieldType}`) ?? []).filter((s) => s.id !== a.id);
    const sImpr = sib.reduce((s, x) => s + x.impressions, 0);
    const siblingsCtr = sImpr ? sib.reduce((s, x) => s + x.clicks, 0) / sImpr : null;
    if ((a.performanceLabel ?? "").toUpperCase() === "LOW") out.push({ id: a.id, reason: "low_label", ctr, siblingsCtr });
    else if (ctr !== null && siblingsCtr !== null && siblingsCtr > 0 && ctr < siblingsCtr / 2) out.push({ id: a.id, reason: "low_ctr", ctr, siblingsCtr });
  }
  return out;
}

/* ---------- volume control ---------- */

export interface MetricRow extends AdMetricValues {
  entityType: string;
  entityId: string;
  /** YYYY-MM-DD; first day of the month for monthly rows. */
  date: string;
  grain: "day" | "month";
}

/** Daily rows older than the cutoff become one row per entity and month (added to an existing monthly row). */
export function rollupMetricRows(rows: readonly MetricRow[], cutoff: string): { keep: MetricRow[]; months: MetricRow[]; rolled: number } {
  const keep: MetricRow[] = [];
  const months = new Map<string, MetricRow>();
  let rolled = 0;
  for (const r of rows) {
    if (r.grain === "day" && r.date >= cutoff) {
      keep.push(r);
      continue;
    }
    if (r.grain === "day") rolled++;
    const month = `${r.date.slice(0, 7)}-01`;
    const k = `${r.entityType}|${r.entityId}|${month}`;
    const cur = months.get(k) ?? { ...ZERO_METRICS, entityType: r.entityType, entityId: r.entityId, date: month, grain: "month" as const };
    months.set(k, { ...cur, ...addMetrics(cur, r) });
  }
  return { keep, months: [...months.values()], rolled };
}

/**
 * Monthly search-term rows under the minimum impressions move to the "(other)" term of the same ad
 * group (or campaign): spend and conversions are kept, so totals still reconcile.
 */
export function groupRareTerms(months: readonly MetricRow[], minImpressions: number, otherOf: (entityId: string) => string | null): MetricRow[] {
  const out = new Map<string, MetricRow>();
  for (const r of months) {
    const other = r.entityType === "search_term" && r.impressions < minImpressions ? otherOf(r.entityId) : null;
    const id = other ?? r.entityId;
    const k = `${r.entityType}|${id}|${r.date}`;
    const cur = out.get(k);
    out.set(k, cur ? { ...cur, ...addMetrics(cur, r) } : { ...r, entityId: id });
  }
  return [...out.values()];
}

/** A daily search-term row too small to keep on its own: under the threshold and without spend, clicks or conversions. */
export function isNoiseTerm(m: Pick<AdMetricValues, "impressions" | "clicks" | "spendMinor" | "conversions">, minImpressions: number): boolean {
  return m.impressions < minImpressions && m.clicks === 0 && m.spendMinor === 0 && m.conversions === 0;
}

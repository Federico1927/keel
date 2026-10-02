import { splitExact } from "@keel/core";
import { IntegrationError, type AdEntityMetricLevel, type AdsCapabilities, type AdsPlatform, type ConnectionTest, type NegativeKeywordInput, type NormalizedAd, type NormalizedAdAsset, type NormalizedAdMetric, type NormalizedAdSet, type NormalizedCampaign, type NormalizedEntityMetric, type NormalizedKeyword } from "../types";
import { FailureScript } from "./failures";

/** Entities below the campaign the simulator reports (the factory loads them from the tenant's data, so a sync updates the seed in place). */
export interface MockAdsStructure {
  adSets: NormalizedAdSet[];
  ads: NormalizedAd[];
  assets: NormalizedAdAsset[];
  keywords: NormalizedKeyword[];
  /** Search terms each keyword triggers (Google); by default the keyword text plus a few modifiers. */
  searchTerms?: { keywordExternalId: string; text: string }[];
}

export interface MockAdsOptions {
  provider: "meta" | "google";
  /** Kept for compatibility: metrics are a stable hash of campaign and day. */
  seed?: number;
  currency: string;
  campaigns: NormalizedCampaign[];
  /** Approximate daily spend per campaign, minor units. */
  dailySpendMinor?: number;
  readOnly?: boolean;
  structure?: MockAdsStructure;
  /** Google: the tenant granted the write scope (pause ads, negative keywords). Meta can always write. */
  adWrites?: boolean;
}

/** Stable value in [0, 1) for a key: metrics do not depend on call order, so levels reconcile across calls. */
function unit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

const MODIFIERS = ["", "sale", "best", "cheap", "online"];

export class MockAdsPlatform implements AdsPlatform {
  readonly provider: string;
  readonly failures = new FailureScript();
  readonly capabilities: AdsCapabilities;
  private statuses = new Map<string, "active" | "paused" | "archived">();
  private adStatuses = new Map<string, "active" | "paused" | "archived">();
  readonly negatives: NegativeKeywordInput[] = [];
  readonly writeLog: { op: string; args: unknown }[] = [];
  private readonly s: MockAdsStructure;

  constructor(private readonly opts: MockAdsOptions) {
    this.provider = opts.provider;
    for (const c of opts.campaigns) this.statuses.set(c.externalId, c.status);
    this.s = opts.structure ?? { adSets: [], ads: [], assets: [], keywords: [] };
    for (const a of this.s.ads) this.adStatuses.set(a.externalId, a.status);
    const google = opts.provider === "google";
    this.capabilities = { supportsKeywords: google, supportsSearchTerms: google, supportsAssetBreakdown: true, supportsAdWrites: google ? opts.adWrites === true : !opts.readOnly };
  }
  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: `Mock ${this.opts.provider} account`, accountId: this.opts.provider === "meta" ? "act_mock" : "123-456-7890" };
  }
  async fetchCampaigns(): Promise<NormalizedCampaign[]> {
    this.failures.check();
    return this.opts.campaigns.map((c) => ({ ...c, status: this.statuses.get(c.externalId) ?? c.status }));
  }

  private days(window: { since: string; until: string }): string[] {
    const out: string[] = [];
    const end = new Date(window.until + "T00:00:00Z");
    for (let d = new Date(window.since + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
    return out;
  }

  /** The campaign's day: the same numbers whichever level asks, so ad sets, ads, keywords and terms add up to it. */
  private campaignDay(campaignExternalId: string, date: string): NormalizedAdMetric {
    const r = (k: string) => unit(`${campaignExternalId}|${date}|${k}`);
    const spend = Math.round((this.opts.dailySpendMinor ?? 5000) * (0.6 + r("s") * 0.8));
    const impressions = Math.round(spend / 8);
    const clicks = Math.round(impressions * (0.01 + r("c") * 0.02));
    return { campaignExternalId, date, spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.6), purchases: Math.round(clicks * 0.03), purchaseValueMinor: Math.round(clicks * 0.03 * 6500) };
  }

  async fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]> {
    this.failures.check();
    const out: NormalizedAdMetric[] = [];
    for (const c of this.opts.campaigns) {
      if ((this.statuses.get(c.externalId) ?? c.status) !== "active") continue;
      for (const date of this.days(window)) out.push(this.campaignDay(c.externalId, date));
    }
    return out;
  }

  async setCampaignStatus(externalId: string, status: "active" | "paused"): Promise<void> {
    this.failures.check();
    if (this.opts.readOnly) throw new IntegrationError("unsupported", `${this.opts.provider} adapter is read-only`);
    if (!this.statuses.has(externalId)) throw new IntegrationError("not_found", `campaign ${externalId} not found`);
    this.statuses.set(externalId, status);
    this.writeLog.push({ op: "setCampaignStatus", args: { externalId, status } });
  }

  async fetchAdSets(): Promise<NormalizedAdSet[]> {
    this.failures.check();
    return this.s.adSets.map((a) => ({ ...a }));
  }
  async fetchAds(): Promise<NormalizedAd[]> {
    this.failures.check();
    return this.s.ads.map((a) => ({ ...a, status: this.adStatuses.get(a.externalId) ?? a.status }));
  }
  async fetchAssets(): Promise<NormalizedAdAsset[]> {
    this.failures.check();
    return this.s.assets.map((a) => ({ ...a }));
  }
  async fetchKeywords(): Promise<NormalizedKeyword[]> {
    this.failures.check();
    return this.capabilities.supportsKeywords ? this.s.keywords.map((k) => ({ ...k })) : [];
  }

  private termsOf(k: NormalizedKeyword): string[] {
    const listed = this.s.searchTerms?.filter((t) => t.keywordExternalId === k.externalId).map((t) => t.text);
    if (listed?.length) return listed;
    return MODIFIERS.map((m) => (m ? `${m} ${k.text}` : k.text));
  }

  async fetchEntityMetrics(level: AdEntityMetricLevel, window: { since: string; until: string }): Promise<NormalizedEntityMetric[]> {
    this.failures.check();
    if ((level === "keyword" || level === "search_term") && !this.capabilities.supportsKeywords) return [];
    const out: NormalizedEntityMetric[] = [];
    const split = (day: NormalizedAdMetric, keys: string[]) => {
      const w = keys.map((k) => 0.3 + unit(k));
      const spend = splitExact(day.spendMinor, w);
      const impr = splitExact(day.impressions, w);
      const clicks = splitExact(day.clicks, w);
      const conv = splitExact(day.purchases, w);
      const value = splitExact(day.purchaseValueMinor, w);
      return keys.map((_, i) => ({ spendMinor: spend[i]!, impressions: impr[i]!, clicks: clicks[i]!, conversions: conv[i]!, conversionValueMinor: value[i]!, reach: Math.round(impr[i]! / 1.6), videoViews3s: 0, videoCompletions: 0 }));
    };
    for (const c of this.opts.campaigns) {
      if ((this.statuses.get(c.externalId) ?? c.status) !== "active") continue;
      const sets = this.s.adSets.filter((a) => a.campaignExternalId === c.externalId);
      if (!sets.length) continue;
      for (const date of this.days(window)) {
        const setDays = split(this.campaignDay(c.externalId, date), sets.map((a) => a.externalId));
        sets.forEach((set, i) => {
          const sd = setDays[i]!;
          const base = { campaignExternalId: c.externalId, adSetExternalId: set.externalId, date };
          if (level === "ad_set") return out.push({ level, entityExternalId: set.externalId, ...base, ...sd });
          const asDay: NormalizedAdMetric = { campaignExternalId: c.externalId, date, spendMinor: sd.spendMinor, impressions: sd.impressions, clicks: sd.clicks, viewContent: 0, purchases: sd.conversions, purchaseValueMinor: sd.conversionValueMinor };
          if (level === "ad" || level === "asset") {
            const ads = this.s.ads.filter((a) => a.adSetExternalId === set.externalId);
            const adDays = split(asDay, ads.map((a) => a.externalId));
            ads.forEach((ad, j) => {
              const ad1 = adDays[j]!;
              if (level === "ad") return out.push({ level, entityExternalId: ad.externalId, adExternalId: ad.externalId, ...base, ...ad1 });
              const assets = this.s.assets.filter((x) => x.adExternalId === ad.externalId);
              for (const field of new Set(assets.map((x) => x.fieldType))) {
                const group = assets.filter((x) => x.fieldType === field);
                const parts = split({ ...asDay, spendMinor: ad1.spendMinor, impressions: ad1.impressions, clicks: ad1.clicks, purchases: ad1.conversions, purchaseValueMinor: ad1.conversionValueMinor }, group.map((x) => `${ad.externalId}|${x.assetExternalId}`));
                group.forEach((x, k) => out.push({ level, entityExternalId: x.assetExternalId, adExternalId: ad.externalId, fieldType: field, ...base, ...parts[k]! }));
              }
            });
            return;
          }
          const kws = this.s.keywords.filter((k) => k.adSetExternalId === set.externalId && !k.negative);
          const kwDays = split(asDay, kws.map((k) => k.externalId));
          kws.forEach((k, j) => {
            const kd = kwDays[j]!;
            if (level === "keyword") return out.push({ level, entityExternalId: k.externalId, ...base, ...kd });
            const terms = this.termsOf(k);
            const parts = split({ ...asDay, spendMinor: kd.spendMinor, impressions: kd.impressions, clicks: kd.clicks, purchases: kd.conversions, purchaseValueMinor: kd.conversionValueMinor }, terms.map((t) => `${k.externalId}|${t}`));
            terms.forEach((text, m) => out.push({ level, entityExternalId: text, keywordExternalId: k.externalId, keywordText: k.text, matchType: text === k.text ? "exact" : k.matchType, termStatus: this.negatives.some((n) => n.text === text && n.campaignExternalId === c.externalId) ? "excluded" : "none", ...base, ...parts[m]! }));
          });
        });
      }
    }
    return out;
  }

  async setAdStatus(ad: { adExternalId: string; adSetExternalId: string | null }, status: "active" | "paused"): Promise<void> {
    this.failures.check();
    if (!this.capabilities.supportsAdWrites) throw new IntegrationError("unsupported", `${this.opts.provider} adapter is read-only`);
    if (!this.adStatuses.has(ad.adExternalId)) throw new IntegrationError("not_found", `ad ${ad.adExternalId} not found`);
    this.adStatuses.set(ad.adExternalId, status);
    this.writeLog.push({ op: "setAdStatus", args: { ...ad, status } });
  }

  async addNegativeKeywords(input: NegativeKeywordInput[]): Promise<{ created: number }> {
    this.failures.check();
    if (!this.capabilities.supportsAdWrites || !this.capabilities.supportsKeywords) throw new IntegrationError("unsupported", `${this.opts.provider} adapter is read-only`);
    this.negatives.push(...input);
    this.writeLog.push({ op: "addNegativeKeywords", args: input });
    return { created: input.length };
  }
}

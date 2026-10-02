import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AdEntityMetricLevel, type AdEntityStatus, type AdsCapabilities, type AdsPlatform, type ConnectionTest, type NegativeKeywordInput, type NormalizedAd, type NormalizedAdAsset, type NormalizedAdMetric, type NormalizedAdSet, type NormalizedCampaign, type NormalizedEntityMetric, type NormalizedKeyword } from "../types";

/**
 * The one place the Google Ads API version lives (adapter, conversions sink, guide, tests). Google
 * sunsets a version about a year after release: v18 is gone. Checked on 2026-10-02 [to verify on
 * Google's "Sunset dates" page before each release]; bump it here and re-record the fixtures.
 */
export const GOOGLE_ADS_API_VERSION = "v23";
/** Oldest version Hullwise accepts: a test fails if the constant drops below it. */
export const GOOGLE_ADS_MIN_SUPPORTED_VERSION = 21;
export const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
/** Version number of a `vNN` string (NaN when malformed). */
export function googleAdsVersionNumber(v: string = GOOGLE_ADS_API_VERSION): number {
  return /^v\d+$/.test(v) ? Number(v.slice(1)) : Number.NaN;
}
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Digits only, no dashes. */
  customerId: string;
  /** Manager (MCC) account when the customer is accessed through one. */
  loginCustomerId?: string | null;
}

type Rec = Record<string, unknown>;

/** GAQL resource per level, and the metric fields every level reads. */
const METRIC_FIELDS = "segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";

const status = (s: unknown): AdEntityStatus => {
  const v = String(s ?? "").toUpperCase();
  return v === "ENABLED" ? "active" : v === "PAUSED" ? "paused" : "archived";
};
const matchType = (s: unknown): "exact" | "phrase" | "broad" => {
  const v = String(s ?? "").toUpperCase();
  return v === "EXACT" || v === "NEAR_EXACT" ? "exact" : v === "PHRASE" || v === "NEAR_PHRASE" ? "phrase" : "broad";
};
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(rec(x).text ?? "")).filter(Boolean) : []);

/**
 * Live Google Ads adapter over GAQL searchStream: campaigns, ad groups, ads, RSA assets, keywords and
 * search terms with daily metrics. Read-only unless the tenant granted the write scope
 * (`writeEnabled`): then it can pause an ad and add negative keywords.
 */
export class GoogleAdsPlatform implements AdsPlatform {
  readonly provider = "google";
  readonly http: HttpClient;
  readonly capabilities: AdsCapabilities;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly base: string;

  constructor(private readonly creds: GoogleAdsCredentials, opts: HttpOptions & { apiVersion?: string; accessToken?: string; writeEnabled?: boolean } = {}) {
    this.http = new HttpClient({ minIntervalMs: 100, ...opts });
    this.capabilities = { supportsKeywords: true, supportsSearchTerms: true, supportsAssetBreakdown: true, supportsAdWrites: opts.writeEnabled === true };
    this.base = `https://googleads.googleapis.com/${opts.apiVersion ?? GOOGLE_ADS_API_VERSION}`;
    if (opts.accessToken) {
      this.accessToken = opts.accessToken;
      this.tokenExpiresAt = Date.now() + 3600_000;
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({ client_id: this.creds.clientId, client_secret: this.creds.clientSecret, refresh_token: this.creds.refreshToken, grant_type: "refresh_token" }).toString();
    const res = await this.http.request<{ access_token: string; expires_in: number }>("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    this.accessToken = res.json.access_token;
    this.tokenExpiresAt = Date.now() + (res.json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private customer(): string {
    return this.creds.customerId.replace(/-/g, "");
  }

  /** Authorized POST to a customer-scoped endpoint (e.g. `:uploadClickConversions`). */
  async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.token();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "developer-token": this.creds.developerToken, "content-type": "application/json" };
    if (this.creds.loginCustomerId) headers["login-customer-id"] = this.creds.loginCustomerId.replace(/-/g, "");
    const res = await this.http.request<T & { error?: { message: string; status?: string } }>(`${this.base}/customers/${this.customer()}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const err = res.json?.error;
    if (err) throw new IntegrationError(err.status === "PERMISSION_DENIED" ? "permission" : err.status === "UNAUTHENTICATED" ? "token_expired" : err.status === "RESOURCE_EXHAUSTED" ? "rate_limited" : "invalid_request", err.message);
    return res.json;
  }

  customerResource(): string {
    return `customers/${this.customer()}`;
  }

  /** searchStream returns an array of chunks, each with `results`. */
  async query(gaql: string): Promise<Rec[]> {
    const token = await this.token();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "developer-token": this.creds.developerToken, "content-type": "application/json" };
    if (this.creds.loginCustomerId) headers["login-customer-id"] = this.creds.loginCustomerId.replace(/-/g, "");
    const res = await this.http.request<{ results?: Rec[] }[] | { error?: { message: string; status?: string } }>(`${this.base}/customers/${this.customer()}/googleAds:searchStream`, { method: "POST", headers, body: JSON.stringify({ query: gaql }) });
    if (!Array.isArray(res.json)) {
      const err = res.json?.error;
      if (err) throw new IntegrationError(err.status === "PERMISSION_DENIED" ? "permission" : err.status === "RESOURCE_EXHAUSTED" ? "rate_limited" : "invalid_request", err.message);
      return [];
    }
    return res.json.flatMap((chunk) => chunk.results ?? []);
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const rows = await this.query("SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1");
      const c = (rows[0]?.customer as Rec | undefined) ?? {};
      return { ok: true, accountName: String(c.descriptiveName ?? ""), accountId: String(c.id ?? this.customer()), scopes: [GOOGLE_ADS_SCOPE] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async fetchCampaigns(): Promise<NormalizedCampaign[]> {
    const rows = await this.query("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id");
    return rows.map((r) => {
      const c = r.campaign as Rec;
      const status = String(c.status ?? "").toUpperCase();
      return { externalId: String(c.id), accountExternalId: this.customer(), name: String(c.name ?? ""), status: status === "ENABLED" ? "active" : status === "PAUSED" ? "paused" : "archived", objective: c.advertisingChannelType ? String(c.advertisingChannelType) : null, dailyBudgetMinor: (r.campaignBudget as Rec | undefined)?.amountMicros ? Math.round(Number((r.campaignBudget as Rec).amountMicros) / 10_000) : null, currency: ((r.customer as Rec | undefined)?.currencyCode as string | undefined) ?? null, platformCreatedAt: null };
    });
  }

  async fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]> {
    const rows = await this.query(`SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${window.since}' AND '${window.until}' AND campaign.status != 'REMOVED'`);
    return rows.map((r) => {
      const m = (r.metrics as Rec | undefined) ?? {};
      return { campaignExternalId: String((r.campaign as Rec).id), date: String((r.segments as Rec).date), spendMinor: Math.round(Number(m.costMicros ?? 0) / 10_000), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), viewContent: 0, purchases: Math.round(Number(m.conversions ?? 0)), purchaseValueMinor: Math.round(Number(m.conversionsValue ?? 0) * 100) };
    });
  }

  async setCampaignStatus(): Promise<void> {
    throw new IntegrationError("unsupported", "Google Ads is read-only in this version");
  }

  async fetchAdSets(): Promise<NormalizedAdSet[]> {
    const rows = await this.query("SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED' ORDER BY ad_group.id");
    return rows.map((r) => {
      const g = rec(r.adGroup);
      return { externalId: String(g.id), campaignExternalId: String(rec(r.campaign).id), name: String(g.name ?? ""), status: status(g.status), optimizationGoal: g.type ? String(g.type) : null, dailyBudgetMinor: null };
    });
  }

  async fetchAds(): Promise<NormalizedAd[]> {
    const rows = await this.query("SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group.id, campaign.id, campaign.tracking_url_template FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' ORDER BY ad_group_ad.ad.id");
    return rows.map((r) => {
      const aga = rec(r.adGroupAd);
      const ad = rec(aga.ad);
      const rsa = rec(ad.responsiveSearchAd);
      const headlines = texts(rsa.headlines);
      const descriptions = texts(rsa.descriptions);
      const type = String(ad.type ?? "").toUpperCase();
      // the tracking template can sit on the ad or be inherited from the campaign
      const urlTags = [ad.trackingUrlTemplate, ad.finalUrlSuffix, rec(r.campaign).trackingUrlTemplate].filter(Boolean).map(String).join(" ") || null;
      return { externalId: String(ad.id), adSetExternalId: String(rec(r.adGroup).id), campaignExternalId: String(rec(r.campaign).id), name: String(ad.name ?? "") || headlines[0] || `Ad ${String(ad.id)}`, status: status(aga.status), format: type.includes("VIDEO") ? "video" : type.includes("IMAGE") || type.includes("DISPLAY") ? "image" : "text", headline: headlines.join(" | ") || null, body: descriptions.join(" ") || null, finalUrl: Array.isArray(ad.finalUrls) && ad.finalUrls.length ? String(ad.finalUrls[0]) : null, urlTags, thumbnailUrl: null };
    });
  }

  /** RSA headlines and descriptions with Google's performance label [to verify: label availability per version]. */
  async fetchAssets(): Promise<NormalizedAdAsset[]> {
    const rows = await this.query("SELECT ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, ad_group_ad_asset_view.enabled, asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id, ad_group_ad.ad.id, ad_group.id, campaign.id FROM ad_group_ad_asset_view WHERE ad_group_ad_asset_view.enabled = TRUE");
    return rows.map((r) => this.mapAsset(r));
  }

  private mapAsset(r: Rec): NormalizedAdAsset {
    const v = rec(r.adGroupAdAssetView);
    const a = rec(r.asset);
    const t = String(a.type ?? "").toUpperCase();
    const field = String(v.fieldType ?? "").toUpperCase();
    return {
      assetExternalId: String(a.id),
      adExternalId: rec(rec(r.adGroupAd).ad).id ? String(rec(rec(r.adGroupAd).ad).id) : null,
      adSetExternalId: rec(r.adGroup).id ? String(rec(r.adGroup).id) : null,
      campaignExternalId: String(rec(r.campaign).id),
      type: t === "IMAGE" ? "image" : t === "YOUTUBE_VIDEO" ? "video" : "text",
      fieldType: field === "HEADLINE" ? "headline" : field === "DESCRIPTION" ? "description" : field === "MARKETING_IMAGE" || field === "SQUARE_MARKETING_IMAGE" ? "image" : field === "YOUTUBE_VIDEO" ? "video" : "other",
      text: rec(a.textAsset).text ? String(rec(a.textAsset).text) : null,
      url: rec(rec(a.imageAsset).fullSize).url ? String(rec(rec(a.imageAsset).fullSize).url) : rec(a.youtubeVideoAsset).youtubeVideoId ? `https://youtu.be/${String(rec(a.youtubeVideoAsset).youtubeVideoId)}` : null,
      performanceLabel: v.performanceLabel && String(v.performanceLabel) !== "UNSPECIFIED" ? String(v.performanceLabel) : null,
    };
  }

  async fetchKeywords(): Promise<NormalizedKeyword[]> {
    const rows = await this.query("SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, ad_group_criterion.status, ad_group_criterion.negative, ad_group.id, campaign.id FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED'");
    return rows.map((r) => {
      const c = rec(r.adGroupCriterion);
      const kw = rec(c.keyword);
      const qs = rec(c.qualityInfo).qualityScore;
      return { externalId: `${String(rec(r.adGroup).id)}~${String(c.criterionId)}`, adSetExternalId: String(rec(r.adGroup).id), campaignExternalId: String(rec(r.campaign).id), text: String(kw.text ?? ""), matchType: matchType(kw.matchType), qualityScore: qs === undefined || qs === null ? null : Number(qs), status: status(c.status), negative: c.negative === true };
    });
  }

  private metric(level: AdEntityMetricLevel, r: Rec, entityExternalId: string, extra: Partial<NormalizedEntityMetric> = {}): NormalizedEntityMetric {
    const m = rec(r.metrics);
    return { level, entityExternalId, campaignExternalId: String(rec(r.campaign).id), adSetExternalId: rec(r.adGroup).id ? String(rec(r.adGroup).id) : null, date: String(rec(r.segments).date), spendMinor: Math.round(Number(m.costMicros ?? 0) / 10_000), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), reach: 0, conversions: Number(m.conversions ?? 0), conversionValueMinor: Math.round(Number(m.conversionsValue ?? 0) * 100), videoViews3s: 0, videoCompletions: 0, ...extra };
  }

  /** Daily metrics of one level over a window; GAQL dates are inclusive. */
  async fetchEntityMetrics(level: AdEntityMetricLevel, window: { since: string; until: string }): Promise<NormalizedEntityMetric[]> {
    const during = `segments.date BETWEEN '${window.since}' AND '${window.until}'`;
    if (level === "ad_set") {
      const rows = await this.query(`SELECT ad_group.id, campaign.id, ${METRIC_FIELDS} FROM ad_group WHERE ${during} AND ad_group.status != 'REMOVED'`);
      return rows.map((r) => this.metric(level, r, String(rec(r.adGroup).id)));
    }
    if (level === "ad") {
      const rows = await this.query(`SELECT ad_group_ad.ad.id, ad_group.id, campaign.id, ${METRIC_FIELDS} FROM ad_group_ad WHERE ${during}`);
      return rows.map((r) => this.metric(level, r, String(rec(rec(r.adGroupAd).ad).id)));
    }
    if (level === "asset") {
      const rows = await this.query(`SELECT ad_group_ad_asset_view.field_type, asset.id, ad_group_ad.ad.id, ad_group.id, campaign.id, ${METRIC_FIELDS} FROM ad_group_ad_asset_view WHERE ${during}`);
      return rows.map((r) => {
        const a = this.mapAsset(r);
        return this.metric(level, r, a.assetExternalId, { adExternalId: a.adExternalId, fieldType: a.fieldType });
      });
    }
    if (level === "keyword") {
      const rows = await this.query(`SELECT ad_group_criterion.criterion_id, ad_group.id, campaign.id, ${METRIC_FIELDS} FROM keyword_view WHERE ${during}`);
      return rows.map((r) => this.metric(level, r, `${String(rec(r.adGroup).id)}~${String(rec(r.adGroupCriterion).criterionId)}`));
    }
    const rows = await this.query(`SELECT search_term_view.search_term, search_term_view.status, segments.search_term_match_type, segments.keyword.ad_group_criterion, segments.keyword.info.text, segments.keyword.info.match_type, ad_group.id, campaign.id, ${METRIC_FIELDS} FROM search_term_view WHERE ${during}`);
    return rows.map((r) => {
      const v = rec(r.searchTermView);
      const seg = rec(r.segments);
      const kw = rec(seg.keyword);
      const crit = String(kw.adGroupCriterion ?? "");
      const st = String(v.status ?? "").toUpperCase();
      return this.metric(level, r, String(v.searchTerm ?? ""), { keywordExternalId: crit ? crit.split("/").pop() ?? null : null, keywordText: rec(kw.info).text ? String(rec(kw.info).text) : null, matchType: seg.searchTermMatchType ? String(seg.searchTermMatchType).toLowerCase() : null, termStatus: st === "ADDED" || st === "ADDED_EXCLUDED" ? "added" : st === "EXCLUDED" ? "excluded" : "none" });
    });
  }

  private requireWrite(): void {
    if (!this.capabilities.supportsAdWrites) throw new IntegrationError("unsupported", "Google Ads is read-only: the tenant has not granted the write scope");
  }

  /** `adGroupAds:mutate` with an update mask on status (resource `customers/{id}/adGroupAds/{adGroupId}~{adId}`). */
  async setAdStatus(ad: { adExternalId: string; adSetExternalId: string | null }, next: "active" | "paused"): Promise<void> {
    this.requireWrite();
    if (!ad.adSetExternalId) throw new IntegrationError("invalid_request", "Google ads are addressed through their ad group");
    await this.post("/adGroupAds:mutate", { operations: [{ updateMask: "status", update: { resourceName: `${this.customerResource()}/adGroupAds/${ad.adSetExternalId}~${ad.adExternalId}`, status: next === "active" ? "ENABLED" : "PAUSED" } }] });
  }

  /** Negative keywords at campaign level (`campaignCriteria:mutate`) or ad group level (`adGroupCriteria:mutate`). */
  async addNegativeKeywords(input: NegativeKeywordInput[]): Promise<{ created: number }> {
    this.requireWrite();
    const kw = (k: NegativeKeywordInput) => ({ text: k.text, matchType: k.matchType.toUpperCase() });
    const campaignLevel = input.filter((k) => !k.adSetExternalId);
    const groupLevel = input.filter((k) => k.adSetExternalId);
    let created = 0;
    if (campaignLevel.length) {
      const res = await this.post<{ results?: unknown[] }>("/campaignCriteria:mutate", { operations: campaignLevel.map((k) => ({ create: { campaign: `${this.customerResource()}/campaigns/${k.campaignExternalId}`, negative: true, keyword: kw(k) } })) });
      created += res.results?.length ?? 0;
    }
    if (groupLevel.length) {
      const res = await this.post<{ results?: unknown[] }>("/adGroupCriteria:mutate", { operations: groupLevel.map((k) => ({ create: { adGroup: `${this.customerResource()}/adGroups/${k.adSetExternalId}`, negative: true, keyword: kw(k) } })) });
      created += res.results?.length ?? 0;
    }
    return { created };
  }
}

import { splitDateWindows } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AdEntityMetricLevel, type AdEntityStatus, type AdsCapabilities, type AdsPlatform, type ConnectionTest, type NormalizedAd, type NormalizedAdAsset, type NormalizedAdMetric, type NormalizedAdSet, type NormalizedCampaign, type NormalizedEntityMetric, failedConnection } from "../types";

/**
 * TikTok Marketing API (TikTok for Business). The one place the version, endpoints and metric names
 * live [to verify against the TikTok API for Business docs before each release]; bump them here and
 * re-record the fixtures.
 */
export const TIKTOK_API_VERSION = "v1.3";
export const TIKTOK_API_BASE = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}`;
/** Advertiser authorization page the store owner is sent to [to verify]. */
export const TIKTOK_AUTH_URL = "https://business-api.tiktok.com/portal/auth";
/** Permission groups the TikTok for Business app needs, by Hullwise module [to verify: names in the developer portal]. */
export const TIKTOK_REQUIRED_SCOPES = ["Ad Account Management", "Ads Management", "Reporting", "Creative Management"] as const;
export const TIKTOK_SCOPES_BY_MODULE: Readonly<Record<string, readonly string[]>> = {
  campaigns: ["Ad Account Management", "Ads Management", "Reporting"],
  creatives: ["Creative Management"],
  pause: ["Ads Management"],
};
/** Reporting metrics requested at every level; `campaign_id` / `adgroup_id` are attribute metrics of the lower levels [to verify]. */
export const TIKTOK_REPORT_METRICS = ["spend", "impressions", "clicks", "reach", "conversion", "complete_payment", "total_complete_payment_rate", "video_play_actions", "video_watched_2s", "video_views_p100", "average_video_play"] as const;
/** Days per reporting call: the API refuses longer daily (`stat_time_day`) ranges [to verify: 30 days]. */
export const TIKTOK_REPORT_MAX_DAYS = 30;
const PAGE_SIZE = 1000;

export interface TiktokCredentials {
  appId: string;
  appSecret: string;
  /** Long-lived advertiser access token from the auth-code exchange (valid until the advertiser revokes it). */
  accessToken: string;
  /** Advertiser accounts the authorization covers; Hullwise imports all of them. */
  advertiserIds: string[];
}

type Rec = Record<string, unknown>;
interface Envelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}
interface ListPage<T> {
  list?: T[];
  page_info?: { page?: number; page_size?: number; total_number?: number; total_page?: number };
}

/**
 * TikTok answers HTTP 200 with a business code. Mapping [to verify against the error-code table]:
 * 40100 too many requests; 40102/40104/40105 token expired, empty or invalid; 40001/40007 no permission; 4xxxx other request errors; 5xxxx server errors.
 */
export function mapTiktokError(code: number, message: string): IntegrationError {
  if (code === 40100 || code === 40133) return new IntegrationError("rate_limited", message, 60_000);
  if (code === 40102 || code === 40104 || code === 40105) return new IntegrationError("token_expired", message);
  if (code === 40001 || code === 40007 || code === 40300) return new IntegrationError("permission", message);
  if (code >= 50000) return new IntegrationError("network", message);
  if (code >= 40000) return new IntegrationError("invalid_request", message);
  return new IntegrationError("unknown", message);
}

const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const minor = (v: unknown): number => Math.round(num(v) * 100);
const status = (r: Rec): AdEntityStatus => {
  const secondary = String(r.secondary_status ?? "").toUpperCase();
  if (secondary.includes("DELETE")) return "archived";
  const op = String(r.operation_status ?? "").toUpperCase();
  return op === "ENABLE" ? "active" : op === "DISABLE" || op === "FROZEN" ? "paused" : "archived";
};
const formatOf = (f: unknown): string => {
  const v = String(f ?? "").toUpperCase();
  return v.includes("VIDEO") ? "video" : v.includes("CAROUSEL") ? "carousel" : v.includes("IMAGE") ? "image" : "other";
};
const dayOf = (v: unknown): string => String(v ?? "").slice(0, 10);
const urlParams = (url: string | null): string | null => {
  if (!url) return null;
  const at = url.indexOf("?");
  return at >= 0 ? url.slice(at + 1) || null : null;
};

/** The advertiser authorization URL: TikTok redirects back with `auth_code` and `state`. */
export function tiktokAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const u = new URL(TIKTOK_AUTH_URL);
  u.searchParams.set("app_id", appId);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  return u.toString();
}

/** Exchanges the auth code for a long-lived access token and the advertiser accounts it covers. */
export async function exchangeTiktokAuthCode(input: { appId: string; appSecret: string; authCode: string }, opts: HttpOptions = {}): Promise<{ accessToken: string; advertiserIds: string[]; scope: string[] }> {
  const http = new HttpClient(opts);
  const res = await http.request<Envelope<{ access_token?: string; advertiser_ids?: (string | number)[]; scope?: (string | number)[] }>>(`${TIKTOK_API_BASE}/oauth2/access_token/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: input.appId, secret: input.appSecret, auth_code: input.authCode }) });
  if (res.json?.code !== 0) throw mapTiktokError(res.json?.code ?? -1, res.json?.message ?? "token exchange failed");
  const token = res.json.data?.access_token;
  if (!token) throw new IntegrationError("invalid_request", "TikTok returned no access token");
  return { accessToken: token, advertiserIds: (res.json.data.advertiser_ids ?? []).map(String), scope: (res.json.data.scope ?? []).map(String) };
}

/**
 * Live TikTok Ads adapter: campaigns, ad groups, ads (copy, video, thumbnail), daily reporting at
 * campaign, ad group and ad level, pause/resume of campaigns and ads, across every authorized
 * advertiser account. TikTok has no keywords or search terms and no per-asset reporting.
 */
export class TiktokAdsPlatform implements AdsPlatform {
  readonly provider = "tiktok";
  readonly capabilities: AdsCapabilities = { supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: false, supportsAdWrites: true };
  readonly http: HttpClient;
  private readonly base: string;
  private adsCache: (NormalizedAd & { videoId: string | null; imageIds: string[]; advertiserId: string })[] | null = null;

  constructor(private readonly creds: TiktokCredentials, opts: HttpOptions & { apiBase?: string } = {}) {
    this.http = new HttpClient({ minIntervalMs: 100, ...opts });
    this.base = opts.apiBase ?? TIKTOK_API_BASE;
  }

  private headers(): Record<string, string> {
    return { "access-token": this.creds.accessToken, "content-type": "application/json" };
  }

  private async get<T>(path: string, params: Record<string, string | number | unknown[] | Rec>): Promise<T> {
    const u = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    const res = await this.http.request<Envelope<T>>(u.toString(), { headers: this.headers() });
    if (!res.json || res.json.code !== 0) throw mapTiktokError(res.json?.code ?? -1, res.json?.message ?? `TikTok ${path} failed`);
    return res.json.data;
  }

  private async post<T>(path: string, body: Rec): Promise<T> {
    const res = await this.http.request<Envelope<T>>(`${this.base}/${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.json || res.json.code !== 0) throw mapTiktokError(res.json?.code ?? -1, res.json?.message ?? `TikTok ${path} failed`);
    return res.json.data;
  }

  /** Every page of a `list` endpoint (`page_info.total_page`). */
  private async all<T>(path: string, params: Record<string, string | number | unknown[] | Rec>, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.get<ListPage<T>>(path, { ...params, page, page_size: PAGE_SIZE });
      out.push(...(data.list ?? []));
      if (page >= (data.page_info?.total_page ?? 1)) break;
    }
    return out;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      if (!this.creds.advertiserIds.length) return { ok: false, error: "No advertiser account authorized" };
      const data = await this.get<{ list?: Rec[] }>("advertiser/info/", { advertiser_ids: this.creds.advertiserIds, fields: ["advertiser_id", "name", "currency", "status", "timezone"] });
      const list = data.list ?? [];
      return { ok: true, accountName: list.map((a) => String(a.name ?? a.advertiser_id)).join(", "), accountId: this.creds.advertiserIds.join(","), scopes: [] };
    } catch (e) {
      return failedConnection(e);
    }
  }

  async fetchCampaigns(): Promise<NormalizedCampaign[]> {
    const out: NormalizedCampaign[] = [];
    const info = await this.get<{ list?: Rec[] }>("advertiser/info/", { advertiser_ids: this.creds.advertiserIds, fields: ["advertiser_id", "currency"] }).catch(() => ({ list: [] as Rec[] }));
    const currency = new Map((info.list ?? []).map((a) => [String(a.advertiser_id), a.currency ? String(a.currency) : null]));
    for (const advertiserId of this.creds.advertiserIds) {
      const rows = await this.all<Rec>("campaign/get/", { advertiser_id: advertiserId });
      for (const c of rows) {
        const daily = String(c.budget_mode ?? "").toUpperCase() === "BUDGET_MODE_DAY" && num(c.budget) > 0;
        out.push({ externalId: String(c.campaign_id), accountExternalId: advertiserId, name: String(c.campaign_name ?? ""), status: status(c), objective: c.objective_type ? String(c.objective_type) : null, dailyBudgetMinor: daily ? minor(c.budget) : null, currency: currency.get(advertiserId) ?? null, platformCreatedAt: c.create_time ? new Date(`${String(c.create_time).replace(" ", "T")}Z`) : null });
      }
    }
    return out;
  }

  /** Report rows over [since, until] at one level, split in windows the API accepts and paged. */
  private async report(level: "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP" | "AUCTION_AD", idDimension: string, extra: readonly string[], window: { since: string; until: string }): Promise<{ advertiserId: string; dimensions: Rec; metrics: Rec }[]> {
    const out: { advertiserId: string; dimensions: Rec; metrics: Rec }[] = [];
    for (const advertiserId of this.creds.advertiserIds) {
      for (const w of splitDateWindows(window.since, window.until, TIKTOK_REPORT_MAX_DAYS)) {
        const rows = await this.all<Rec>("report/integrated/get/", { advertiser_id: advertiserId, report_type: "BASIC", data_level: level, dimensions: [idDimension, "stat_time_day"], metrics: [...TIKTOK_REPORT_METRICS, ...extra], start_date: w.since, end_date: w.until });
        for (const r of rows) out.push({ advertiserId, dimensions: rec(r.dimensions), metrics: rec(r.metrics) });
      }
    }
    return out;
  }

  /** Daily reporting per campaign; spend arrives in account currency major units and is stored in minor units. */
  async fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]> {
    const rows = await this.report("AUCTION_CAMPAIGN", "campaign_id", [], window);
    return rows.map(({ dimensions: d, metrics: m }) => ({ campaignExternalId: String(d.campaign_id), date: dayOf(d.stat_time_day), spendMinor: minor(m.spend), impressions: num(m.impressions), clicks: num(m.clicks), viewContent: 0, purchases: num(m.complete_payment ?? m.conversion), purchaseValueMinor: minor(m.total_complete_payment_rate) }));
  }

  private async findAdvertiser(endpoint: "campaign/get/" | "ad/get/", filterKey: "campaign_ids" | "ad_ids", id: string): Promise<string> {
    if (this.creds.advertiserIds.length === 1) return this.creds.advertiserIds[0]!;
    for (const advertiserId of this.creds.advertiserIds) {
      const data = await this.get<ListPage<Rec>>(endpoint, { advertiser_id: advertiserId, filtering: { [filterKey]: [id] }, page: 1, page_size: 1 });
      if ((data.list ?? []).length) return advertiserId;
    }
    throw new IntegrationError("not_found", `${filterKey.replace("_ids", "")} ${id} not found in the authorized advertisers`);
  }

  async setCampaignStatus(externalId: string, s: "active" | "paused"): Promise<void> {
    const advertiserId = await this.findAdvertiser("campaign/get/", "campaign_ids", externalId);
    await this.post("campaign/status/update/", { advertiser_id: advertiserId, campaign_ids: [externalId], operation_status: s === "active" ? "ENABLE" : "DISABLE" });
  }

  async setAdStatus(ad: { adExternalId: string }, s: "active" | "paused"): Promise<void> {
    const advertiserId = await this.findAdvertiser("ad/get/", "ad_ids", ad.adExternalId);
    await this.post("ad/status/update/", { advertiser_id: advertiserId, ad_ids: [ad.adExternalId], operation_status: s === "active" ? "ENABLE" : "DISABLE" });
  }

  /** Ad groups (TikTok's ad sets): optimization goal and daily budget. */
  async fetchAdSets(): Promise<NormalizedAdSet[]> {
    const out: NormalizedAdSet[] = [];
    for (const advertiserId of this.creds.advertiserIds) {
      for (const a of await this.all<Rec>("adgroup/get/", { advertiser_id: advertiserId })) {
        const daily = String(a.budget_mode ?? "").toUpperCase() === "BUDGET_MODE_DAY" && num(a.budget) > 0;
        out.push({ externalId: String(a.adgroup_id), campaignExternalId: String(a.campaign_id), name: String(a.adgroup_name ?? ""), status: status(a), optimizationGoal: a.optimization_goal ? String(a.optimization_goal) : null, dailyBudgetMinor: daily ? minor(a.budget) : null });
      }
    }
    return out;
  }

  private async loadAds() {
    if (this.adsCache) return this.adsCache;
    const out: (NormalizedAd & { videoId: string | null; imageIds: string[]; advertiserId: string })[] = [];
    for (const advertiserId of this.creds.advertiserIds) {
      const rows = await this.all<Rec>("ad/get/", { advertiser_id: advertiserId });
      const videoIds = [...new Set(rows.map((r) => (r.video_id ? String(r.video_id) : null)).filter((v): v is string => Boolean(v)))];
      const covers = new Map<string, string | null>();
      // thumbnails need the Creative Management permission; without it the ads keep no thumbnail
      for (let i = 0; i < videoIds.length; i += 60) {
        const info = await this.get<{ list?: Rec[] }>("file/video/ad/info/", { advertiser_id: advertiserId, video_ids: videoIds.slice(i, i + 60) }).catch((e: unknown) => {
          if (e instanceof IntegrationError && e.code === "permission") return { list: [] as Rec[] };
          throw e;
        });
        for (const v of info.list ?? []) covers.set(String(v.video_id), v.video_cover_url ? String(v.video_cover_url) : v.poster_url ? String(v.poster_url) : null);
      }
      for (const a of rows) {
        const landing = a.landing_page_url ? String(a.landing_page_url) : null;
        const videoId = a.video_id ? String(a.video_id) : null;
        out.push({ externalId: String(a.ad_id), adSetExternalId: a.adgroup_id ? String(a.adgroup_id) : null, campaignExternalId: String(a.campaign_id), name: String(a.ad_name ?? ""), status: status(a), format: formatOf(a.ad_format ?? (videoId ? "SINGLE_VIDEO" : "")), headline: a.display_name ? String(a.display_name) : null, body: a.ad_text ? String(a.ad_text) : null, finalUrl: landing, urlTags: urlParams(landing), thumbnailUrl: videoId ? (covers.get(videoId) ?? null) : null, videoId, imageIds: Array.isArray(a.image_ids) ? a.image_ids.map(String) : [], advertiserId });
      }
    }
    this.adsCache = out;
    return out;
  }

  /** Ads with their copy (`ad_text`), landing URL (where the UTM template lives), video and thumbnail. */
  async fetchAds(): Promise<NormalizedAd[]> {
    return (await this.loadAds()).map(({ videoId: _v, imageIds: _i, advertiserId: _a, ...ad }) => ad);
  }

  /** The video (with its id) and images of each ad, so the creative pages can show them; TikTok reports no metrics per asset. */
  async fetchAssets(): Promise<NormalizedAdAsset[]> {
    const out: NormalizedAdAsset[] = [];
    for (const a of await this.loadAds()) {
      const base = { adExternalId: a.externalId, adSetExternalId: a.adSetExternalId, campaignExternalId: a.campaignExternalId, text: null, performanceLabel: null };
      if (a.videoId) out.push({ ...base, assetExternalId: a.videoId, type: "video", fieldType: "video", url: a.thumbnailUrl });
      for (const img of a.imageIds) out.push({ ...base, assetExternalId: img, type: "image", fieldType: "image", url: null });
    }
    return out;
  }

  private entityRow(level: AdEntityMetricLevel, entityExternalId: string, d: Rec, m: Rec, ids: { campaign: string; adSet: string | null; ad?: string | null }): NormalizedEntityMetric {
    return { level, entityExternalId, campaignExternalId: ids.campaign, adSetExternalId: ids.adSet, adExternalId: ids.ad ?? null, date: dayOf(d.stat_time_day), spendMinor: minor(m.spend), impressions: num(m.impressions), clicks: num(m.clicks), reach: num(m.reach), conversions: num(m.complete_payment ?? m.conversion), conversionValueMinor: minor(m.total_complete_payment_rate), videoViews3s: num(m.video_watched_2s), videoCompletions: num(m.video_views_p100) };
  }

  /**
   * Daily reporting per ad group or ad (TikTok's 2-second views stand in for 3-second views). Rows
   * whose campaign the API does not name (no attribute metric) fall back to the structure.
   */
  async fetchEntityMetrics(level: AdEntityMetricLevel, window: { since: string; until: string }): Promise<NormalizedEntityMetric[]> {
    if (level === "ad_set") {
      const rows = await this.report("AUCTION_ADGROUP", "adgroup_id", ["campaign_id"], window);
      const parents = rows.some((r) => !r.metrics.campaign_id) ? new Map((await this.fetchAdSets()).map((s) => [s.externalId, s.campaignExternalId])) : new Map<string, string>();
      return rows.map(({ dimensions: d, metrics: m }) => {
        const id = String(d.adgroup_id);
        return this.entityRow(level, id, d, m, { campaign: m.campaign_id ? String(m.campaign_id) : (parents.get(id) ?? ""), adSet: id });
      });
    }
    if (level === "ad") {
      const rows = await this.report("AUCTION_AD", "ad_id", ["campaign_id", "adgroup_id"], window);
      const ads = rows.some((r) => !r.metrics.campaign_id || !r.metrics.adgroup_id) ? new Map((await this.loadAds()).map((a) => [a.externalId, a])) : new Map<string, NormalizedAd>();
      return rows.map(({ dimensions: d, metrics: m }) => {
        const id = String(d.ad_id);
        const known = ads.get(id);
        return this.entityRow(level, id, d, m, { campaign: m.campaign_id ? String(m.campaign_id) : (known?.campaignExternalId ?? ""), adSet: m.adgroup_id ? String(m.adgroup_id) : (known?.adSetExternalId ?? null), ad: id });
      });
    }
    return [];
  }
}

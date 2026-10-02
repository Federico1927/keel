import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AdEntityMetricLevel, type AdEntityStatus, type AdsCapabilities, type AdsPlatform, type ConnectionTest, type NormalizedAd, type NormalizedAdAsset, type NormalizedAdMetric, type NormalizedAdSet, type NormalizedCampaign, type NormalizedEntityMetric } from "../types";

export const META_API_VERSION = "v21.0";
/** Marketing API permissions the installer must request for the system user / app. */
export const META_REQUIRED_PERMISSIONS = ["ads_read", "ads_management", "business_management"];

export interface MetaCredentials {
  accessToken: string;
  /** With or without the `act_` prefix. */
  adAccountId: string;
}

type Rec = Record<string, unknown>;
interface GraphPage<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message: string; code: number; error_subcode?: number; type?: string };
}

export function mapMetaError(e: { message: string; code: number; error_subcode?: number }): IntegrationError {
  if (e.code === 190) return new IntegrationError("token_expired", e.message);
  if (e.code === 17 || e.code === 32 || e.code === 613 || e.code === 4 || e.code === 80004) return new IntegrationError("rate_limited", e.message, 60_000);
  if (e.code === 10 || e.code === 200 || e.code === 294) return new IntegrationError("permission", e.message);
  if (e.code === 100) return new IntegrationError("invalid_request", e.message);
  return new IntegrationError("unknown", e.message);
}

function actionValue(actions: Rec[] | undefined, types: string[]): number {
  if (!actions) return 0;
  for (const t of types) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
}

const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const entityStatus = (r: Rec): AdEntityStatus => {
  const s = String(r.effective_status ?? r.status ?? "").toUpperCase();
  return s === "ACTIVE" ? "active" : s.includes("PAUSED") || s === "PENDING_REVIEW" || s === "IN_PROCESS" || s === "WITH_ISSUES" ? "paused" : "archived";
};
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

/**
 * Asset breakdowns: one per insights call (Meta refuses two asset breakdowns together). They exist only
 * for dynamic creative / Advantage+ creative ads [to verify]; other ads return no rows.
 */
export const META_ASSET_BREAKDOWNS = [
  { breakdown: "body_asset", type: "text", fieldType: "body" },
  { breakdown: "title_asset", type: "text", fieldType: "title" },
  { breakdown: "image_asset", type: "image", fieldType: "image" },
  { breakdown: "video_asset", type: "video", fieldType: "video" },
] as const;

/** Live Meta Marketing API adapter (campaigns, ad sets, ads, asset breakdowns, daily insights, pause/resume of campaigns and ads). */
export class MetaAdsPlatform implements AdsPlatform {
  readonly provider = "meta";
  readonly capabilities: AdsCapabilities = { supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: true, supportsAdWrites: true };
  readonly http: HttpClient;
  private readonly base: string;
  private readonly account: string;

  constructor(private readonly creds: MetaCredentials, opts: HttpOptions & { apiVersion?: string } = {}) {
    this.http = new HttpClient({ minIntervalMs: 200, ...opts });
    this.base = `https://graph.facebook.com/${opts.apiVersion ?? META_API_VERSION}`;
    this.account = creds.adAccountId.startsWith("act_") ? creds.adAccountId : `act_${creds.adAccountId}`;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<GraphPage<T>> {
    const u = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("access_token", this.creds.accessToken);
    const res = await this.http.request<GraphPage<T> & { error?: GraphPage<T>["error"] }>(u.toString());
    if (res.json?.error) throw mapMetaError(res.json.error);
    const usage = res.headers.get("x-business-use-case-usage") ?? res.headers.get("x-ad-account-usage");
    if (usage) {
      try {
        const parsed = JSON.parse(usage) as Record<string, { call_count?: number; total_time?: number; total_cputime?: number; estimated_time_to_regain_access?: number }[] | { acc_id_util_pct?: number }>;
        const pct = Math.max(...Object.values(parsed).flatMap((v) => (Array.isArray(v) ? v.map((x) => Math.max(x.call_count ?? 0, x.total_time ?? 0, x.total_cputime ?? 0)) : [Number((v as { acc_id_util_pct?: number }).acc_id_util_pct ?? 0)])));
        if (pct >= 95) throw new IntegrationError("rate_limited", `Meta usage at ${pct}%`, 60_000);
      } catch (e) {
        if (e instanceof IntegrationError) throw e;
      }
    }
    return res.json;
  }

  private async all<T>(path: string, params: Record<string, string>, max = 50): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < max; i++) {
      const page = await this.get<T>(path, after ? { ...params, after } : params);
      out.push(...(page.data ?? []));
      after = page.paging?.cursors?.after;
      if (!after || !page.paging?.next) break;
    }
    return out;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await this.get<Rec>(this.account, { fields: "name,account_id,currency,account_status" });
      const acc = res as unknown as Rec;
      const perms = await this.get<{ permission: string; status: string }>("me/permissions", {});
      const granted = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
      return { ok: true, accountName: String(acc.name ?? ""), accountId: String(acc.account_id ?? this.account), scopes: granted, missingScopes: META_REQUIRED_PERMISSIONS.filter((p) => granted.length && !granted.includes(p)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async fetchCampaigns(): Promise<NormalizedCampaign[]> {
    const rows = await this.all<Rec>(`${this.account}/campaigns`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,account_id", limit: "200" });
    return rows.map((c) => {
      const status = String(c.effective_status ?? c.status ?? "").toUpperCase();
      return { externalId: String(c.id), accountExternalId: this.account, name: String(c.name ?? ""), status: status === "ACTIVE" ? "active" : status === "PAUSED" || status === "CAMPAIGN_PAUSED" || status === "ADSET_PAUSED" ? "paused" : "archived", objective: c.objective ? String(c.objective) : null, dailyBudgetMinor: c.daily_budget ? Number(c.daily_budget) : null, currency: null, platformCreatedAt: c.created_time ? new Date(String(c.created_time)) : null };
    });
  }

  /** Daily insights at campaign level; spend arrives in account currency major units and is stored in minor units. */
  async fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]> {
    const rows = await this.all<Rec>(`${this.account}/insights`, { level: "campaign", time_increment: "1", time_range: JSON.stringify({ since: window.since, until: window.until }), fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,date_start", limit: "500" });
    return rows.map((r) => ({ campaignExternalId: String(r.campaign_id), date: String(r.date_start), spendMinor: Math.round(Number(r.spend ?? 0) * 100), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), viewContent: actionValue(r.actions as Rec[], ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"]), purchases: actionValue(r.actions as Rec[], ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]), purchaseValueMinor: Math.round(actionValue(r.action_values as Rec[], ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]) * 100) }));
  }

  async setCampaignStatus(externalId: string, status: "active" | "paused"): Promise<void> {
    await this.postStatus(externalId, status);
  }

  private async postStatus(objectId: string, status: "active" | "paused"): Promise<void> {
    const u = new URL(`${this.base}/${objectId}`);
    const body = new URLSearchParams({ status: status === "active" ? "ACTIVE" : "PAUSED", access_token: this.creds.accessToken }).toString();
    const res = await this.http.request<{ success?: boolean; error?: { message: string; code: number } }>(u.toString(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (res.json?.error) throw mapMetaError(res.json.error);
    if (res.json?.success === false) throw new IntegrationError("invalid_request", "Meta refused the status change");
  }

  async setAdStatus(ad: { adExternalId: string }, status: "active" | "paused"): Promise<void> {
    await this.postStatus(ad.adExternalId, status);
  }

  async fetchAdSets(): Promise<NormalizedAdSet[]> {
    const rows = await this.all<Rec>(`${this.account}/adsets`, { fields: "id,name,status,effective_status,campaign_id,optimization_goal,daily_budget", limit: "200" });
    return rows.map((a) => ({ externalId: String(a.id), campaignExternalId: String(a.campaign_id), name: String(a.name ?? ""), status: entityStatus(a), optimizationGoal: a.optimization_goal ? String(a.optimization_goal) : null, dailyBudgetMinor: a.daily_budget ? Number(a.daily_budget) : null }));
  }

  /** Ads with their creative: copy, URL parameters (where the UTM template lives), format. */
  async fetchAds(): Promise<NormalizedAd[]> {
    const rows = await this.all<Rec>(`${this.account}/ads`, { fields: "id,name,status,effective_status,adset_id,campaign_id,creative{id,title,body,object_type,thumbnail_url,url_tags,link_url,asset_feed_spec{bodies,titles,link_urls}}", limit: "200" });
    return rows.map((a) => {
      const c = rec(a.creative);
      const feed = rec(c.asset_feed_spec);
      const bodies = Array.isArray(feed.bodies) ? feed.bodies.map((b) => String(rec(b).text ?? "")).filter(Boolean) : [];
      const titles = Array.isArray(feed.titles) ? feed.titles.map((b) => String(rec(b).text ?? "")).filter(Boolean) : [];
      const links = Array.isArray(feed.link_urls) ? feed.link_urls.map((l) => String(rec(l).website_url ?? "")).filter(Boolean) : [];
      const type = String(c.object_type ?? "").toUpperCase();
      return { externalId: String(a.id), adSetExternalId: a.adset_id ? String(a.adset_id) : null, campaignExternalId: String(a.campaign_id), name: String(a.name ?? ""), status: entityStatus(a), format: type === "VIDEO" ? "video" : type === "SHARE" || type === "PHOTO" ? "image" : type.includes("CAROUSEL") ? "carousel" : "other", headline: (c.title ? String(c.title) : titles[0]) ?? null, body: (c.body ? String(c.body) : bodies.join(" ")) || null, finalUrl: (c.link_url ? String(c.link_url) : links[0]) ?? null, urlTags: c.url_tags ? String(c.url_tags) : null, thumbnailUrl: c.thumbnail_url ? String(c.thumbnail_url) : null };
    });
  }

  private assetOf(r: Rec, b: (typeof META_ASSET_BREAKDOWNS)[number]): NormalizedAdAsset | null {
    const a = rec(r[b.breakdown]);
    if (!a.id) return null;
    return { assetExternalId: String(a.id), adExternalId: r.ad_id ? String(r.ad_id) : null, adSetExternalId: r.adset_id ? String(r.adset_id) : null, campaignExternalId: String(r.campaign_id), type: b.type, fieldType: b.fieldType, text: a.text ? String(a.text) : null, url: a.url ? String(a.url) : a.thumbnail_url ? String(a.thumbnail_url) : null, performanceLabel: null };
  }

  /** Assets of dynamic-creative ads, read from the asset breakdowns of the last 90 days. */
  async fetchAssets(): Promise<NormalizedAdAsset[]> {
    const out = new Map<string, NormalizedAdAsset>();
    for (const b of META_ASSET_BREAKDOWNS) {
      const rows = await this.all<Rec>(`${this.account}/insights`, { level: "ad", breakdowns: b.breakdown, date_preset: "last_90d", fields: "ad_id,adset_id,campaign_id,impressions", limit: "500" });
      for (const r of rows) {
        const a = this.assetOf(r, b);
        if (a) out.set(`${a.adExternalId}|${a.fieldType}|${a.assetExternalId}`, a);
      }
    }
    return [...out.values()];
  }

  private insightRow(level: AdEntityMetricLevel, r: Rec, entityExternalId: string, extra: Partial<NormalizedEntityMetric> = {}): NormalizedEntityMetric {
    const actions = r.actions as Rec[] | undefined;
    return { level, entityExternalId, campaignExternalId: String(r.campaign_id), adSetExternalId: r.adset_id ? String(r.adset_id) : null, adExternalId: r.ad_id ? String(r.ad_id) : null, date: String(r.date_start), spendMinor: Math.round(Number(r.spend ?? 0) * 100), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), reach: Number(r.reach ?? 0), conversions: actionValue(actions, PURCHASE), conversionValueMinor: Math.round(actionValue(r.action_values as Rec[], PURCHASE) * 100), videoViews3s: actionValue(actions, ["video_view"]), videoCompletions: actionValue(r.video_p100_watched_actions as Rec[], ["video_view"]), ...extra };
  }

  /** Daily insights per ad set, ad or asset (asset rows come from the four breakdowns); Meta has no keywords or search terms. */
  async fetchEntityMetrics(level: AdEntityMetricLevel, window: { since: string; until: string }): Promise<NormalizedEntityMetric[]> {
    if (level === "keyword" || level === "search_term") return [];
    const base = { time_increment: "1", time_range: JSON.stringify({ since: window.since, until: window.until }), limit: "500" };
    if (level === "ad_set") {
      const rows = await this.all<Rec>(`${this.account}/insights`, { ...base, level: "adset", fields: "adset_id,campaign_id,spend,impressions,clicks,reach,actions,action_values,date_start" });
      return rows.map((r) => this.insightRow(level, r, String(r.adset_id)));
    }
    if (level === "ad") {
      const rows = await this.all<Rec>(`${this.account}/insights`, { ...base, level: "ad", fields: "ad_id,adset_id,campaign_id,spend,impressions,clicks,reach,actions,action_values,video_p100_watched_actions,date_start" });
      return rows.map((r) => this.insightRow(level, r, String(r.ad_id)));
    }
    const out: NormalizedEntityMetric[] = [];
    for (const b of META_ASSET_BREAKDOWNS) {
      const rows = await this.all<Rec>(`${this.account}/insights`, { ...base, level: "ad", breakdowns: b.breakdown, fields: "ad_id,adset_id,campaign_id,spend,impressions,clicks,actions,action_values,date_start" });
      for (const r of rows) {
        const a = this.assetOf(r, b);
        if (a) out.push(this.insightRow(level, r, a.assetExternalId, { fieldType: b.fieldType, reach: 0 }));
      }
    }
    return out;
  }
}

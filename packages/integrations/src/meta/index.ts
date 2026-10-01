import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AdsPlatform, type ConnectionTest, type NormalizedAdMetric, type NormalizedCampaign } from "../types";

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

/** Live Meta Marketing API adapter (campaigns + daily insights + pause/resume). */
export class MetaAdsPlatform implements AdsPlatform {
  readonly provider = "meta";
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
    const u = new URL(`${this.base}/${externalId}`);
    const body = new URLSearchParams({ status: status === "active" ? "ACTIVE" : "PAUSED", access_token: this.creds.accessToken }).toString();
    const res = await this.http.request<{ success?: boolean; error?: { message: string; code: number } }>(u.toString(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (res.json?.error) throw mapMetaError(res.json.error);
    if (res.json?.success === false) throw new IntegrationError("invalid_request", "Meta refused the status change");
  }
}

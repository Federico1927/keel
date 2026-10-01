import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AdsPlatform, type ConnectionTest, type NormalizedAdMetric, type NormalizedCampaign } from "../types";

export const GOOGLE_ADS_API_VERSION = "v18";
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

/** Live Google Ads adapter: read-only in the MVP (campaigns + daily metrics via GAQL searchStream). */
export class GoogleAdsPlatform implements AdsPlatform {
  readonly provider = "google";
  readonly http: HttpClient;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly base: string;

  constructor(private readonly creds: GoogleAdsCredentials, opts: HttpOptions & { apiVersion?: string; accessToken?: string } = {}) {
    this.http = new HttpClient({ minIntervalMs: 100, ...opts });
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
}

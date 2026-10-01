import { createRng, type Rng } from "../rng";
import { IntegrationError, type AdsPlatform, type ConnectionTest, type NormalizedAdMetric, type NormalizedCampaign } from "../types";
import { FailureScript } from "./failures";

export interface MockAdsOptions {
  provider: "meta" | "google";
  seed?: number;
  currency: string;
  campaigns: NormalizedCampaign[];
  /** Approximate daily spend per campaign, minor units. */
  dailySpendMinor?: number;
  readOnly?: boolean;
}

export class MockAdsPlatform implements AdsPlatform {
  readonly provider: string;
  readonly failures = new FailureScript();
  private rng: Rng;
  private statuses = new Map<string, "active" | "paused" | "archived">();
  readonly writeLog: { op: string; args: unknown }[] = [];

  constructor(private readonly opts: MockAdsOptions) {
    this.provider = opts.provider;
    this.rng = createRng(opts.seed ?? 7);
    for (const c of opts.campaigns) this.statuses.set(c.externalId, c.status);
  }
  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: `Mock ${this.opts.provider} account`, accountId: this.opts.provider === "meta" ? "act_mock" : "123-456-7890" };
  }
  async fetchCampaigns(): Promise<NormalizedCampaign[]> {
    this.failures.check();
    return this.opts.campaigns.map((c) => ({ ...c, status: this.statuses.get(c.externalId) ?? c.status }));
  }
  async fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]> {
    this.failures.check();
    const out: NormalizedAdMetric[] = [];
    const start = new Date(window.since + "T00:00:00Z");
    const end = new Date(window.until + "T00:00:00Z");
    for (const c of this.opts.campaigns) {
      if ((this.statuses.get(c.externalId) ?? c.status) !== "active") continue;
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const spend = Math.round((this.opts.dailySpendMinor ?? 5000) * (0.6 + this.rng.next() * 0.8));
        const impressions = Math.round(spend / 8);
        const clicks = Math.round(impressions * (0.01 + this.rng.next() * 0.02));
        out.push({ campaignExternalId: c.externalId, date: d.toISOString().slice(0, 10), spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.6), purchases: Math.round(clicks * 0.03), purchaseValueMinor: Math.round(clicks * 0.03 * 6500) });
      }
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
}

import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { GoogleAdsPlatform } from "./index";

const token = { access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" };
const campaignsStream = [{ results: [{ campaign: { resourceName: "customers/1234567890/campaigns/900000001", id: "900000001", name: "Brand – Search", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "25000000" }, customer: { currencyCode: "EUR" } }, { campaign: { id: "900000002", name: "Shopping – All", status: "PAUSED", advertisingChannelType: "SHOPPING" }, campaignBudget: { amountMicros: "10000000" }, customer: { currencyCode: "EUR" } }] }];
const metricsStream = [{ results: [{ campaign: { id: "900000001" }, segments: { date: "2026-09-28" }, metrics: { costMicros: "18450000", impressions: "4200", clicks: "210", conversions: 6.0, conversionsValue: 480.5 } }] }, { results: [{ campaign: { id: "900000002" }, segments: { date: "2026-09-28" }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 0, conversionsValue: 0 } }] }];

describe("google ads adapter", () => {
  const make = (routes: Parameters<typeof fixtureFetch>[0]) => new GoogleAdsPlatform({ developerToken: "dev", clientId: "cid", clientSecret: "cs", refreshToken: "rt", customerId: "123-456-7890", loginCustomerId: "999-999-9999" }, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });

  it("refreshes the token once, sends developer and login headers, maps campaigns and metrics", async () => {
    let tokenCalls = 0;
    const p = make([
      { match: (u) => u.includes("oauth2.googleapis.com/token"), body: () => (tokenCalls++, token) },
      { match: (u, i) => u.includes("googleAds:searchStream") && (i?.body ?? "").includes("FROM campaign WHERE campaign.status"), body: campaignsStream },
      { match: (u, i) => u.includes("googleAds:searchStream") && (i?.body ?? "").includes("segments.date BETWEEN"), body: metricsStream },
    ]);
    const cs = await p.fetchCampaigns();
    expect(cs[0]).toMatchObject({ externalId: "900000001", status: "active", dailyBudgetMinor: 2500, currency: "EUR", accountExternalId: "1234567890" });
    const m = await p.fetchDailyMetrics({ since: "2026-09-28", until: "2026-09-28" });
    expect(m[0]).toMatchObject({ campaignExternalId: "900000001", spendMinor: 1845, impressions: 4200, clicks: 210, purchases: 6, purchaseValueMinor: 48050 });
    expect(m).toHaveLength(2);
    expect(tokenCalls).toBe(1);
    expect(p.http.calls.some((c) => c.url.includes("/customers/1234567890/googleAds:searchStream"))).toBe(true);
    await expect(p.setCampaignStatus()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("surfaces permission errors", async () => {
    const p = make([
      { match: (u) => u.includes("oauth2.googleapis.com/token"), body: token },
      { match: (u) => u.includes("googleAds:searchStream"), status: 403, body: { error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } } },
    ]);
    await expect(p.fetchCampaigns()).rejects.toMatchObject({ code: "permission" });
  });
});

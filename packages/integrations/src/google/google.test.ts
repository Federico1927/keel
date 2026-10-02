import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { GOOGLE_ADS_API_BASE, GOOGLE_ADS_API_VERSION, GOOGLE_ADS_MIN_SUPPORTED_VERSION, GoogleAdsPlatform, googleAdsVersionNumber } from "./index";
import * as F from "./__fixtures__/entities";

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

describe("google ads API version", () => {
  it("reads the version from one supported constant", () => {
    expect(GOOGLE_ADS_API_VERSION).toMatch(/^v\d+$/);
    expect(googleAdsVersionNumber()).toBeGreaterThanOrEqual(GOOGLE_ADS_MIN_SUPPORTED_VERSION);
    expect(googleAdsVersionNumber("v18")).toBeLessThan(GOOGLE_ADS_MIN_SUPPORTED_VERSION);
    expect(GOOGLE_ADS_API_BASE).toBe(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`);
  });
});

describe("google ads below the campaign (fixtures)", () => {
  const routes = (extra: Parameters<typeof fixtureFetch>[0]) => [{ match: (u: string) => u.includes("oauth2.googleapis.com/token"), body: token }, ...extra];
  const make = (extra: Parameters<typeof fixtureFetch>[0], writeEnabled = false) => new GoogleAdsPlatform({ developerToken: "dev", clientId: "cid", clientSecret: "cs", refreshToken: "rt", customerId: "123-456-7890" }, { fetchImpl: fixtureFetch(routes(extra)), sleep: async () => undefined, minIntervalMs: 0, writeEnabled });
  const gaql = (resource: string, metrics = false) => (u: string, i?: { body?: string }) => u.includes("googleAds:searchStream") && (i?.body ?? "").includes(`FROM ${resource} `) && (i?.body ?? "").includes("segments.date BETWEEN") === metrics;
  const window = { since: "2026-09-28", until: "2026-09-28" };

  it("every request goes to the versioned base URL", async () => {
    const p = make([{ match: gaql("ad_group"), body: F.adGroupsStream }]);
    await p.fetchAdSets();
    expect(p.http.calls.filter((c) => c.url.includes("googleads")).every((c) => c.url.startsWith(`${GOOGLE_ADS_API_BASE}/customers/1234567890/`))).toBe(true);
  });

  it("maps ad groups, RSAs, assets with performance labels and keywords with quality score", async () => {
    const p = make([
      { match: gaql("ad_group"), body: F.adGroupsStream },
      { match: gaql("ad_group_ad"), body: F.adsStream },
      { match: gaql("ad_group_ad_asset_view"), body: F.assetsStream },
      { match: gaql("keyword_view"), body: F.keywordsStream },
    ]);
    expect(await p.fetchAdSets()).toEqual([
      { externalId: "150000001", campaignExternalId: "900000001", name: "Linen shirts – exact", status: "active", optimizationGoal: "SEARCH_STANDARD", dailyBudgetMinor: null },
      { externalId: "150000002", campaignExternalId: "900000001", name: "Linen – broad", status: "paused", optimizationGoal: "SEARCH_STANDARD", dailyBudgetMinor: null },
    ]);
    const [ad] = await p.fetchAds();
    expect(ad).toMatchObject({ externalId: "690000001", adSetExternalId: "150000001", format: "text", headline: "Natural linen shirts | Free returns", body: "Breathable linen, made in Portugal.", finalUrl: "https://shop.example/collections/linen" });
    expect(ad!.urlTags).toContain("utm_content={creative}");
    const assets = await p.fetchAssets();
    expect(assets.map((a) => [a.assetExternalId, a.fieldType, a.performanceLabel, a.adExternalId])).toEqual([["880000001", "headline", "BEST", "690000001"], ["880000002", "description", "LOW", "690000001"]]);
    const kws = await p.fetchKeywords();
    expect(kws[0]).toEqual({ externalId: "150000001~301", adSetExternalId: "150000001", campaignExternalId: "900000001", text: "linen shirt", matchType: "exact", qualityScore: 8, status: "active", negative: false });
    expect(kws[1]).toMatchObject({ matchType: "broad", qualityScore: null, status: "paused" });
  });

  it("reads daily metrics for every level, search terms with the triggering keyword", async () => {
    const p = make([
      { match: gaql("ad_group", true), body: F.adGroupMetricsStream },
      { match: gaql("ad_group_ad", true), body: F.adMetricsStream },
      { match: gaql("ad_group_ad_asset_view", true), body: F.assetMetricsStream },
      { match: gaql("keyword_view", true), body: F.keywordMetricsStream },
      { match: gaql("search_term_view", true), body: F.searchTermMetricsStream },
    ]);
    expect(await p.fetchEntityMetrics("ad_set", window)).toEqual([expect.objectContaining({ level: "ad_set", entityExternalId: "150000001", spendMinor: 1845, conversions: 6, conversionValueMinor: 48050 })]);
    expect((await p.fetchEntityMetrics("ad", window))[0]).toMatchObject({ entityExternalId: "690000001", adSetExternalId: "150000001", spendMinor: 1845 });
    expect((await p.fetchEntityMetrics("asset", window))[0]).toMatchObject({ entityExternalId: "880000001", adExternalId: "690000001", fieldType: "headline", spendMinor: 900 });
    expect((await p.fetchEntityMetrics("keyword", window))[0]).toMatchObject({ entityExternalId: "150000001~301", spendMinor: 1200, conversions: 5 });
    const terms = await p.fetchEntityMetrics("search_term", window);
    expect(terms[0]).toMatchObject({ entityExternalId: "linen shirt", keywordExternalId: "150000001~301", keywordText: "linen shirt", matchType: "exact", termStatus: "none", spendMinor: 800 });
    expect(terms[1]).toMatchObject({ entityExternalId: "free linen shirt", termStatus: "excluded", conversions: 0 });
    expect(p.http.calls.some((c) => (c.body ?? "").includes("segments.date BETWEEN '2026-09-28' AND '2026-09-28'"))).toBe(true);
  });

  it("stays read-only without the write scope; with it, pauses ads and adds negative keywords", async () => {
    const ro = make([]);
    expect(ro.capabilities.supportsAdWrites).toBe(false);
    await expect(ro.addNegativeKeywords([{ campaignExternalId: "900000001", text: "free linen shirt", matchType: "exact" }])).rejects.toMatchObject({ code: "unsupported" });
    await expect(ro.setAdStatus({ adExternalId: "690000001", adSetExternalId: "150000001" }, "paused")).rejects.toMatchObject({ code: "unsupported" });
    const rw = make([
      { match: (u) => u.endsWith("/campaignCriteria:mutate"), body: { results: [{ resourceName: "customers/1234567890/campaignCriteria/900000001~1" }] } },
      { match: (u) => u.endsWith("/adGroupAds:mutate"), body: { results: [{ resourceName: "customers/1234567890/adGroupAds/150000001~690000001" }] } },
    ], true);
    expect(await rw.addNegativeKeywords([{ campaignExternalId: "900000001", text: "free linen shirt", matchType: "exact" }])).toEqual({ created: 1 });
    const body = JSON.parse(rw.http.calls.find((c) => c.url.endsWith("/campaignCriteria:mutate"))!.body!);
    expect(body.operations[0].create).toEqual({ campaign: "customers/1234567890/campaigns/900000001", negative: true, keyword: { text: "free linen shirt", matchType: "EXACT" } });
    await rw.setAdStatus({ adExternalId: "690000001", adSetExternalId: "150000001" }, "paused");
    expect(JSON.parse(rw.http.calls.at(-1)!.body!).operations[0]).toEqual({ updateMask: "status", update: { resourceName: "customers/1234567890/adGroupAds/150000001~690000001", status: "PAUSED" } });
  });

  it("maps quota errors to rate limits", async () => {
    const p = make([{ match: (u) => u.includes("googleAds:searchStream"), body: { error: { message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } } }]);
    await expect(p.fetchEntityMetrics("search_term", window)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

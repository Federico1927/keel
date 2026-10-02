import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { TIKTOK_API_BASE, TiktokAdsPlatform, exchangeTiktokAuthCode, mapTiktokError, tiktokAuthorizeUrl } from "./index";
import * as F from "./__fixtures__/responses";

type Routes = Parameters<typeof fixtureFetch>[0];
const creds = { appId: "app-1", appSecret: "secret-1", accessToken: "act.example-long-lived-token", advertiserIds: ["7100000000000000001", "7100000000000000002"] };
const make = (routes: Routes, advertiserIds = creds.advertiserIds) => new TiktokAdsPlatform({ ...creds, advertiserIds }, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });
const q = (url: string) => new URL(url).searchParams;
const path = (url: string, p: string) => url.startsWith(`${TIKTOK_API_BASE}/${p}`);
const window = { since: "2026-09-28", until: "2026-09-29" };

describe("tiktok oauth", () => {
  it("builds the advertiser authorization URL and exchanges the auth code for a long-lived token and advertisers", async () => {
    const url = new URL(tiktokAuthorizeUrl("app-1", "https://hullwise.example/api/integrations/tiktok/oauth/callback", "st4te"));
    expect(url.origin + url.pathname).toBe("https://business-api.tiktok.com/portal/auth");
    expect(url.searchParams.get("app_id")).toBe("app-1");
    expect(url.searchParams.get("state")).toBe("st4te");
    let body = "";
    const out = await exchangeTiktokAuthCode({ appId: "app-1", appSecret: "secret-1", authCode: "code-1" }, { fetchImpl: fixtureFetch([{ match: (u, i) => path(u, "oauth2/access_token/") && i?.method === "POST", body: (_u: string, i?: { body?: string }) => ((body = i?.body ?? ""), F.accessToken) }]), sleep: async () => undefined });
    expect(out).toEqual({ accessToken: "act.example-long-lived-token", advertiserIds: ["7100000000000000001", "7100000000000000002"], scope: ["4", "5", "6", "14"] });
    expect(JSON.parse(body)).toEqual({ app_id: "app-1", secret: "secret-1", auth_code: "code-1" });
    await expect(exchangeTiktokAuthCode({ appId: "a", appSecret: "b", authCode: "used" }, { fetchImpl: fixtureFetch([{ match: () => true, body: F.authCodeUsed }]) })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("tiktok adapter (fixtures)", () => {
  it("declares no keywords, search terms or asset reporting, and writes to ads", () => {
    expect(make([]).capabilities).toEqual({ supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: false, supportsAdWrites: true });
  });

  it("tests the connection with every authorized advertiser and reports a readable error otherwise", async () => {
    const p = make([{ match: (u) => path(u, "advertiser/info/"), body: F.advertiserInfo }]);
    expect(await p.testConnection()).toMatchObject({ ok: true, accountName: "Example Apparel EU, Example Apparel Outlet", accountId: "7100000000000000001,7100000000000000002" });
    expect(p.http.calls[0]!.url).toContain(encodeURIComponent('["7100000000000000001","7100000000000000002"]'));
    const expired = make([{ match: () => true, body: F.tokenExpired }]);
    expect(await expired.testConnection()).toEqual({ ok: false, error: "The access token is invalid or has been revoked." });
  });

  it("maps campaigns of several advertisers across pages: status, daily budget in minor units, currency", async () => {
    const p = make([
      { match: (u) => path(u, "advertiser/info/"), body: F.advertiserInfo },
      { match: (u) => path(u, "campaign/get/") && q(u).get("advertiser_id") === "7100000000000000001" && q(u).get("page") === "1", body: F.campaignsAdv1Page1 },
      { match: (u) => path(u, "campaign/get/") && q(u).get("advertiser_id") === "7100000000000000001" && q(u).get("page") === "2", body: F.campaignsAdv1Page2 },
      { match: (u) => path(u, "campaign/get/") && q(u).get("advertiser_id") === "7100000000000000002", body: F.campaignsAdv2 },
    ]);
    const cs = await p.fetchCampaigns();
    expect(cs.map((c) => [c.externalId, c.status, c.dailyBudgetMinor, c.accountExternalId])).toEqual([
      ["1780000000000101", "active", 8050, "7100000000000000001"],
      ["1780000000000102", "paused", null, "7100000000000000001"],
      ["1780000000000103", "archived", 2000, "7100000000000000001"],
      ["1780000000000201", "active", 3000, "7100000000000000002"],
    ]);
    expect(cs[0]).toMatchObject({ name: "Linen drop – Spark Ads", objective: "WEB_CONVERSIONS", currency: "EUR", platformCreatedAt: new Date("2026-06-01T09:30:00Z") });
    expect(p.http.calls.every((c) => !c.url.includes("access_token"))).toBe(true);
  });

  it("reads daily campaign reporting across pages, converting spend and purchase value to minor units", async () => {
    const p = make([
      { match: (u) => path(u, "report/integrated/get/") && q(u).get("page") === "1", body: F.campaignReportDay1 },
      { match: (u) => path(u, "report/integrated/get/") && q(u).get("page") === "2", body: F.campaignReportDay2 },
    ], ["7100000000000000001"]);
    const rows = await p.fetchDailyMetrics(window);
    expect(rows).toEqual([
      { campaignExternalId: "1780000000000101", date: "2026-09-28", spendMinor: 6137, impressions: 18450, clicks: 212, viewContent: 0, purchases: 7, purchaseValueMinor: 49860 },
      { campaignExternalId: "1780000000000101", date: "2026-09-29", spendMinor: 5800, impressions: 17020, clicks: 190, viewContent: 0, purchases: 0, purchaseValueMinor: 0 },
    ]);
    const params = q(p.http.calls[0]!.url);
    expect(params.get("data_level")).toBe("AUCTION_CAMPAIGN");
    expect(JSON.parse(params.get("dimensions")!)).toEqual(["campaign_id", "stat_time_day"]);
    expect(params.get("start_date")).toBe("2026-09-28");
    expect(params.get("end_date")).toBe("2026-09-29");
  });

  it("splits a 90-day backfill into windows the reporting API accepts", async () => {
    const p = make([{ match: (u) => path(u, "report/integrated/get/"), body: F.emptyReport }], ["7100000000000000001"]);
    await p.fetchDailyMetrics({ since: "2026-07-01", until: "2026-09-28" });
    const ranges = p.http.calls.map((c) => [q(c.url).get("start_date"), q(c.url).get("end_date")]);
    expect(ranges).toEqual([["2026-07-01", "2026-07-30"], ["2026-07-31", "2026-08-29"], ["2026-08-30", "2026-09-28"]]);
  });

  it("maps ad groups and ads with copy, landing URL parameters, video id and thumbnail; the video becomes an asset", async () => {
    const p = make([
      { match: (u) => path(u, "adgroup/get/"), body: F.adGroups },
      { match: (u) => path(u, "ad/get/"), body: F.ads },
      { match: (u) => path(u, "file/video/ad/info/"), body: F.videoInfo },
    ], ["7100000000000000001"]);
    expect(await p.fetchAdSets()).toEqual([
      { externalId: "1780000000001101", campaignExternalId: "1780000000000101", name: "Broad 18-34 IT", status: "active", optimizationGoal: "CONVERT", dailyBudgetMinor: 4000 },
      { externalId: "1780000000001102", campaignExternalId: "1780000000000101", name: "Interest – fashion", status: "paused", optimizationGoal: "CONVERT", dailyBudgetMinor: null },
    ]);
    const list = await p.fetchAds();
    expect(list[0]).toEqual({ externalId: "1780000000002101", adSetExternalId: "1780000000001101", campaignExternalId: "1780000000000101", name: "UGC try-on | hook 1", status: "active", format: "video", headline: "Example Apparel", body: "Linen that breathes all summer. Free returns.", finalUrl: "https://shop.example/products/linen-shirt?utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__&utm_term=__AID__", urlTags: "utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__&utm_term=__AID__", thumbnailUrl: "https://p16-example.tiktokcdn.com/cover01.jpeg" });
    expect(list[1]).toMatchObject({ format: "carousel", status: "paused", thumbnailUrl: null, urlTags: "utm_source=tiktok" });
    const assets = await p.fetchAssets();
    expect(assets.map((a) => [a.adExternalId, a.type, a.assetExternalId])).toEqual([["1780000000002101", "video", "v10033g50000example01"], ["1780000000002102", "image", "ad-site-i18n-sg/202610020000example1"], ["1780000000002102", "image", "ad-site-i18n-sg/202610020000example2"]]);
    // ads are read once for ads and assets
    expect(p.http.calls.filter((c) => c.url.includes("/ad/get/")).length).toBe(1);
  });

  it("reads ad-group and ad reporting per day with reach, conversions, video views and completions; no keyword levels", async () => {
    const p = make([
      { match: (u) => path(u, "report/integrated/get/") && q(u).get("data_level") === "AUCTION_ADGROUP", body: F.adGroupReport },
      { match: (u) => path(u, "report/integrated/get/") && q(u).get("data_level") === "AUCTION_AD", body: F.adReport },
      { match: (u) => path(u, "ad/get/"), body: F.ads },
      { match: (u) => path(u, "file/video/ad/info/"), body: F.videoInfo },
    ], ["7100000000000000001"]);
    expect(await p.fetchEntityMetrics("ad_set", window)).toEqual([{ level: "ad_set", entityExternalId: "1780000000001101", campaignExternalId: "1780000000000101", adSetExternalId: "1780000000001101", adExternalId: null, date: "2026-09-28", spendMinor: 4010, impressions: 12100, clicks: 150, reach: 9900, conversions: 5, conversionValueMinor: 35500, videoViews3s: 5200, videoCompletions: 640 }]);
    const adRows = await p.fetchEntityMetrics("ad", window);
    expect(adRows[0]).toMatchObject({ level: "ad", entityExternalId: "1780000000002101", adExternalId: "1780000000002101", adSetExternalId: "1780000000001101", spendMinor: 3325, conversions: 4, conversionValueMinor: 28900, videoViews3s: 4300, videoCompletions: 520 });
    // a row without attribute metrics takes its parents from the ads list
    expect(adRows[1]).toMatchObject({ entityExternalId: "1780000000002102", campaignExternalId: "1780000000000101", adSetExternalId: "1780000000001101", spendMinor: 685 });
    expect(JSON.parse(q(p.http.calls.find((c) => q(c.url).get("data_level") === "AUCTION_AD")!.url).get("metrics")!)).toEqual(expect.arrayContaining(["spend", "complete_payment", "campaign_id", "adgroup_id"]));
    for (const level of ["asset", "keyword", "search_term"] as const) expect(await p.fetchEntityMetrics(level, window)).toEqual([]);
  });

  it("pauses and resumes campaigns and ads with a POST naming the advertiser that owns them", async () => {
    const p = make([
      { match: (u) => path(u, "campaign/get/") && q(u).get("advertiser_id") === "7100000000000000001", body: F.emptyReport },
      { match: (u) => path(u, "campaign/get/") && q(u).get("advertiser_id") === "7100000000000000002", body: F.campaignsAdv2 },
      { match: (u, i) => path(u, "campaign/status/update/") && i?.method === "POST", body: F.statusUpdated },
      { match: (u, i) => path(u, "ad/status/update/") && i?.method === "POST", body: F.adStatusUpdated },
      { match: (u) => path(u, "ad/get/"), body: F.ads },
    ]);
    await p.setCampaignStatus("1780000000000201", "paused");
    const post = p.http.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({ advertiser_id: "7100000000000000002", campaign_ids: ["1780000000000201"], operation_status: "DISABLE" });
    await p.setAdStatus({ adExternalId: "1780000000002101" }, "active");
    expect(JSON.parse(p.http.calls.filter((c) => c.method === "POST")[1]!.body!)).toEqual({ advertiser_id: "7100000000000000001", ad_ids: ["1780000000002101"], operation_status: "ENABLE" });
    const single = make([{ match: (u, i) => path(u, "campaign/status/update/") && i?.method === "POST", body: F.statusUpdated }], ["7100000000000000001"]);
    await single.setCampaignStatus("1780000000000101", "active");
    expect(single.http.calls).toHaveLength(1);
  });

  it("maps business error codes: rate limit (resumable), expired token, missing permission", async () => {
    await expect(make([{ match: () => true, body: F.rateLimited }]).fetchEntityMetrics("ad", window)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 60_000 });
    await expect(make([{ match: () => true, body: F.tokenExpired }]).fetchCampaigns()).rejects.toMatchObject({ code: "token_expired" });
    await expect(make([{ match: () => true, body: F.noPermission }], ["7100000000000000001"]).setCampaignStatus("1", "paused")).rejects.toMatchObject({ code: "permission" });
    expect(mapTiktokError(51000, "internal").code).toBe("network");
    // HTTP 429 is retried by the shared client before it gives up as a rate limit
    const limited = make([{ match: () => true, status: 429, headers: { "retry-after": "2" }, body: "slow down" }], ["7100000000000000001"]);
    await expect(limited.fetchDailyMetrics(window)).rejects.toMatchObject({ code: "rate_limited" });
    expect(limited.http.calls).toHaveLength(4);
  });

  it("keeps the thumbnail empty when the app lacks Creative Management", async () => {
    const p = make([
      { match: (u) => path(u, "ad/get/"), body: F.ads },
      { match: (u) => path(u, "file/video/ad/info/"), body: F.noPermission },
    ], ["7100000000000000001"]);
    expect((await p.fetchAds())[0]!.thumbnailUrl).toBeNull();
  });
});

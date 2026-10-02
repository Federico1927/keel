import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { META_ADVANTAGE_LOCKED_MESSAGE, META_API_VERSION, MetaAdsPlatform, isAdvantageLockedError } from "./index";
import * as F from "./__fixtures__/entities";

const campaigns = { data: [{ id: "120210000000001", name: "Summer Sale – Prospecting", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "5000", created_time: "2026-05-01T10:00:00+0000", account_id: "123" }, { id: "120210000000002", name: "Retargeting", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_SALES", daily_budget: "2000", created_time: "2026-04-01T10:00:00+0000", account_id: "123" }], paging: { cursors: { before: "a", after: "b" } } };
const insightsPage1 = { data: [{ campaign_id: "120210000000001", campaign_name: "Summer Sale – Prospecting", spend: "48.37", impressions: "12000", clicks: "310", actions: [{ action_type: "omni_view_content", value: "140" }, { action_type: "omni_purchase", value: "7" }], action_values: [{ action_type: "omni_purchase", value: "612.50" }], date_start: "2026-09-28", date_stop: "2026-09-28" }], paging: { cursors: { after: "next1" }, next: "https://graph.facebook.com/next" } };
const insightsPage2 = { data: [{ campaign_id: "120210000000001", campaign_name: "Summer Sale – Prospecting", spend: "51.00", impressions: "13000", clicks: "330", actions: [], date_start: "2026-09-29", date_stop: "2026-09-29" }], paging: { cursors: { after: "end" } } };

describe("meta adapter", () => {
  const make = (routes: Parameters<typeof fixtureFetch>[0]) => new MetaAdsPlatform({ accessToken: "tok", adAccountId: "123" }, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });

  it("maps campaigns and daily insights across pages, converting spend to minor units", async () => {
    const p = make([
      { match: (u) => u.includes("/act_123/campaigns"), body: campaigns },
      { match: (u) => u.includes("/act_123/insights") && !u.includes("after="), body: insightsPage1 },
      { match: (u) => u.includes("/act_123/insights") && u.includes("after=next1"), body: insightsPage2 },
    ]);
    const cs = await p.fetchCampaigns();
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ externalId: "120210000000001", status: "active", dailyBudgetMinor: 5000, accountExternalId: "act_123" });
    expect(cs[1]!.status).toBe("paused");
    const m = await p.fetchDailyMetrics({ since: "2026-09-28", until: "2026-09-29" });
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ campaignExternalId: "120210000000001", date: "2026-09-28", spendMinor: 4837, impressions: 12000, clicks: 310, viewContent: 140, purchases: 7, purchaseValueMinor: 61250 });
    expect(m[1]!.purchases).toBe(0);
    const url = p.http.calls.find((c) => c.url.includes("/insights"))!.url;
    expect(decodeURIComponent(url)).toContain('"since":"2026-09-28"');
    expect(url).toContain("time_increment=1");
  });

  it("maps Graph API errors to codes and pauses campaigns with a POST", async () => {
    const expired = make([{ match: () => true, body: { error: { message: "Error validating access token: Session has expired", code: 190 } } }]);
    await expect(expired.fetchCampaigns()).rejects.toMatchObject({ code: "token_expired" });
    const limited = make([{ match: () => true, body: { error: { message: "User request limit reached", code: 17 } } }]);
    await expect(limited.fetchCampaigns()).rejects.toMatchObject({ code: "rate_limited" });
    const p = make([{ match: (u, i) => u.endsWith("/120210000000001") && i?.method === "POST", body: { success: true } }, { match: (u) => u.includes("/120210000000001?fields=smart_promotion_type"), body: { id: "120210000000001", smart_promotion_type: "GUIDED_CREATION" } }]);
    await p.setCampaignStatus("120210000000001", "paused");
    expect(p.http.calls.find((c) => c.method === "POST")!.body).toContain("status=PAUSED");
  });
});

describe("meta adapter below the campaign (fixtures)", () => {
  const make = (routes: Parameters<typeof fixtureFetch>[0]) => new MetaAdsPlatform({ accessToken: "tok", adAccountId: "123" }, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });
  const window = { since: "2026-09-28", until: "2026-09-28" };

  it("declares what it reports", () => {
    expect(make([]).capabilities).toEqual({ supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: true, supportsAdWrites: true });
  });

  it("maps ad sets and ads with copy, URL parameters and dynamic-creative copy", async () => {
    const p = make([
      { match: (u) => u.includes("/act_123/adsets"), body: F.adSetsPage },
      { match: (u) => u.includes("/act_123/ads?"), body: F.adsPage },
    ]);
    const sets = await p.fetchAdSets();
    expect(sets).toEqual([
      { externalId: "120210000000101", campaignExternalId: "120210000000001", name: "Prospecting – broad 25-45", status: "active", optimizationGoal: "OFFSITE_CONVERSIONS", dailyBudgetMinor: 3000 },
      { externalId: "120210000000102", campaignExternalId: "120210000000001", name: "Retargeting 30d", status: "paused", optimizationGoal: "OFFSITE_CONVERSIONS", dailyBudgetMinor: null },
    ]);
    const ads = await p.fetchAds();
    expect(ads[0]).toMatchObject({ externalId: "120210000001001", adSetExternalId: "120210000000101", format: "video", headline: "Natural linen shirt", finalUrl: "https://shop.example/products/linen-shirt", status: "active" });
    expect(ads[0]!.urlTags).toContain("utm_content={{ad.id}}");
    expect(ads[1]).toMatchObject({ status: "paused", headline: "Natural linen", body: "Linen that breathes Made in Portugal", finalUrl: "https://shop.example/collections/linen" });
    expect(decodeURIComponent(p.http.calls[1]!.url)).toContain("creative{id,title,body");
  });

  it("reads ad-set and ad insights per day, with reach and video views", async () => {
    const p = make([
      { match: (u) => u.includes("/insights") && u.includes("level=adset"), body: F.adSetInsights },
      { match: (u) => u.includes("/insights") && u.includes("level=ad&"), body: F.adInsights },
    ]);
    const sets = await p.fetchEntityMetrics("ad_set", window);
    expect(sets).toEqual([expect.objectContaining({ level: "ad_set", entityExternalId: "120210000000101", campaignExternalId: "120210000000001", date: "2026-09-28", spendMinor: 3010, conversions: 4, conversionValueMinor: 24000, reach: 4000 })]);
    const ads = await p.fetchEntityMetrics("ad", window);
    expect(ads[0]).toMatchObject({ level: "ad", entityExternalId: "120210000001001", adSetExternalId: "120210000000101", spendMinor: 2140, impressions: 5400, clicks: 120, reach: 3100, conversions: 3, conversionValueMinor: 18900, videoViews3s: 1500, videoCompletions: 220 });
    expect(await p.fetchEntityMetrics("keyword", window)).toEqual([]);
    expect(await p.fetchEntityMetrics("search_term", window)).toEqual([]);
  });

  it("reads assets from the four breakdowns, one call each", async () => {
    const p = make([
      { match: (u) => u.includes("breakdowns=body_asset"), body: F.bodyAssetInsights },
      { match: (u) => u.includes("breakdowns=image_asset"), body: F.imageAssetInsights },
      { match: (u) => u.includes("breakdowns=title_asset") || u.includes("breakdowns=video_asset"), body: F.emptyInsights },
    ]);
    const assets = await p.fetchAssets();
    expect(assets.map((a) => [a.assetExternalId, a.type, a.fieldType, a.text ?? a.url])).toEqual([["6001", "text", "body", "Linen that breathes"], ["6002", "text", "body", "Made in Portugal"], ["7001", "image", "image", "https://cdn.example/img.jpg"]]);
    const metrics = await p.fetchEntityMetrics("asset", window);
    expect(metrics.find((m) => m.entityExternalId === "6001")).toMatchObject({ level: "asset", adExternalId: "120210000001002", fieldType: "body", spendMinor: 420, conversions: 1 });
    expect(p.http.calls.filter((c) => c.url.includes("breakdowns=")).length).toBe(8);
  });

  it("pauses an ad with a POST on the ad id and maps rate limits", async () => {
    const p = make([{ match: (u, i) => u.endsWith("/120210000001001") && i?.method === "POST", body: { success: true } }, { match: (u) => u.includes("/120210000001001?fields="), body: { id: "120210000001001", campaign: { id: "1", smart_promotion_type: "GUIDED_CREATION" } } }]);
    await p.setAdStatus({ adExternalId: "120210000001001" }, "paused");
    expect(p.http.calls.find((c) => c.method === "POST")!.body).toContain("status=PAUSED");
    const limited = make([{ match: () => true, body: { error: { message: "Application request limit reached", code: 4 } } }]);
    await expect(limited.fetchEntityMetrics("ad", window)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("meta API v26 (issue #89)", () => {
  const make = (routes: Parameters<typeof fixtureFetch>[0]) => new MetaAdsPlatform({ accessToken: "tok", adAccountId: "123" }, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });

  it("calls the pinned version", async () => {
    const p = make([{ match: (u) => u.includes("/act_123/campaigns"), body: campaigns }]);
    await p.fetchCampaigns();
    expect(p.http.calls[0]!.url).toContain(`graph.facebook.com/${META_API_VERSION}/`);
    expect(META_API_VERSION).toBe("v26.0");
  });

  it("refuses a status change on a legacy Advantage+ shopping campaign with a readable message, without writing", async () => {
    const p = make([{ match: (u) => u.includes("?fields=smart_promotion_type"), body: { id: "9", smart_promotion_type: "AUTOMATED_SHOPPING_ADS" } }, { match: (_u, i) => i?.method === "POST", body: { success: true } }]);
    await expect(p.setCampaignStatus("9", "paused")).rejects.toMatchObject({ code: "invalid_request", message: META_ADVANTAGE_LOCKED_MESSAGE });
    expect(p.http.calls.some((c) => c.method === "POST")).toBe(false);
    const ad = make([{ match: (u) => u.includes("?fields="), body: { id: "8", campaign: { id: "9", smart_promotion_type: "SMART_APP_PROMOTION" } } }]);
    await expect(ad.setAdStatus({ adExternalId: "8" }, "active")).rejects.toThrow(META_ADVANTAGE_LOCKED_MESSAGE);
  });

  it("maps Meta's own refusal of an Advantage+ shopping update to the readable message", async () => {
    const p = make([{ match: (u) => u.includes("?fields="), body: { error: { message: "Unsupported get request", code: 100 } } }, { match: (_u, i) => i?.method === "POST", body: { error: { message: "Advantage+ shopping campaigns can no longer be updated through the API", code: 100, error_subcode: 1885183 } } }]);
    await expect(p.setCampaignStatus("9", "paused")).rejects.toThrow(META_ADVANTAGE_LOCKED_MESSAGE);
    expect(isAdvantageLockedError("Invalid parameter")).toBe(false);
  });
});

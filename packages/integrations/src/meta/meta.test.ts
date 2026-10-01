import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { MetaAdsPlatform } from "./index";

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
    const p = make([{ match: (u, i) => u.endsWith("/120210000000001") && i?.method === "POST", body: { success: true } }]);
    await p.setCampaignStatus("120210000000001", "paused");
    expect(p.http.calls[0]!.body).toContain("status=PAUSED");
  });
});

import { describe, expect, it } from "vitest";
import { channelOfGa4Group, conversionRate, conversionRateRows, ga4DateToIso, matchTrafficCampaign, normalizeLandingPath } from "./traffic";
import type { CampaignRef } from "./attribution";

describe("traffic (GA4, #86)", () => {
  it("normalises landing pages to the path", () => {
    expect(normalizeLandingPath("/products/linen-shirt?utm_source=facebook&fbclid=X")).toBe("/products/linen-shirt");
    expect(normalizeLandingPath("https://Shop.example/Products/Linen-Shirt/#reviews")).toBe("/products/linen-shirt");
    expect(normalizeLandingPath("//collections//new/")).toBe("/collections/new");
    expect(normalizeLandingPath("/")).toBe("/");
    expect(normalizeLandingPath("/?utm_source=google")).toBe("/");
    expect(normalizeLandingPath("https://shop.example")).toBe("/");
    expect(normalizeLandingPath("products/x")).toBe("/products/x");
    expect(normalizeLandingPath("")).toBe("(not set)");
    expect(normalizeLandingPath(null)).toBe("(not set)");
    expect(normalizeLandingPath("(not set)")).toBe("(not set)");
    expect(normalizeLandingPath(`/${"a".repeat(800)}`).length).toBe(500);
  });

  it("maps GA4 default channel groups to Hullwise channels", () => {
    expect(channelOfGa4Group("Paid Social")).toBe("paid_social");
    expect(channelOfGa4Group("Cross-network")).toBe("paid_search");
    expect(channelOfGa4Group("Paid Shopping")).toBe("paid_search");
    expect(channelOfGa4Group("organic search")).toBe("organic_search");
    expect(channelOfGa4Group("Organic Social")).toBe("social");
    expect(channelOfGa4Group("Email")).toBe("email");
    expect(channelOfGa4Group("Affiliates")).toBe("referral");
    expect(channelOfGa4Group("Direct")).toBe("direct");
    expect(channelOfGa4Group("Unassigned")).toBe("unknown");
    expect(channelOfGa4Group("SMS")).toBe("unknown");
    expect(channelOfGa4Group(null)).toBe("unknown");
  });

  it("converts GA4 dates", () => {
    expect(ga4DateToIso("20260115")).toBe("2026-01-15");
    expect(ga4DateToIso("2026-01-15")).toBe("2026-01-15");
  });

  it("computes conversion rates and keeps them unclamped", () => {
    expect(conversionRate(3, 150)).toBe(0.02);
    expect(conversionRate(3, 0)).toBeNull();
    expect(conversionRate(5, 2)).toBe(2.5);
  });

  it("joins orders, GA4 and pixel sessions by key, with totals", () => {
    const r = conversionRateRows({
      orders: [{ key: "paid_social", orders: 30 }, { key: "email", orders: 8 }, { key: "marketplace", orders: 2 }],
      sessions: [{ key: "paid_social", sessions: 1500, engagedSessions: 900, addToCarts: 120 }, { key: "email", sessions: 200, engagedSessions: 150, addToCarts: 20 }, { key: "direct", sessions: 400 }],
      pixel: [{ key: "paid_social", sessions: 1000 }, { key: "email", sessions: 400 }],
    });
    expect(r.rows.map((x) => x.key)).toEqual(["paid_social", "direct", "email", "marketplace"]);
    expect(r.rows[0]).toMatchObject({ orders: 30, sessions: 1500, rate: 0.02, pixelSessions: 1000, pixelRate: 0.03, engagedSessions: 900, addToCarts: 120 });
    expect(r.rows[1]).toMatchObject({ orders: 0, sessions: 400, rate: 0, pixelSessions: 0, pixelRate: null });
    expect(r.rows[3]).toMatchObject({ orders: 2, sessions: 0, rate: null });
    expect(r.totals).toMatchObject({ orders: 40, sessions: 2100, pixelSessions: 1400, engagedSessions: 1050, addToCarts: 140 });
    expect(r.totals.rate).toBeCloseTo(40 / 2100);
    expect(conversionRateRows({ orders: [], sessions: [] }).totals.pixelSessions).toBeNull();
    // the pixel's rate counts only the orders of its own coverage
    const cov = conversionRateRows({ orders: [{ key: "email", orders: 8 }], sessions: [{ key: "email", sessions: 200 }], pixel: [{ key: "email", sessions: 100 }], pixelOrders: [{ key: "email", orders: 3 }] });
    expect(cov.rows[0]).toMatchObject({ orders: 8, rate: 0.04, pixelRate: 0.03 });
    expect(cov.totals.pixelRate).toBe(0.03);
  });

  it("matches traffic to campaigns by the order rule: id, then normalised name; placeholders never match", () => {
    const campaigns: CampaignRef[] = [
      { id: "c1", externalId: "120000030199", name: "Prospecting – Broad", platform: "meta" },
      { id: "c2", externalId: "987654321", name: "Brand Search IT", platform: "google" },
      { id: "c3", externalId: "555000111", name: "brand search it", platform: "meta" },
    ];
    expect(matchTrafficCampaign({ source: "facebook", medium: "paid", campaignName: "120000030199" }, campaigns)?.id).toBe("c1");
    expect(matchTrafficCampaign({ source: "google", medium: "cpc", campaignName: "Brand Search IT" }, campaigns)?.id).toBe("c2");
    // the same name on two platforms: the session source decides
    expect(matchTrafficCampaign({ source: "facebook", medium: "paid", campaignName: "Brand search it" }, campaigns)?.id).toBe("c3");
    expect(matchTrafficCampaign({ source: "google", medium: "organic", campaignName: "(organic)" }, campaigns)).toBeNull();
    expect(matchTrafficCampaign({ source: "(direct)", medium: "(none)", campaignName: "(direct)" }, campaigns)).toBeNull();
    expect(matchTrafficCampaign({ source: "newsletter", medium: "email", campaignName: "weekly-19" }, campaigns)).toBeNull();
    expect(matchTrafficCampaign({ source: "x", medium: "y", campaignName: "" }, campaigns)).toBeNull();
  });
});

describe("aggregateTrafficRows", () => {
  it("sums rows that differ only by the query string of the landing page", async () => {
    const { aggregateTrafficRows } = await import("./traffic");
    const base = { date: "2026-01-02", channelGroup: "Paid Social", source: "facebook", medium: "paid", campaignName: "123456789" };
    const out = aggregateTrafficRows([
      { ...base, landingPath: "/products/x", sessions: 10, totalUsers: 9, engagedSessions: 6, addToCarts: 1 },
      { ...base, landingPath: "/products/x", sessions: 5, totalUsers: 5, engagedSessions: 2, addToCarts: 0 },
      { ...base, date: "2026-01-01", landingPath: "/products/x", sessions: 1, totalUsers: 1, engagedSessions: 1, addToCarts: 0 },
      { ...base, source: "  ", landingPath: "/", sessions: 2, totalUsers: 2, engagedSessions: 1, addToCarts: 0 },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ date: "2026-01-01", sessions: 1 });
    expect(out.find((r) => r.date === "2026-01-02" && r.landingPath === "/products/x")).toMatchObject({ sessions: 15, totalUsers: 14, engagedSessions: 8, addToCarts: 1 });
    expect(out.find((r) => r.landingPath === "/")?.source).toBe("(not set)");
  });
});

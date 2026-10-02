import { describe, expect, it } from "vitest";
import { adEntityEconomics, adPauseSuggestions, allocateKeel, assetPauseSuggestions, checkUtmTemplate, groupRareTerms, isNoiseTerm, keelByKey, negativeKeywordCandidates, normalizeSearchText, orderAdKeys, reconcileSpend, rollupMetricRows, splitExact, ADS_UTM_TEMPLATES, ZERO_METRICS, type MetricRow } from "./ads";

describe("UTM templates", () => {
  it("accepts the documented templates and names what is missing", () => {
    expect(checkUtmTemplate("meta", ADS_UTM_TEMPLATES.meta)).toEqual({ ok: true, missing: [] });
    expect(checkUtmTemplate("google", null, ADS_UTM_TEMPLATES.google)).toEqual({ ok: true, missing: [] });
    expect(checkUtmTemplate("meta", "utm_source=facebook&utm_campaign={{campaign.id}}")).toEqual({ ok: false, missing: ["utm_content", "utm_term"] });
    expect(checkUtmTemplate("google", "https://shop.example/p?utm_content={creative}")).toEqual({ ok: false, missing: ["utm_term"] });
    expect(checkUtmTemplate("tiktok", ADS_UTM_TEMPLATES.tiktok)).toEqual({ ok: true, missing: [] });
    expect(checkUtmTemplate("tiktok", "utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__")).toEqual({ ok: false, missing: ["utm_term"] });
    expect(checkUtmTemplate("snapchat", "")).toEqual({ ok: true, missing: [] });
  });

  it("maps an order's UTMs to ad, ad set and keyword per platform", () => {
    expect(orderAdKeys("meta", { utmContent: "2385100001", utmTerm: "120000000000-as1" })).toEqual({ adExternalId: "2385100001", adSetExternalId: "120000000000-as1", termText: null });
    expect(orderAdKeys("google", { utmContent: "6912100003", utmTerm: "  Linen  Shirt " })).toEqual({ adExternalId: "6912100003", adSetExternalId: null, termText: "linen shirt" });
    expect(orderAdKeys("tiktok", { utmContent: "1780000000000301", utmTerm: "1780000000000201" })).toEqual({ adExternalId: "1780000000000301", adSetExternalId: "1780000000000201", termText: null });
    expect(normalizeSearchText('"+linen +shirt"')).toBe("linen shirt");
    expect(normalizeSearchText("[oak table]")).toBe("oak table");
  });
});

describe("Keel numbers per entity", () => {
  it("counts revenue and margin only for sale orders; cancelled ones are kept apart", () => {
    const m = keelByKey([
      { key: "a", inScope: true, netRevenueMinor: 5000, marginMinor: 2000 },
      { key: "a", inScope: false, netRevenueMinor: 9000, marginMinor: 4000 },
      { key: "b", inScope: false, netRevenueMinor: 1000, marginMinor: 300 },
    ]);
    expect(m.get("a")).toEqual({ orders: 1, netRevenueMinor: 5000, marginMinor: 2000, allOrders: 2 });
    expect(m.get("b")).toEqual({ orders: 0, netRevenueMinor: 0, marginMinor: 0, allOrders: 1 });
    const e = adEntityEconomics({ spendMinor: 1000, impressions: 10000, clicks: 200, conversions: 3, conversionValueMinor: 15000 }, m.get("a")!);
    expect(e).toMatchObject({ profitMinor: 1000, roas: 5, platformConversions: 3, excludedOrders: 1, ctr: 0.02 });
  });

  it("splits exactly and allocates an ad's numbers to its assets by spend share", () => {
    expect(splitExact(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitExact(7, [0, 0])).toEqual([7, 0]);
    const parts = allocateKeel({ orders: 3, allOrders: 4, netRevenueMinor: 10001, marginMinor: 3000 }, new Map([["x", 300], ["y", 100]]));
    expect(parts.get("x")!.orders + parts.get("y")!.orders).toBe(3);
    expect(parts.get("x")!.netRevenueMinor + parts.get("y")!.netRevenueMinor).toBe(10001);
    expect(parts.get("x")!.marginMinor).toBe(2250);
  });
});

describe("spend reconciliation", () => {
  it("ad-level spend equals campaign spend for the day; the gap is unallocated", () => {
    const r = reconcileSpend(new Map([["2026-09-28", 10000], ["2026-09-29", 8000]]), new Map([["2026-09-28", 10000], ["2026-09-29", 7400]]));
    expect(r.rows).toEqual([{ date: "2026-09-28", parentMinor: 10000, childrenMinor: 10000, unallocatedMinor: 0 }, { date: "2026-09-29", parentMinor: 8000, childrenMinor: 7400, unallocatedMinor: 600 }]);
    expect(r.unallocatedMinor).toBe(600);
  });
});

describe("suggestions", () => {
  const term = (id: string, o: Partial<Parameters<typeof negativeKeywordCandidates>[0][number]> = {}) => ({ id, text: id, status: "none", isOther: false, spendMinor: 5000, clicks: 40, conversions: 0, keel: { orders: 0, netRevenueMinor: 0, marginMinor: 0, allOrders: 0 }, keelMatchable: true, ...o });

  it("a search term with spend and only cancelled orders is a negative-keyword candidate", () => {
    const c = negativeKeywordCandidates([
      term("free shoes", { keel: { orders: 0, netRevenueMinor: 0, marginMinor: 0, allOrders: 3 } }),
      term("linen shirt", { keel: { orders: 4, netRevenueMinor: 20000, marginMinor: 8000, allOrders: 4 } }),
      term("cheap sofa", { keelMatchable: false, conversions: 0, spendMinor: 9000 }),
      term("sofa outlet", { keelMatchable: false, conversions: 2 }),
      term("tiny", { spendMinor: 50 }),
      term("(other)", { isOther: true }),
      term("already", { status: "excluded" }),
    ], { minSpendMinor: 1000, minClicks: 5 });
    expect(c.map((x) => [x.text, x.reason])).toEqual([["cheap sofa", "no_conversions"], ["free shoes", "only_cancelled"]]);
  });

  it("proposes losing or fatigued active ads and weak assets", () => {
    const s = adPauseSuggestions([
      { id: "a", status: "active", spendMinor: 10000, economics: { profitMinor: -6000, roi: -0.6 }, fatigue: "fresh" },
      { id: "b", status: "active", spendMinor: 10000, economics: { profitMinor: -500, roi: -0.05 }, fatigue: "fatigued" },
      { id: "c", status: "paused", spendMinor: 10000, economics: { profitMinor: -9000, roi: -0.9 }, fatigue: null },
      { id: "d", status: "active", spendMinor: 10000, economics: { profitMinor: 4000, roi: 0.4 }, fatigue: "fatigued" },
    ], { minSpendMinor: 1000, roiMedium: -0.2 });
    expect(s.map((x) => [x.id, x.reason])).toEqual([["a", "losing"], ["b", "fatigued"]]);
    const a = assetPauseSuggestions([
      { id: "h1", adId: "ad", fieldType: "headline", performanceLabel: "BEST", impressions: 1000, clicks: 50 },
      { id: "h2", adId: "ad", fieldType: "headline", performanceLabel: "LOW", impressions: 1000, clicks: 40 },
      { id: "h3", adId: "ad", fieldType: "headline", performanceLabel: null, impressions: 1000, clicks: 10 },
      { id: "h4", adId: "ad", fieldType: "headline", performanceLabel: "LOW", impressions: 10, clicks: 0 },
    ], { minImpressions: 100 });
    expect(a.map((x) => [x.id, x.reason])).toEqual([["h2", "low_label"], ["h3", "low_ctr"]]);
  });
});

describe("volume control", () => {
  const row = (id: string, date: string, impressions: number, spend = 100, grain: "day" | "month" = "day"): MetricRow => ({ ...ZERO_METRICS, entityType: "search_term", entityId: id, date, grain, impressions, spendMinor: spend, clicks: 1 });

  it("rolls daily rows older than the cutoff into months, adding to existing monthly rows", () => {
    const r = rollupMetricRows([row("a", "2026-05-03", 10), row("a", "2026-05-20", 15), row("a", "2026-04-01", 100, 900, "month"), row("a", "2026-04-28", 5), row("a", "2026-07-10", 9)], "2026-07-01");
    expect(r.rolled).toBe(3);
    expect(r.keep).toHaveLength(1);
    expect(r.months.find((m) => m.date === "2026-05-01")).toMatchObject({ impressions: 25, spendMinor: 200, grain: "month" });
    expect(r.months.find((m) => m.date === "2026-04-01")).toMatchObject({ impressions: 105, spendMinor: 1000 });
  });

  it("groups rare search terms under (other) of their ad group, keeping spend", () => {
    const g = groupRareTerms([row("a", "2026-05-01", 3, 50, "month"), row("b", "2026-05-01", 4, 70, "month"), row("c", "2026-05-01", 500, 900, "month"), row("o", "2026-05-01", 2, 10, "month")], 10, (id) => (id === "c" ? "o" : "o"));
    expect(g.find((x) => x.entityId === "o")).toMatchObject({ impressions: 9, spendMinor: 130 });
    expect(g.find((x) => x.entityId === "c")).toMatchObject({ impressions: 500 });
    expect(g.reduce((s, x) => s + x.spendMinor, 0)).toBe(1030);
    expect(isNoiseTerm({ impressions: 2, clicks: 0, spendMinor: 0, conversions: 0 }, 10)).toBe(true);
    expect(isNoiseTerm({ impressions: 2, clicks: 1, spendMinor: 30, conversions: 0 }, 10)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { adPlatformOf, deriveChannel, extractAttribution, matchCampaign, splitDateWindows } from "./attribution";

describe("attribution", () => {
  it("extracts utm and click ids with note attributes winning over landing and referrer", () => {
    const a = extractAttribution({ landingSite: "/products/x?utm_source=facebook&utm_medium=paid&utm_campaign=Summer%20Sale&fbclid=F1", referringSite: "https://l.facebook.com/?utm_source=ref", noteAttributes: [{ name: "UTM Campaign", value: "notes-win" }, { name: "gclid", value: "G1" }] });
    expect(a.utmCampaign).toBe("notes-win");
    expect(a.utmSource).toBe("facebook");
    expect(a.clickIds).toEqual({ fbclid: "F1", gclid: "G1" });
  });
  it("derives the channel", () => {
    const base = { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, utmId: null, clickIds: {} };
    expect(deriveChannel({ ...base, clickIds: { fbclid: "x" } }, null)).toBe("paid_social");
    expect(deriveChannel({ ...base, clickIds: { gclid: "x" } }, null)).toBe("paid_search");
    expect(deriveChannel({ ...base, utmSource: "klaviyo", utmMedium: "email" }, null)).toBe("email");
    expect(deriveChannel({ ...base, utmSource: "google", utmMedium: "organic" }, null)).toBe("organic_search");
    expect(deriveChannel(base, "https://www.google.com/")).toBe("organic_search");
    expect(deriveChannel(base, "https://blog.example.com/post")).toBe("referral");
    expect(deriveChannel(base, null)).toBe("direct");
    expect(deriveChannel(base, null, "amazon")).toBe("marketplace");
  });
  it("matches campaigns by id then by normalized name, preferring the click-id platform", () => {
    const campaigns = [
      { id: "a", externalId: "120000000001", name: "Summer Sale – Prospecting", platform: "meta" },
      { id: "b", externalId: "900000001", name: "Summer Sale", platform: "google" },
    ];
    const base = { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, utmId: null, clickIds: {} };
    expect(matchCampaign({ ...base, utmId: "900000001" }, campaigns)?.id).toBe("b");
    expect(matchCampaign({ ...base, utmCampaign: "summer sale" }, campaigns)?.id).toBe("b");
    expect(matchCampaign({ ...base, utmCampaign: "Summer_Sale_Prospecting" }, campaigns)?.id).toBe("a");
    expect(matchCampaign({ ...base, utmCampaign: "summer sale", clickIds: { gclid: "g" } }, campaigns)?.id).toBe("b");
    expect(matchCampaign({ ...base, utmCampaign: "xyz" }, campaigns)).toBeNull();
  });
  it("attributes a TikTok click (ttclid + utm_campaign = campaign id) to the TikTok campaign, even when the id or name exists elsewhere", () => {
    const campaigns = [
      { id: "m", externalId: "1780000000000101", name: "Linen drop", platform: "meta" },
      { id: "t", externalId: "1780000000000101", name: "Linen drop", platform: "tiktok" },
      { id: "g", externalId: "900000001", name: "Brand", platform: "google" },
    ];
    const base = { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, utmId: null, clickIds: {} };
    const a = extractAttribution({ landingSite: "/products/linen-shirt?utm_source=tiktok&utm_medium=paid_social&utm_campaign=1780000000000101&utm_content=1780000000000301&utm_term=1780000000000201&ttclid=E.C.P.abc", referringSite: null, noteAttributes: [] });
    expect(a.clickIds.ttclid).toBe("E.C.P.abc");
    expect(adPlatformOf(a)).toBe("tiktok");
    expect(deriveChannel(a, null)).toBe("paid_social");
    expect(matchCampaign(a, campaigns)?.id).toBe("t");
    // the UTM source alone points to TikTok too; a Meta click still prefers Meta
    expect(matchCampaign({ ...base, utmSource: "tiktok", utmCampaign: "linen drop" }, campaigns)?.id).toBe("t");
    expect(matchCampaign({ ...base, utmCampaign: "1780000000000101", clickIds: { fbclid: "f" } }, campaigns)?.id).toBe("m");
    expect(adPlatformOf({ utmSource: "newsletter", clickIds: {} })).toBeNull();
  });
  it("splits windows", () => {
    expect(splitDateWindows("2026-01-01", "2026-01-20", 7)).toEqual([{ since: "2026-01-01", until: "2026-01-07" }, { since: "2026-01-08", until: "2026-01-14" }, { since: "2026-01-15", until: "2026-01-20" }]);
    expect(splitDateWindows("2026-01-05", "2026-01-01", 7)).toEqual([]);
  });
});

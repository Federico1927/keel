import { describe, expect, it } from "vitest";
import { GOOGLE_ADS_SETUP, INTEGRATION_SETUP, META_SETUP, SHOPIFY_SUBSCRIPTIONS_SETUP, isMetaAdvantageLockedError, ownerSetupReady, setupCopyValues, validateSetupFields } from "./integration-setup";

/** #90: every integration card connects from a typed setup definition. */
describe("integration setup definitions", () => {
  it("covers every self-serve integration, each with unique steps, labelled copy values and an unknown fallback", () => {
    expect(Object.keys(INTEGRATION_SETUP).sort()).toEqual(["address", "anthropic", "ga4", "google", "loop", "meta", "recharge", "shopify", "shopify_subscriptions", "spoki", "tiktok"]);
    for (const g of Object.values(INTEGRATION_SETUP)) {
      const keys = g.steps.map((s) => s.key);
      expect(new Set(keys).size, g.provider).toBe(keys.length);
      expect(g.errors.unknown, g.provider).toBeTruthy();
      for (const id of setupCopyValues(g)) expect(g.copyLabels?.[id], `${g.provider}.${id}`).toBeTruthy();
      // vendor UI is flagged "To verify" on every guide
      expect(g.steps.some((s) => s.verify), g.provider).toBe(true);
    }
  });

  it("validates Meta's fields: several ad accounts, an optional pixel", () => {
    expect(validateSetupFields(META_SETUP, { accessToken: "EAAB".padEnd(40, "x"), adAccountIds: "act_123456789, 987654321", pixelId: "" })).toEqual({ ok: true, values: { accessToken: "EAAB".padEnd(40, "x"), adAccountIds: "act_123456789, 987654321", pixelId: "" } });
    expect(validateSetupFields(META_SETUP, { accessToken: "EAAB".padEnd(40, "x"), adAccountIds: "act_123456789", pixelId: "12345678" }).ok).toBe(true);
    expect(validateSetupFields(META_SETUP, { accessToken: "EAAB".padEnd(40, "x"), adAccountIds: "my account", pixelId: "" })).toEqual({ ok: false, field: "adAccountIds" });
    expect(validateSetupFields(META_SETUP, { accessToken: "EAAB".padEnd(40, "x"), adAccountIds: "act_123456789", pixelId: "px" })).toEqual({ ok: false, field: "pixelId" });
    expect(validateSetupFields(META_SETUP, { accessToken: "short", adAccountIds: "act_123456789" })).toEqual({ ok: false, field: "accessToken" });
    // a guide without fields (Shopify Subscriptions goes through the Shopify connection) always validates
    expect(validateSetupFields(SHOPIFY_SUBSCRIPTIONS_SETUP, {})).toEqual({ ok: true, values: {} });
  });

  it("knows when the owner-side prerequisites of an OAuth path are configured", () => {
    expect(ownerSetupReady(GOOGLE_ADS_SETUP, {})).toBe(false);
    expect(ownerSetupReady(GOOGLE_ADS_SETUP, { HULLWISE_GOOGLE_ADS_CLIENT_ID: "c", HULLWISE_GOOGLE_ADS_CLIENT_SECRET: "s", HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN: " " })).toBe(false);
    expect(ownerSetupReady(GOOGLE_ADS_SETUP, { HULLWISE_GOOGLE_ADS_CLIENT_ID: "c", HULLWISE_GOOGLE_ADS_CLIENT_SECRET: "s", HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN: "d" })).toBe(true);
    expect(ownerSetupReady(META_SETUP, {})).toBe(true);
  });

  it("recognises Meta's refusal to pause a legacy Advantage+ campaign", () => {
    expect(isMetaAdvantageLockedError("Meta no longer lets apps pause or resume legacy Advantage+ shopping or app campaigns (Marketing API v25 and later).")).toBe(true);
    expect(isMetaAdvantageLockedError("(#100) Cannot update an Advantage+ Shopping Campaign (ASC) through the API")).toBe(true);
    expect(isMetaAdvantageLockedError("Error validating access token")).toBe(false);
    expect(isMetaAdvantageLockedError(null)).toBe(false);
  });
});

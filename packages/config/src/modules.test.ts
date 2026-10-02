import { describe, expect, it } from "vitest";
import { isModuleInPlan } from "./modules";
import { AD_PLATFORMS, adPlatformMinPlan, adPlatformsForPlan, isAdPlatform, isAdPlatformInPlan } from "./ads";

describe("modules by plan", () => {
  it("includes core.mcp from Growth up, other core modules in every plan, never add-ons", () => {
    expect(isModuleInPlan("core.mcp", "starter")).toBe(false);
    expect(isModuleInPlan("core.mcp", "growth")).toBe(true);
    expect(isModuleInPlan("core.mcp", "scale")).toBe(true);
    expect(isModuleInPlan("core.mcp", "unknown")).toBe(false);
    expect(isModuleInPlan("core.api", "starter")).toBe(false);
    expect(isModuleInPlan("core.api", "growth")).toBe(true);
    expect(isModuleInPlan("core.orders", "starter")).toBe(true);
    expect(isModuleInPlan("addon.cod", "scale")).toBe(false);
  });
});

describe("ad platforms by plan", () => {
  it("TikTok comes with core.ads.tiktok from Growth up; Meta and Google are in every plan", () => {
    expect(AD_PLATFORMS).toEqual(["meta", "google", "tiktok"]);
    expect(isModuleInPlan("core.ads.tiktok", "starter")).toBe(false);
    expect(isModuleInPlan("core.ads.tiktok", "growth")).toBe(true);
    expect(adPlatformsForPlan("starter")).toEqual(["meta", "google"]);
    expect(adPlatformsForPlan("scale")).toEqual(["meta", "google", "tiktok"]);
    expect(isAdPlatformInPlan("tiktok", "starter")).toBe(false);
    expect(isAdPlatformInPlan("meta", "starter")).toBe(true);
    expect(isAdPlatformInPlan("snapchat", "scale")).toBe(false);
    expect(isAdPlatform("tiktok")).toBe(true);
    expect(isAdPlatform("shopify")).toBe(false);
    expect(adPlatformMinPlan("tiktok")).toBe("growth");
    expect(adPlatformMinPlan("meta")).toBeNull();
  });
});

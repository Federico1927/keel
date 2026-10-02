import { describe, expect, it } from "vitest";
import { ANALYTICS_PLATFORMS, ANALYTICS_PLATFORM_MIN_PLAN, isAnalyticsPlatformInPlan } from "./analytics-platform";

describe("GA4 by plan (#86)", () => {
  it("is in every plan today", () => {
    expect(ANALYTICS_PLATFORMS).toEqual(["ga4"]);
    expect(ANALYTICS_PLATFORM_MIN_PLAN).toBeNull();
    for (const p of ["starter", "growth", "scale"]) expect(isAnalyticsPlatformInPlan(p)).toBe(true);
  });
  it("follows the plan order when a minimum plan is set", () => {
    expect(isAnalyticsPlatformInPlan("starter", "growth")).toBe(false);
    expect(isAnalyticsPlatformInPlan("growth", "growth")).toBe(true);
    expect(isAnalyticsPlatformInPlan("scale", "growth")).toBe(true);
    expect(isAnalyticsPlatformInPlan("unknown", "growth")).toBe(false);
  });
});

describe("GA4 setup checklist", () => {
  it("is plain data: ordered steps with one copy value and one input, and a fix for every error", async () => {
    const { GA4_SETUP } = await import("./integration-setup");
    expect(GA4_SETUP.steps.map((s) => s.key)).toEqual(["open_admin", "access", "add_viewer", "property_id", "paste", "connect"]);
    expect(GA4_SETUP.steps.filter((s) => "copy" in s).map((s) => ("copy" in s ? s.copy : null))).toEqual(["serviceAccountEmail"]);
    expect(GA4_SETUP.steps.filter((s) => "input" in s)).toHaveLength(1);
    for (const e of Object.values(GA4_SETUP.errors)) expect(e.fixKey.endsWith(".fix")).toBe(true);
  });
});

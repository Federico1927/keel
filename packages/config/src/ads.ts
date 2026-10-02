import { MODULES, isModuleInPlan, type ModuleKey } from "./modules";
import type { PlanKey } from "./plans";

/**
 * Ad platforms Keel imports spend from (each one is an `AdsPlatform` adapter). Every per-platform list
 * in core, services, the seed and the UI derives from this constant: adding a platform starts here.
 */
export const AD_PLATFORMS = ["meta", "google", "tiktok"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export function isAdPlatform(value: unknown): value is AdPlatform {
  return typeof value === "string" && (AD_PLATFORMS as readonly string[]).includes(value);
}

/** Platforms sold as a plan module (a `core.*` module with `minPlan`); a platform not listed is in every plan. */
export const AD_PLATFORM_MODULES: Partial<Record<AdPlatform, ModuleKey>> = { tiktok: "core.ads.tiktok" };

/** Whether the tenant's plan includes the ad platform (checked server side: pages, actions, jobs). */
export function isAdPlatformInPlan(platform: string, planKey: string): boolean {
  if (!isAdPlatform(platform)) return false;
  const mod = AD_PLATFORM_MODULES[platform];
  return !mod || isModuleInPlan(mod, planKey);
}

/** The ad platforms a plan includes, in catalog order. */
export function adPlatformsForPlan(planKey: string): AdPlatform[] {
  return AD_PLATFORMS.filter((p) => isAdPlatformInPlan(p, planKey));
}

/** The lowest plan that includes the ad platform (null: every plan), for the "from plan X" hints. */
export function adPlatformMinPlan(platform: AdPlatform): PlanKey | null {
  const mod = AD_PLATFORM_MODULES[platform];
  return mod ? (MODULES[mod].minPlan ?? null) : null;
}

/** Brand names as the platforms write them (not translated). */
export const AD_PLATFORM_LABELS: Readonly<Record<AdPlatform, string>> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };

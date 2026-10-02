import { PLAN_KEYS, type PlanKey } from "./plans";

/**
 * Web analytics platforms Hullwise reads traffic from (each one is an `AnalyticsPlatform` adapter, #86).
 * GA4 is the only one; the integration row's provider is the key.
 */
export const ANALYTICS_PLATFORMS = ["ga4"] as const;
export type AnalyticsPlatformKey = (typeof ANALYTICS_PLATFORMS)[number];

/**
 * Lowest plan that includes GA4 traffic and conversion rates. Decision of 2026-10-02 (DECISIONS): every
 * plan (null), as part of `core.analytics`: conversion rate is basic analytics and GA4 is free for the
 * store. Selling it from Growth is a one-line change here; pages, actions and jobs all read this.
 */
export const ANALYTICS_PLATFORM_MIN_PLAN: PlanKey | null = null;

/** Whether the tenant's plan includes the GA4 integration (checked server side: pages, actions, jobs). */
export function isAnalyticsPlatformInPlan(planKey: string, minPlan: PlanKey | null = ANALYTICS_PLATFORM_MIN_PLAN): boolean {
  if (!minPlan) return true;
  const at = PLAN_KEYS.indexOf(planKey as PlanKey);
  return at >= 0 && at >= PLAN_KEYS.indexOf(minPlan);
}

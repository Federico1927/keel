export const PLAN_KEYS = ["starter", "growth", "scale"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanDefinition {
  key: PlanKey;
  nameKey: string;
  monthlyPriceMinor: number;
  setupFeeMinor: number;
  currency: string;
  maxOrdersPerMonth: number;
  maxUsers: number;
}

/** Example plans; values are editable here and copied into the seed. */
export const PLANS: Record<PlanKey, PlanDefinition> = {
  starter: { key: "starter", nameKey: "plans.starter", monthlyPriceMinor: 14900, setupFeeMinor: 49000, currency: "EUR", maxOrdersPerMonth: 1500, maxUsers: 3 },
  growth: { key: "growth", nameKey: "plans.growth", monthlyPriceMinor: 34900, setupFeeMinor: 99000, currency: "EUR", maxOrdersPerMonth: 6000, maxUsers: 10 },
  scale: { key: "scale", nameKey: "plans.scale", monthlyPriceMinor: 79900, setupFeeMinor: 199000, currency: "EUR", maxOrdersPerMonth: 25000, maxUsers: 30 },
};

/** Days of unpaid invoice after which a tenant is suspended (default, per-tenant override). */
export const DEFAULT_SUSPEND_AFTER_DAYS = 14;

export const PLAN_KEYS = ["starter", "growth", "scale"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Currency of every platform price (plans, add-ons, overage). Tenant stores keep their own currency. */
export const PLATFORM_CURRENCY = "USD";

export interface PlanDefinition {
  key: PlanKey;
  nameKey: string;
  monthlyPriceMinor: number;
  setupFeeMinor: number;
  currency: string;
  maxOrdersPerMonth: number;
  /** null = unlimited users (every plan, by commercial decision). */
  maxUsers: number | null;
}

/**
 * The three self-serve plans. These values are the source of truth for billing and are mirrored by
 * the landing (`apps/landing/src/config/pricing.ts`, whose test fails when the two drift). The
 * landing's "Scale" setup fee is a "from" price; "Enterprise" is a custom contract with no plan key.
 */
export const PLANS: Record<PlanKey, PlanDefinition> = {
  starter: {
    key: "starter",
    nameKey: "plans.starter",
    monthlyPriceMinor: 24900,
    setupFeeMinor: 49000,
    currency: PLATFORM_CURRENCY,
    maxOrdersPerMonth: 1000,
    maxUsers: null,
  },
  growth: {
    key: "growth",
    nameKey: "plans.growth",
    monthlyPriceMinor: 59900,
    setupFeeMinor: 150000,
    currency: PLATFORM_CURRENCY,
    maxOrdersPerMonth: 5000,
    maxUsers: null,
  },
  scale: {
    key: "scale",
    nameKey: "plans.scale",
    monthlyPriceMinor: 119000,
    setupFeeMinor: 300000,
    currency: PLATFORM_CURRENCY,
    maxOrdersPerMonth: 20000,
    maxUsers: null,
  },
};

/** Orders above `maxOrdersPerMonth` are billed per block at month end. */
export const OVERAGE = { pricePerBlockMinor: 4900, blockOrders: 1000 } as const;

/** Days of unpaid invoice after which a tenant is suspended (default, per-tenant override). */
export const DEFAULT_SUSPEND_AFTER_DAYS = 14;

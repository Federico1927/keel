/**
 * Every price, threshold and pricing flag of the landing lives here. Translated copy for the
 * plans (names, feature lines, FAQ) lives in `messages/<locale>.json` under `pricing.*`, keyed by
 * the identifiers below, so changing a number never touches a component and changing a sentence
 * never touches this file.
 */

export const PRICING_CURRENCY = "USD";

/** Annual billing: months paid per year (12 - 2 free months). */
export const ANNUAL_MONTHS_CHARGED = 10;

export type PlanId = "starter" | "growth" | "scale" | "enterprise";

export interface Plan {
  id: PlanId;
  /** Monthly list price; null means "on quote". */
  monthlyPrice: number | null;
  /** Orders per month included; null means "above the Scale ceiling". */
  includedOrdersPerMonth: number | null;
  /** One-off setup fee; null means "on quote". `setupFeeFrom` marks "from" pricing. */
  setupFee: number | null;
  setupFeeFrom?: boolean;
  /** Days the audit log is kept (mirrors `auditRetentionDays` in @hullwise/config); null = per contract. */
  auditRetentionDays: number | null;
  /**
   * Feature identifiers, translated under `pricing.features.<id>`. Each one maps to module keys of
   * @hullwise/config in `claims.ts`; a test checks that a plan lists a module exactly from the plan
   * that includes it (`isModuleInPlan`), so the cards never promise what the product does not gate.
   */
  features: readonly string[];
  /** Features of the previous tier are included; the plan card shows "Everything in <previous>". */
  inheritsFrom?: PlanId;
  recommended?: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    monthlyPrice: 249,
    includedOrdersPerMonth: 1000,
    setupFee: 490,
    auditRetentionDays: 180,
    features: [
      "orders_shipments",
      "products_purchasing",
      "returns_discounts",
      "analytics_pnl",
      "campaigns_stock",
      "crm_segments_rfm",
      "ai_assistant",
    ],
  },
  {
    id: "growth",
    monthlyPrice: 599,
    includedOrdersPerMonth: 5000,
    setupFee: 1500,
    auditRetentionDays: 365,
    inheritsFrom: "starter",
    features: ["mcp", "tiktok_ads"],
    recommended: true,
  },
  {
    id: "scale",
    monthlyPrice: 1190,
    includedOrdersPerMonth: 20000,
    setupFee: 3000,
    setupFeeFrom: true,
    auditRetentionDays: 730,
    inheritsFrom: "growth",
    features: ["priority_support"],
  },
  {
    id: "enterprise",
    monthlyPrice: null,
    includedOrdersPerMonth: null,
    setupFee: null,
    auditRetentionDays: null,
    inheritsFrom: "scale",
    features: ["enterprise_volume", "enterprise_sla", "enterprise_custom"],
  },
];

/** Overage above the included orders: price per block of `blockSize` orders. */
export const OVERAGE = { pricePerBlock: 49, blockSize: 1000 } as const;

/**
 * Add-ons and tailored integrations, priced per account. Monthly prices mirror
 * `monthlyPriceMinor` of the add-on modules in @hullwise/config (test in pricing.test.ts); add-ons the
 * product lists as "on request" have no price and show "on quote". An add-on is listed here only
 * once it is built.
 */
export type AddonPricing =
  { id: string; kind: "monthly"; price: number } | { id: string; kind: "quote" };

export const ADDONS: readonly AddonPricing[] = [
  { id: "customer_campaigns", kind: "monthly", price: 99 },
  { id: "subscriptions", kind: "monthly", price: 149 },
  { id: "cod", kind: "monthly", price: 199 },
  { id: "custom_integration", kind: "quote" },
  { id: "custom_development", kind: "quote" },
];

/** Launch offer for the first customers. Switch `enabled` to hide every mention of it. */
export const FOUNDING_OFFER = {
  enabled: true,
  discountPercent: 40,
  months: 12,
  seats: 10,
} as const;

/**
 * Reference figure for the "what a specialised stack costs" comparison. No competitor is named
 * anywhere on the page: only the typical total and the revenue band it applies to.
 */
export const STACK_COMPARISON = {
  minMonthly: 800,
  maxMonthly: 1300,
  revenueBandMinMillions: 1,
  revenueBandMaxMillions: 5,
} as const;

/** Price per month on the annual plan (two months free), rounded to the unit. */
export function annualMonthlyEquivalent(monthlyPrice: number): number {
  return Math.round((monthlyPrice * ANNUAL_MONTHS_CHARGED) / 12);
}

/** Price per year on the annual plan. */
export function annualTotal(monthlyPrice: number): number {
  return monthlyPrice * ANNUAL_MONTHS_CHARGED;
}

/** Monthly fee during the founding period (rounded to the unit). */
export function foundingPrice(monthlyPrice: number): number {
  return Math.round(monthlyPrice * (1 - FOUNDING_OFFER.discountPercent / 100));
}

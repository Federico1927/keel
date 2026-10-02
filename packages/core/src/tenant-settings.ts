import { z } from "zod";
import { TENANT_SETTING_DEFAULTS } from "@keel/config";

export const PAYMENT_METHODS = ["card", "wallet", "bank_transfer", "cod", "bnpl", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const feeMap = z.object({
  card: z.number().int().min(0),
  wallet: z.number().int().min(0),
  bank_transfer: z.number().int().min(0),
  cod: z.number().int().min(0),
  bnpl: z.number().int().min(0),
  other: z.number().int().min(0),
});

/** Typed shape of `tenants.settings`. Every field has a neutral default. */
export const tenantSettingsSchema = z.object({
  lowStockThreshold: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.lowStockThreshold),
  coverageDaysWarning: z.number().int().min(1).default(TENANT_SETTING_DEFAULTS.coverageDaysWarning),
  coverageDaysCritical: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.coverageDaysCritical),
  salesVelocityLookbackDays: z.number().int().min(1).max(365).default(TENANT_SETTING_DEFAULTS.salesVelocityLookbackDays),
  reorderTargetDays: z.number().int().min(1).max(365).default(TENANT_SETTING_DEFAULTS.reorderTargetDays),
  roiGood: z.number().default(TENANT_SETTING_DEFAULTS.roiGood),
  roiMedium: z.number().default(TENANT_SETTING_DEFAULTS.roiMedium),
  campaignStockThreshold: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.campaignStockThreshold),
  duplicateOrderWindowDays: z.number().int().min(0).max(60).default(TENANT_SETTING_DEFAULTS.duplicateOrderWindowDays),
  shipmentStuckDays: z.number().int().min(1).default(TENANT_SETTING_DEFAULTS.shipmentStuckDays),
  shipmentFreshnessHours: z.number().int().min(1).default(TENANT_SETTING_DEFAULTS.shipmentFreshnessHours),
  shipmentStickyExceptionDays: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.shipmentStickyExceptionDays),
  returnWindowDays: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.returnWindowDays),
  returnShippingFallbackDays: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.returnShippingFallbackDays),
  /** Product types that can never be returned (e.g. gift cards); matched case-insensitively. */
  returnExcludedProductTypes: z.array(z.string().max(80)).max(50).default([]),
  /** Return shipping cost deducted from the refund when the reason puts the fault on the customer (0 = never). */
  returnShippingCostMinor: z.number().int().min(0).default(0),
  /** Cost of a return label and of handling one return (inspection, repacking), for the P/L. */
  returnLabelCostMinor: z.number().int().min(0).default(0),
  returnHandlingCostMinor: z.number().int().min(0).default(0),
  /** Customer predictions: P(active) in percent at or above which churn risk is low, and medium. */
  churnLowPct: z.number().int().min(1).max(100).default(70),
  churnMediumPct: z.number().int().min(0).max(100).default(40),
  /** Write returns to the commerce platform (return request, approval, restock, refund, close). */
  returnsWriteBack: z.boolean().default(true),
  /** Write product costs edited or imported in Keel to the commerce platform (Shopify `inventoryItem.unitCost`). */
  costWriteBack: z.boolean().default(false),
  /** Backorders: an order line stock cannot serve waits for an incoming purchase order and holds the order (`on_hold`, awaiting stock). */
  backorderHold: z.boolean().default(true),
  /** While an order waits for stock, also place a fulfillment hold on the commerce platform so the warehouse does not ship it. */
  backorderPlatformHold: z.boolean().default(true),
  /** Order tags written on the platform when a return reaches a status (e.g. refunded → "REFUNDED"). */
  returnPlatformTags: z.record(z.string(), z.array(z.string().max(40)).max(5)).default({}),
  paymentFeeBps: feeMap.default({ ...TENANT_SETTING_DEFAULTS.paymentFeeBps }),
  paymentFeeFixedMinor: feeMap.default({ ...TENANT_SETTING_DEFAULTS.paymentFeeFixedMinor }),
  shippingCostMinor: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.shippingCostMinor),
  /** Gateway name (lowercased) → normalized payment method. Seeded with common gateways. */
  gatewayMap: z.record(z.string(), z.enum(PAYMENT_METHODS)).default({}),
  /**
   * Per-tenant switches for behaviour that exists in the code base but is wanted by one account
   * only (`"orders.show_vat_column": true`). Read with `hasFeature`; set from the console.
   * A switch is cheaper than an add-on and leaves no trace in the core when it is off.
   */
  featureFlags: z.record(z.string().max(80), z.boolean()).default({}),
  /** Replenishment: target service level (basis points, 9500 = 95 %), days of demand each order covers, cover thresholds for analysis and transfers. */
  serviceLevelBps: z.number().int().min(5000).max(9990).default(9500),
  reviewDays: z.number().int().min(7).max(180).default(30),
  excessCoverDays: z.number().int().min(30).max(720).default(120),
  slowCoverDays: z.number().int().min(30).max(720).default(180),
  /** Markdown suggestions (issue #30): minimum gross margin on the net-of-tax price a markdown may leave, basis points (2000 = 20 %). */
  markdownMinMarginBps: z.number().int().min(0).max(9500).default(2000),
  transferShortDays: z.number().int().min(1).max(90).default(14),
  transferSurplusDays: z.number().int().min(7).max(365).default(45),
  /** Notifications: a paid order still unshipped after this many hours is late to ship; a sync is late after its freshness window plus this grace. */
  lateToShipHours: z.number().int().min(1).max(720).default(48),
  /** Fulfilment (issue #28): an order ready to ship is late after this many working days (tenant time zone); `lateToShipHours` is kept for old rows only. */
  lateToShipBusinessDays: z.number().int().min(0).max(30).default(2),
  /** Working days for the shipping clock, ISO weekdays (1 = Monday … 7 = Sunday). */
  workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5]),
  /** Where delivery-exception instructions go by email when no carrier connector is available (the carrier's customer service). */
  carrierInstructionEmail: z.string().email().max(200).nullable().default(null),
  syncDelayGraceMinutes: z.number().int().min(0).max(10_080).default(60),
  /** Dashboards (issue #43): users may copy a tenant dashboard into a personal one; the tenant's dashboards stay the reference. */
  personalDashboards: z.boolean().default(true),
  /** Ads below the campaign (issue #40): daily rows of ad sets, assets, keywords and search terms are kept this many days, then rolled up to months. */
  adsDailyRetentionDays: z.number().int().min(30).max(730).default(90),
  /** Search terms under this many impressions (per day without spend, per month at roll-up) are grouped under "(other)". */
  adsSearchTermMinImpressions: z.number().int().min(0).max(100_000).default(10),
  /** Spend an ad, asset or search term must reach in the period before Keel suggests pausing it or excluding it. */
  adsMinSpendMinor: z.number().int().min(0).default(2000),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

/** True when the tenant switched this feature on. Unknown keys are off. */
export function hasFeature(settings: Pick<TenantSettings, "featureFlags">, key: string): boolean {
  return settings.featureFlags[key] === true;
}

export function parseTenantSettings(raw: unknown): TenantSettings {
  const result = tenantSettingsSchema.safeParse(raw ?? {});
  return result.success ? result.data : tenantSettingsSchema.parse({});
}

/** Default gateway → method map used when a tenant has no override. */
export const DEFAULT_GATEWAY_MAP: Record<string, PaymentMethod> = {
  shopify_payments: "card",
  stripe: "card",
  card: "card",
  credit_card: "card",
  adyen: "card",
  braintree: "card",
  paypal: "wallet",
  apple_pay: "wallet",
  google_pay: "wallet",
  shop_pay: "wallet",
  amazon_pay: "wallet",
  bank_deposit: "bank_transfer",
  bank_transfer: "bank_transfer",
  bonifico: "bank_transfer",
  wire: "bank_transfer",
  cash_on_delivery: "cod",
  cod: "cod",
  contrassegno: "cod",
  "cash on delivery (cod)": "cod",
  klarna: "bnpl",
  afterpay: "bnpl",
  clearpay: "bnpl",
  scalapay: "bnpl",
  affirm: "bnpl",
  sezzle: "bnpl",
  manual: "other",
  gift_card: "other",
};

export function normalizePaymentMethod(gateways: readonly string[], override: Record<string, PaymentMethod> = {}): PaymentMethod {
  for (const raw of gateways) {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const direct = override[key] ?? override[raw.trim().toLowerCase()] ?? DEFAULT_GATEWAY_MAP[key] ?? DEFAULT_GATEWAY_MAP[raw.trim().toLowerCase()];
    if (direct) return direct;
    if (/cod|cash_on|contrassegno|contra_reembolso|nachnahme/.test(key)) return "cod";
    if (/paypal|apple|google|shop_pay|wallet|amazon/.test(key)) return "wallet";
    if (/bank|bonifico|wire|sepa|transfer/.test(key)) return "bank_transfer";
    if (/klarna|afterpay|clearpay|scalapay|affirm|sezzle|bnpl|installment|rate/.test(key)) return "bnpl";
    if (/card|stripe|adyen|visa|mastercard|checkout|payments/.test(key)) return "card";
  }
  return "other";
}

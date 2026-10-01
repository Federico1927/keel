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
  paymentFeeBps: feeMap.default({ ...TENANT_SETTING_DEFAULTS.paymentFeeBps }),
  paymentFeeFixedMinor: feeMap.default({ ...TENANT_SETTING_DEFAULTS.paymentFeeFixedMinor }),
  shippingCostMinor: z.number().int().min(0).default(TENANT_SETTING_DEFAULTS.shippingCostMinor),
  /** Gateway name (lowercased) → normalized payment method. Seeded with common gateways. */
  gatewayMap: z.record(z.string(), z.enum(PAYMENT_METHODS)).default({}),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

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

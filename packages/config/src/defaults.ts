/** Neutral defaults for tenant settings; every value is overridable per tenant. */
export const TENANT_SETTING_DEFAULTS = {
  lowStockThreshold: 10,
  coverageDaysWarning: 21,
  coverageDaysCritical: 7,
  salesVelocityLookbackDays: 30,
  reorderTargetDays: 30,
  roiGood: 0.8,
  roiMedium: 0.2,
  campaignStockThreshold: 30,
  duplicateOrderWindowDays: 5,
  shipmentStuckDays: 7,
  shipmentFreshnessHours: 24,
  shipmentStickyExceptionDays: 15,
  returnWindowDays: 14,
  returnShippingFallbackDays: 5,
  /** Payment fee percentage per normalized method, in basis points. */
  paymentFeeBps: { card: 180, wallet: 250, bank_transfer: 0, cod: 0, bnpl: 400, other: 0 },
  /** Fixed payment fee per order per method, minor units. */
  paymentFeeFixedMinor: { card: 25, wallet: 25, bank_transfer: 0, cod: 0, bnpl: 30, other: 0 },
  /** Default shipping cost per shipment, minor units, used until a cost setting exists. */
  shippingCostMinor: 650,
} as const;

export const PAGE_SIZE = 50;
export const MAX_SEGMENT_DEPTH = 3;
export const MAX_SEGMENT_CONDITIONS = 30;
/** One-click discounts offered on an existing order (basis points); custom % or amounts are always possible. */
export const ORDER_DISCOUNT_PRESETS_BPS = [500, 1000, 1500, 2000] as const;

/** Days processed webhook events, finished platform writes, sync runs and job rows are kept (platform-wide, not per tenant). */
export const PLATFORM_RETENTION_DAYS_DEFAULT = 14;

/** Days drift rows that record lost stock (unexplained falls, unreported levels) are kept for the unexplained-loss report, whatever the platform window. */
export const INVENTORY_LOSS_RETENTION_DAYS = 400;

/** Retention window from `HULLWISE_RETENTION_DAYS` (1–365), the default otherwise. */
export function platformRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HULLWISE_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : PLATFORM_RETENTION_DAYS_DEFAULT;
}

/** Days a supplier purchase order link stays valid after it is issued (resend issues a new one). */
export const SUPPLIER_LINK_TTL_DAYS = 30;

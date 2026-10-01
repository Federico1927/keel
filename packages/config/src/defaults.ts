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

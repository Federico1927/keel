/** Canonical order lifecycle (CLAUDE.md §4). Independent of the commerce platform. */
export const ORDER_STATUSES = [
  "new",
  "pending_review",
  "confirmed",
  "fulfilling",
  "shipped",
  "delivered",
  "on_hold",
  "cancelled",
  "returned_partial",
  "returned",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses that count as a completed sale for revenue and profit. */
export const SALE_STATUSES: readonly OrderStatus[] = ["confirmed", "fulfilling", "shipped", "delivered", "returned_partial"];
/** Statuses excluded from revenue, profit and campaign attribution. */
export const NON_SALE_STATUSES: readonly OrderStatus[] = ["cancelled", "returned", "refunded"];
/** Open statuses: the order still needs work. */
export const OPEN_STATUSES: readonly OrderStatus[] = ["new", "pending_review", "confirmed", "fulfilling", "on_hold"];
export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "cancelled", "returned", "refunded"];

export const PAYMENT_STATUSES = ["pending", "paid", "partially_refunded", "refunded", "voided"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SHIPMENT_STATUSES = [
  "pending",
  "label_created",
  "in_transit",
  "out_for_delivery",
  "attempted",
  "delivered",
  "exception",
  "returned",
  "failed",
  "unknown",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_FINAL_STATUSES: readonly ShipmentStatus[] = ["delivered", "returned", "failed"];
export const SHIPMENT_EXCEPTION_STATUSES: readonly ShipmentStatus[] = ["attempted", "exception", "failed"];

export const RETURN_STATUSES = ["requested", "approved", "received", "inspected", "refunded", "exchanged", "voucher_issued", "rejected"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_RESOLUTIONS = ["refund", "exchange", "voucher"] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];
export const RETURN_FAULTS = ["merchant", "customer", "undetermined"] as const;
export type ReturnFault = (typeof RETURN_FAULTS)[number];
export const INSPECTION_OUTCOMES = ["intact", "damaged", "missing"] as const;

export const PURCHASE_ORDER_STATUSES = ["draft", "sent", "confirmed", "in_transit", "partially_received", "received", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
/** Purchase orders counted as incoming stock. */
export const INCOMING_PO_STATUSES: readonly PurchaseOrderStatus[] = ["confirmed", "in_transit", "partially_received"];

/** The canonical list lives in @keel/config (plan modules gate some platforms); re-exported for domain code. */
export { AD_PLATFORMS, isAdPlatform, type AdPlatform } from "@keel/config";
export const CAMPAIGN_STATUSES = ["active", "paused", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const INTEGRATION_PROVIDERS = ["shopify", "meta", "google", "tiktok", "ga4", "messaging", "warehouse", "carrier"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export const INTEGRATION_STATUSES = ["not_connected", "connected", "error", "syncing"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const ORDER_EVENT_TYPES = [
  "imported",
  "platform_update",
  "status_changed",
  "payment_updated",
  "fulfillment_updated",
  "shipment_updated",
  "note_added",
  "assigned",
  "cancelled",
  "return_requested",
  "return_updated",
  "manual_payment_recorded",
  "hold_set",
  "hold_released",
  "cod_attempt",
  "cod_assigned",
  "modified",
  "replaces",
  "replaced",
  "discount_applied",
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Attribution channels, the same values `deriveChannel` produces from live orders. */
export const CHANNELS = [
  "paid_social",
  "paid_search",
  "organic_search",
  "social",
  "email",
  "referral",
  "direct",
  "marketplace",
  "unknown",
] as const;
export type Channel = (typeof CHANNELS)[number];

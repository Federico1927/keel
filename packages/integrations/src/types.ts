import type { PaymentMethod, PaymentStatus, ShipmentStatus } from "@keel/core";

/** Normalized shapes every commerce adapter returns. Platform-specific fields never leak past the adapter. */
export interface Address {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface NormalizedCustomer {
  externalId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  city: string | null;
  zip: string | null;
  acceptsMarketing: boolean;
  tags: string[];
  platformCreatedAt: Date | null;
}

export interface NormalizedOrderLine {
  externalId: string;
  variantExternalId: string | null;
  productExternalId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  currentQuantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  totalMinor: number;
}

export interface NormalizedDiscountApplication {
  code: string;
  type: "percentage" | "fixed_amount" | "free_shipping";
  amountMinor: number;
}

export interface NormalizedOrder {
  externalId: string;
  orderNumber: number;
  name: string;
  customer: NormalizedCustomer | null;
  email: string | null;
  phone: string | null;
  customerName: string | null;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  refundedMinor: number;
  paymentGateways: string[];
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  financialStatusRaw: string | null;
  fulfillmentStatusRaw: string | null;
  tags: string[];
  shippingAddress: Address | null;
  billingAddress: Address | null;
  note: string | null;
  noteAttributes: { name: string; value: string }[];
  landingSite: string | null;
  referringSite: string | null;
  sourceChannel: string;
  placedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  closedAt: Date | null;
  platformUpdatedAt: Date;
  lines: NormalizedOrderLine[];
  discounts: NormalizedDiscountApplication[];
  fulfillments: NormalizedFulfillment[];
}

export interface NormalizedFulfillment {
  externalId: string;
  status: ShipmentStatus;
  externalStatus: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
}

export interface NormalizedProduct {
  externalId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: "active" | "draft" | "archived";
  tags: string[];
  options: { name: string; values: string[] }[];
  imageUrl: string | null;
  platformCreatedAt: Date | null;
  variants: NormalizedVariant[];
}

export interface NormalizedVariant {
  externalId: string;
  inventoryItemExternalId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  compareAtMinor: number | null;
  weightGrams: number | null;
}

export interface NormalizedInventoryLevel {
  inventoryItemExternalId: string;
  locationExternalId: string;
  available: number;
  onHand: number | null;
  committed: number | null;
  updatedAt: Date;
}

export interface NormalizedLocation {
  externalId: string;
  name: string;
  country: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface NormalizedDiscount {
  externalId: string;
  code: string;
  title: string | null;
  type: "percentage" | "fixed_amount" | "free_shipping";
  value: number;
  minimumAmountMinor: number | null;
  usageLimit: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
}

export interface NormalizedReturn {
  externalId: string;
  orderExternalId: string;
  status: string;
  requestedAt: Date;
  lines: { orderLineExternalId: string; quantity: number; reason: string | null }[];
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null when finished. */
  nextCursor: string | null;
}

export interface SyncQuery {
  cursor?: string | null;
  updatedSince?: Date | null;
  createdSince?: Date | null;
  limit?: number;
}

export interface WebhookRegistration {
  topic: string;
  address: string;
  status: "registered" | "existing" | "failed";
  error?: string;
}

export interface ConnectionTest {
  ok: boolean;
  accountName?: string;
  accountId?: string;
  scopes?: string[];
  missingScopes?: string[];
  error?: string;
}

export interface VerifiedWebhook {
  topic: string;
  externalId: string;
  sourceUpdatedAt: string;
  payload: unknown;
}

/** Commerce platform contract (Shopify today, anything tomorrow). */
export interface CommercePlatform {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  fetchOrders(q: SyncQuery): Promise<Page<NormalizedOrder>>;
  fetchOrder(externalId: string): Promise<NormalizedOrder | null>;
  fetchCustomers(q: SyncQuery): Promise<Page<NormalizedCustomer>>;
  fetchProducts(q: SyncQuery): Promise<Page<NormalizedProduct>>;
  fetchLocations(): Promise<NormalizedLocation[]>;
  fetchInventoryLevels(inventoryItemExternalIds: string[]): Promise<NormalizedInventoryLevel[]>;
  fetchDiscounts(q: SyncQuery): Promise<Page<NormalizedDiscount>>;
  fetchReturns(q: SyncQuery): Promise<Page<NormalizedReturn>>;
  registerWebhooks(callbackUrl: string, topics: string[]): Promise<WebhookRegistration[]>;
  /** Verifies the signature and normalizes the envelope; throws on invalid signature. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<VerifiedWebhook>;
  parseWebhookOrder(payload: unknown): NormalizedOrder;
  // Writes
  cancelOrder(externalId: string, opts: { reason?: string; restock: boolean; refund: boolean }): Promise<void>;
  addOrderNote(externalId: string, note: string): Promise<void>;
  updateOrderTags(externalId: string, add: string[], remove: string[]): Promise<void>;
  updateVariant(variantExternalId: string, patch: { priceMinor?: number }): Promise<void>;
  updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived"): Promise<void>;
  setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number): Promise<void>;
  createDiscountCode(input: { code: string; title: string; type: "percentage" | "fixed_amount" | "free_shipping"; value: number; startsAt?: Date | null; endsAt?: Date | null; usageLimit?: number | null; minimumAmountMinor?: number | null }): Promise<{ externalId: string }>;
  createDiscountPool(input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null }): Promise<{ externalId: string; imported: string[]; failed: string[] }>;
  restockReturn(orderExternalId: string, lines: { orderLineExternalId: string; quantity: number; locationExternalId: string }[]): Promise<void>;
}

export interface NormalizedCampaign {
  externalId: string;
  accountExternalId: string;
  name: string;
  status: "active" | "paused" | "archived";
  objective: string | null;
  dailyBudgetMinor: number | null;
  currency: string | null;
  platformCreatedAt: Date | null;
  /** URLs found in ads/creatives, used to suggest linked products. */
  landingUrls?: string[];
}

export interface NormalizedAdMetric {
  campaignExternalId: string;
  date: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  viewContent: number;
  purchases: number;
  purchaseValueMinor: number;
}

export interface AdsPlatform {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  fetchCampaigns(): Promise<NormalizedCampaign[]>;
  fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]>;
  /** Google is read-only in the MVP; its adapter throws `unsupported`. */
  setCampaignStatus(externalId: string, status: "active" | "paused"): Promise<void>;
}

export interface AnalyticsPlatform {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  fetchDailySessions(window: { since: string; until: string }): Promise<{ date: string; sessions: number; channel: string }[]>;
}

/** Slots for per-account integrations: interfaces + mock only (CLAUDE.md §6.1). */
export interface MessagingChannel {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  sendMessage(input: { to: string; template: string; variables: Record<string, string> }): Promise<{ messageId: string }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ messageId: string; status: "sent" | "delivered" | "read" | "failed"; raw: unknown }>;
}

export interface WarehouseProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  pushOrder(order: NormalizedOrder): Promise<{ externalId: string }>;
  fetchStock(): Promise<{ sku: string; available: number }[]>;
  fetchShipmentStatus(orderExternalId: string): Promise<{ status: ShipmentStatus; externalStatus: string; at: Date } | null>;
}

export interface CarrierProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  track(trackingNumber: string): Promise<{ status: ShipmentStatus; externalStatus: string; events: { status: ShipmentStatus; description: string; location: string | null; at: Date }[] }>;
}

export class IntegrationError extends Error {
  constructor(
    public readonly code: "rate_limited" | "token_expired" | "permission" | "invalid_request" | "not_found" | "unsupported" | "network" | "unknown",
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

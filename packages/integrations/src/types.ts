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

export interface OrderDetailsPatch {
  shippingAddress?: Address | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
}

export interface CreateOrderInput {
  lines: { variantExternalId: string | null; sku: string | null; title: string; quantity: number; unitPriceMinor: number }[];
  currency: string;
  email: string | null;
  phone: string | null;
  customerExternalId: string | null;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  shippingMinor: number;
  discountMinor: number;
  note: string | null;
  tags: string[];
  noteAttributes: { name: string; value: string }[];
  /** Lineage, for the platform note / attributes: the order this one replaces. */
  replacesOrderName: string | null;
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
  /** Unit cost on the platform (Shopify `inventoryItem.unitCost`); undefined when the payload does not carry it (REST webhooks). */
  costMinor?: number | null;
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
  parseWebhookProduct(payload: unknown): NormalizedProduct;
  parseWebhookCustomer(payload: unknown): NormalizedCustomer | null;
  parseWebhookInventoryLevel(payload: unknown): NormalizedInventoryLevel;
  // Writes
  cancelOrder(externalId: string, opts: { reason?: string; restock: boolean; refund: boolean }): Promise<void>;
  /** Contact and note changes on an open order (address, phone, email, note). Line changes go through `createOrder` + `cancelOrder`. */
  updateOrderDetails(externalId: string, patch: OrderDetailsPatch): Promise<void>;
  /** Creates an unpaid order (payment pending, e.g. cash on delivery) and returns it normalized, as a sync would. */
  createOrder(input: CreateOrderInput): Promise<NormalizedOrder>;
  /** Draft order the customer pays through the platform's invoice (exchange with a difference to pay); the order arrives by webhook once paid. */
  createInvoiceOrder(input: CreateOrderInput): Promise<{ draftExternalId: string; invoiceUrl: string | null }>;
  addOrderNote(externalId: string, note: string): Promise<void>;
  updateOrderTags(externalId: string, add: string[], remove: string[]): Promise<void>;
  updateVariant(variantExternalId: string, patch: { priceMinor?: number }): Promise<void>;
  updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived"): Promise<void>;
  /** Unit cost of a variant on the platform (Shopify: the inventory item's `cost`); the inventory item id is looked up when unknown. */
  updateVariantCost(variant: { variantExternalId: string; inventoryItemExternalId: string | null }, costMinor: number): Promise<void>;
  setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number): Promise<void>;
  createDiscountCode(input: { code: string; title: string; type: "percentage" | "fixed_amount" | "free_shipping"; value: number; startsAt?: Date | null; endsAt?: Date | null; usageLimit?: number | null; minimumAmountMinor?: number | null }): Promise<{ externalId: string }>;
  createDiscountPool(input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null }): Promise<{ externalId: string; imported: string[]; failed: string[] }>;
  /** Adds returned units back to stock at a location (inventory item ids, not order lines). */
  restockInventory(lines: { inventoryItemExternalId: string; locationExternalId: string; quantity: number }[]): Promise<void>;
  // Returns write-back: request → approve or decline → (restock) → refund → close.
  /** Opens a return request on the order; the order must be fulfilled on the platform. */
  requestReturn(orderExternalId: string, input: { lines: PlatformReturnLineInput[]; note?: string | null }): Promise<{ externalId: string; lines: { orderLineExternalId: string; externalId: string }[] }>;
  approveReturn(returnExternalId: string): Promise<void>;
  declineReturn(returnExternalId: string, note: string | null): Promise<void>;
  /** Refunds returned lines; the amount is capped by what was actually captured. Unpaid orders get a refund without money movement. */
  refundReturn(orderExternalId: string, input: { lines: { orderLineExternalId: string; quantity: number }[]; amountMinor: number; currency: string; note?: string | null; notify: boolean }): Promise<{ externalId: string; amountMinor: number }>;
  closeReturn(returnExternalId: string): Promise<void>;
}

export interface PlatformReturnLineInput {
  orderLineExternalId: string;
  quantity: number;
  /** Platform reason code (Shopify ReturnReason: SIZE_TOO_SMALL, DEFECTIVE, …); null = OTHER. */
  reason: string | null;
  note?: string | null;
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

/**
 * Payment guarantee for instant exchanges: a hold on the customer's card for the value of the
 * items still to come back. Voided when they arrive, captured when they do not. Live providers
 * (Stripe manual capture, Shopify Payments vaulted card) plug in here; the mock records calls.
 */
export interface PaymentGuarantee {
  readonly provider: string;
  authorize(input: { amountMinor: number; currency: string; customerEmail: string | null; reference: string }): Promise<{ authId: string; status: "authorized" | "requires_action" | "failed"; actionUrl: string | null }>;
  capture(authId: string, amountMinor?: number): Promise<void>;
  void(authId: string): Promise<void>;
}

/**
 * Return labels (prepaid shipping label or QR code for drop-off). Live providers (EasyPost,
 * Shippo, a carrier's own API) plug in here; the mock returns a tracking code and lets Keel
 * render the label itself.
 */
export interface ReturnLabelProvider {
  readonly provider: string;
  createLabel(input: { reference: string; from: Address | null; to: string; weightGrams: number | null }): Promise<{ carrier: string; trackingCode: string; labelUrl: string | null; qrCode: string | null }>;
}

/* ---------- audience destinations (segment sync) ---------- */

/** Where a segment can be pushed. Live adapters need the account's own credentials (external block); only mocks exist. */
export const AUDIENCE_PROVIDERS = ["meta_custom_audience", "google_customer_match", "email_tool"] as const;
export type AudienceProvider = (typeof AUDIENCE_PROVIDERS)[number];

export interface AudienceMember {
  customerId: string;
  email: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
}

/** What a destination receives for one customer: hashed identifiers for ad platforms, plain profile fields for email tools. */
export interface AudienceMatchKeys {
  customerId: string;
  keys: Record<string, string>;
}

export interface AudienceDestination {
  readonly provider: AudienceProvider;
  testConnection(): Promise<ConnectionTest>;
  /** Creates the audience (or list) when `existingId` is null; returns its id. */
  ensureAudience(name: string, existingId: string | null): Promise<{ audienceId: string }>;
  addMembers(audienceId: string, members: AudienceMatchKeys[]): Promise<{ accepted: number }>;
  removeMembers(audienceId: string, members: AudienceMatchKeys[]): Promise<{ removed: number }>;
}

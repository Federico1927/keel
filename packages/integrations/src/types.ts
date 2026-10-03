import type { BalanceTransactionType, PaymentMethod, PaymentStatus, PayoutStatus, ShipmentStatus } from "@hullwise/core";

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
  /** Not every platform can change it after checkout (Shopify's orderUpdate cannot): adapters that can't ignore it and Hullwise keeps it locally. */
  billingAddress?: Address | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
}

/** Discount added to an existing, unfulfilled order. */
export interface OrderDiscountPatch {
  type: "percentage" | "fixed_amount";
  /** Basis points for a percentage, minor units for a fixed amount. */
  value: number;
  /** Amount in minor units as Hullwise computed it (the adapter may spread it across lines). */
  amountMinor: number;
  currency: string;
  code: string;
  reason?: string | null;
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
  /**
   * Payment state carried over from the replaced order. `paid` marks the new order paid (the money
   * stays with the cancelled one, which is not refunded); omitted = payment pending (cash on delivery).
   */
  payment?: { method: PaymentMethod; status: "pending" | "paid"; gateways: string[] };
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

/** Fulfilment created from Hullwise (issue #28): lines omitted = everything still unfulfilled on the order. */
export interface CreateFulfillmentInput {
  orderExternalId: string;
  lines?: { orderLineExternalId: string; quantity: number }[];
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  notifyCustomer: boolean;
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
  /*
   * Full mirror (issue #19). Optional: undefined = the payload does not carry the field (REST
   * webhook, a mock built from a few variants) and the stored value is kept.
   */
  /** The platform's last change; an edit opened on an older version is refused. */
  platformUpdatedAt?: Date | null;
  descriptionHtml?: string | null;
  seo?: { title: string | null; description: string | null };
  /** Standard taxonomy category: id and full name. */
  category?: { id: string; name: string } | null;
  collections?: NormalizedCollectionRef[];
  /** Sales channels (Shopify publications) and whether the product is published on each. */
  publishedChannels?: NormalizedPublication[];
  /** First metafields, read-only. */
  metafields?: NormalizedMetafield[];
  /** Gallery in display order. */
  media?: NormalizedMedia[];
}

export interface NormalizedMedia {
  /** Platform media id, as the platform writes it back (Shopify: the media gid, its type included). */
  externalId: string;
  type: "image" | "video" | "model";
  /** Always an image: the preview for videos and 3D models. */
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}
export interface NormalizedCollectionRef {
  id: string;
  title: string;
  handle: string | null;
}
export interface NormalizedPublication {
  id: string;
  name: string;
  published: boolean;
  publishedAt: string | null;
}
export interface NormalizedMetafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** Product fields Hullwise edits (issue #19); everything else is edited on the platform. */
export interface ProductPatch {
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  /** The whole tag list (absolute). */
  tags?: string[];
  status?: "active" | "draft" | "archived";
  seo?: { title: string | null; description: string | null };
  /** Taxonomy category id; null removes the category. */
  categoryId?: string | null;
}

/** Gallery changes; each answers the product as the platform holds it afterwards. */
export type ProductMediaOperation =
  | { type: "create"; url: string; alt: string | null }
  | { type: "reorder"; mediaExternalIds: string[] }
  | { type: "delete"; mediaExternalIds: string[] }
  | { type: "alt"; mediaExternalId: string; alt: string | null };

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
  /* Mirror (issue #19); undefined = not in the payload. */
  /** The media shown for the variant (an id of `NormalizedProduct.media`). */
  imageMediaExternalId?: string | null;
  inventoryPolicy?: "deny" | "continue";
  tracksInventory?: boolean | null;
  requiresShipping?: boolean | null;
  taxable?: boolean | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
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
  /** Platform status, lower-cased (Shopify `ReturnStatus`: requested, open, declined, canceled, closed). */
  status: string;
  requestedAt: Date;
  closedAt?: Date | null;
  /** The customer's note on the request (first line note when the platform keeps notes per line). */
  note?: string | null;
  /** `externalId`: the platform's return line id; `reason`: platform reason code, lower-cased. */
  lines: { externalId?: string | null; orderLineExternalId: string; quantity: number; reason: string | null; note?: string | null }[];
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
  /** The missing scopes a core module cannot work without (Shopify), and every missing scope per module. */
  missingRequiredScopes?: string[];
  missingScopesByModule?: Record<string, string[]>;
  error?: string;
  /** The `IntegrationError` code behind `error`, when the adapter knows it (GA4's setup checklist explains it in plain words). */
  errorCode?: IntegrationError["code"];
}

export interface VerifiedWebhook {
  topic: string;
  externalId: string;
  sourceUpdatedAt: string;
  payload: unknown;
}

export interface VariantPatch {
  priceMinor?: number;
  compareAtMinor?: number | null;
  /* Issue #19: the variant fields Hullwise edits besides prices. */
  sku?: string | null;
  barcode?: string | null;
  weightGrams?: number | null;
  inventoryPolicy?: "deny" | "continue";
}

/** A deposit of the platform's payment processor (Shopify Payments) to the merchant's bank. */
export interface NormalizedPayout {
  externalId: string;
  status: PayoutStatus;
  issuedAt: Date;
  currency: string;
  /** Charges in the deposit, before fees. */
  grossMinor: number;
  /** Refunds (negative). */
  refundsMinor: number;
  /** Adjustments, disputes, reserves (signed). */
  adjustmentsMinor: number;
  feeMinor: number;
  netMinor: number;
}

/** One movement of the processor balance: a charge, a refund, an adjustment; its fee is the actual one. */
export interface NormalizedBalanceTransaction {
  externalId: string;
  payoutExternalId: string | null;
  type: BalanceTransactionType;
  orderExternalId: string | null;
  /** Signed: charges positive, refunds negative. */
  amountMinor: number;
  /** Fee the processor took (positive = cost). */
  feeMinor: number;
  netMinor: number;
  currency: string;
  occurredAt: Date;
}

/** Money-only or per-line refund; restocked lines go back to `locationExternalId` (default location when null). */
export interface RefundOrderInput {
  lines: { orderLineExternalId: string; quantity: number; restock: boolean }[];
  locationExternalId?: string | null;
  amountMinor: number;
  currency: string;
  note?: string | null;
  notify: boolean;
}

/** Payment received outside the platform's checkout (bank transfer, cash, cheque…). */
export interface ManualPaymentInput {
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  /** The amount settles the whole balance (Shopify `orderMarkAsPaid`); otherwise a partial manual payment. */
  fullBalance: boolean;
  note?: string | null;
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
  /** Returns of orders updated since `updatedSince` (any status), newest first; the nightly reconcile reads them. */
  fetchReturns(q: SyncQuery): Promise<Page<NormalizedReturn>>;
  fetchReturn(externalId: string): Promise<NormalizedReturn | null>;
  /** Payouts of the platform's payment processor issued since `createdSince`, newest first. */
  fetchPayouts(q: SyncQuery): Promise<Page<NormalizedPayout>>;
  /** Balance transactions (charges, refunds, adjustments with their actual fees) of one payout. */
  fetchBalanceTransactions(q: { payoutExternalId: string; cursor?: string | null; limit?: number }): Promise<Page<NormalizedBalanceTransaction>>;
  registerWebhooks(callbackUrl: string, topics: string[]): Promise<WebhookRegistration[]>;
  /** Removes the webhook subscriptions pointing at `callbackUrl` (the store leaves Hullwise); the others stay. */
  unregisterWebhooks(callbackUrl: string): Promise<{ removed: number; failed: number }>;
  /** Verifies the signature and normalizes the envelope; throws on invalid signature. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<VerifiedWebhook>;
  parseWebhookOrder(payload: unknown): NormalizedOrder;
  parseWebhookProduct(payload: unknown): NormalizedProduct;
  parseWebhookCustomer(payload: unknown): NormalizedCustomer | null;
  parseWebhookInventoryLevel(payload: unknown): NormalizedInventoryLevel;
  /** A `returns/*` payload normalized, or null when it lacks the lines (the caller then reads the return with `fetchReturn`). */
  parseWebhookReturn(payload: unknown): NormalizedReturn | null;
  // Writes
  cancelOrder(externalId: string, opts: { reason?: string; restock: boolean; refund: boolean }): Promise<void>;
  /** Contact and note changes on an open order (address, phone, email, note). Line changes go through `createOrder` + `cancelOrder`. */
  updateOrderDetails(externalId: string, patch: OrderDetailsPatch): Promise<void>;
  /** Creates an order (payment pending unless `input.payment.status` is `paid`) and returns it normalized, as a sync would. Used by cancel-and-recreate edits. */
  createOrder(input: CreateOrderInput): Promise<NormalizedOrder>;
  /** Draft order the customer pays through the platform's invoice (exchange with a difference to pay); the order arrives by webhook once paid. */
  createInvoiceOrder(input: CreateOrderInput): Promise<{ draftExternalId: string; invoiceUrl: string | null }>;
  /** Adds a manual discount to an open, unfulfilled order (order edit on the platform). */
  applyOrderDiscount(externalId: string, discount: OrderDiscountPatch): Promise<void>;
  addOrderNote(externalId: string, note: string): Promise<void>;
  /** Puts the order's open fulfillment orders on hold (e.g. waiting for stock) so the warehouse does not ship it. Idempotent. */
  holdFulfillment(externalId: string, hold: FulfillmentHoldInput): Promise<void>;
  /** Releases the holds Hullwise placed on the order; holds placed by others stay. A no-op when there is none. */
  releaseFulfillment(externalId: string): Promise<void>;
  updateOrderTags(externalId: string, add: string[], remove: string[]): Promise<void>;
  /** One product with every mirrored field (media, SEO, channels, metafields…); null when it does not exist. */
  fetchProduct(externalId: string): Promise<NormalizedProduct | null>;
  /** Writes the editable product fields and answers the product as the platform holds it afterwards. */
  updateProduct(externalId: string, patch: ProductPatch): Promise<NormalizedProduct>;
  /** Adds (from a URL), reorders, removes media or changes alt text; answers the product afterwards. */
  updateProductMedia(externalId: string, op: ProductMediaOperation): Promise<NormalizedProduct>;
  /** Variant fields: price and compare-at price (`compareAtMinor: null` removes it), SKU, barcode, weight, inventory policy. */
  updateVariant(variantExternalId: string, patch: VariantPatch): Promise<void>;
  updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived"): Promise<void>;
  updateProductTags(productExternalId: string, add: string[], remove: string[]): Promise<void>;
  /** Unit cost of a variant on the platform (Shopify: the inventory item's `cost`); the inventory item id is looked up when unknown. */
  updateVariantCost(variant: { variantExternalId: string; inventoryItemExternalId: string | null }, costMinor: number): Promise<void>;
  setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number): Promise<void>;
  createDiscountCode(input: { code: string; title: string; type: "percentage" | "fixed_amount" | "free_shipping"; value: number; startsAt?: Date | null; endsAt?: Date | null; usageLimit?: number | null; minimumAmountMinor?: number | null }): Promise<{ externalId: string }>;
  createDiscountPool(input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null }): Promise<{ externalId: string; imported: string[]; failed: string[] }>;
  /** Adds codes to an existing pool discount (top-up); codes the platform refused are returned in `failed`. */
  addDiscountPoolCodes(poolExternalId: string, codes: string[]): Promise<{ imported: string[]; failed: string[] }>;
  /**
   * Turns one code on or off on the platform. A standalone code is found by id (or by code when the id is
   * not known yet); a code of a pool is removed from (or added back to) the pool's discount.
   */
  setDiscountActive(discount: { externalId: string | null; code: string; poolExternalId?: string | null }, active: boolean): Promise<void>;
  /** Turns a whole pool on or off: every code of the pool's discount stops (or starts) being accepted. */
  setDiscountPoolActive(poolExternalId: string, active: boolean): Promise<void>;
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
  /** Records a payment received outside checkout on an order whose payment is pending. */
  markOrderPaid(externalId: string, input: ManualPaymentInput): Promise<void>;
  /**
   * Refunds money on an order, optionally on lines (with restock). The amount is capped by what was
   * captured and not yet refunded; the answer carries the amount the platform accepted.
   * `refundReturn` is this call without restock.
   */
  refundOrder(externalId: string, input: RefundOrderInput): Promise<{ externalId: string; amountMinor: number }>;
  /** Creates a fulfilment with carrier and tracking and returns it normalized, as a sync would read it. */
  createFulfillment(input: CreateFulfillmentInput): Promise<NormalizedFulfillment>;
}

export interface FulfillmentHoldInput {
  /** Why the order waits; mapped to the platform's reason codes (Shopify `FulfillmentHoldReason`). */
  reason: "awaiting_stock" | "other";
  note?: string | null;
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

/* ---------- below the campaign (issue #40) ---------- */

export type AdEntityStatus = "active" | "paused" | "archived";

/** Meta ad set or Google ad group. */
export interface NormalizedAdSet {
  externalId: string;
  campaignExternalId: string;
  name: string;
  status: AdEntityStatus;
  /** Optimization goal (Meta) or ad group type (Google). */
  optimizationGoal: string | null;
  dailyBudgetMinor: number | null;
}

export interface NormalizedAd {
  externalId: string;
  adSetExternalId: string | null;
  campaignExternalId: string;
  name: string;
  status: AdEntityStatus;
  /** image | video | carousel | collection | text | other */
  format: string;
  headline: string | null;
  body: string | null;
  finalUrl: string | null;
  /** Meta URL parameters or Google tracking template + final URL suffix: where the UTM template lives. */
  urlTags: string | null;
  thumbnailUrl: string | null;
}

/** A text, image or video piece of an ad the platform reports on (RSA headline, dynamic-creative body…). */
export interface NormalizedAdAsset {
  /** Platform asset id (Meta asset breakdown id, Google asset id). */
  assetExternalId: string;
  adExternalId: string | null;
  adSetExternalId: string | null;
  campaignExternalId: string;
  type: "text" | "image" | "video";
  /** headline | description | body | title | image | video | other */
  fieldType: string;
  text: string | null;
  url: string | null;
  /** Google's BEST / GOOD / LOW / LEARNING; null elsewhere. */
  performanceLabel: string | null;
}

export interface NormalizedKeyword {
  /** `adGroupId~criterionId` on Google. */
  externalId: string;
  adSetExternalId: string | null;
  campaignExternalId: string;
  text: string;
  matchType: "exact" | "phrase" | "broad";
  qualityScore: number | null;
  status: AdEntityStatus;
  negative: boolean;
}

export type AdEntityMetricLevel = "ad_set" | "ad" | "asset" | "keyword" | "search_term";

/**
 * One entity-day. `entityExternalId` is the ad set / ad / keyword id, the asset id (with `adExternalId`
 * and `fieldType`), or the search term text (with the ad group and the keyword that triggered it).
 */
export interface NormalizedEntityMetric {
  level: AdEntityMetricLevel;
  entityExternalId: string;
  campaignExternalId: string;
  adSetExternalId: string | null;
  adExternalId?: string | null;
  fieldType?: string | null;
  /** Search terms: the keyword that matched (`adGroupId~criterionId` when known), the term's own match type and status. */
  keywordExternalId?: string | null;
  keywordText?: string | null;
  matchType?: string | null;
  termStatus?: "added" | "excluded" | "none" | null;
  date: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  conversionValueMinor: number;
  videoViews3s: number;
  videoCompletions: number;
}

/** What a platform can report below the campaign; Hullwise hides the tabs a platform cannot fill. */
export interface AdsCapabilities {
  supportsKeywords: boolean;
  supportsSearchTerms: boolean;
  supportsAssetBreakdown: boolean;
  /** Pause an ad / add negative keywords (Google only with the write scope granted by the tenant). */
  supportsAdWrites: boolean;
}

export const NO_ADS_CAPABILITIES: AdsCapabilities = { supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: false, supportsAdWrites: false };

export interface NegativeKeywordInput {
  campaignExternalId: string;
  /** Ad group level when set, campaign level otherwise. */
  adSetExternalId?: string | null;
  text: string;
  matchType: "exact" | "phrase" | "broad";
}

export interface AdsPlatform {
  readonly provider: string;
  /** Optional for adapters that only report campaigns (all deeper methods are optional too). */
  readonly capabilities?: AdsCapabilities;
  testConnection(): Promise<ConnectionTest>;
  fetchCampaigns(): Promise<NormalizedCampaign[]>;
  fetchDailyMetrics(window: { since: string; until: string }): Promise<NormalizedAdMetric[]>;
  /** Google is read-only in the MVP; its adapter throws `unsupported`. */
  setCampaignStatus(externalId: string, status: "active" | "paused"): Promise<void>;
  fetchAdSets?(): Promise<NormalizedAdSet[]>;
  fetchAds?(): Promise<NormalizedAd[]>;
  fetchAssets?(): Promise<NormalizedAdAsset[]>;
  fetchKeywords?(): Promise<NormalizedKeyword[]>;
  fetchEntityMetrics?(level: AdEntityMetricLevel, window: { since: string; until: string }): Promise<NormalizedEntityMetric[]>;
  setAdStatus?(ad: { adExternalId: string; adSetExternalId: string | null }, status: "active" | "paused"): Promise<void>;
  addNegativeKeywords?(input: NegativeKeywordInput[]): Promise<{ created: number }>;
}

/**
 * One day of web traffic for one combination of channel group, source / medium / campaign and landing
 * page (GA4 `runReport`, #86). Strings are the vendor's values (`(not set)` when missing); `landingPath`
 * is the normalised path of `landingPage` (`normalizeLandingPath`). `totalUsers` is not additive across rows.
 */
export interface NormalizedTrafficRow {
  date: string;
  channelGroup: string;
  source: string;
  medium: string;
  campaignName: string;
  landingPage: string;
  landingPath: string;
  sessions: number;
  totalUsers: number;
  engagedSessions: number;
  addToCarts: number;
}

/** A GA4 property the credentials can read (the property picker). */
export interface AnalyticsProperty {
  propertyId: string;
  displayName: string;
  accountName: string | null;
  timeZone?: string | null;
  currencyCode?: string | null;
}

export interface AnalyticsPlatform {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  /** Properties the credentials can read; empty when the vendor cannot list them. */
  listProperties(): Promise<AnalyticsProperty[]>;
  /** Daily traffic over an inclusive window, every page of the report. */
  fetchDailyTraffic(window: { since: string; until: string }): Promise<NormalizedTrafficRow[]>;
}

/** One message to send. `meta` tells a channel that keeps its own message log what the message is about; others ignore it. */
export interface MessageSendInput {
  to: string;
  template: string;
  variables: Record<string, string>;
  idempotencyKey?: string;
  meta?: { purpose?: string; orderId?: string | null; customerId?: string | null; campaignId?: string | null };
}

/** Slots for per-account integrations: interfaces + mock only (CLAUDE.md §6.1). */
export interface MessagingChannel {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  /**
   * `idempotencyKey`: Hullwise's key for the message (campaign × customer × channel). Providers that
   * accept one must deliver a repeated key once and answer with the first message id; a send queue
   * resumed after a crash resends its unconfirmed messages with the same key.
   */
  sendMessage(input: MessageSendInput): Promise<{ messageId: string }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ messageId: string; status: "sent" | "delivered" | "read" | "failed"; raw: unknown }>;
}

export interface WarehouseProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  pushOrder(order: NormalizedOrder): Promise<{ externalId: string }>;
  fetchStock(): Promise<{ sku: string; available: number }[]>;
  fetchShipmentStatus(orderExternalId: string): Promise<{ status: ShipmentStatus; externalStatus: string; at: Date } | null>;
}

/** What to do with a parcel in exception (issue #28). `reference` is Hullwise's idempotency key for the instruction. */
export interface CarrierInstruction {
  reference: string;
  trackingNumber: string;
  carrier: string | null;
  resolution: "redeliver" | "new_address" | "pickup_point" | "return";
  address?: Address | null;
  pickupPoint?: string | null;
  note?: string | null;
}

export interface CarrierProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  track(trackingNumber: string): Promise<{ status: ShipmentStatus; externalStatus: string; events: { status: ShipmentStatus; description: string; location: string | null; at: Date }[] }>;
  /** Sends a delivery instruction for a parcel in exception; returns the carrier's reference. */
  sendInstruction(input: CarrierInstruction): Promise<{ reference: string }>;
}

/** A failed connection test with the adapter's error code when it has one (the setup checklists explain it in plain words). */
export function failedConnection(e: unknown): ConnectionTest {
  return { ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof IntegrationError ? { errorCode: e.code } : {}) };
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
 * Address provider slot: autocomplete and validation for the order-edit dialog. Live providers
 * (Google Places, Loqate, a national postal service) plug in here per account; only the mock exists.
 */
export interface AddressSuggestion {
  id: string;
  label: string;
  address: Address;
}
export interface AddressValidation {
  valid: boolean;
  issues: { field: "name" | "address1" | "city" | "zip" | "country" | "province"; code: "required" | "invalid_zip" | "invalid_country" | "not_found" }[];
  /** Cleaned version (trimmed, upper-case country and postal code), when the provider returns one. */
  normalized: Address | null;
}
export interface AddressProvider {
  readonly provider: string;
  testConnection(): Promise<ConnectionTest>;
  autocomplete(query: string, opts: { country: string | null; limit?: number }): Promise<AddressSuggestion[]>;
  validate(address: Address): Promise<AddressValidation>;
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
 * Shippo, a carrier's own API) plug in here; the mock returns a tracking code and lets Hullwise
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

import { normalizePaymentMethod } from "@hullwise/core";
import { createHmac } from "node:crypto";
import { createRng, type Rng } from "../rng";
import {
  type PlatformReturnLineInput,
  IntegrationError,
  type CommercePlatform,
  type ConnectionTest,
  type NormalizedCustomer,
  type NormalizedDiscount,
  type NormalizedInventoryLevel,
  type NormalizedLocation,
  type NormalizedOrder,
  type NormalizedProduct,
  type NormalizedReturn,
  type Page,
  type ProductMediaOperation,
  type ProductPatch,
  type SyncQuery,
  type VerifiedWebhook,
  type WebhookRegistration,
 type CreateOrderInput, type FulfillmentHoldInput, type ManualPaymentInput, type NormalizedBalanceTransaction, type NormalizedPayout, type OrderDetailsPatch, type OrderDiscountPatch, type RefundOrderInput, type VariantPatch, type CreateFulfillmentInput, type NormalizedFulfillment } from "../types";
import { FailureScript } from "./failures";
import { buildMockPayouts, isProcessorGateway, type MockPaymentOrder, type MockPayoutRefund } from "./payouts";
import { SHOPIFY_ALL_SCOPES, missingShopifyScopes } from "../shopify/oauth";

export interface MockCatalogVariant {
  externalId: string;
  productExternalId: string;
  inventoryItemExternalId: string;
  sku: string;
  title: string;
  productTitle: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  /** Unit cost the simulated store reports (`inventoryItem.unitCost`); null or absent = never entered. */
  unitCostMinor?: number | null;
  barcode?: string | null;
  productImageUrl?: string | null;
}

/** Return statuses as the simulated store reports them (Shopify `ReturnStatus`, lower-cased). */
export type MockReturnStatus = "requested" | "open" | "declined" | "canceled" | "closed";
interface MockReturn {
  externalId: string;
  orderExternalId: string;
  status: MockReturnStatus;
  requestedAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  note: string | null;
  lines: { externalId: string; orderLineExternalId: string; quantity: number; reason: string | null; note: string | null }[];
}

export interface MockCommerceOptions {
  seed?: number;
  currency: string;
  country: string;
  orderNumberPrefix: string;
  /** Catalog the mock draws from so generated orders match the tenant's products. */
  variants: MockCatalogVariant[];
  locations: NormalizedLocation[];
  customers: NormalizedCustomer[];
  startOrderNumber: number;
  webhookSecret?: string;
  /** Starting stock per inventory item and location (the tenant's levels); unknown pairs get a random level on first read. */
  inventory?: { inventoryItemExternalId: string; locationExternalId: string; available: number }[];
  /** The tenant's recent orders paid through the processor: payouts and fees are built from them (plus orders the mock creates). */
  paymentOrders?: MockPaymentOrder[];
  /**
   * Full products the simulated store holds (issue #19: media, SEO, channels, metafields…). Without
   * them the catalog is built from `variants`. Writes change this state and bump `platformUpdatedAt`.
   */
  products?: NormalizedProduct[];
  /** Scopes the simulated app installation holds (default: all of them); test connection reports the rest as missing (#89). */
  grantedScopes?: string[];
  /** Shop domain the simulator answers as (webhooks, test connection). */
  shopDomain?: string;
}

/** Category names the simulated store resolves when a category id is written. */
const MOCK_CATEGORY_NAMES: Record<string, string> = {};

/**
 * In-memory Shopify-like platform. It produces new orders on every `fetchOrders`
 * call (as a live store would), can emit webhook envelopes signed like Shopify, and
 * fails on demand (`failures.failNext`). No network, ever.
 */
export class MockCommercePlatform implements CommercePlatform {
  readonly provider = "shopify";
  readonly failures = new FailureScript();
  private rng: Rng;
  private orders = new Map<string, NormalizedOrder>();
  private nextNumber: number;
  private webhookSecret: string;
  private writes: { op: string; args: unknown }[] = [];
  /** Stock the store holds, per `item@location`: orders take from it, writes set or add to it. */
  private stock = new Map<string, number>();

  /** The store's products, by external id (issue #19). */
  private catalog = new Map<string, NormalizedProduct>();
  private mediaSeq = 9_000_000;

  constructor(private readonly opts: MockCommerceOptions) {
    this.rng = createRng(opts.seed ?? 42);
    this.nextNumber = opts.startOrderNumber;
    this.webhookSecret = opts.webhookSecret ?? "mock-webhook-secret";
    for (const l of opts.inventory ?? []) this.stock.set(`${l.inventoryItemExternalId}@${l.locationExternalId}`, l.available);
    if (opts.products) for (const p of opts.products) this.catalog.set(p.externalId, structuredClone(p));
    else
      for (const v of opts.variants) {
        let p = this.catalog.get(v.productExternalId);
        if (!p) {
          p = { externalId: v.productExternalId, title: v.productTitle, handle: v.productTitle.toLowerCase().replace(/\s+/g, "-"), vendor: "Mock", productType: null, status: "active", tags: [], options: [], imageUrl: v.productImageUrl ?? null, platformCreatedAt: null, variants: [] };
          this.catalog.set(v.productExternalId, p);
        }
        p.variants.push({ externalId: v.externalId, inventoryItemExternalId: v.inventoryItemExternalId, sku: v.sku, barcode: v.barcode ?? null, title: v.title, optionValues: v.optionValues, priceMinor: v.priceMinor, compareAtMinor: null, weightGrams: null, costMinor: v.unitCostMinor ?? null });
      }
  }

  /** A change made in the store admin behind Hullwise's back (tests: stale edits, sync). */
  simulateExternalEdit(productExternalId: string, patch: Partial<Omit<NormalizedProduct, "externalId" | "variants">>): NormalizedProduct {
    const p = this.productOrThrow(productExternalId);
    Object.assign(p, patch);
    this.touch(p);
    return structuredClone(p);
  }
  private productOrThrow(externalId: string): NormalizedProduct {
    const p = this.catalog.get(externalId);
    if (!p) throw new IntegrationError("not_found", `Product ${externalId} not found`);
    return p;
  }
  /** Every write moves `updatedAt` forward, as the store does. */
  private touch(p: NormalizedProduct): void {
    p.platformUpdatedAt = new Date(Math.max(Date.now(), (p.platformUpdatedAt?.getTime() ?? 0) + 1000));
  }
  private variantInCatalog(variantExternalId: string): { product: NormalizedProduct; variant: NormalizedProduct["variants"][number] } | null {
    for (const product of this.catalog.values()) {
      const variant = product.variants.find((v) => v.externalId === variantExternalId);
      if (variant) return { product, variant };
    }
    return null;
  }

  /** Current stock of an item at a location (tests). */
  stockOf(inventoryItemExternalId: string, locationExternalId: string): number | undefined {
    return this.stock.get(`${inventoryItemExternalId}@${locationExternalId}`);
  }
  /** Changes stock behind Hullwise's back, as a manual edit in the store admin would (tests, drift). */
  adjustStock(inventoryItemExternalId: string, locationExternalId: string, delta: number): void {
    const key = `${inventoryItemExternalId}@${locationExternalId}`;
    this.stock.set(key, (this.stock.get(key) ?? 0) + delta);
  }
  private defaultLocation(): string | null {
    return (this.opts.locations.find((l) => l.isDefault && l.isActive) ?? this.opts.locations.find((l) => l.isActive))?.externalId ?? null;
  }
  /** Units leave (or come back to) the default location, like a sale or a restocked cancellation. */
  private moveStock(lines: { variantExternalId: string | null; quantity: number }[], sign: 1 | -1): void {
    const loc = this.defaultLocation();
    if (!loc) return;
    for (const l of lines) {
      const inv = this.opts.variants.find((v) => v.externalId === l.variantExternalId)?.inventoryItemExternalId;
      if (inv && this.stock.has(`${inv}@${loc}`)) this.adjustStock(inv, loc, sign * l.quantity);
    }
  }

  /** Audit of write calls, for tests and the integrations page. */
  get writeLog() {
    return this.writes;
  }

  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    const scopes = this.opts.grantedScopes ?? SHOPIFY_ALL_SCOPES;
    const missing = missingShopifyScopes(scopes);
    return { ok: true, accountName: "Mock Store", accountId: this.opts.shopDomain ?? "mock-shop.myshopify.com", scopes, missingScopes: [...missing.required, ...missing.optional], missingRequiredScopes: missing.required, missingScopesByModule: missing.byModule };
  }

  /** Builds a plausible new order from the catalog. */
  generateOrder(at = new Date()): NormalizedOrder {
    const rng = this.rng;
    const number = this.nextNumber++;
    const customer = rng.pick(this.opts.customers);
    const lineCount = rng.weighted([[1, 60], [2, 28], [3, 10], [4, 2]] as const);
    const chosen = rng.shuffle(this.opts.variants).slice(0, lineCount);
    const lines = chosen.map((v, i) => {
      const qty = rng.weighted([[1, 85], [2, 13], [3, 2]] as const);
      return {
        externalId: `${number}-${i + 1}`,
        variantExternalId: v.externalId,
        productExternalId: v.productExternalId,
        sku: v.sku,
        title: v.productTitle,
        variantTitle: v.title,
        quantity: qty,
        currentQuantity: qty,
        unitPriceMinor: v.priceMinor,
        discountMinor: 0,
        totalMinor: v.priceMinor * qty,
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.totalMinor, 0);
    const discount = rng.chance(0.25) ? Math.round(subtotal * 0.1) : 0;
    const shipping = subtotal - discount > 8000 ? 0 : 590;
    const gateway = rng.weighted([["shopify_payments", 55], ["paypal", 22], ["klarna", 8], ["bank_deposit", 5], ["cash_on_delivery", 10]] as const);
    const paymentMethod = normalizePaymentMethod([gateway]);
    const financial = paymentMethod === "cod" || paymentMethod === "bank_transfer" ? "pending" : "paid";
    const total = subtotal - discount + shipping;
    const order: NormalizedOrder = {
      externalId: String(900000000 + number),
      orderNumber: number,
      name: `#${this.opts.orderNumberPrefix}${number}`,
      customer,
      email: customer.email,
      phone: customer.phone,
      customerName: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
      currency: this.opts.currency,
      subtotalMinor: subtotal,
      discountMinor: discount,
      shippingMinor: shipping,
      taxMinor: 0,
      totalMinor: total,
      refundedMinor: 0,
      paymentGateways: [gateway],
      paymentMethod,
      paymentStatus: financial === "paid" ? "paid" : "pending",
      financialStatusRaw: financial,
      fulfillmentStatusRaw: null,
      tags: rng.chance(0.15) ? ["vip"] : [],
      shippingAddress: { name: `${customer.firstName} ${customer.lastName}`, address1: `${rng.int(1, 120)} Mock Street`, city: customer.city, zip: customer.zip, country: customer.country, phone: customer.phone },
      billingAddress: null,
      note: null,
      noteAttributes: rng.chance(0.5) ? [{ name: "utm_source", value: rng.pick(["facebook", "google", "instagram"]) }, { name: "utm_campaign", value: `mock-${rng.int(1, 9)}` }] : [],
      landingSite: rng.chance(0.5) ? `/products/mock?utm_source=facebook&utm_medium=paid&utm_campaign=mock-${rng.int(1, 9)}&fbclid=abc${rng.int(1000, 9999)}` : "/",
      referringSite: null,
      sourceChannel: "web",
      placedAt: at,
      cancelledAt: null,
      cancelReason: null,
      closedAt: null,
      platformUpdatedAt: at,
      lines,
      discounts: discount ? [{ code: "WELCOME10", type: "percentage", amountMinor: discount }] : [],
      fulfillments: [],
    };
    this.orders.set(order.externalId, order);
    this.moveStock(order.lines, -1);
    return order;
  }

  async fetchOrders(q: SyncQuery): Promise<Page<NormalizedOrder>> {
    this.failures.check();
    const page = Number(q.cursor ?? 0);
    const limit = Math.min(q.limit ?? 50, 250);
    // Simulate a store with new activity: up to 3 pages of fresh orders per sync.
    // a store without catalog or customers (a tenant connected from scratch) takes no new orders
    if (page === 0 && this.opts.customers.length && this.opts.variants.length) {
      const count = this.rng.int(2, 6);
      for (let i = 0; i < count; i++) this.generateOrder(new Date(Date.now() - this.rng.int(0, 3600) * 1000));
    }
    const all = [...this.orders.values()].sort((a, b) => a.platformUpdatedAt.getTime() - b.platformUpdatedAt.getTime());
    const filtered = all.filter((o) => (!q.updatedSince || o.platformUpdatedAt >= q.updatedSince) && (!q.createdSince || o.placedAt >= q.createdSince));
    const items = filtered.slice(page * limit, (page + 1) * limit);
    const nextCursor = (page + 1) * limit < filtered.length ? String(page + 1) : null;
    return { items, nextCursor };
  }

  async fetchOrder(externalId: string): Promise<NormalizedOrder | null> {
    this.failures.check();
    return this.orders.get(externalId) ?? null;
  }

  async fetchCustomers(q: SyncQuery): Promise<Page<NormalizedCustomer>> {
    this.failures.check();
    const page = Number(q.cursor ?? 0);
    const limit = q.limit ?? 250;
    const items = this.opts.customers.slice(page * limit, (page + 1) * limit);
    return { items, nextCursor: (page + 1) * limit < this.opts.customers.length ? String(page + 1) : null };
  }

  async fetchProducts(q: SyncQuery = {}): Promise<Page<NormalizedProduct>> {
    this.failures.check();
    const all = [...this.catalog.values()];
    const from = Number(q.cursor ?? 0) || 0;
    const limit = q.limit ?? 250;
    return { items: all.slice(from, from + limit).map((p) => structuredClone(p)), nextCursor: from + limit < all.length ? String(from + limit) : null };
  }
  async fetchProduct(externalId: string): Promise<NormalizedProduct | null> {
    this.failures.check();
    const p = this.catalog.get(externalId);
    return p ? structuredClone(p) : null;
  }
  async updateProduct(externalId: string, patch: ProductPatch): Promise<NormalizedProduct> {
    this.record("updateProduct", { externalId, patch });
    const p = this.productOrThrow(externalId);
    const { seo, categoryId, ...plain } = patch;
    Object.assign(p, plain);
    if (seo) p.seo = { title: seo.title || null, description: seo.description || null };
    if (categoryId !== undefined) p.category = categoryId ? { id: categoryId, name: MOCK_CATEGORY_NAMES[categoryId] ?? p.category?.name ?? categoryId } : null;
    this.touch(p);
    return structuredClone(p);
  }
  async updateProductMedia(externalId: string, op: ProductMediaOperation): Promise<NormalizedProduct> {
    this.record("updateProductMedia", { externalId, op });
    const p = this.productOrThrow(externalId);
    let media = [...(p.media ?? [])];
    if (op.type === "create") media.push({ externalId: `gid://shopify/MediaImage/${++this.mediaSeq}`, type: "image", url: op.url, alt: op.alt, width: null, height: null });
    else if (op.type === "reorder") media = [...op.mediaExternalIds.map((id) => media.find((m) => m.externalId === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)), ...media.filter((m) => !op.mediaExternalIds.includes(m.externalId))];
    else if (op.type === "delete") {
      media = media.filter((m) => !op.mediaExternalIds.includes(m.externalId));
      for (const v of p.variants) if (v.imageMediaExternalId && op.mediaExternalIds.includes(v.imageMediaExternalId)) v.imageMediaExternalId = null;
    } else {
      const m = media.find((x) => x.externalId === op.mediaExternalId);
      if (!m) throw new IntegrationError("not_found", "Media not found");
      m.alt = op.alt;
    }
    p.media = media;
    p.imageUrl = media[0]?.url ?? null;
    this.touch(p);
    return structuredClone(p);
  }

  async fetchLocations(): Promise<NormalizedLocation[]> {
    this.failures.check();
    return this.opts.locations;
  }

  async fetchInventoryLevels(ids: string[]): Promise<NormalizedInventoryLevel[]> {
    this.failures.check();
    const out: NormalizedInventoryLevel[] = [];
    for (const id of ids)
      for (const loc of this.opts.locations) {
        if (!loc.isActive) continue;
        const key = `${id}@${loc.externalId}`;
        if (!this.stock.has(key)) this.stock.set(key, this.rng.int(0, 60));
        out.push({ inventoryItemExternalId: id, locationExternalId: loc.externalId, available: this.stock.get(key)!, onHand: null, committed: null, updatedAt: new Date() });
      }
    return out;
  }

  async fetchDiscounts(): Promise<Page<NormalizedDiscount>> {
    this.failures.check();
    return { items: [{ externalId: "mock-d-1", code: "WELCOME10", title: "Welcome 10%", type: "percentage", value: 1000, minimumAmountMinor: null, usageLimit: null, usedCount: 120, startsAt: null, endsAt: null, isActive: true }], nextCursor: null };
  }

  async fetchReturns(q: SyncQuery): Promise<Page<NormalizedReturn>> {
    this.failures.check();
    const since = q.updatedSince ?? q.createdSince ?? null;
    const all = [...this.returns.values()].filter((r) => !since || r.updatedAt >= since).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const page = Number(q.cursor ?? 0);
    const limit = Math.min(q.limit ?? 50, 250);
    return { items: all.slice(page * limit, (page + 1) * limit).map((r) => this.returnOf(r)), nextCursor: (page + 1) * limit < all.length ? String(page + 1) : null };
  }
  async fetchReturn(externalId: string): Promise<NormalizedReturn | null> {
    this.failures.check();
    const r = this.returns.get(externalId);
    return r ? this.returnOf(r) : null;
  }
  private returnOf(r: MockReturn): NormalizedReturn {
    return { externalId: r.externalId, orderExternalId: r.orderExternalId, status: r.status, requestedAt: r.requestedAt, closedAt: r.closedAt, note: r.note, lines: r.lines.map((l) => ({ ...l })) };
  }
  /**
   * A return opened in the store admin or by the customer on the store, behind Hullwise's back (tests, the
   * "simulate return" button). Lines are order line ids of any order, also of the seeded history.
   */
  openPlatformReturn(input: { orderExternalId: string; lines: { orderLineExternalId: string; quantity: number; reason?: string | null }[]; note?: string | null; status?: MockReturnStatus }): NormalizedReturn {
    const externalId = this.nextReturnId();
    const now = new Date();
    const r: MockReturn = { externalId, orderExternalId: input.orderExternalId, status: input.status ?? "requested", requestedAt: now, updatedAt: now, closedAt: input.status === "closed" ? now : null, note: input.note ?? null, lines: input.lines.map((l, i) => ({ externalId: `${externalId}-l${i + 1}`, orderLineExternalId: l.orderLineExternalId, quantity: l.quantity, reason: l.reason ?? null, note: null })) };
    this.returns.set(externalId, r);
    return this.returnOf(r);
  }
  /** Changes a return's status on the store (approve, decline, close in the admin). */
  setPlatformReturnStatus(externalId: string, status: MockReturnStatus): void {
    const r = this.returns.get(externalId);
    if (!r) return;
    r.status = status;
    r.updatedAt = new Date(Math.max(Date.now(), r.updatedAt.getTime() + 1));
    if (status === "closed" || status === "declined" || status === "canceled") r.closedAt = r.updatedAt;
  }
  /** Signed `returns/*` webhook for a return the simulator holds, as the platform would send it. */
  buildReturnWebhook(topic: string, returnExternalId: string): { headers: Record<string, string>; rawBody: string } {
    const r = this.returns.get(returnExternalId);
    if (!r) throw new IntegrationError("not_found", `Mock: return ${returnExternalId} not found`);
    const rawBody = JSON.stringify({ id: r.externalId, updated_at: r.updatedAt.toISOString(), __normalized: this.returnOf(r) });
    return { headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": this.sign(rawBody), "x-shopify-shop-domain": this.opts.shopDomain ?? "mock-shop.myshopify.com" }, rawBody };
  }

  /** Refunds made through this simulator since it started (they show up in the next payouts). */
  private payoutRefunds: MockPayoutRefund[] = [];
  private payoutData(since?: Date | null) {
    const known = new Set((this.opts.paymentOrders ?? []).map((o) => o.externalId));
    const own: MockPaymentOrder[] = [...this.orders.values()].filter((o) => !known.has(o.externalId) && o.paymentStatus !== "pending" && o.paymentStatus !== "voided").map((o) => ({ externalId: o.externalId, placedAt: o.placedAt, totalMinor: o.totalMinor, refundedMinor: 0, gateways: o.paymentGateways }));
    return buildMockPayouts({ orders: [...(this.opts.paymentOrders ?? []), ...own], refunds: this.payoutRefunds, currency: this.opts.currency, now: new Date(), since });
  }
  async fetchPayouts(q: SyncQuery): Promise<Page<NormalizedPayout>> {
    this.failures.check();
    const all = this.payoutData(q.createdSince ?? null).payouts;
    const page = Number(q.cursor ?? 0);
    const limit = Math.min(q.limit ?? 50, 250);
    return { items: all.slice(page * limit, (page + 1) * limit), nextCursor: (page + 1) * limit < all.length ? String(page + 1) : null };
  }
  async fetchBalanceTransactions(q: { payoutExternalId: string; cursor?: string | null; limit?: number }): Promise<Page<NormalizedBalanceTransaction>> {
    this.failures.check();
    const all = this.payoutData().transactions.filter((t) => t.payoutExternalId === q.payoutExternalId);
    const page = Number(q.cursor ?? 0);
    const limit = Math.min(q.limit ?? 100, 250);
    return { items: all.slice(page * limit, (page + 1) * limit), nextCursor: (page + 1) * limit < all.length ? String(page + 1) : null };
  }

  async registerWebhooks(callbackUrl: string, topics: string[]): Promise<WebhookRegistration[]> {
    this.failures.check();
    return topics.map((topic) => ({ topic, address: callbackUrl, status: "registered" as const }));
  }

  sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("base64");
  }

  /** Builds a signed webhook envelope for the given order, exactly like the platform would. */
  buildWebhook(topic: string, order: NormalizedOrder): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify({ id: Number(order.externalId), updated_at: order.platformUpdatedAt.toISOString(), __normalized: order });
    return { headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": this.sign(rawBody), "x-shopify-shop-domain": this.opts.shopDomain ?? "mock-shop.myshopify.com" }, rawBody };
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<VerifiedWebhook> {
    const sig = headers["x-shopify-hmac-sha256"];
    if (!sig || sig !== this.sign(rawBody)) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as { id: number; updated_at: string };
    return { topic: headers["x-shopify-topic"] ?? "unknown", externalId: String(payload.id), sourceUpdatedAt: payload.updated_at, payload };
  }

  parseWebhookOrder(payload: unknown): NormalizedOrder {
    const p = payload as { __normalized: NormalizedOrder };
    const o = p.__normalized;
    return { ...o, customer: o.customer ? { ...o.customer, platformCreatedAt: o.customer.platformCreatedAt ? new Date(o.customer.platformCreatedAt) : null } : null, placedAt: new Date(o.placedAt), platformUpdatedAt: new Date(o.platformUpdatedAt), cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null, closedAt: o.closedAt ? new Date(o.closedAt) : null, fulfillments: o.fulfillments.map((f) => ({ ...f, createdAt: new Date(f.createdAt), updatedAt: new Date(f.updatedAt), deliveredAt: f.deliveredAt ? new Date(f.deliveredAt) : null })) };
  }

  parseWebhookProduct(payload: unknown): NormalizedProduct {
    const p = (payload as { __normalized: NormalizedProduct }).__normalized;
    return { ...p, platformCreatedAt: p.platformCreatedAt ? new Date(p.platformCreatedAt) : null, ...(p.platformUpdatedAt !== undefined ? { platformUpdatedAt: p.platformUpdatedAt ? new Date(p.platformUpdatedAt) : null } : {}) };
  }
  /** A signed `products/*` webhook of a product the store holds (tests). */
  buildProductWebhook(topic: string, productExternalId: string): { headers: Record<string, string>; rawBody: string } {
    const p = this.productOrThrow(productExternalId);
    const rawBody = JSON.stringify({ id: Number(p.externalId) || p.externalId, updated_at: (p.platformUpdatedAt ?? new Date()).toISOString(), __normalized: p });
    return { headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": this.sign(rawBody), "x-shopify-shop-domain": this.opts.shopDomain ?? "mock-shop.myshopify.com" }, rawBody };
  }
  parseWebhookCustomer(payload: unknown): NormalizedCustomer | null {
    return (payload as { __normalized?: NormalizedCustomer }).__normalized ?? null;
  }
  parseWebhookReturn(payload: unknown): NormalizedReturn | null {
    const r = (payload as { __normalized?: NormalizedReturn }).__normalized;
    return r ? { ...r, requestedAt: new Date(r.requestedAt), closedAt: r.closedAt ? new Date(r.closedAt) : null } : null;
  }
  parseWebhookInventoryLevel(payload: unknown): NormalizedInventoryLevel {
    const p = payload as { inventory_item_id: string; location_id: string; available: number; updated_at: string };
    return { inventoryItemExternalId: String(p.inventory_item_id), locationExternalId: String(p.location_id), available: Number(p.available), onHand: null, committed: null, updatedAt: new Date(p.updated_at) };
  }

  private record(op: string, args: unknown) {
    this.failures.check();
    this.writes.push({ op, args });
  }
  async cancelOrder(externalId: string, opts: { reason?: string; restock: boolean; refund: boolean }) {
    this.record("cancelOrder", { externalId, ...opts });
    const o = this.orders.get(externalId);
    if (o && !o.cancelledAt && opts.restock) this.moveStock(o.lines.map((l) => ({ variantExternalId: l.variantExternalId, quantity: l.currentQuantity })), 1);
    if (o) {
      o.cancelledAt = new Date();
      o.financialStatusRaw = opts.refund && o.paymentStatus === "paid" ? "refunded" : o.paymentStatus === "pending" ? "voided" : o.financialStatusRaw;
      o.paymentStatus = opts.refund && o.paymentStatus === "paid" ? "refunded" : o.paymentStatus === "pending" ? "voided" : o.paymentStatus;
      o.platformUpdatedAt = new Date();
    }
  }
  async addOrderNote(externalId: string, note: string) {
    this.record("addOrderNote", { externalId, note });
  }
  async updateOrderDetails(externalId: string, patch: OrderDetailsPatch) {
    this.failures.check();
    this.record("updateOrderDetails", { externalId, patch });
    const o = this.orders.get(externalId);
    if (!o) return;
    if (patch.email !== undefined) o.email = patch.email;
    if (patch.phone !== undefined) o.phone = patch.phone;
    if (patch.note !== undefined) o.note = patch.note;
    if (patch.shippingAddress !== undefined) o.shippingAddress = patch.shippingAddress;
    if (patch.billingAddress !== undefined) o.billingAddress = patch.billingAddress;
    o.platformUpdatedAt = new Date();
  }
  async applyOrderDiscount(externalId: string, discount: OrderDiscountPatch) {
    this.record("applyOrderDiscount", { externalId, ...discount });
    const o = this.orders.get(externalId);
    if (!o) return;
    o.discountMinor += discount.amountMinor;
    o.totalMinor = Math.max(0, o.totalMinor - discount.amountMinor);
    o.discounts = [...o.discounts, { code: discount.code, type: discount.type, amountMinor: discount.amountMinor }];
    o.platformUpdatedAt = new Date();
  }
  async createOrder(input: CreateOrderInput): Promise<NormalizedOrder> {
    this.failures.check();
    this.record("createOrder", { lines: input.lines.length, replaces: input.replacesOrderName, payment: input.payment ?? null });
    const number = this.nextNumber++;
    const now = new Date();
    const lines = input.lines.map((l, i) => {
      const v = l.variantExternalId ? this.opts.variants.find((x) => x.externalId === l.variantExternalId) : undefined;
      const unit = v?.priceMinor ?? l.unitPriceMinor;
      return { externalId: `${number}-${i + 1}`, variantExternalId: v?.externalId ?? l.variantExternalId, productExternalId: v?.productExternalId ?? null, sku: v?.sku ?? l.sku, title: v?.productTitle ?? l.title, variantTitle: v?.title ?? null, quantity: l.quantity, currentQuantity: l.quantity, unitPriceMinor: unit, discountMinor: 0, totalMinor: unit * l.quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.totalMinor, 0);
    const customer = input.customerExternalId ? (this.opts.customers.find((c) => c.externalId === input.customerExternalId) ?? null) : null;
    const order: NormalizedOrder = {
      externalId: String(900000000 + number),
      orderNumber: number,
      name: `#${this.opts.orderNumberPrefix}${number}`,
      customer,
      email: input.email,
      phone: input.phone,
      customerName: input.shippingAddress?.name ?? (customer ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : null),
      currency: input.currency,
      subtotalMinor: subtotal,
      discountMinor: input.discountMinor,
      shippingMinor: input.shippingMinor,
      taxMinor: 0,
      totalMinor: subtotal - input.discountMinor + input.shippingMinor,
      refundedMinor: 0,
      paymentGateways: input.payment?.gateways.length ? [...input.payment.gateways] : ["cash_on_delivery"],
      paymentMethod: input.payment?.method ?? "cod",
      paymentStatus: input.payment?.status ?? "pending",
      financialStatusRaw: input.payment?.status ?? "pending",
      fulfillmentStatusRaw: null,
      tags: [...input.tags],
      shippingAddress: input.shippingAddress,
      billingAddress: input.billingAddress,
      note: input.note,
      noteAttributes: [...input.noteAttributes, ...(input.replacesOrderName ? [{ name: "replaces_order", value: input.replacesOrderName }] : [])],
      landingSite: null,
      referringSite: null,
      sourceChannel: "pos",
      placedAt: now,
      cancelledAt: null,
      cancelReason: null,
      closedAt: null,
      platformUpdatedAt: now,
      lines,
      discounts: [],
      fulfillments: [],
    };
    this.orders.set(order.externalId, order);
    this.moveStock(order.lines, -1);
    return order;
  }
  async updateOrderTags(externalId: string, add: string[], remove: string[]) {
    this.failures.check();
    this.record("updateOrderTags", { externalId, add, remove });
    const o = this.orders.get(externalId);
    if (!o) return;
    const drop = new Set(remove.map((t) => t.trim().toLowerCase()));
    const kept = o.tags.filter((t) => !drop.has(t.trim().toLowerCase()));
    const have = new Set(kept.map((t) => t.trim().toLowerCase()));
    const tags = [...kept, ...add.filter((t) => !have.has(t.trim().toLowerCase()))];
    this.orders.set(externalId, { ...o, tags, platformUpdatedAt: new Date() });
  }
  /** Fulfillment holds per order (Hullwise's own), as the store would show them. */
  private holds = new Map<string, FulfillmentHoldInput>();
  /** Current Hullwise hold on an order (tests). */
  fulfillmentHoldOf(externalId: string): FulfillmentHoldInput | undefined {
    return this.holds.get(externalId);
  }
  async holdFulfillment(externalId: string, hold: FulfillmentHoldInput) {
    this.record("holdFulfillment", { externalId, ...hold });
    this.holds.set(externalId, { reason: hold.reason, note: hold.note ?? null });
  }
  async releaseFulfillment(externalId: string) {
    this.record("releaseFulfillment", { externalId });
    this.holds.delete(externalId);
  }
  async updateVariant(variantExternalId: string, patch: VariantPatch) {
    this.record("updateVariant", { variantExternalId, patch });
    const v = this.opts.variants.find((x) => x.externalId === variantExternalId);
    if (v && patch.priceMinor !== undefined) v.priceMinor = patch.priceMinor;
    if (v && patch.sku !== undefined) v.sku = patch.sku ?? "";
    const found = this.variantInCatalog(variantExternalId);
    if (found) {
      Object.assign(found.variant, patch);
      this.touch(found.product);
    }
  }
  async updateProductTags(productExternalId: string, add: string[], remove: string[]) {
    this.record("updateProductTags", { productExternalId, add, remove });
    const p = this.catalog.get(productExternalId);
    if (p) {
      p.tags = [...p.tags.filter((t) => !remove.includes(t)), ...add.filter((t) => !p.tags.includes(t))];
      this.touch(p);
    }
  }
  async updateVariantCost(variant: { variantExternalId: string; inventoryItemExternalId: string | null }, costMinor: number) {
    this.record("updateVariantCost", { ...variant, costMinor });
    const v = this.opts.variants.find((x) => x.externalId === variant.variantExternalId);
    if (v) v.unitCostMinor = costMinor;
    const found = this.variantInCatalog(variant.variantExternalId);
    if (found) found.variant.costMinor = costMinor;
  }
  async updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived") {
    this.record("updateProductStatus", { productExternalId, status });
    const p = this.catalog.get(productExternalId);
    if (p) {
      p.status = status;
      this.touch(p);
    }
  }
  async setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number) {
    this.record("setInventory", { inventoryItemExternalId, locationExternalId, available });
    this.stock.set(`${inventoryItemExternalId}@${locationExternalId}`, available);
  }
  /** Codes the store accepts: standalone codes by code, pools by their discount id with their codes. */
  private discountActive = new Map<string, boolean>();
  private pools = new Map<string, { active: boolean; codes: Map<string, boolean> }>();
  private poolSeq = 0;
  async createDiscountCode(input: { code: string }) {
    this.record("createDiscountCode", input);
    this.discountActive.set(input.code.toUpperCase(), true);
    return { externalId: `mock-d-${input.code}` };
  }
  async createDiscountPool(input: { title: string; codes: string[] }) {
    this.record("createDiscountPool", { title: input.title, count: input.codes.length });
    const externalId = `mock-pool-${Date.now().toString(36)}-${++this.poolSeq}`;
    this.pools.set(externalId, { active: true, codes: new Map(input.codes.map((c) => [c.toUpperCase(), true])) });
    return { externalId, imported: input.codes, failed: [] };
  }
  private poolOf(id: string) {
    return this.pools.get(id) ?? this.pools.set(id, { active: true, codes: new Map() }).get(id)!;
  }
  async addDiscountPoolCodes(poolExternalId: string, codes: string[]) {
    this.record("addDiscountPoolCodes", { poolExternalId, count: codes.length });
    const pool = this.poolOf(poolExternalId);
    for (const c of codes) pool.codes.set(c.toUpperCase(), true);
    return { imported: codes, failed: [] };
  }
  async setDiscountActive(discount: { externalId: string | null; code: string; poolExternalId?: string | null }, active: boolean) {
    this.record("setDiscountActive", { ...discount, active });
    if (discount.poolExternalId) this.poolOf(discount.poolExternalId).codes.set(discount.code.toUpperCase(), active);
    else this.discountActive.set(discount.code.toUpperCase(), active);
  }
  async setDiscountPoolActive(poolExternalId: string, active: boolean) {
    this.record("setDiscountPoolActive", { poolExternalId, active });
    const pool = this.poolOf(poolExternalId);
    pool.active = active;
    for (const c of pool.codes.keys()) pool.codes.set(c, active);
  }
  /** Whether the store accepts a code now (tests); undefined for codes it never saw. */
  discountCodeActive(code: string): boolean | undefined {
    const c = code.toUpperCase();
    for (const p of this.pools.values()) if (p.codes.has(c)) return p.active && p.codes.get(c)!;
    return this.discountActive.get(c);
  }
  private draftSeq = 0;
  async createInvoiceOrder(input: CreateOrderInput) {
    this.record("createInvoiceOrder", { lines: input.lines.length, discountMinor: input.discountMinor });
    const id = `mock-draft-${++this.draftSeq}`;
    return { draftExternalId: id, invoiceUrl: `https://mock-shop.myshopify.com/invoices/${id}` };
  }
  async restockInventory(lines: { inventoryItemExternalId: string; locationExternalId: string; quantity: number }[]) {
    this.record("restockInventory", { lines });
    for (const l of lines) this.adjustStock(l.inventoryItemExternalId, l.locationExternalId, l.quantity);
  }
  private returnSeq = 0;
  private returns = new Map<string, MockReturn>();
  /** Unique across simulator restarts, so a return id stored by an earlier process never matches a new one. */
  private nextReturnId(): string {
    return `mock-r-${Date.now().toString(36)}-${++this.returnSeq}`;
  }
  async requestReturn(orderExternalId: string, input: { lines: PlatformReturnLineInput[]; note?: string | null }) {
    this.record("requestReturn", { orderExternalId, lines: input.lines });
    const externalId = this.nextReturnId();
    const now = new Date();
    const lines = input.lines.map((l, i) => ({ externalId: `${externalId}-l${i + 1}`, orderLineExternalId: l.orderLineExternalId, quantity: l.quantity, reason: l.reason?.toLowerCase() ?? null, note: l.note ?? null }));
    this.returns.set(externalId, { externalId, orderExternalId, status: "requested", requestedAt: now, updatedAt: now, closedAt: null, note: input.note ?? null, lines });
    return { externalId, lines: lines.map((l) => ({ orderLineExternalId: l.orderLineExternalId, externalId: l.externalId })) };
  }
  private setReturn(id: string, status: "approved" | "declined" | "closed") {
    if (!this.returns.has(id)) return;
    this.setPlatformReturnStatus(id, status === "approved" ? "open" : status);
  }
  async approveReturn(returnExternalId: string) {
    this.record("approveReturn", { returnExternalId });
    this.setReturn(returnExternalId, "approved");
  }
  async declineReturn(returnExternalId: string, note: string | null) {
    this.record("declineReturn", { returnExternalId, note });
    this.setReturn(returnExternalId, "declined");
  }
  async refundReturn(orderExternalId: string, input: { lines: { orderLineExternalId: string; quantity: number }[]; amountMinor: number; currency: string; note?: string | null; notify: boolean }) {
    this.record("refundReturn", { orderExternalId, ...input });
    return this.applyRefund(orderExternalId, { ...input, lines: input.lines.map((l) => ({ ...l, restock: false })) });
  }
  async refundOrder(orderExternalId: string, input: RefundOrderInput) {
    this.record("refundOrder", { orderExternalId, ...input });
    return this.applyRefund(orderExternalId, input);
  }
  /** Shared by both refund calls: capped by what is left on orders the simulator knows, restock to the location, money in the next payout. */
  private applyRefund(orderExternalId: string, input: RefundOrderInput): { externalId: string; amountMinor: number } {
    const o = this.orders.get(orderExternalId);
    const captured = o ? (o.paymentStatus === "pending" || o.paymentStatus === "voided" ? 0 : o.totalMinor - o.refundedMinor) : input.amountMinor;
    const amount = Math.max(0, Math.min(input.amountMinor, captured));
    const loc = input.locationExternalId ?? this.defaultLocation();
    for (const l of input.lines) {
      if (!l.restock || !loc) continue;
      const line = o?.lines.find((x) => x.externalId === l.orderLineExternalId);
      const inv = line ? this.opts.variants.find((v) => v.externalId === line.variantExternalId)?.inventoryItemExternalId : undefined;
      if (inv) this.adjustStock(inv, loc, l.quantity);
    }
    if (o && amount > 0) {
      o.refundedMinor += amount;
      o.paymentStatus = o.refundedMinor >= o.totalMinor ? "refunded" : "partially_refunded";
      o.financialStatusRaw = o.paymentStatus;
      o.platformUpdatedAt = new Date();
    }
    const knownToProcessor = o ? isProcessorGateway(o.paymentGateways) : (this.opts.paymentOrders ?? []).some((p) => p.externalId === orderExternalId);
    if (amount > 0 && knownToProcessor) this.payoutRefunds.push({ orderExternalId, amountMinor: amount, at: new Date() });
    return { externalId: `mock-refund-${++this.returnSeq}`, amountMinor: amount };
  }
  async markOrderPaid(externalId: string, input: ManualPaymentInput) {
    this.record("markOrderPaid", { externalId, ...input });
    const o = this.orders.get(externalId);
    if (o && input.fullBalance) {
      o.paymentStatus = "paid";
      o.financialStatusRaw = "paid";
      o.platformUpdatedAt = new Date();
    }
  }
  async closeReturn(returnExternalId: string) {
    this.record("closeReturn", { returnExternalId });
    this.setReturn(returnExternalId, "closed");
  }
  private fulfillmentSeq = 0;
  /**
   * Fulfils the order (all remaining lines or the given ones). Orders the simulator does not hold
   * (the seeded history) are acknowledged too, as the store would for an order it knows.
   */
  async createFulfillment(input: CreateFulfillmentInput): Promise<NormalizedFulfillment> {
    this.record("createFulfillment", { ...input });
    const o = this.orders.get(input.orderExternalId);
    if (o?.cancelledAt) throw new IntegrationError("invalid_request", `Mock: order ${input.orderExternalId} is cancelled`);
    if (o && o.fulfillmentStatusRaw === "fulfilled") throw new IntegrationError("invalid_request", `Mock: order ${input.orderExternalId} is already fulfilled`);
    const now = new Date();
    const f: NormalizedFulfillment = { externalId: `mock-f-${Date.now().toString(36)}-${++this.fulfillmentSeq}`, status: "label_created", externalStatus: "confirmed", trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl ?? null, carrier: input.carrier, createdAt: now, updatedAt: now, deliveredAt: null };
    if (o) {
      const partial = input.lines?.length && input.lines.some((l) => (o.lines.find((x) => x.externalId === l.orderLineExternalId)?.currentQuantity ?? 0) > l.quantity);
      o.fulfillments = [...o.fulfillments, f];
      o.fulfillmentStatusRaw = partial ? "partial" : "fulfilled";
      o.platformUpdatedAt = now;
    }
    return f;
  }
}

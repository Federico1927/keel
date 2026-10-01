import { normalizePaymentMethod } from "@keel/core";
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
  type SyncQuery,
  type VerifiedWebhook,
  type WebhookRegistration,
 type CreateOrderInput, type OrderDetailsPatch } from "../types";
import { FailureScript } from "./failures";

export interface MockCatalogVariant {
  externalId: string;
  productExternalId: string;
  inventoryItemExternalId: string;
  sku: string;
  title: string;
  productTitle: string;
  optionValues: Record<string, string>;
  priceMinor: number;
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
}

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

  constructor(private readonly opts: MockCommerceOptions) {
    this.rng = createRng(opts.seed ?? 42);
    this.nextNumber = opts.startOrderNumber;
    this.webhookSecret = opts.webhookSecret ?? "mock-webhook-secret";
    for (const l of opts.inventory ?? []) this.stock.set(`${l.inventoryItemExternalId}@${l.locationExternalId}`, l.available);
  }

  /** Current stock of an item at a location (tests). */
  stockOf(inventoryItemExternalId: string, locationExternalId: string): number | undefined {
    return this.stock.get(`${inventoryItemExternalId}@${locationExternalId}`);
  }
  /** Changes stock behind Keel's back, as a manual edit in the store admin would (tests, drift). */
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
    return { ok: true, accountName: "Mock Store", accountId: "mock-shop.myshopify.com", scopes: ["read_orders", "write_orders", "read_products", "write_products", "read_inventory", "write_inventory", "read_customers", "read_discounts", "write_discounts", "read_returns", "read_fulfillments"] };
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
    if (page === 0) {
      const count = this.rng.int(2, 6);
      for (let i = 0; i < count; i++) this.generateOrder(new Date(Date.now() - this.rng.int(0, 3600) * 1000));
    }
    const all = [...this.orders.values()].sort((a, b) => a.platformUpdatedAt.getTime() - b.platformUpdatedAt.getTime());
    const filtered = q.updatedSince ? all.filter((o) => o.platformUpdatedAt >= q.updatedSince!) : all;
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

  async fetchProducts(): Promise<Page<NormalizedProduct>> {
    this.failures.check();
    const byProduct = new Map<string, NormalizedProduct>();
    for (const v of this.opts.variants) {
      let p = byProduct.get(v.productExternalId);
      if (!p) {
        p = { externalId: v.productExternalId, title: v.productTitle, handle: v.productTitle.toLowerCase().replace(/\s+/g, "-"), vendor: "Mock", productType: null, status: "active", tags: [], options: [], imageUrl: null, platformCreatedAt: null, variants: [] };
        byProduct.set(v.productExternalId, p);
      }
      p.variants.push({ externalId: v.externalId, inventoryItemExternalId: v.inventoryItemExternalId, sku: v.sku, barcode: null, title: v.title, optionValues: v.optionValues, priceMinor: v.priceMinor, compareAtMinor: null, weightGrams: null });
    }
    return { items: [...byProduct.values()], nextCursor: null };
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

  async fetchReturns(): Promise<Page<NormalizedReturn>> {
    this.failures.check();
    return { items: [], nextCursor: null };
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
    return { headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": this.sign(rawBody), "x-shopify-shop-domain": "mock-shop.myshopify.com" }, rawBody };
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
    return (payload as { __normalized: NormalizedProduct }).__normalized;
  }
  parseWebhookCustomer(payload: unknown): NormalizedCustomer | null {
    return (payload as { __normalized?: NormalizedCustomer }).__normalized ?? null;
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
    o.platformUpdatedAt = new Date();
  }
  async createOrder(input: CreateOrderInput): Promise<NormalizedOrder> {
    this.failures.check();
    this.record("createOrder", { lines: input.lines.length, replaces: input.replacesOrderName });
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
      paymentGateways: ["cash_on_delivery"],
      paymentMethod: "cod",
      paymentStatus: "pending",
      financialStatusRaw: "pending",
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
  async updateVariant(variantExternalId: string, patch: { priceMinor?: number }) {
    this.record("updateVariant", { variantExternalId, patch });
  }
  async updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived") {
    this.record("updateProductStatus", { productExternalId, status });
  }
  async setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number) {
    this.record("setInventory", { inventoryItemExternalId, locationExternalId, available });
    this.stock.set(`${inventoryItemExternalId}@${locationExternalId}`, available);
  }
  async createDiscountCode(input: { code: string }) {
    this.record("createDiscountCode", input);
    return { externalId: `mock-d-${input.code}` };
  }
  async createDiscountPool(input: { title: string; codes: string[] }) {
    this.record("createDiscountPool", { title: input.title, count: input.codes.length });
    return { externalId: `mock-pool-${Date.now()}`, imported: input.codes, failed: [] };
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
  private returns = new Map<string, { orderExternalId: string; status: "requested" | "approved" | "declined" | "closed" }>();
  async requestReturn(orderExternalId: string, input: { lines: PlatformReturnLineInput[]; note?: string | null }) {
    this.record("requestReturn", { orderExternalId, lines: input.lines });
    const externalId = `mock-r-${++this.returnSeq}`;
    this.returns.set(externalId, { orderExternalId, status: "requested" });
    return { externalId, lines: input.lines.map((l, i) => ({ orderLineExternalId: l.orderLineExternalId, externalId: `${externalId}-l${i + 1}` })) };
  }
  private setReturn(id: string, status: "approved" | "declined" | "closed") {
    const r = this.returns.get(id);
    if (r) r.status = status;
    else this.returns.set(id, { orderExternalId: "", status });
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
    return { externalId: `mock-refund-${++this.returnSeq}`, amountMinor: input.amountMinor };
  }
  async closeReturn(returnExternalId: string) {
    this.record("closeReturn", { returnExternalId });
    this.setReturn(returnExternalId, "closed");
  }
}

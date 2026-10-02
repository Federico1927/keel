import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type CommercePlatform, type ConnectionTest, type CreateFulfillmentInput, type CreateOrderInput, type NormalizedCustomer, type NormalizedFulfillment, type NormalizedDiscount, type NormalizedInventoryLevel, type NormalizedLocation, type NormalizedOrder, type NormalizedProduct, type NormalizedReturn, type OrderDetailsPatch, type OrderDiscountPatch, type Page, type VariantPatch, type PlatformReturnLineInput, type SyncQuery, type VerifiedWebhook, type WebhookRegistration, type FulfillmentHoldInput } from "../types";
import { ORDER_FIELDS, PRODUCT_FIELDS, gidToId, idToGid, mapFulfillmentStatus, mapGraphqlCustomer, mapGraphqlDiscount, mapGraphqlInventoryLevel, mapGraphqlLocation, mapGraphqlOrder, mapGraphqlProduct, mapRestCustomer, mapRestInventoryLevel, mapRestOrder, mapRestProduct } from "./mappers";
import { SHOPIFY_ALL_SCOPES, SHOPIFY_API_VERSION, verifyWebhookHmac } from "./oauth";

export interface ShopifyCredentials {
  shop: string;
  accessToken: string;
  /** App secret (public app) or the custom app's webhook signing secret. */
  apiSecret: string;
}
export interface ShopifyOptions extends HttpOptions {
  apiVersion?: string;
}

type Rec = Record<string, unknown>;
/** Handle of the fulfillment holds Keel places: releasing touches only these. */
export const KEEL_HOLD_HANDLE = "keel-awaiting-stock";
interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

/**
 * Live Shopify adapter over the Admin GraphQL API. All I/O goes through the injectable
 * HttpClient, so the test-suite runs it against recorded payloads with zero network.
 */
export class ShopifyCommercePlatform implements CommercePlatform {
  readonly provider = "shopify";
  readonly http: HttpClient;
  private readonly endpoint: string;

  constructor(private readonly creds: ShopifyCredentials, opts: ShopifyOptions = {}) {
    this.http = new HttpClient({ minIntervalMs: 250, ...opts });
    this.endpoint = `https://${creds.shop}/admin/api/${opts.apiVersion ?? SHOPIFY_API_VERSION}/graphql.json`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.http.request<GraphqlResponse<T>>(this.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": this.creds.accessToken }, body: JSON.stringify({ query, variables }) });
      const body = res.json;
      if (body.errors?.length) {
        const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message));
        if (throttled && attempt < 3) {
          const restore = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
          await new Promise((r) => setTimeout(r, Math.min(5000, Math.ceil(1000 / Math.max(1, restore)) * 50)));
          continue;
        }
        const access = body.errors.some((e) => e.extensions?.code === "ACCESS_DENIED" || /access denied|not approved/i.test(e.message));
        throw new IntegrationError(throttled ? "rate_limited" : access ? "permission" : "invalid_request", body.errors.map((e) => e.message).join("; "));
      }
      if (!body.data) throw new IntegrationError("unknown", "Empty GraphQL response");
      return body.data;
    }
    throw new IntegrationError("rate_limited", "GraphQL throttled");
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const data = await this.graphql<{ shop: { name: string; myshopifyDomain: string; currencyCode: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`{ shop { name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`);
      const scopes = data.currentAppInstallation?.accessScopes?.map((s) => s.handle) ?? [];
      const missing = SHOPIFY_ALL_SCOPES.filter((s) => !scopes.includes(s) && !(s.startsWith("read_") && scopes.includes(s.replace("read_", "write_"))));
      return { ok: true, accountName: data.shop.name, accountId: data.shop.myshopifyDomain, scopes, missingScopes: missing };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async pageOf<T>(root: string, fields: string, q: SyncQuery, map: (n: Rec) => T | null, extraQuery = ""): Promise<Page<T>> {
    const parts: string[] = [];
    if (q.updatedSince) parts.push(`updated_at:>='${q.updatedSince.toISOString()}'`);
    if (q.createdSince) parts.push(`created_at:>='${q.createdSince.toISOString()}'`);
    if (extraQuery) parts.push(extraQuery);
    const data = await this.graphql<Record<string, { nodes: Rec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>>(`query($first: Int!, $after: String, $query: String) { ${root}(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`, { first: Math.min(q.limit ?? 50, 250), after: q.cursor ?? null, query: parts.join(" AND ") || null });
    const conn = data[root]!;
    return { items: conn.nodes.map(map).filter((x): x is T => x !== null), nextCursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
  }

  fetchOrders(q: SyncQuery): Promise<Page<NormalizedOrder>> {
    return this.pageOf("orders", ORDER_FIELDS, q, mapGraphqlOrder, "status:any");
  }
  async fetchOrder(externalId: string): Promise<NormalizedOrder | null> {
    const data = await this.graphql<{ order: Rec | null }>(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: idToGid("Order", externalId) });
    return data.order ? mapGraphqlOrder(data.order) : null;
  }
  fetchCustomers(q: SyncQuery): Promise<Page<NormalizedCustomer>> {
    return this.pageOf("customers", `id legacyResourceId email phone firstName lastName tags createdAt emailMarketingConsent { marketingState } smsMarketingConsent { marketingState } defaultAddress { city zip countryCodeV2 phone }`, q, mapGraphqlCustomer);
  }
  fetchProducts(q: SyncQuery): Promise<Page<NormalizedProduct>> {
    return this.pageOf("products", PRODUCT_FIELDS, q, mapGraphqlProduct);
  }
  async fetchLocations(): Promise<NormalizedLocation[]> {
    const data = await this.graphql<{ locations: { nodes: Rec[] } }>(`{ locations(first: 50, includeInactive: true) { nodes { id legacyResourceId name isActive isPrimary address { countryCode } } } }`);
    return data.locations.nodes.map(mapGraphqlLocation);
  }
  async fetchInventoryLevels(ids: string[]): Promise<NormalizedInventoryLevel[]> {
    const out: NormalizedInventoryLevel[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const data = await this.graphql<{ nodes: (Rec | null)[] }>(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id legacyResourceId inventoryLevels(first: 20) { nodes { updatedAt location { id legacyResourceId } quantities(names: ["available", "on_hand", "committed"]) { name quantity } } } } } }`, { ids: chunk.map((id) => idToGid("InventoryItem", id)) });
      for (const n of data.nodes) {
        if (!n) continue;
        const item = String(n.legacyResourceId);
        for (const lvl of ((n.inventoryLevels as Rec).nodes as Rec[]) ?? []) out.push(mapGraphqlInventoryLevel(item, lvl));
      }
    }
    return out;
  }
  async fetchDiscounts(q: SyncQuery): Promise<Page<NormalizedDiscount>> {
    const data = await this.graphql<{ discountNodes: { nodes: Rec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(`query($first: Int!, $after: String) { discountNodes(first: $first, after: $after) { nodes { id discount { __typename ... on DiscountCodeBasic { title status startsAt endsAt usageLimit asyncUsageCount codes(first: 1) { nodes { code } } customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } } minimumRequirement { ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } } } } ... on DiscountCodeFreeShipping { title status startsAt endsAt usageLimit asyncUsageCount codes(first: 1) { nodes { code } } } ... on DiscountAutomaticBasic { title status startsAt endsAt asyncUsageCount customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } } } } } pageInfo { hasNextPage endCursor } } }`, { first: Math.min(q.limit ?? 50, 100), after: q.cursor ?? null });
    return { items: data.discountNodes.nodes.map(mapGraphqlDiscount).filter((d): d is NormalizedDiscount => d !== null), nextCursor: data.discountNodes.pageInfo.hasNextPage ? data.discountNodes.pageInfo.endCursor : null };
  }
  async fetchReturns(q: SyncQuery): Promise<Page<NormalizedReturn>> {
    const data = await this.graphql<{ orders: { nodes: { legacyResourceId: string; returns: { nodes: Rec[] } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(`query($first: Int!, $after: String) { orders(first: $first, after: $after, query: "return_status:IN_PROGRESS OR return_status:RETURN_REQUESTED", sortKey: UPDATED_AT) { nodes { legacyResourceId returns(first: 5) { nodes { id status createdAt returnLineItems(first: 20) { nodes { quantity returnReason ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } } } } } } pageInfo { hasNextPage endCursor } } }`, { first: Math.min(q.limit ?? 50, 100), after: q.cursor ?? null });
    const items: NormalizedReturn[] = [];
    for (const o of data.orders.nodes) {
      for (const r of o.returns.nodes) {
        items.push({ externalId: String(r.id).split("/").pop()!, orderExternalId: o.legacyResourceId, status: String(r.status).toLowerCase(), requestedAt: new Date(String(r.createdAt)), lines: (((r.returnLineItems as Rec).nodes as Rec[]) ?? []).map((l) => ({ orderLineExternalId: String((((l.fulfillmentLineItem as Rec | undefined)?.lineItem as Rec | undefined)?.id ?? "")).split("/").pop()!, quantity: Number(l.quantity), reason: l.returnReason ? String(l.returnReason).toLowerCase() : null })) });
      }
    }
    return { items, nextCursor: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null };
  }

  /** Idempotent: lists existing subscriptions for the callback and creates only the missing topics. */
  async registerWebhooks(callbackUrl: string, topics: string[]): Promise<WebhookRegistration[]> {
    const existing = await this.graphql<{ webhookSubscriptions: { nodes: { topic: string; endpoint: { callbackUrl?: string } }[] } }>(`{ webhookSubscriptions(first: 100) { nodes { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
    const have = new Set(existing.webhookSubscriptions.nodes.filter((n) => n.endpoint.callbackUrl === callbackUrl).map((n) => n.topic));
    const out: WebhookRegistration[] = [];
    for (const topic of topics) {
      const enumTopic = topic.toUpperCase().replace("/", "_");
      if (have.has(enumTopic)) {
        out.push({ topic, address: callbackUrl, status: "existing" });
        continue;
      }
      try {
        const res = await this.graphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(`mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`, { topic: enumTopic, sub: { callbackUrl, format: "JSON" } });
        const err = res.webhookSubscriptionCreate.userErrors[0]?.message;
        out.push(err ? { topic, address: callbackUrl, status: "failed", error: err } : { topic, address: callbackUrl, status: "registered" });
      } catch (e) {
        out.push({ topic, address: callbackUrl, status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<VerifiedWebhook> {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (!verifyWebhookHmac(rawBody, h["x-shopify-hmac-sha256"], this.creds.apiSecret)) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as Rec;
    const topic = h["x-shopify-topic"] ?? "unknown";
    const externalId = String(payload.id ?? payload.inventory_item_id ?? h["x-shopify-webhook-id"] ?? "");
    const sourceUpdatedAt = String(payload.updated_at ?? payload.created_at ?? h["x-shopify-triggered-at"] ?? "");
    return { topic, externalId, sourceUpdatedAt, payload };
  }

  parseWebhookOrder(payload: unknown): NormalizedOrder {
    return mapRestOrder(payload as Rec);
  }
  parseWebhookProduct(payload: unknown): NormalizedProduct {
    return mapRestProduct(payload as Rec);
  }
  parseWebhookCustomer(payload: unknown): NormalizedCustomer | null {
    return mapRestCustomer(payload as Rec);
  }
  parseWebhookInventoryLevel(payload: unknown): NormalizedInventoryLevel {
    return mapRestInventoryLevel(payload as Rec);
  }

  private async mutate(name: string, mutation: string, variables: Record<string, unknown>): Promise<Rec> {
    const data = await this.graphql<Record<string, Rec & { userErrors?: { field?: string[]; message: string }[] }>>(mutation, variables);
    const res = data[name];
    const err = res?.userErrors?.[0];
    if (err) throw new IntegrationError("invalid_request", `${name}: ${err.message}`);
    return res ?? {};
  }

  async cancelOrder(externalId: string, opts: { reason?: string; restock: boolean; refund: boolean }): Promise<void> {
    const reason = ({ customer: "CUSTOMER", fraud: "FRAUD", inventory: "INVENTORY", declined: "DECLINED", staff: "STAFF" } as Record<string, string>)[opts.reason ?? ""] ?? "OTHER";
    await this.mutate("orderCancel", `mutation($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) { orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: true) { job { id } orderCancelUserErrors { field message } userErrors { field message } } }`, { orderId: idToGid("Order", externalId), reason, refund: opts.refund, restock: opts.restock });
  }
  async updateOrderDetails(externalId: string, patch: OrderDetailsPatch): Promise<void> {
    const input: Rec = { id: idToGid("Order", externalId) };
    if (patch.email !== undefined) input.email = patch.email;
    if (patch.note !== undefined) input.note = patch.note;
    if (patch.shippingAddress !== undefined && patch.shippingAddress) {
      const a = patch.shippingAddress;
      input.shippingAddress = { address1: a.address1 ?? null, address2: a.address2 ?? null, city: a.city ?? null, provinceCode: a.province ?? null, zip: a.zip ?? null, countryCode: a.country ?? null, phone: patch.phone ?? a.phone ?? null, firstName: a.name?.split(" ")[0] ?? null, lastName: a.name?.split(" ").slice(1).join(" ") || null };
    }
    await this.mutate("orderUpdate", `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`, { input });
  }
  /**
   * Draft order → complete with payment pending. To verify on a real account: tax behaviour,
   * shipping line and the COD gateway name depend on the shop's settings.
   */
  async createInvoiceOrder(input: CreateOrderInput): Promise<{ draftExternalId: string; invoiceUrl: string | null }> {
    const created = await this.mutate("draftOrderCreate", `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }`, { input: this.draftInput(input) });
    const draft = created.draftOrder as { id: string; invoiceUrl: string | null };
    const sent = await this.mutate("draftOrderInvoiceSend", `mutation($id: ID!) { draftOrderInvoiceSend(id: $id) { draftOrder { id invoiceUrl } userErrors { field message } } }`, { id: draft.id });
    return { draftExternalId: gidToId(draft.id) ?? draft.id, invoiceUrl: ((sent.draftOrder as { invoiceUrl?: string | null } | undefined)?.invoiceUrl ?? draft.invoiceUrl) || null };
  }

  private draftInput(input: CreateOrderInput): Rec {
    const a = input.shippingAddress;
    const address = a ? { address1: a.address1 ?? null, address2: a.address2 ?? null, city: a.city ?? null, provinceCode: a.province ?? null, zip: a.zip ?? null, countryCode: a.country ?? null, phone: input.phone ?? a.phone ?? null, firstName: a.name?.split(" ")[0] ?? null, lastName: a.name?.split(" ").slice(1).join(" ") || null } : null;
    return {
      lineItems: input.lines.map((l) => (l.variantExternalId ? { variantId: idToGid("ProductVariant", l.variantExternalId), quantity: l.quantity } : { title: l.title, quantity: l.quantity, originalUnitPrice: (l.unitPriceMinor / 100).toFixed(2) })),
      email: input.email,
      phone: input.phone,
      note: input.note,
      tags: input.tags,
      shippingAddress: address,
      billingAddress: input.billingAddress ? address : null,
      customAttributes: [...input.noteAttributes, ...(input.replacesOrderName ? [{ key: "replaces_order", value: input.replacesOrderName }] : [])].map((x) => ("key" in x ? x : { key: x.name, value: x.value })),
      ...(input.shippingMinor > 0 ? { shippingLine: { title: "Shipping", price: (input.shippingMinor / 100).toFixed(2) } } : {}),
      ...(input.discountMinor > 0 ? { appliedDiscount: { valueType: "FIXED_AMOUNT", value: input.discountMinor / 100, title: "Keel" } } : {}),
    };
  }

  async createOrder(input: CreateOrderInput): Promise<NormalizedOrder> {
    const draft = this.draftInput(input);
    const created = await this.mutate("draftOrderCreate", `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } } }`, { input: draft });
    const draftId = String((created.draftOrder as Rec).id);
    // a paid original keeps its payment on the cancelled order: the replacement is marked paid (to verify: gateway shown as "manual")
    const paymentPending = input.payment?.status !== "paid";
    const completed = await this.mutate("draftOrderComplete", `mutation($id: ID!, $paymentPending: Boolean) { draftOrderComplete(id: $id, paymentPending: $paymentPending) { draftOrder { order { id legacyResourceId } } userErrors { field message } } }`, { id: draftId, paymentPending });
    const orderId = String(((completed.draftOrder as Rec).order as Rec).legacyResourceId ?? String(((completed.draftOrder as Rec).order as Rec).id).split("/").pop());
    const order = await this.fetchOrder(orderId);
    if (!order) throw new IntegrationError("not_found", "Created order not readable");
    return order;
  }
  /**
   * Order editing API: begin → line discounts → commit. A percentage goes on every line; a fixed
   * amount goes on the line with the largest total (capped there). To verify on a real account:
   * whether `fixedValue` applies per unit or per line, and the customer notification setting.
   */
  async applyOrderDiscount(externalId: string, discount: OrderDiscountPatch): Promise<void> {
    const begun = await this.mutate("orderEditBegin", `mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id lineItems(first: 100) { nodes { id quantity originalUnitPriceSet { shopMoney { amount } } } } } userErrors { field message } } }`, { id: idToGid("Order", externalId) });
    const calc = begun.calculatedOrder as { id: string; lineItems: { nodes: { id: string; quantity: number; originalUnitPriceSet: { shopMoney: { amount: string } } }[] } };
    const lines = calc.lineItems.nodes.filter((l) => l.quantity > 0);
    if (!lines.length) throw new IntegrationError("invalid_request", "No editable lines");
    const description = discount.reason ? `${discount.code} · ${discount.reason}` : discount.code;
    const targets = discount.type === "percentage" ? lines.map((l) => ({ id: l.id, value: { percentValue: discount.value / 100 } })) : [{ id: [...lines].sort((a, b) => Number(b.originalUnitPriceSet.shopMoney.amount) * b.quantity - Number(a.originalUnitPriceSet.shopMoney.amount) * a.quantity)[0]!.id, value: { fixedValue: { amount: (discount.amountMinor / 100).toFixed(2), currencyCode: discount.currency } } }];
    for (const t of targets) await this.mutate("orderEditAddLineItemDiscount", `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) { orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) { calculatedOrder { id } userErrors { field message } } }`, { id: calc.id, lineItemId: t.id, discount: { description, ...t.value } });
    await this.mutate("orderEditCommit", `mutation($id: ID!, $staffNote: String) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id } userErrors { field message } } }`, { id: calc.id, staffNote: description });
  }
  async addOrderNote(externalId: string, note: string): Promise<void> {
    await this.mutate("orderUpdate", `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`, { input: { id: idToGid("Order", externalId), note } });
  }
  async updateOrderTags(externalId: string, add: string[], remove: string[]): Promise<void> {
    const id = idToGid("Order", externalId);
    if (add.length) await this.mutate("tagsAdd", `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: add });
    if (remove.length) await this.mutate("tagsRemove", `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: remove });
  }
  async updateVariant(variantExternalId: string, patch: VariantPatch): Promise<void> {
    const data = await this.graphql<{ productVariant: { product: { id: string } } | null }>(`query($id: ID!) { productVariant(id: $id) { product { id } } }`, { id: idToGid("ProductVariant", variantExternalId) });
    if (!data.productVariant) throw new IntegrationError("not_found", "Variant not found");
    await this.mutate("productVariantsBulkUpdate", `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`, { productId: data.productVariant.product.id, variants: [{ id: idToGid("ProductVariant", variantExternalId), ...(patch.priceMinor !== undefined ? { price: (patch.priceMinor / 100).toFixed(2) } : {}), ...(patch.compareAtMinor !== undefined ? { compareAtPrice: patch.compareAtMinor === null ? null : (patch.compareAtMinor / 100).toFixed(2) } : {}) }] });
  }
  /** `inventoryItemUpdate` with `cost`: needs write_inventory. To verify on a real account: multi-currency shops store the cost in the shop currency. */
  async updateVariantCost(variant: { variantExternalId: string; inventoryItemExternalId: string | null }, costMinor: number): Promise<void> {
    let itemId = variant.inventoryItemExternalId ? idToGid("InventoryItem", variant.inventoryItemExternalId) : null;
    if (!itemId) {
      const data = await this.graphql<{ productVariant: { inventoryItem: { id: string } } | null }>(`query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { id: idToGid("ProductVariant", variant.variantExternalId) });
      if (!data.productVariant) throw new IntegrationError("not_found", "Variant not found");
      itemId = data.productVariant.inventoryItem.id;
    }
    await this.mutate("inventoryItemUpdate", `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id unitCost { amount } } userErrors { field message } } }`, { id: itemId, input: { cost: (costMinor / 100).toFixed(2) } });
  }
  async updateProductTags(productExternalId: string, add: string[], remove: string[]): Promise<void> {
    const id = idToGid("Product", productExternalId);
    if (add.length) await this.mutate("tagsAdd", `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: add });
    if (remove.length) await this.mutate("tagsRemove", `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: remove });
  }
  async updateProductStatus(productExternalId: string, status: "active" | "draft" | "archived"): Promise<void> {
    await this.mutate("productUpdate", `mutation($input: ProductInput!) { productUpdate(input: $input) { userErrors { field message } } }`, { input: { id: idToGid("Product", productExternalId), status: status.toUpperCase() } });
  }
  async setInventory(inventoryItemExternalId: string, locationExternalId: string, available: number): Promise<void> {
    await this.mutate("inventorySetQuantities", `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }`, { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [{ inventoryItemId: idToGid("InventoryItem", inventoryItemExternalId), locationId: idToGid("Location", locationExternalId), quantity: available }] } });
  }
  async createDiscountCode(input: { code: string; title: string; type: "percentage" | "fixed_amount" | "free_shipping"; value: number; startsAt?: Date | null; endsAt?: Date | null; usageLimit?: number | null; minimumAmountMinor?: number | null }): Promise<{ externalId: string }> {
    const common = { title: input.title, code: input.code, startsAt: (input.startsAt ?? new Date()).toISOString(), endsAt: input.endsAt?.toISOString() ?? null, usageLimit: input.usageLimit ?? null, appliesOncePerCustomer: false, customerSelection: { all: true }, ...(input.minimumAmountMinor ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: (input.minimumAmountMinor / 100).toFixed(2) } } } : {}) };
    if (input.type === "free_shipping") {
      const res = await this.mutate("discountCodeFreeShippingCreate", `mutation($d: DiscountCodeFreeShippingInput!) { discountCodeFreeShippingCreate(freeShippingCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`, { d: { ...common, destination: { all: true } } });
      return { externalId: String((res.codeDiscountNode as Rec).id).split("/").pop()! };
    }
    const value = input.type === "percentage" ? { percentage: input.value / 10000 } : { discountAmount: { amount: (input.value / 100).toFixed(2), appliesOnEachItem: false } };
    const res = await this.mutate("discountCodeBasicCreate", `mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`, { d: { ...common, customerGets: { value, items: { all: true } } } });
    return { externalId: String((res.codeDiscountNode as Rec).id).split("/").pop()! };
  }
  /** One discount + bulk-added redeem codes (blocks of 100; Shopify processes them asynchronously). */
  async createDiscountPool(input: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null }): Promise<{ externalId: string; imported: string[]; failed: string[] }> {
    const [first, ...rest] = input.codes;
    if (!first) throw new IntegrationError("invalid_request", "No codes");
    const { externalId } = await this.createDiscountCode({ code: first, title: input.title, type: input.type, value: input.value, startsAt: input.startsAt, endsAt: input.endsAt, usageLimit: null });
    const imported = [first];
    const failed: string[] = [];
    for (let i = 0; i < rest.length; i += 100) {
      const chunk = rest.slice(i, i + 100);
      try {
        const res = await this.mutate("discountRedeemCodeBulkAdd", `mutation($id: ID!, $codes: [DiscountRedeemCodeInput!]!) { discountRedeemCodeBulkAdd(discountId: $id, codes: $codes) { bulkCreation { id } userErrors { field message } } }`, { id: idToGid("DiscountCodeNode", externalId), codes: chunk.map((code) => ({ code })) });
        void res;
        imported.push(...chunk);
      } catch {
        failed.push(...chunk);
      }
    }
    return { externalId, imported, failed };
  }
  async restockInventory(lines: { inventoryItemExternalId: string; locationExternalId: string; quantity: number }[]): Promise<void> {
    if (!lines.length) return;
    await this.mutate("inventoryAdjustQuantities", `mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { field message } } }`, { input: { name: "available", reason: "restock", changes: lines.map((l) => ({ inventoryItemId: idToGid("InventoryItem", l.inventoryItemExternalId), locationId: idToGid("Location", l.locationExternalId), delta: l.quantity })) } });
  }

  /** Fulfillment orders of an order with their holds (Shopify splits an order per location). */
  private async fulfillmentOrders(orderExternalId: string): Promise<{ id: string; status: string; holds: { id: string; handle: string | null }[] }[]> {
    const data = await this.graphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; fulfillmentHolds: { id: string; handle: string | null }[] }[] } } | null }>(`query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle } } } } }`, { id: idToGid("Order", orderExternalId) });
    if (!data.order) throw new IntegrationError("not_found", `Order ${orderExternalId} not found`);
    return data.order.fulfillmentOrders.nodes.map((n) => ({ id: n.id, status: n.status, holds: n.fulfillmentHolds ?? [] }));
  }

  /** Holds every open fulfillment order with Keel's handle; one already holding Keel's hold is left alone. */
  async holdFulfillment(externalId: string, hold: FulfillmentHoldInput): Promise<void> {
    const reason = hold.reason === "awaiting_stock" ? "INVENTORY_OUT_OF_STOCK" : "OTHER";
    for (const fo of await this.fulfillmentOrders(externalId)) {
      if (fo.holds.some((h) => h.handle === KEEL_HOLD_HANDLE)) continue;
      if (fo.status !== "OPEN" && fo.status !== "ON_HOLD") continue;
      await this.mutate("fulfillmentOrderHold", `mutation($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) { fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) { fulfillmentHold { id } userErrors { field message } } }`, { id: fo.id, fulfillmentHold: { reason, reasonNotes: hold.note ?? undefined, handle: KEEL_HOLD_HANDLE, notifyMerchant: false } });
    }
  }

  /** Releases only the holds carrying Keel's handle, so a merchant's own hold survives. */
  async releaseFulfillment(externalId: string): Promise<void> {
    for (const fo of await this.fulfillmentOrders(externalId)) {
      const ours = fo.holds.filter((h) => h.handle === KEEL_HOLD_HANDLE).map((h) => h.id);
      if (!ours.length) continue;
      await this.mutate("fulfillmentOrderReleaseHold", `mutation($id: ID!, $holdIds: [ID!]) { fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) { fulfillmentOrder { id status } userErrors { field message } } }`, { id: fo.id, holdIds: ours });
    }
  }

  /** Order line → fulfillment line items (a return is opened on fulfilled units). */
  private async fulfillmentLines(orderExternalId: string): Promise<{ id: string; lineItemId: string; quantity: number }[]> {
    const data = await this.graphql<{ order: { fulfillments: { fulfillmentLineItems: { nodes: { id: string; quantity: number; lineItem: { id: string } }[] } }[] } | null }>(`query($id: ID!) { order(id: $id) { fulfillments(first: 20) { fulfillmentLineItems(first: 100) { nodes { id quantity lineItem { id } } } } } }`, { id: idToGid("Order", orderExternalId) });
    if (!data.order) throw new IntegrationError("not_found", `Order ${orderExternalId} not found`);
    return data.order.fulfillments.flatMap((f) => f.fulfillmentLineItems.nodes.map((n) => ({ id: n.id, lineItemId: gidToId(n.lineItem.id) ?? n.lineItem.id, quantity: n.quantity })));
  }

  async requestReturn(orderExternalId: string, input: { lines: PlatformReturnLineInput[]; note?: string | null }): Promise<{ externalId: string; lines: { orderLineExternalId: string; externalId: string }[] }> {
    const fls = await this.fulfillmentLines(orderExternalId);
    const items: Rec[] = [];
    for (const l of input.lines) {
      let left = l.quantity;
      for (const f of fls.filter((x) => x.lineItemId === l.orderLineExternalId)) {
        if (left <= 0) break;
        const q = Math.min(left, f.quantity);
        items.push({ fulfillmentLineItemId: f.id, quantity: q, returnReason: l.reason ?? "OTHER", customerNote: l.note ?? input.note ?? undefined });
        left -= q;
      }
      if (left > 0) throw new IntegrationError("invalid_request", `Line ${l.orderLineExternalId} is not fulfilled on Shopify for ${l.quantity} units`);
    }
    const res = await this.mutate("returnRequest", `mutation($input: ReturnRequestInput!) { returnRequest(input: $input) { return { id returnLineItems(first: 100) { nodes { id ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } } } } userErrors { field message } } }`, { input: { orderId: idToGid("Order", orderExternalId), returnLineItems: items } });
    const ret = res.return as { id: string; returnLineItems: { nodes: { id: string; fulfillmentLineItem?: { lineItem: { id: string } } }[] } } | undefined;
    if (!ret) throw new IntegrationError("unknown", "returnRequest returned no return");
    return { externalId: gidToId(ret.id) ?? ret.id, lines: ret.returnLineItems.nodes.map((n) => ({ orderLineExternalId: gidToId(n.fulfillmentLineItem?.lineItem.id) ?? "", externalId: gidToId(n.id) ?? n.id })) };
  }

  async approveReturn(returnExternalId: string): Promise<void> {
    await this.mutate("returnApproveRequest", `mutation($input: ReturnApproveRequestInput!) { returnApproveRequest(input: $input) { return { id status } userErrors { field message } } }`, { input: { id: idToGid("Return", returnExternalId) } });
  }

  async declineReturn(returnExternalId: string, note: string | null): Promise<void> {
    await this.mutate("returnDeclineRequest", `mutation($input: ReturnDeclineRequestInput!) { returnDeclineRequest(input: $input) { return { id status } userErrors { field message } } }`, { input: { id: idToGid("Return", returnExternalId), declineReason: "OTHER", declineNote: note ?? undefined } });
  }

  async refundReturn(orderExternalId: string, input: { lines: { orderLineExternalId: string; quantity: number }[]; amountMinor: number; currency: string; note?: string | null; notify: boolean }): Promise<{ externalId: string; amountMinor: number }> {
    const orderId = idToGid("Order", orderExternalId);
    // Money goes back on the original capture: refundable = captured − already refunded; nothing captured (e.g. paid on delivery) → no transaction.
    const data = await this.graphql<{ order: { transactions: { id: string; kind: string; status: string; gateway: string; amountSet: { shopMoney: { amount: string } } }[] } | null }>(`query($id: ID!) { order(id: $id) { transactions(first: 50) { id kind status gateway amountSet { shopMoney { amount } } } } }`, { id: orderId });
    if (!data.order) throw new IntegrationError("not_found", `Order ${orderExternalId} not found`);
    const ok = data.order.transactions.filter((t) => t.status === "SUCCESS");
    const minor = (a: string) => Math.round(Number(a) * 100);
    const parent = ok.find((t) => t.kind === "SALE" || t.kind === "CAPTURE");
    const captured = ok.filter((t) => t.kind === "SALE" || t.kind === "CAPTURE").reduce((s, t) => s + minor(t.amountSet.shopMoney.amount), 0);
    const refunded = ok.filter((t) => t.kind === "REFUND").reduce((s, t) => s + minor(t.amountSet.shopMoney.amount), 0);
    const amount = parent ? Math.max(0, Math.min(input.amountMinor, captured - refunded)) : 0;
    const res = await this.mutate("refundCreate", `mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } } }`, {
      input: {
        orderId,
        note: input.note ?? undefined,
        notify: input.notify,
        refundLineItems: input.lines.map((l) => ({ lineItemId: idToGid("LineItem", l.orderLineExternalId), quantity: l.quantity, restockType: "NO_RESTOCK" })),
        transactions: amount > 0 && parent ? [{ orderId, parentId: parent.id, gateway: parent.gateway, kind: "REFUND", amount: (amount / 100).toFixed(2) }] : [],
      },
    });
    const refund = res.refund as { id: string; totalRefundedSet: { shopMoney: { amount: string } } } | undefined;
    if (!refund) throw new IntegrationError("unknown", "refundCreate returned no refund");
    return { externalId: gidToId(refund.id) ?? refund.id, amountMinor: minor(refund.totalRefundedSet.shopMoney.amount) };
  }

  async closeReturn(returnExternalId: string): Promise<void> {
    await this.mutate("returnClose", `mutation($id: ID!) { returnClose(id: $id) { return { id status } userErrors { field message } } }`, { id: idToGid("Return", returnExternalId) });
  }

  /**
   * Fulfilment from Keel: the order's open fulfillment orders → one `fulfillmentCreate` with the
   * tracking info. Lines omitted = every remaining unit. Scope `write_merchant_managed_fulfillment_orders`
   * (or the third-party / assigned variants, depending on who holds the location).
   */
  async createFulfillment(input: CreateFulfillmentInput): Promise<NormalizedFulfillment> {
    const data = await this.graphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] } }[] } } | null }>(`query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } } } } }`, { id: idToGid("Order", input.orderExternalId) });
    if (!data.order) throw new IntegrationError("not_found", `Order ${input.orderExternalId} not found`);
    const open = data.order.fulfillmentOrders.nodes.filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");
    const wanted = input.lines ? new Map(input.lines.map((l) => [l.orderLineExternalId, l.quantity])) : null;
    const groups: Rec[] = [];
    for (const fo of open) {
      const items: { id: string; quantity: number }[] = [];
      for (const li of fo.lineItems.nodes) {
        if (li.remainingQuantity <= 0) continue;
        const lineId = gidToId(li.lineItem.id) ?? li.lineItem.id;
        if (!wanted) items.push({ id: li.id, quantity: li.remainingQuantity });
        else if (wanted.has(lineId)) {
          const q = Math.min(li.remainingQuantity, wanted.get(lineId)!);
          if (q > 0) items.push({ id: li.id, quantity: q });
          wanted.set(lineId, wanted.get(lineId)! - q);
        }
      }
      if (items.length) groups.push({ fulfillmentOrderId: fo.id, ...(wanted ? { fulfillmentOrderLineItems: items } : {}) });
    }
    if (!groups.length) throw new IntegrationError("invalid_request", `Order ${input.orderExternalId} has nothing left to fulfil`);
    const res = await this.mutate("fulfillmentCreate", `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id legacyResourceId status displayStatus createdAt updatedAt trackingInfo { number url company } } userErrors { field message } } }`, { fulfillment: { lineItemsByFulfillmentOrder: groups, notifyCustomer: input.notifyCustomer, trackingInfo: { company: input.carrier, number: input.trackingNumber, ...(input.trackingUrl ? { url: input.trackingUrl } : {}) } } });
    const f = res.fulfillment as { id: string; legacyResourceId?: string; status: string; displayStatus?: string | null; createdAt: string; updatedAt?: string; trackingInfo?: { number?: string; url?: string; company?: string }[] } | undefined;
    if (!f) throw new IntegrationError("unknown", "fulfillmentCreate returned no fulfillment");
    const ti = f.trackingInfo?.[0];
    const display = (f.displayStatus ?? "").toLowerCase() || null;
    return { externalId: String(f.legacyResourceId ?? gidToId(f.id) ?? f.id), status: mapFulfillmentStatus(display, f.status.toLowerCase()), externalStatus: display, trackingNumber: ti?.number ?? input.trackingNumber, trackingUrl: ti?.url ?? input.trackingUrl ?? null, carrier: ti?.company ?? input.carrier, createdAt: new Date(f.createdAt), updatedAt: new Date(f.updatedAt ?? f.createdAt), deliveredAt: null };
  }
}

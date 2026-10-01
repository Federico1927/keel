import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type CommercePlatform, type ConnectionTest, type NormalizedCustomer, type NormalizedDiscount, type NormalizedInventoryLevel, type NormalizedLocation, type NormalizedOrder, type NormalizedProduct, type NormalizedReturn, type Page, type SyncQuery, type VerifiedWebhook, type WebhookRegistration } from "../types";
import { ORDER_FIELDS, PRODUCT_FIELDS, idToGid, mapGraphqlCustomer, mapGraphqlDiscount, mapGraphqlInventoryLevel, mapGraphqlLocation, mapGraphqlOrder, mapGraphqlProduct, mapRestCustomer, mapRestInventoryLevel, mapRestOrder, mapRestProduct } from "./mappers";
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
  async addOrderNote(externalId: string, note: string): Promise<void> {
    await this.mutate("orderUpdate", `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`, { input: { id: idToGid("Order", externalId), note } });
  }
  async updateOrderTags(externalId: string, add: string[], remove: string[]): Promise<void> {
    const id = idToGid("Order", externalId);
    if (add.length) await this.mutate("tagsAdd", `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: add });
    if (remove.length) await this.mutate("tagsRemove", `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags: remove });
  }
  async updateVariant(variantExternalId: string, patch: { priceMinor?: number }): Promise<void> {
    const data = await this.graphql<{ productVariant: { product: { id: string } } | null }>(`query($id: ID!) { productVariant(id: $id) { product { id } } }`, { id: idToGid("ProductVariant", variantExternalId) });
    if (!data.productVariant) throw new IntegrationError("not_found", "Variant not found");
    await this.mutate("productVariantsBulkUpdate", `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`, { productId: data.productVariant.product.id, variants: [{ id: idToGid("ProductVariant", variantExternalId), ...(patch.priceMinor !== undefined ? { price: (patch.priceMinor / 100).toFixed(2) } : {}) }] });
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
  async restockReturn(_orderExternalId: string, lines: { orderLineExternalId: string; quantity: number; locationExternalId: string }[]): Promise<void> {
    // Restock through inventory adjustments keyed by the variant's inventory item; the caller passes inventory item ids as orderLineExternalId when known.
    await this.mutate("inventoryAdjustQuantities", `mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { field message } } }`, { input: { name: "available", reason: "restock", changes: lines.map((l) => ({ inventoryItemId: idToGid("InventoryItem", l.orderLineExternalId), locationId: idToGid("Location", l.locationExternalId), delta: l.quantity })) } });
  }
}

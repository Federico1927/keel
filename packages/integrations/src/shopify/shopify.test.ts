import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { ShopifyCommercePlatform } from "./adapter";
import { mapRestOrder } from "./mappers";
import { buildInstallUrl, verifyOAuthCallback, verifyWebhookHmac } from "./oauth";
import { graphqlCancel, graphqlDiscounts, graphqlFulfillmentOrderHold, graphqlFulfillmentOrderReleaseHold, graphqlFulfillmentOrders, graphqlInventory, graphqlInventoryItemUpdate, graphqlOrdersPage, graphqlProductsPage, graphqlProduct, graphqlProductMediaPage2, graphqlProductUpdate, graphqlShop, graphqlThrottled, graphqlVariantInventoryItem, graphqlWebhookCreate, graphqlWebhooks, restOrderWebhook, graphqlPayouts, graphqlBalanceTransactions, graphqlNoPaymentsAccount, graphqlMarkAsPaid, graphqlManualPayment, graphqlReturnsPage, graphqlReturn, restReturnWebhook, restReturnApproveWebhook, graphqlDiscountDeactivate, graphqlDiscountByCode, graphqlRedeemCodeBulkDelete, graphqlRedeemCodeBulkAdd } from "./__fixtures__";

const creds = { shop: "northwind-demo.myshopify.com", accessToken: "shpat_test", apiSecret: "shhh" };
const bodyOf = (init?: { body?: string }) => (init?.body ? (JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }) : { query: "", variables: {} });

function platform(routes: Parameters<typeof fixtureFetch>[0]) {
  return new ShopifyCommercePlatform(creds, { fetchImpl: fixtureFetch(routes), sleep: async () => undefined, minIntervalMs: 0 });
}

describe("shopify mappers", () => {
  it("maps an orders/* webhook payload to the canonical order without reading tags as state", () => {
    const o = mapRestOrder(restOrderWebhook);
    expect(o.externalId).toBe("5678901234567");
    expect(o.orderNumber).toBe(1042);
    expect(o.paymentMethod).toBe("card");
    expect(o.paymentStatus).toBe("paid");
    expect(o.totalMinor).toBe(17600);
    expect(o.taxMinor).toBe(3068);
    expect(o.shippingMinor).toBe(590);
    expect(o.discountMinor).toBe(1890);
    expect(o.tags).toEqual(["vip", "wholesale"]);
    expect(o.lines).toHaveLength(2);
    expect(o.lines[1]).toMatchObject({ quantity: 2, unitPriceMinor: 3000, discountMinor: 600, totalMinor: 5400, variantExternalId: "4100002" });
    expect(o.discounts[0]).toMatchObject({ code: "WELCOME10", amountMinor: 1890 });
    expect(o.customer).toMatchObject({ externalId: "7000000001", acceptsMarketing: true, country: "IT" });
    expect(o.fulfillments[0]).toMatchObject({ status: "in_transit", carrier: "BRT", trackingNumber: "BRT123456789IT" });
    expect(o.landingSite).toContain("fbclid=");
    expect(o.noteAttributes).toHaveLength(2);
  });
});

describe("shopify adapter", () => {
  it("tests the connection and reports missing scopes", async () => {
    const p = platform([{ match: () => true, body: graphqlShop }]);
    const t = await p.testConnection();
    expect(t.ok).toBe(true);
    expect(t.accountName).toBe("Northwind Apparel");
    expect(t.missingScopes).toContain("read_returns");
    expect(t.missingScopes).not.toContain("read_orders");
  });

  it("pages orders with a cursor, mapping COD gateway and gclid landing page", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("orders(first"), body: graphqlOrdersPage }]);
    const page = await p.fetchOrders({ updatedSince: new Date("2026-09-01T00:00:00Z"), limit: 50 });
    expect(page.nextCursor).toBe("eyJsYXN0X2lkIjo1Njc4OTAxMjM0NTY4fQ==");
    const o = page.items[0]!;
    expect(o.paymentMethod).toBe("cod");
    expect(o.paymentStatus).toBe("pending");
    expect(o.totalMinor).toBe(6490);
    expect(o.lines[0]!.sku).toBe("SNK-42-NER");
    const sent = bodyOf({ body: p.http.calls[0]!.body! });
    expect(sent.variables.query).toContain("updated_at:>='2026-09-01");
    expect(sent.variables.query).toContain("status:any");
  });

  it("maps products, discounts and inventory levels", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("products(first"), body: graphqlProductsPage },
      { match: (_u, i) => bodyOf(i).query.includes("media(first: 50, after"), body: graphqlProductMediaPage2 },
      { match: (_u, i) => bodyOf(i).query.includes("discountNodes"), body: graphqlDiscounts },
      { match: (_u, i) => bodyOf(i).query.includes("InventoryItem"), body: graphqlInventory },
    ]);
    const products = await p.fetchProducts({});
    expect(products.items[0]).toMatchObject({ externalId: "8100001", productType: "Outerwear", status: "active" });
    // the second media page was read too (one product query, no second product fetch)
    expect(products.items[0]!.media!.map((m) => m.externalId)).toEqual(["gid://shopify/MediaImage/3100001", "gid://shopify/Video/3100002", "gid://shopify/Model3d/3100003"]);
    expect(products.items[0]!.variants[0]).toMatchObject({ sku: "GIA-M-BLU", priceMinor: 12900, compareAtMinor: 15900, weightGrams: 800, inventoryItemExternalId: "4500001", optionValues: { Size: "M", Color: "Blu" }, costMinor: 4850 });
    // a variant without a cost on Shopify maps to null, never to zero
    expect(products.items[0]!.variants[1]).toMatchObject({ sku: "GIA-L-BLU", barcode: null, costMinor: null, weightGrams: 800 });
    expect(bodyOf({ body: p.http.calls[0]!.body! }).query).toContain("unitCost { amount");
    const discounts = await p.fetchDiscounts({});
    expect(discounts.items[0]).toMatchObject({ code: "WELCOME10", type: "percentage", value: 1000, usedCount: 412 });
    expect(discounts.items[1]).toMatchObject({ code: "FREESHIP", type: "free_shipping", usageLimit: 1000 });
    const levels = await p.fetchInventoryLevels(["4500001"]);
    expect(levels[0]).toMatchObject({ inventoryItemExternalId: "4500001", locationExternalId: "6100001", available: 12, onHand: 15, committed: 3 });
  });

  it("retries when the GraphQL cost limit is throttled", async () => {
    let n = 0;
    const p = platform([{ match: () => true, body: () => (n++ === 0 ? graphqlThrottled : graphqlShop) }]);
    const t = await p.testConnection();
    expect(t.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("maps HTTP errors to integration error codes and honours Retry-After on 429", async () => {
    let n = 0;
    const p = platform([{ match: () => true, status: 429, headers: { "retry-after": "2" }, body: () => (n++, { errors: "Too many requests" }) }]);
    await expect(p.fetchLocations()).rejects.toMatchObject({ code: "rate_limited" });
    expect(n).toBe(4);
    const p401 = platform([{ match: () => true, status: 401, body: { errors: "Invalid API key or access token" } }]);
    await expect(p401.fetchLocations()).rejects.toMatchObject({ code: "token_expired" });
  });

  it("registers only missing webhooks and verifies HMAC signatures", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("webhookSubscriptions(first"), body: graphqlWebhooks },
      { match: (_u, i) => bodyOf(i).query.includes("webhookSubscriptionCreate"), body: graphqlWebhookCreate },
    ]);
    const res = await p.registerWebhooks("https://keel.example/api/webhooks/shopify", ["orders/create", "orders/updated"]);
    expect(res).toEqual([{ topic: "orders/create", address: "https://keel.example/api/webhooks/shopify", status: "existing" }, { topic: "orders/updated", address: "https://keel.example/api/webhooks/shopify", status: "registered" }]);
    const raw = JSON.stringify(restOrderWebhook);
    const sig = createHmac("sha256", creds.apiSecret).update(raw, "utf8").digest("base64");
    const v = await p.verifyWebhook({ "X-Shopify-Topic": "orders/updated", "X-Shopify-Hmac-Sha256": sig }, raw);
    expect(v).toMatchObject({ topic: "orders/updated", externalId: "5678901234567", sourceUpdatedAt: "2026-09-29T08:00:00+02:00" });
    await expect(p.verifyWebhook({ "X-Shopify-Hmac-Sha256": "bad" }, raw)).rejects.toBeInstanceOf(IntegrationError);
    expect(verifyWebhookHmac(raw, sig, "other-secret")).toBe(false);
    expect(p.parseWebhookOrder(v.payload).name).toBe("#NW1042");
  });

  it("writes go through mutations with user errors surfaced", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("orderCancel"), body: graphqlCancel },
      { match: (_u, i) => bodyOf(i).query.includes("productUpdate"), body: { data: { productUpdate: { userErrors: [{ field: ["status"], message: "Invalid status" }] } } } },
    ]);
    await expect(p.cancelOrder("5678901234567", { reason: "customer", restock: true, refund: false })).resolves.toBeUndefined();
    const sent = bodyOf({ body: p.http.calls[0]!.body! });
    expect(sent.variables).toMatchObject({ orderId: "gid://shopify/Order/5678901234567", reason: "CUSTOMER", restock: true, refund: false });
    await expect(p.updateProductStatus("8100001", "draft")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("applies a discount to an existing order through the order editing API", async () => {
    const begin = { data: { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/1", lineItems: { nodes: [{ id: "gid://shopify/CalculatedLineItem/1", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "20.00" } } }, { id: "gid://shopify/CalculatedLineItem/2", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "30.00" } } }] } }, userErrors: [] } } };
    const routes = [
      { match: (_u: string, i?: { body?: string }) => bodyOf(i).query.includes("orderEditBegin"), body: begin },
      { match: (_u: string, i?: { body?: string }) => bodyOf(i).query.includes("orderEditAddLineItemDiscount"), body: { data: { orderEditAddLineItemDiscount: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/1" }, userErrors: [] } } } },
      { match: (_u: string, i?: { body?: string }) => bodyOf(i).query.includes("orderEditCommit"), body: { data: { orderEditCommit: { order: { id: "gid://shopify/Order/5678901234567" }, userErrors: [] } } } },
    ];
    const pct = platform(routes);
    await pct.applyOrderDiscount("5678901234567", { type: "percentage", value: 1000, amountMinor: 800, currency: "USD", code: "KEEL-10%" });
    const pctCalls = pct.http.calls.map((c) => bodyOf({ body: c.body! }));
    expect(pctCalls.filter((c) => c.query.includes("orderEditAddLineItemDiscount"))).toHaveLength(2);
    expect(pctCalls[1]!.variables).toMatchObject({ discount: { percentValue: 10, description: "KEEL-10%" } });
    const fixed = platform(routes);
    await fixed.applyOrderDiscount("5678901234567", { type: "fixed_amount", value: 500, amountMinor: 500, currency: "USD", code: "KEEL-5.00" });
    const fixedCalls = fixed.http.calls.map((c) => bodyOf({ body: c.body! }));
    const adds = fixedCalls.filter((c) => c.query.includes("orderEditAddLineItemDiscount"));
    expect(adds).toHaveLength(1);
    expect(adds[0]!.variables).toMatchObject({ lineItemId: "gid://shopify/CalculatedLineItem/2", discount: { fixedValue: { amount: "5.00", currencyCode: "USD" } } });
    expect(fixedCalls.at(-1)!.query).toContain("orderEditCommit");
  });
});

describe("shopify product mirror (issue #19)", () => {
  it("maps every mirrored field of the recorded product", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("product(id"), body: graphqlProduct }]);
    const prod = (await p.fetchProduct("8100001"))!;
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/Product/8100001" });
    expect(prod).toMatchObject({
      platformUpdatedAt: new Date("2026-09-20T08:15:00Z"),
      descriptionHtml: "<p>Giacca leggera <strong>impermeabile</strong>.</p>",
      seo: { title: "Giacca Primavera impermeabile", description: "Giacca leggera per la mezza stagione." },
      category: { id: "gid://shopify/TaxonomyCategory/aa-1-10-2", name: "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets" },
      collections: [{ id: "gid://shopify/Collection/501", title: "Primavera 2026", handle: "primavera-2026" }],
      publishedChannels: [{ id: "gid://shopify/Publication/1", name: "Online Store", published: true, publishedAt: "2026-02-01T10:05:00Z" }, { id: "gid://shopify/Publication/2", name: "Point of Sale", published: false, publishedAt: null }],
      metafields: [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Nylon riciclato" }],
    });
    // a media still processing (no image yet) is skipped; a video keeps its preview image
    expect(prod.media).toEqual([
      { externalId: "gid://shopify/MediaImage/3100001", type: "image", url: "https://cdn.example/giacca.jpg", alt: "Giacca blu, fronte", width: 1200, height: 1500 },
      { externalId: "gid://shopify/Video/3100002", type: "video", url: "https://cdn.example/giacca-video.jpg", alt: null, width: 1280, height: 720 },
    ]);
    expect(prod.variants[0]).toMatchObject({ imageMediaExternalId: "gid://shopify/MediaImage/3100001", inventoryPolicy: "deny", taxable: true, tracksInventory: true, requiresShipping: true, hsCode: "620193", countryOfOrigin: "IT", costMinor: 4850 });
    expect(prod.variants[1]).toMatchObject({ imageMediaExternalId: null, inventoryPolicy: "continue", taxable: false, tracksInventory: false, requiresShipping: false, hsCode: null, countryOfOrigin: null, costMinor: null });
    const missing = platform([{ match: () => true, body: { data: { product: null } } }]);
    expect(await missing.fetchProduct("1")).toBeNull();
  });
  it("leaves the fields a REST webhook does not carry undefined (the stored mirror is kept)", () => {
    const p = platform([]);
    const prod = p.parseWebhookProduct({ id: 8100001, title: "Giacca", body_html: "<p>x</p>", updated_at: "2026-09-20T08:15:00Z", status: "active", tags: "a, b", options: [{ name: "Size", values: ["M"] }], variants: [{ id: 1, title: "M", option1: "M", price: "10.00", inventory_policy: "continue", taxable: true }] });
    expect(prod).toMatchObject({ descriptionHtml: "<p>x</p>", platformUpdatedAt: new Date("2026-09-20T08:15:00Z"), tags: ["a", "b"] });
    expect(prod.media).toBeUndefined();
    expect(prod.seo).toBeUndefined();
    expect(prod.metafields).toBeUndefined();
    expect(prod.variants[0]).toMatchObject({ inventoryPolicy: "continue", taxable: true });
    expect(prod.variants[0]!.imageMediaExternalId).toBeUndefined();
  });
  it("updates the editable fields with productUpdate(product:) and maps the answer", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("productUpdate"), body: graphqlProductUpdate }]);
    const after = await p.updateProduct("8100001", { title: "Giacca Primavera Light", tags: ["new-in", "light"], seo: { title: "Giacca Light", description: "Nuova descrizione" }, status: "draft", categoryId: null, descriptionHtml: "<p>y</p>", vendor: "NW", productType: "Coats" });
    const sent = bodyOf({ body: p.http.calls[0]!.body! });
    expect(sent.query).toContain("productUpdate(product: $product)");
    expect(sent.variables).toEqual({ product: { id: "gid://shopify/Product/8100001", title: "Giacca Primavera Light", descriptionHtml: "<p>y</p>", vendor: "NW", productType: "Coats", tags: ["new-in", "light"], status: "DRAFT", seo: { title: "Giacca Light", description: "Nuova descrizione" }, category: null } });
    expect(after).toMatchObject({ title: "Giacca Primavera Light", tags: ["new-in", "light"], platformUpdatedAt: new Date("2026-09-21T09:00:00Z"), seo: { title: "Giacca Light", description: "Nuova descrizione" } });
    const refused = platform([{ match: () => true, body: { data: { productUpdate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } } }]);
    await expect(refused.updateProduct("8100001", { title: "" })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("writes media operations and reads the product back", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("productReorderMedia"), body: { data: { productReorderMedia: { job: { id: "gid://shopify/Job/1", done: false }, mediaUserErrors: [], userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("job(id"), body: { data: { job: { id: "gid://shopify/Job/1", done: true } } } },
      { match: (_u, i) => bodyOf(i).query.includes("productDeleteMedia"), body: { data: { productDeleteMedia: { deletedMediaIds: ["gid://shopify/Video/3100002"], mediaUserErrors: [], userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("fileUpdate"), body: { data: { fileUpdate: { files: [{ id: "gid://shopify/MediaImage/3100001", alt: "Fronte" }], userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("productUpdate"), body: { data: { productUpdate: { product: { id: "gid://shopify/Product/8100001" }, userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("product(id"), body: graphqlProduct },
    ]);
    await p.updateProductMedia("8100001", { type: "reorder", mediaExternalIds: ["gid://shopify/Video/3100002", "gid://shopify/MediaImage/3100001"] });
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/Product/8100001", moves: [{ id: "gid://shopify/Video/3100002", newPosition: "0" }, { id: "gid://shopify/MediaImage/3100001", newPosition: "1" }] });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).query).toContain("job(id");
    await p.updateProductMedia("8100001", { type: "delete", mediaExternalIds: ["gid://shopify/Video/3100002"] });
    expect(bodyOf({ body: p.http.calls[3]!.body! }).variables).toEqual({ productId: "gid://shopify/Product/8100001", mediaIds: ["gid://shopify/Video/3100002"] });
    await p.updateProductMedia("8100001", { type: "alt", mediaExternalId: "gid://shopify/MediaImage/3100001", alt: "Fronte" });
    expect(bodyOf({ body: p.http.calls[5]!.body! }).variables).toEqual({ files: [{ id: "gid://shopify/MediaImage/3100001", alt: "Fronte" }] });
    const after = await p.updateProductMedia("8100001", { type: "create", url: "https://cdn.example/new.jpg", alt: null });
    expect(bodyOf({ body: p.http.calls[7]!.body! }).variables).toEqual({ product: { id: "gid://shopify/Product/8100001" }, media: [{ originalSource: "https://cdn.example/new.jpg", alt: "", mediaContentType: "IMAGE" }] });
    expect(after.externalId).toBe("8100001");
  });
  it("writes SKU, barcode, weight and inventory policy through productVariantsBulkUpdate", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("productVariant(id"), body: { data: { productVariant: { product: { id: "gid://shopify/Product/77" } } } } },
      { match: (_u, i) => bodyOf(i).query.includes("productVariantsBulkUpdate"), body: { data: { productVariantsBulkUpdate: { userErrors: [] } } } },
    ]);
    await p.updateVariant("4100001", { sku: "GIA-M-BLU-2", barcode: null, weightGrams: 750, inventoryPolicy: "continue" });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toEqual({ productId: "gid://shopify/Product/77", variants: [{ id: "gid://shopify/ProductVariant/4100001", barcode: "", inventoryPolicy: "CONTINUE", inventoryItem: { sku: "GIA-M-BLU-2", measurement: { weight: { value: 750, unit: "GRAMS" } } } }] });
  });
});

describe("shopify product cost write", () => {
  it("updates the inventory item cost, looking the item up when only the variant is known", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("productVariant(id"), body: graphqlVariantInventoryItem },
      { match: (_u, i) => bodyOf(i).query.includes("inventoryItemUpdate"), body: graphqlInventoryItemUpdate },
    ]);
    await p.updateVariantCost({ variantExternalId: "4100001", inventoryItemExternalId: "4500001" }, 5200);
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/InventoryItem/4500001", input: { cost: "52.00" } });
    await p.updateVariantCost({ variantExternalId: "4100004", inventoryItemExternalId: null }, 1999);
    expect(p.http.calls).toHaveLength(3);
    expect(bodyOf({ body: p.http.calls[2]!.body! }).variables).toEqual({ id: "gid://shopify/InventoryItem/4500004", input: { cost: "19.99" } });
    const rejected = platform([{ match: () => true, body: { data: { inventoryItemUpdate: { inventoryItem: null, userErrors: [{ field: ["input", "cost"], message: "Cost must be positive" }] } } } }]);
    await expect(rejected.updateVariantCost({ variantExternalId: "1", inventoryItemExternalId: "2" }, 1)).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("shopify product bulk writes", () => {
  it("sets price and compare-at on a variant and adds/removes product tags", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("productVariant(id"), body: { data: { productVariant: { product: { id: "gid://shopify/Product/77" } } } } },
      { match: (_u, i) => bodyOf(i).query.includes("productVariantsBulkUpdate"), body: { data: { productVariantsBulkUpdate: { userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("tagsAdd"), body: { data: { tagsAdd: { userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("tagsRemove"), body: { data: { tagsRemove: { userErrors: [] } } } },
    ]);
    await p.updateVariant("4100001", { priceMinor: 4990, compareAtMinor: 5990 });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toEqual({ productId: "gid://shopify/Product/77", variants: [{ id: "gid://shopify/ProductVariant/4100001", price: "49.90", compareAtPrice: "59.90" }] });
    await p.updateVariant("4100001", { compareAtMinor: null });
    expect(bodyOf({ body: p.http.calls[3]!.body! }).variables).toEqual({ productId: "gid://shopify/Product/77", variants: [{ id: "gid://shopify/ProductVariant/4100001", compareAtPrice: null }] });
    await p.updateProductTags("77", ["sale"], ["new"]);
    expect(p.http.calls.slice(4).map((c) => bodyOf({ body: c.body! }).variables)).toEqual([{ id: "gid://shopify/Product/77", tags: ["sale"] }, { id: "gid://shopify/Product/77", tags: ["new"] }]);
  });
});

describe("shopify fulfillment holds (backorders)", () => {
  it("holds only open fulfillment orders without Keel's hold, and releases only Keel's holds", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrders(first"), body: graphqlFulfillmentOrders },
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrderHold("), body: graphqlFulfillmentOrderHold },
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrderReleaseHold("), body: graphqlFulfillmentOrderReleaseHold },
    ]);
    await p.holdFulfillment("5678901234567", { reason: "awaiting_stock", note: "PO-202609-004" });
    expect(p.http.calls).toHaveLength(2);
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/Order/5678901234567" });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toEqual({ id: "gid://shopify/FulfillmentOrder/701", fulfillmentHold: { reason: "INVENTORY_OUT_OF_STOCK", reasonNotes: "PO-202609-004", handle: "keel-awaiting-stock", notifyMerchant: false } });
    await p.releaseFulfillment("5678901234567");
    expect(p.http.calls).toHaveLength(4);
    expect(bodyOf({ body: p.http.calls[3]!.body! }).variables).toEqual({ id: "gid://shopify/FulfillmentOrder/702", holdIds: ["gid://shopify/FulfillmentHold/81"] });
  });
  it("surfaces user errors and unknown orders", async () => {
    const missing = platform([{ match: () => true, body: { data: { order: null } } }]);
    await expect(missing.holdFulfillment("1", { reason: "other" })).rejects.toMatchObject({ code: "not_found" });
    const refused = platform([
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrders(first"), body: graphqlFulfillmentOrders },
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrderHold("), body: { data: { fulfillmentOrderHold: { fulfillmentHold: null, userErrors: [{ field: ["id"], message: "Fulfillment order is not open" }] } } } },
    ]);
    await expect(refused.holdFulfillment("5678901234567", { reason: "awaiting_stock" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("shopify returns write-back", () => {
  const fulfillments = { data: { order: { fulfillments: [{ fulfillmentLineItems: { nodes: [{ id: "gid://shopify/FulfillmentLineItem/91", quantity: 1, lineItem: { id: "gid://shopify/LineItem/11" } }, { id: "gid://shopify/FulfillmentLineItem/92", quantity: 2, lineItem: { id: "gid://shopify/LineItem/12" } }] } }] } } };
  it("opens a return on fulfilled units, approves and closes it", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("fulfillments(first"), body: fulfillments },
      { match: (_u, i) => bodyOf(i).query.includes("returnRequest("), body: { data: { returnRequest: { return: { id: "gid://shopify/Return/501", returnLineItems: { nodes: [{ id: "gid://shopify/ReturnLineItem/601", fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/12" } } }] } }, userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("returnApproveRequest"), body: { data: { returnApproveRequest: { return: { id: "gid://shopify/Return/501", status: "OPEN" }, userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("returnClose"), body: { data: { returnClose: { return: { id: "gid://shopify/Return/501", status: "CLOSED" }, userErrors: [] } } } },
    ]);
    const r = await p.requestReturn("5678901234567", { lines: [{ orderLineExternalId: "12", quantity: 2, reason: "SIZE_TOO_SMALL", note: "Too tight" }] });
    expect(r).toEqual({ externalId: "501", lines: [{ orderLineExternalId: "12", externalId: "601" }] });
    const sent = bodyOf({ body: p.http.calls[1]!.body! });
    expect(sent.variables).toMatchObject({ input: { orderId: "gid://shopify/Order/5678901234567", returnLineItems: [{ fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/92", quantity: 2, returnReason: "SIZE_TOO_SMALL", customerNote: "Too tight" }] } });
    await p.approveReturn("501");
    await p.closeReturn("501");
    expect(bodyOf({ body: p.http.calls[3]!.body! }).variables).toEqual({ id: "gid://shopify/Return/501" });
  });
  it("refuses a return on units that are not fulfilled", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("fulfillments(first"), body: fulfillments }]);
    await expect(p.requestReturn("5678901234567", { lines: [{ orderLineExternalId: "11", quantity: 3, reason: null }] })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("refunds on the original capture, capped by what is still refundable", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("transactions(first"), body: { data: { order: { transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "100.00" } } }, { id: "gid://shopify/OrderTransaction/2", kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "70.00" } } }] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("refundCreate"), body: { data: { refundCreate: { refund: { id: "gid://shopify/Refund/77", totalRefundedSet: { shopMoney: { amount: "30.00" } } }, userErrors: [] } } } },
    ]);
    const r = await p.refundReturn("5678901234567", { lines: [{ orderLineExternalId: "12", quantity: 1 }], amountMinor: 4500, currency: "EUR", notify: true });
    expect(r).toEqual({ externalId: "77", amountMinor: 3000 });
    const sent = bodyOf({ body: p.http.calls[1]!.body! }).variables as { input: { transactions: { amount: string; parentId: string }[]; refundLineItems: { lineItemId: string; restockType: string }[] } };
    expect(sent.input.transactions).toEqual([{ orderId: "gid://shopify/Order/5678901234567", parentId: "gid://shopify/OrderTransaction/1", gateway: "shopify_payments", kind: "REFUND", amount: "30.00" }]);
    expect(sent.input.refundLineItems[0]).toEqual({ lineItemId: "gid://shopify/LineItem/12", quantity: 1, restockType: "NO_RESTOCK" });
  });
  it("records a refund without money movement when nothing was captured", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("transactions(first"), body: { data: { order: { transactions: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("refundCreate"), body: { data: { refundCreate: { refund: { id: "gid://shopify/Refund/78", totalRefundedSet: { shopMoney: { amount: "0.00" } } }, userErrors: [] } } } },
    ]);
    const r = await p.refundReturn("5678901234567", { lines: [{ orderLineExternalId: "12", quantity: 1 }], amountMinor: 4500, currency: "EUR", notify: false });
    expect(r.amountMinor).toBe(0);
    expect((bodyOf({ body: p.http.calls[1]!.body! }).variables as { input: { transactions: unknown[] } }).input.transactions).toEqual([]);
  });
});

describe("shopify payments: refunds, manual payments, payouts", () => {
  const transactions = { data: { order: { transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "50.00" } } }] } } };
  it("refunds part of an order with restock at a location", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("transactions(first"), body: transactions },
      { match: (_u, i) => bodyOf(i).query.includes("refundCreate"), body: { data: { refundCreate: { refund: { id: "gid://shopify/Refund/79", totalRefundedSet: { shopMoney: { amount: "10.00" } } }, userErrors: [] } } } },
    ]);
    const r = await p.refundOrder("5678901234567", { lines: [{ orderLineExternalId: "12", quantity: 1, restock: true }], locationExternalId: "6100001", amountMinor: 1000, currency: "EUR", note: "Goodwill", notify: false });
    expect(r).toEqual({ externalId: "79", amountMinor: 1000 });
    const sent = bodyOf({ body: p.http.calls[1]!.body! }).variables as { input: { note: string; transactions: { amount: string }[]; refundLineItems: unknown[] } };
    expect(sent.input.note).toBe("Goodwill");
    expect(sent.input.transactions[0]!.amount).toBe("10.00");
    expect(sent.input.refundLineItems).toEqual([{ lineItemId: "gid://shopify/LineItem/12", quantity: 1, restockType: "RETURN", locationId: "gid://shopify/Location/6100001" }]);
  });
  it("marks the whole balance paid, or records a partial manual payment", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("orderMarkAsPaid"), body: graphqlMarkAsPaid },
      { match: (_u, i) => bodyOf(i).query.includes("orderCreateManualPayment"), body: graphqlManualPayment },
    ]);
    await p.markOrderPaid("5678901234567", { amountMinor: 5000, currency: "EUR", method: "bank_transfer", fullBalance: true });
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ input: { id: "gid://shopify/Order/5678901234567" } });
    await p.markOrderPaid("5678901234567", { amountMinor: 2000, currency: "EUR", method: "bank_transfer", fullBalance: false });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toEqual({ id: "gid://shopify/Order/5678901234567", amount: { amount: "20.00", currencyCode: "EUR" }, paymentMethodName: "bank_transfer" });
  });
  it("reads payouts with their totals and the balance transactions with actual fees", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("payouts(first"), body: graphqlPayouts },
      { match: (_u, i) => bodyOf(i).query.includes("balanceTransactions(first"), body: graphqlBalanceTransactions },
    ]);
    const page = await p.fetchPayouts({ createdSince: new Date("2026-09-01T00:00:00Z"), limit: 2 });
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toMatchObject({ first: 2, query: "issued_at:>=2026-09-01" });
    expect(page.nextCursor).toBe("eyJsYXN0X2lkIjo4ODAwMn0=");
    expect(page.items[0]).toEqual({ externalId: "88001", status: "paid", issuedAt: new Date("2026-09-29T08:00:00Z"), currency: "EUR", grossMinor: 22600, refundsMinor: -4500, adjustmentsMinor: -100, feeMinor: 398, netMinor: 17602 });
    expect(page.items[0]!.grossMinor + page.items[0]!.refundsMinor + page.items[0]!.adjustmentsMinor - page.items[0]!.feeMinor).toBe(page.items[0]!.netMinor);
    expect(page.items[1]!.status).toBe("in_transit");
    const txns = await p.fetchBalanceTransactions({ payoutExternalId: "88001" });
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toMatchObject({ query: "payout_id:88001" });
    // test-mode transactions are not money
    expect(txns.items.map((t) => [t.type, t.orderExternalId, t.amountMinor, t.feeMinor, t.netMinor])).toEqual([["charge", "5678901234567", 17600, 289, 17311], ["charge", "5678901234568", 5000, 109, 4891], ["refund", "5678901230001", -4500, 0, -4500], ["adjustment", null, -100, 0, -100]]);
    expect(txns.items.reduce((s, t) => s + t.feeMinor, 0)).toBe(page.items[0]!.feeMinor);
    expect(txns.items[0]!.payoutExternalId).toBe("88001");
  });
  it("a shop without Shopify Payments has no payouts", async () => {
    const p = platform([{ match: () => true, body: graphqlNoPaymentsAccount }]);
    expect(await p.fetchPayouts({})).toEqual({ items: [], nextCursor: null });
    expect(await p.fetchBalanceTransactions({ payoutExternalId: "1" })).toEqual({ items: [], nextCursor: null });
  });
});

describe("shopify fulfilment from Keel", () => {
  const fulfillmentOrders = { data: { order: { fulfillmentOrders: { nodes: [
    { id: "gid://shopify/FulfillmentOrder/71", status: "OPEN", lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/81", remainingQuantity: 1, lineItem: { id: "gid://shopify/LineItem/11" } }, { id: "gid://shopify/FulfillmentOrderLineItem/82", remainingQuantity: 2, lineItem: { id: "gid://shopify/LineItem/12" } }] } },
    { id: "gid://shopify/FulfillmentOrder/72", status: "CLOSED", lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/83", remainingQuantity: 0, lineItem: { id: "gid://shopify/LineItem/13" } }] } },
  ] } } } };
  const created = { data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/91", legacyResourceId: "91", status: "SUCCESS", displayStatus: "CONFIRMED", createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-01T09:00:00Z", trackingInfo: [{ number: "1Z999", url: "https://track.example/1Z999", company: "UPS" }] }, userErrors: [] } } };
  it("fulfils every open line of the order with the tracking info and maps the result", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrders(first"), body: fulfillmentOrders },
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentCreate"), body: created },
    ]);
    const f = await p.createFulfillment({ orderExternalId: "5678901234567", carrier: "UPS", trackingNumber: "1Z999", trackingUrl: "https://track.example/1Z999", notifyCustomer: true });
    expect(f).toMatchObject({ externalId: "91", status: "label_created", externalStatus: "confirmed", trackingNumber: "1Z999", carrier: "UPS" });
    const sent = bodyOf({ body: p.http.calls[1]!.body! }).variables;
    expect(sent).toEqual({ fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/71" }], notifyCustomer: true, trackingInfo: { company: "UPS", number: "1Z999", url: "https://track.example/1Z999" } } });
  });
  it("fulfils only the requested lines and refuses an order with nothing left", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrders(first"), body: fulfillmentOrders },
      { match: (_u, i) => bodyOf(i).query.includes("fulfillmentCreate"), body: created },
    ]);
    await p.createFulfillment({ orderExternalId: "5678901234567", lines: [{ orderLineExternalId: "12", quantity: 1 }], carrier: "UPS", trackingNumber: "1Z999", notifyCustomer: false });
    expect((bodyOf({ body: p.http.calls[1]!.body! }).variables as { fulfillment: { lineItemsByFulfillmentOrder: unknown[] } }).fulfillment.lineItemsByFulfillmentOrder).toEqual([{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/71", fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/82", quantity: 1 }] }]);
    const none = platform([{ match: (_u, i) => bodyOf(i).query.includes("fulfillmentOrders(first"), body: { data: { order: { fulfillmentOrders: { nodes: [] } } } } }]);
    await expect(none.createFulfillment({ orderExternalId: "1", carrier: "UPS", trackingNumber: "1", notifyCustomer: false })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("shopify exchange invoice", () => {
  it("creates a draft with the return credit as discount and sends the invoice", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("draftOrderCreate"), body: { data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/900", invoiceUrl: "https://shop/invoices/abc" }, userErrors: [] } } } },
      { match: (_u, i) => bodyOf(i).query.includes("draftOrderInvoiceSend"), body: { data: { draftOrderInvoiceSend: { draftOrder: { id: "gid://shopify/DraftOrder/900", invoiceUrl: "https://shop/invoices/abc" }, userErrors: [] } } } },
    ]);
    const r = await p.createInvoiceOrder({ lines: [{ variantExternalId: "4100002", sku: null, title: "Shirt M", quantity: 1, unitPriceMinor: 5500 }], currency: "EUR", email: "a@example.com", phone: null, customerExternalId: null, shippingAddress: null, billingAddress: null, shippingMinor: 0, discountMinor: 4000, note: "Exchange R-12", tags: ["exchange"], noteAttributes: [{ name: "keel_return_id", value: "r1" }], replacesOrderName: null });
    expect(r).toEqual({ draftExternalId: "900", invoiceUrl: "https://shop/invoices/abc" });
    const sent = bodyOf({ body: p.http.calls[0]!.body! }).variables as { input: { appliedDiscount: { value: number }; customAttributes: { key: string }[] } };
    expect(sent.input.appliedDiscount.value).toBe(40);
    expect(sent.input.customAttributes[0]!.key).toBe("keel_return_id");
  });
});

describe("shopify oauth", () => {
  it("builds the install url and verifies the callback hmac", () => {
    const url = buildInstallUrl("northwind-demo.myshopify.com", "key", ["read_orders"], "https://keel.example/cb", "st");
    expect(url).toContain("https://northwind-demo.myshopify.com/admin/oauth/authorize?client_id=key&scope=read_orders");
    const query: Record<string, string> = { code: "abc", shop: "northwind-demo.myshopify.com", state: "st", timestamp: "1700000000" };
    const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
    const hmac = createHmac("sha256", "secret").update(message).digest("hex");
    expect(verifyOAuthCallback({ ...query, hmac }, "secret")).toBe(true);
    expect(verifyOAuthCallback({ ...query, hmac }, "wrong")).toBe(false);
  });
});

describe("shopify returns and discount lifecycle (issue #35)", () => {
  it("reads returns of recently updated orders with lines, reasons and notes", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("returns(first"), body: graphqlReturnsPage }]);
    const page = await p.fetchReturns({ updatedSince: new Date("2026-09-25T00:00:00Z"), limit: 25 });
    expect(page.nextCursor).toBe("eyJsYXN0X2lkIjo1Njc4OTAxMjM0NTcwfQ==");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ externalId: "501", orderExternalId: "5678901234567", status: "open", note: "Too tight on the shoulders", lines: [{ externalId: "601", orderLineExternalId: "1001", quantity: 1, reason: "size_too_small" }] });
    expect(page.items[1]).toMatchObject({ externalId: "502", status: "closed", lines: [{ orderLineExternalId: "1101", quantity: 2, reason: "defective", note: "Seam open" }] });
    expect(page.items[1]!.closedAt?.toISOString()).toBe("2026-09-27T16:00:00.000Z");
    const sent = bodyOf({ body: p.http.calls[0]!.body! }).variables;
    expect(sent.query).toContain("updated_at:>='2026-09-25");
    expect(sent.query).toContain("-return_status:NO_RETURN");
  });

  it("maps a returns/request payload and leaves a payload without lines to fetchReturn", async () => {
    const p = platform([{ match: (_u, i) => bodyOf(i).query.includes("return(id"), body: graphqlReturn }]);
    expect(p.parseWebhookReturn(restReturnWebhook)).toMatchObject({ externalId: "501", orderExternalId: "5678901234567", status: "requested", lines: [{ externalId: "601", orderLineExternalId: "1001", quantity: 1, reason: "size_too_small", note: "Too tight on the shoulders" }] });
    expect(p.parseWebhookReturn(restReturnApproveWebhook)).toBeNull();
    const r = await p.fetchReturn("501");
    expect(r).toMatchObject({ externalId: "501", orderExternalId: "5678901234567", status: "open" });
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/Return/501" });
  });

  it("deactivates a pool, a pool code and a standalone code found by code; tops up a pool", async () => {
    const p = platform([
      { match: (_u, i) => bodyOf(i).query.includes("discountCodeDeactivate"), body: graphqlDiscountDeactivate },
      { match: (_u, i) => bodyOf(i).query.includes("codeDiscountNodeByCode"), body: graphqlDiscountByCode },
      { match: (_u, i) => bodyOf(i).query.includes("discountCodeRedeemCodeBulkDelete"), body: graphqlRedeemCodeBulkDelete },
      { match: (_u, i) => bodyOf(i).query.includes("discountRedeemCodeBulkAdd"), body: graphqlRedeemCodeBulkAdd },
    ]);
    await p.setDiscountPoolActive("9001", false);
    expect(bodyOf({ body: p.http.calls[0]!.body! }).variables).toEqual({ id: "gid://shopify/DiscountCodeNode/9001" });
    await p.setDiscountActive({ externalId: null, code: "SUMMER20" }, false);
    expect(bodyOf({ body: p.http.calls[1]!.body! }).variables).toEqual({ code: "SUMMER20" });
    expect(bodyOf({ body: p.http.calls[2]!.body! }).variables).toEqual({ id: "gid://shopify/DiscountCodeNode/9002" });
    await p.setDiscountActive({ externalId: "9001:NW-ABCD2345", code: "NW-ABCD2345", poolExternalId: "9001" }, false);
    expect(bodyOf({ body: p.http.calls[3]!.body! }).variables).toEqual({ id: "gid://shopify/DiscountCodeNode/9001", search: "code:NW-ABCD2345" });
    const codes = Array.from({ length: 150 }, (_, i) => `NW-T${String(i).padStart(4, "0")}`);
    const r = await p.addDiscountPoolCodes("9001", codes);
    expect(r.imported).toHaveLength(150);
    expect(p.http.calls).toHaveLength(6);
  });
});

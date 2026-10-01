import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { ShopifyCommercePlatform } from "./adapter";
import { mapRestOrder } from "./mappers";
import { buildInstallUrl, verifyOAuthCallback, verifyWebhookHmac } from "./oauth";
import { graphqlCancel, graphqlDiscounts, graphqlInventory, graphqlInventoryItemUpdate, graphqlOrdersPage, graphqlProductsPage, graphqlShop, graphqlThrottled, graphqlVariantInventoryItem, graphqlWebhookCreate, graphqlWebhooks, restOrderWebhook } from "./__fixtures__";

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
      { match: (_u, i) => bodyOf(i).query.includes("discountNodes"), body: graphqlDiscounts },
      { match: (_u, i) => bodyOf(i).query.includes("InventoryItem"), body: graphqlInventory },
    ]);
    const products = await p.fetchProducts({});
    expect(products.items[0]).toMatchObject({ externalId: "8100001", productType: "Outerwear", status: "active" });
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

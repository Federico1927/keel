import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { ShopifyCommercePlatform } from "./adapter";
import { mapRestOrder } from "./mappers";
import { buildInstallUrl, verifyOAuthCallback, verifyWebhookHmac } from "./oauth";
import { graphqlCancel, graphqlDiscounts, graphqlInventory, graphqlOrdersPage, graphqlProductsPage, graphqlShop, graphqlThrottled, graphqlWebhookCreate, graphqlWebhooks, restOrderWebhook } from "./__fixtures__";

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
    expect(products.items[0]!.variants[0]).toMatchObject({ sku: "GIA-M-BLU", priceMinor: 12900, compareAtMinor: 15900, weightGrams: 800, inventoryItemExternalId: "4500001", optionValues: { Size: "M", Color: "Blu" } });
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

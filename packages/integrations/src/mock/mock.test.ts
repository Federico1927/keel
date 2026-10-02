import { describe, expect, it } from "vitest";
import { MockCommercePlatform } from "./commerce";
import { MockAdsPlatform } from "./ads";
import { MockAddressProvider } from "./address";
import { MockCarrierProvider } from "./slots";
import { IntegrationError } from "../types";

function platform() {
  return new MockCommercePlatform({
    currency: "EUR",
    country: "IT",
    orderNumberPrefix: "T-",
    startOrderNumber: 1,
    locations: [{ externalId: "loc-1", name: "Main", country: "IT", isDefault: true, isActive: true }],
    customers: [{ externalId: "c1", email: "a@b.it", phone: "+393331234567", firstName: "Anna", lastName: "Bianchi", country: "IT", city: "Milano", zip: "20100", acceptsMarketing: true, tags: [], platformCreatedAt: null }],
    variants: [
      { externalId: "v1", productExternalId: "p1", inventoryItemExternalId: "i1", sku: "SKU1", title: "M", productTitle: "Tee", optionValues: { Size: "M" }, priceMinor: 2900, unitCostMinor: 1100, productImageUrl: "https://cdn.example/tee.jpg" },
      { externalId: "v2", productExternalId: "p1", inventoryItemExternalId: "i2", sku: "SKU2", title: "L", productTitle: "Tee", optionValues: { Size: "L" }, priceMinor: 2900 },
    ],
  });
}

describe("MockCommercePlatform", () => {
  it("generates deterministic orders and pages", async () => {
    const a = platform();
    const b = platform();
    const pa = await a.fetchOrders({ limit: 2 });
    const pb = await b.fetchOrders({ limit: 2 });
    expect(pa.items.map((o) => o.name)).toEqual(pb.items.map((o) => o.name));
    expect(pa.items.length).toBeGreaterThan(0);
  });
  it("signs and verifies webhooks", async () => {
    const p = platform();
    const order = p.generateOrder();
    const env = p.buildWebhook("orders/create", order);
    const verified = await p.verifyWebhook(env.headers, env.rawBody);
    expect(verified.externalId).toBe(order.externalId);
    expect(p.parseWebhookOrder(verified.payload).name).toBe(order.name);
    await expect(p.verifyWebhook({ ...env.headers, "x-shopify-hmac-sha256": "bad" }, env.rawBody)).rejects.toBeInstanceOf(IntegrationError);
  });
  it("reports the unit cost like Shopify's inventory item and keeps a cost written back", async () => {
    const p = platform();
    const [tee] = (await p.fetchProducts()).items;
    expect(tee!.imageUrl).toBe("https://cdn.example/tee.jpg");
    expect(tee!.variants.map((v) => v.costMinor)).toEqual([1100, null]);
    await p.updateVariantCost({ variantExternalId: "v2", inventoryItemExternalId: "i2" }, 1250);
    expect(p.writeLog.at(-1)).toEqual({ op: "updateVariantCost", args: { variantExternalId: "v2", inventoryItemExternalId: "i2", costMinor: 1250 } });
    expect((await p.fetchProducts()).items[0]!.variants.map((v) => v.costMinor)).toEqual([1100, 1250]);
  });
  it("injects failures once", async () => {
    const p = platform();
    p.failures.failNext("rate_limited");
    await expect(p.fetchOrders({})).rejects.toMatchObject({ code: "rate_limited" });
    await expect(p.fetchOrders({})).resolves.toBeTruthy();
  });
  it("records writes and applies cancellation", async () => {
    const p = platform();
    const o = p.generateOrder();
    await p.cancelOrder(o.externalId, { restock: true, refund: false });
    expect(p.writeLog[0]?.op).toBe("cancelOrder");
    expect((await p.fetchOrder(o.externalId))?.cancelledAt).not.toBeNull();
  });
});

describe("MockAdsPlatform", () => {
  it("returns daily metrics for active campaigns and respects read-only", async () => {
    const meta = new MockAdsPlatform({ provider: "meta", currency: "EUR", campaigns: [{ externalId: "c1", accountExternalId: "act", name: "Summer", status: "active", objective: null, dailyBudgetMinor: 5000, currency: "EUR", platformCreatedAt: null }] });
    const rows = await meta.fetchDailyMetrics({ since: "2026-09-01", until: "2026-09-03" });
    expect(rows).toHaveLength(3);
    await meta.setCampaignStatus("c1", "paused");
    expect(await meta.fetchDailyMetrics({ since: "2026-09-01", until: "2026-09-01" })).toHaveLength(0);
    const google = new MockAdsPlatform({ provider: "google", currency: "EUR", campaigns: [], readOnly: true });
    await expect(google.setCampaignStatus("x", "paused")).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("order edits on the mock platform", () => {
  it("creates a paid replacement carrying the payment method, then discounts it", async () => {
    const p = platform();
    const o = await p.createOrder({ lines: [{ variantExternalId: "v1", sku: null, title: "Tee", quantity: 2, unitPriceMinor: 2900 }], currency: "EUR", email: "a@b.it", phone: null, customerExternalId: "c1", shippingAddress: null, billingAddress: null, shippingMinor: 500, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: "#T-1", payment: { method: "card", status: "paid", gateways: ["shopify_payments"] } });
    expect(o).toMatchObject({ paymentMethod: "card", paymentStatus: "paid", totalMinor: 6300, paymentGateways: ["shopify_payments"] });
    expect(o.noteAttributes).toContainEqual({ name: "replaces_order", value: "#T-1" });
    await p.applyOrderDiscount(o.externalId, { type: "percentage", value: 1000, amountMinor: 580, currency: "EUR", code: "KEEL-10%" });
    const after = await p.fetchOrder(o.externalId);
    expect(after).toMatchObject({ discountMinor: 580, totalMinor: 5720 });
    expect(p.writeLog.map((w) => w.op)).toEqual(["createOrder", "applyOrderDiscount"]);
  });
});

describe("MockAddressProvider", () => {
  it("suggests deterministic addresses in the requested country and validates the format", async () => {
    const a = new MockAddressProvider();
    expect(await a.autocomplete("ma", { country: "US" })).toEqual([]);
    const s = await a.autocomplete("main street", { country: "US" });
    expect(s).toHaveLength(3);
    expect(s[0]!.address).toMatchObject({ address1: "Main Street 1", city: "Austin", province: "TX", zip: "78701", country: "US" });
    expect(await a.autocomplete("main street", { country: "US" })).toEqual(s);
    const ok = await a.validate({ name: "Ann Lee", ...s[0]!.address });
    expect(ok.valid).toBe(true);
    const bad = await a.validate({ name: "Ann Lee", address1: "1 Nowhere Rd", city: "Austin", province: "TX", zip: "7870", country: "us" });
    expect(bad.valid).toBe(false);
    expect(bad.issues.map((i) => i.code).sort()).toEqual(["invalid_zip", "not_found"]);
    expect(bad.normalized?.country).toBe("US");
  });
});

describe("fulfilment and carrier instructions on the mocks", () => {
  it("fulfils an order once, with the tracking, and refuses a second fulfilment", async () => {
    const p = platform();
    const [o] = (await p.fetchOrders({ limit: 1 })).items;
    const f = await p.createFulfillment({ orderExternalId: o!.externalId, carrier: "UPS", trackingNumber: "1Z1", notifyCustomer: true });
    expect(f).toMatchObject({ status: "label_created", externalStatus: "confirmed", carrier: "UPS", trackingNumber: "1Z1" });
    expect((await p.fetchOrder(o!.externalId))!.fulfillmentStatusRaw).toBe("fulfilled");
    await expect(p.createFulfillment({ orderExternalId: o!.externalId, carrier: "UPS", trackingNumber: "1Z2", notifyCustomer: false })).rejects.toBeInstanceOf(IntegrationError);
    // an order the simulator does not hold (seeded history) is acknowledged
    expect((await p.createFulfillment({ orderExternalId: "unknown", carrier: "DHL", trackingNumber: "JD1", notifyCustomer: false })).trackingNumber).toBe("JD1");
  });
  it("records carrier instructions and can fail on demand", async () => {
    const c = new MockCarrierProvider();
    expect(await c.sendInstruction({ reference: "case:1", trackingNumber: "1Z1", carrier: "UPS", resolution: "redeliver" })).toEqual({ reference: "mock-instr-1" });
    c.failures.failNext("network");
    await expect(c.sendInstruction({ reference: "case:2", trackingNumber: "1Z2", carrier: "UPS", resolution: "return" })).rejects.toBeInstanceOf(IntegrationError);
    expect(c.instructions).toHaveLength(1);
  });
});

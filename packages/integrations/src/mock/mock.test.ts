import { describe, expect, it } from "vitest";
import { MockCommercePlatform } from "./commerce";
import { MOCK_ACCOUNT_IDS, MockAdsPlatform, mockDemoAdsAccount } from "./ads";
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
  it("holds full products: writes change them, move updatedAt forward and answer the product (issue #19)", async () => {
    const base = platform();
    const [tee] = (await base.fetchProducts()).items;
    const p = new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "T-", startOrderNumber: 1, locations: [], customers: [], variants: [], products: [{ ...tee!, platformUpdatedAt: new Date("2026-09-01T00:00:00Z"), media: [{ externalId: "m1", type: "image", url: "/a.svg", alt: null, width: null, height: null }, { externalId: "m2", type: "image", url: "/b.svg", alt: null, width: null, height: null }] }] });
    const updated = await p.updateProduct("p1", { title: "Tee 2", seo: { title: "SEO", description: "" } });
    expect(updated).toMatchObject({ title: "Tee 2", seo: { title: "SEO", description: null } });
    expect(updated.platformUpdatedAt!.getTime()).toBeGreaterThan(new Date("2026-09-01T00:00:00Z").getTime());
    const reordered = await p.updateProductMedia("p1", { type: "reorder", mediaExternalIds: ["m2", "m1"] });
    expect(reordered.media!.map((m) => m.externalId)).toEqual(["m2", "m1"]);
    expect(reordered.imageUrl).toBe("/b.svg");
    expect(reordered.platformUpdatedAt!.getTime()).toBeGreaterThan(updated.platformUpdatedAt!.getTime());
    const added = await p.updateProductMedia("p1", { type: "create", url: "/c.svg", alt: "C" });
    expect(added.media).toHaveLength(3);
    await p.updateVariant("v1", { sku: "NEW", compareAtMinor: 3900 });
    expect((await p.fetchProduct("p1"))!.variants[0]).toMatchObject({ sku: "NEW", compareAtMinor: 3900 });
    const outside = p.simulateExternalEdit("p1", { title: "Edited in the store" });
    expect(outside.title).toBe("Edited in the store");
    expect(await p.fetchProduct("nope")).toBeNull();
    await expect(p.updateProduct("nope", { title: "x" })).rejects.toBeInstanceOf(IntegrationError);
    expect(p.writeLog.map((w) => w.op)).toEqual(["updateProduct", "updateProductMedia", "updateProductMedia", "updateVariant", "updateProduct"]);
    expect((await p.fetchProducts({ limit: 1 })).nextCursor).toBeNull();
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

describe("mock fulfillment holds", () => {
  it("holds and releases an order, and fails on demand", async () => {
    const m = platform();
    await m.holdFulfillment("o1", { reason: "awaiting_stock", note: "PO-1" });
    expect(m.fulfillmentHoldOf("o1")).toEqual({ reason: "awaiting_stock", note: "PO-1" });
    await m.releaseFulfillment("o1");
    expect(m.fulfillmentHoldOf("o1")).toBeUndefined();
    m.failures.failNext("rate_limited");
    await expect(m.holdFulfillment("o1", { reason: "awaiting_stock" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(m.writeLog.map((w) => w.op)).toEqual(["holdFulfillment", "releaseFulfillment"]);
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

describe("MockCommercePlatform returns and discount lifecycle", () => {
  it("holds returns opened on the store, sends signed returns webhooks and lists them by update time", async () => {
    const p = platform();
    const order = p.generateOrder();
    const r = p.openPlatformReturn({ orderExternalId: order.externalId, lines: [{ orderLineExternalId: order.lines[0]!.externalId, quantity: 1, reason: "size_too_small" }], note: "Too small" });
    const env = p.buildReturnWebhook("returns/request", r.externalId);
    const verified = await p.verifyWebhook(env.headers, env.rawBody);
    expect(verified.externalId).toBe(r.externalId);
    expect(p.parseWebhookReturn(verified.payload)).toMatchObject({ externalId: r.externalId, status: "requested", lines: [{ quantity: 1, reason: "size_too_small" }] });
    p.setPlatformReturnStatus(r.externalId, "open");
    const again = p.buildReturnWebhook("returns/approve", r.externalId);
    expect((await p.verifyWebhook(again.headers, again.rawBody)).sourceUpdatedAt).not.toBe(verified.sourceUpdatedAt);
    expect((await p.fetchReturn(r.externalId))?.status).toBe("open");
    expect((await p.fetchReturns({ updatedSince: new Date(Date.now() - 60_000) })).items.map((x) => x.externalId)).toEqual([r.externalId]);
    // a return requested by Keel is visible to the reconcile too, with its lines
    const pushed = await p.requestReturn(order.externalId, { lines: [{ orderLineExternalId: order.lines[0]!.externalId, quantity: 1, reason: "DEFECTIVE" }] });
    expect(pushed.externalId).not.toBe(r.externalId);
    expect((await p.fetchReturn(pushed.externalId))?.lines[0]).toMatchObject({ externalId: pushed.lines[0]!.externalId, reason: "defective" });
  });

  it("deactivates a pool and its codes, single codes and topped-up codes", async () => {
    const p = platform();
    const pool = await p.createDiscountPool({ title: "Pool", codes: ["P-A", "P-B"] });
    await p.addDiscountPoolCodes(pool.externalId, ["P-C"]);
    expect(p.discountCodeActive("P-C")).toBe(true);
    await p.setDiscountActive({ externalId: null, code: "P-A", poolExternalId: pool.externalId }, false);
    expect(p.discountCodeActive("P-A")).toBe(false);
    expect(p.discountCodeActive("P-B")).toBe(true);
    await p.setDiscountPoolActive(pool.externalId, false);
    expect(["P-A", "P-B", "P-C"].map((c) => p.discountCodeActive(c))).toEqual([false, false, false]);
    await p.createDiscountCode({ code: "SOLO" });
    await p.setDiscountActive({ externalId: "mock-d-SOLO", code: "SOLO" }, false);
    expect(p.discountCodeActive("SOLO")).toBe(false);
    expect(p.discountCodeActive("UNKNOWN")).toBeUndefined();
  });
});

describe("MockAdsPlatform below the campaign", () => {
  const campaign = { externalId: "900", accountExternalId: "act", name: "Search", status: "active" as const, objective: null, dailyBudgetMinor: 5000, currency: "EUR", platformCreatedAt: null };
  const structure = {
    adSets: [{ externalId: "g1", campaignExternalId: "900", name: "G1", status: "active" as const, optimizationGoal: null, dailyBudgetMinor: null }, { externalId: "g2", campaignExternalId: "900", name: "G2", status: "active" as const, optimizationGoal: null, dailyBudgetMinor: null }],
    ads: [{ externalId: "a1", adSetExternalId: "g1", campaignExternalId: "900", name: "A1", status: "active" as const, format: "text", headline: "Linen", body: null, finalUrl: null, urlTags: null, thumbnailUrl: null }, { externalId: "a2", adSetExternalId: "g2", campaignExternalId: "900", name: "A2", status: "active" as const, format: "text", headline: "Oak", body: null, finalUrl: null, urlTags: null, thumbnailUrl: null }],
    assets: [{ assetExternalId: "h1", adExternalId: "a1", adSetExternalId: "g1", campaignExternalId: "900", type: "text" as const, fieldType: "headline", text: "Linen", url: null, performanceLabel: "GOOD" }, { assetExternalId: "h2", adExternalId: "a1", adSetExternalId: "g1", campaignExternalId: "900", type: "text" as const, fieldType: "headline", text: "Free returns", url: null, performanceLabel: "LOW" }],
    keywords: [{ externalId: "g1~1", adSetExternalId: "g1", campaignExternalId: "900", text: "linen shirt", matchType: "exact" as const, qualityScore: 7, status: "active" as const, negative: false }, { externalId: "g2~2", adSetExternalId: "g2", campaignExternalId: "900", text: "oak table", matchType: "broad" as const, qualityScore: 5, status: "active" as const, negative: false }],
  };
  const window = { since: "2026-09-27", until: "2026-09-28" };

  it("every level adds up to the campaign day, whatever the call order", async () => {
    const p = new MockAdsPlatform({ provider: "google", currency: "EUR", campaigns: [campaign], readOnly: true, structure });
    const terms = await p.fetchEntityMetrics("search_term", window);
    const campaignDays = await p.fetchDailyMetrics(window);
    const sum = (rows: { date: string; spendMinor: number }[], d: string) => rows.filter((r) => r.date === d).reduce((s, r) => s + r.spendMinor, 0);
    for (const level of ["ad_set", "ad", "keyword"] as const) {
      const rows = await p.fetchEntityMetrics(level, window);
      for (const c of campaignDays) expect(sum(rows, c.date)).toBe(c.spendMinor);
    }
    for (const c of campaignDays) expect(sum(terms, c.date)).toBe(c.spendMinor);
    const assets = await p.fetchEntityMetrics("asset", window);
    const adDay = (await p.fetchEntityMetrics("ad", window)).find((r) => r.entityExternalId === "a1" && r.date === "2026-09-28")!;
    expect(sum(assets.filter((a) => a.fieldType === "headline"), "2026-09-28")).toBe(adDay.spendMinor);
    expect(terms.some((t) => t.entityExternalId === "sale linen shirt" && t.keywordExternalId === "g1~1")).toBe(true);
  });

  it("google writes need the tenant's write scope; meta pauses ads", async () => {
    const ro = new MockAdsPlatform({ provider: "google", currency: "EUR", campaigns: [campaign], structure });
    await expect(ro.addNegativeKeywords([{ campaignExternalId: "900", text: "free", matchType: "exact" }])).rejects.toMatchObject({ code: "unsupported" });
    const rw = new MockAdsPlatform({ provider: "google", currency: "EUR", campaigns: [campaign], structure, adWrites: true });
    await rw.addNegativeKeywords([{ campaignExternalId: "900", text: "cheap linen shirt", matchType: "exact" }]);
    const terms = await rw.fetchEntityMetrics("search_term", { since: "2026-09-28", until: "2026-09-28" });
    expect(terms.find((t) => t.entityExternalId === "cheap linen shirt")!.termStatus).toBe("excluded");
    const meta = new MockAdsPlatform({ provider: "meta", currency: "EUR", campaigns: [campaign], structure });
    expect(await meta.fetchKeywords()).toEqual([]);
    await meta.setAdStatus({ adExternalId: "a1", adSetExternalId: "g1" }, "paused");
    expect((await meta.fetchAds()).find((a) => a.externalId === "a1")!.status).toBe("paused");
  });
});

describe("MockAdsPlatform as TikTok", () => {
  const demo = mockDemoAdsAccount("tiktok", { key: "tenant-1", currency: "EUR", landingBase: "https://shop.example" });
  const window = { since: "2026-07-01", until: "2026-09-28" };

  it("builds a deterministic demo account: campaigns, ad groups, video ads with the TikTok UTM template", () => {
    expect(mockDemoAdsAccount("tiktok", { key: "tenant-1", currency: "EUR", landingBase: "https://shop.example" })).toEqual(demo);
    expect(demo.campaigns).toHaveLength(4);
    expect(demo.structure.adSets).toHaveLength(8);
    expect(demo.structure.ads).toHaveLength(16);
    expect(demo.structure.ads.every((a) => a.format === "video" && a.urlTags!.includes("utm_content=__CID__"))).toBe(true);
    expect(demo.structure.assets.every((a) => a.type === "video")).toBe(true);
    expect(mockDemoAdsAccount("tiktok", { key: "tenant-2", currency: "EUR", landingBase: "https://shop.example" }).campaigns[0]!.externalId).not.toBe(demo.campaigns[0]!.externalId);
  });

  it("declares TikTok's capabilities, reports 90 days that reconcile across levels, pauses and simulates errors", async () => {
    const p = new MockAdsPlatform({ provider: "tiktok", currency: "EUR", campaigns: demo.campaigns, structure: demo.structure });
    expect(p.capabilities).toEqual({ supportsKeywords: false, supportsSearchTerms: false, supportsAssetBreakdown: false, supportsAdWrites: true });
    expect(await p.testConnection()).toMatchObject({ ok: true, accountId: MOCK_ACCOUNT_IDS.tiktok });
    const days = await p.fetchDailyMetrics(window);
    const active = demo.campaigns.filter((c) => c.status === "active").length;
    expect(days).toHaveLength(active * 90);
    const ads = await p.fetchEntityMetrics("ad", window);
    const sets = await p.fetchEntityMetrics("ad_set", window);
    const total = (rows: { spendMinor: number }[]) => rows.reduce((s, r) => s + r.spendMinor, 0);
    expect(total(ads)).toBe(total(days));
    expect(total(sets)).toBe(total(days));
    expect(await p.fetchEntityMetrics("keyword", window)).toEqual([]);
    expect(await p.fetchKeywords()).toEqual([]);
    await p.setCampaignStatus(demo.campaigns[0]!.externalId, "paused");
    await p.setAdStatus({ adExternalId: demo.structure.ads[0]!.externalId, adSetExternalId: null }, "paused");
    expect(p.writeLog.map((w) => w.op)).toEqual(["setCampaignStatus", "setAdStatus"]);
    p.failures.failNext("rate_limited");
    await expect(p.fetchEntityMetrics("ad", window)).rejects.toMatchObject({ code: "rate_limited" });
    p.failures.failNext("token_expired");
    await expect(p.fetchCampaigns()).rejects.toMatchObject({ code: "token_expired" });
  });
});


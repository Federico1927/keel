import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { LOOP_ORDERS, LOOP_SUBSCRIPTIONS, RECHARGE_CHARGES, RECHARGE_CUSTOMERS, RECHARGE_SUBSCRIPTIONS, SHOPIFY_CANCELLED_CONTRACT, SHOPIFY_CONTRACT, SHOPIFY_SCOPES, shopifyContractsPage } from "./__fixtures__/responses";
import { LoopSubscriptionProvider } from "./loop";
import { MockSubscriptionProvider } from "./mock";
import { RechargeSubscriptionProvider } from "./recharge";
import { ShopifySubscriptionProvider, mapShopifyContract } from "./shopify";
import { normalizePaymentError, type SubscriptionProvider } from "./types";

type Routes = Parameters<typeof fixtureFetch>[0];
const noSleep = { sleep: async () => undefined, minIntervalMs: 0 };
const gqlRoute = (match: (q: string) => boolean, body: unknown, status = 200): Routes[number] => ({ match: (url, init) => url.includes("/graphql.json") && match(String(JSON.parse(init?.body ?? "{}").query ?? "")), status, body });
const shopify = (routes: Routes) => new ShopifySubscriptionProvider({ shop: "harbor-home.myshopify.com", accessToken: "shpat_test", apiSecret: "secret" }, { fetchImpl: fixtureFetch(routes), ...noSleep });

describe("Shopify native subscriptions (Admin GraphQL)", () => {
  it("maps contracts: status, customer, lines, frequency, next billing, price, discounts, origin order", async () => {
    const p = shopify([gqlRoute((q) => q.includes("subscriptionContracts(") && !q.includes("billingAttempts"), shopifyContractsPage([SHOPIFY_CONTRACT, SHOPIFY_CANCELLED_CONTRACT], true, "cur-2"))]);
    const page = await p.fetchContracts({ limit: 2 });
    expect(page.nextCursor).toBe("cur-2");
    const [c, cancelled] = page.items;
    expect(c).toMatchObject({ externalId: "5550001", status: "active", currency: "USD", intervalUnit: "month", intervalCount: 1, priceMinor: 2880, originOrderExternalId: "9100001", customer: { externalId: "7001", email: "ava.miller@example.com" } });
    expect(c!.lines[0]).toMatchObject({ externalId: "61001", variantExternalId: "4401", productExternalId: "3301", quantity: 2, unitPriceMinor: 1440 });
    expect(c!.nextBillingAt?.toISOString()).toBe("2026-10-04T10:15:00.000Z");
    expect(c!.discounts[0]!.title).toBe("Subscribe & save 10%");
    expect(cancelled).toMatchObject({ status: "cancelled", nextBillingAt: null, cancelledForNonPayment: true });
    expect(cancelled!.endedAt?.toISOString()).toBe("2026-07-01T08:00:00.000Z");
  });

  it("reads billing attempts with the failure reason and groups retries by cycle", async () => {
    const p = shopify([gqlRoute((q) => q.includes("billingAttempts"), shopifyContractsPage([SHOPIFY_CONTRACT]))]);
    const { items } = await p.fetchBillingAttempts({});
    expect(items.map((a) => [a.externalId, a.status, a.errorCode, a.cycleKey, a.orderExternalId])).toEqual([
      ["71003", "success", null, "2026-09-04", "9100007"],
      ["71002", "success", null, "2026-08-04", "9100005"],
      ["71001", "failed", "insufficient_funds", "2026-08-04", null],
    ]);
  });

  it("pauses through the mutation and answers the contract as Shopify holds it", async () => {
    const paused = { ...SHOPIFY_CONTRACT, status: "PAUSED" };
    const fetchImpl = fixtureFetch([gqlRoute((q) => q.includes("subscriptionContractPause"), { data: { subscriptionContractPause: { contract: paused, userErrors: [] } } })]);
    const p = new ShopifySubscriptionProvider({ shop: "harbor-home.myshopify.com", accessToken: "shpat_test", apiSecret: "secret" }, { fetchImpl, ...noSleep });
    const c = await p.pause("5550001");
    expect(c.status).toBe("paused");
    const body = JSON.parse(p.shopify.http.calls[0]!.body!);
    expect(body.variables).toEqual({ id: "gid://shopify/SubscriptionContract/5550001" });
  });

  it("surfaces user errors as readable integration errors and checks the scopes", async () => {
    const p = shopify([gqlRoute((q) => q.includes("subscriptionContractCancel"), { data: { subscriptionContractCancel: { contract: null, userErrors: [{ field: ["id"], message: "Contract is already cancelled" }] } } }), gqlRoute((q) => q.includes("accessScopes"), SHOPIFY_SCOPES)]);
    await expect(p.cancel("5550001")).rejects.toMatchObject({ code: "invalid_request", message: "Contract is already cancelled" });
    expect(await p.testConnection()).toMatchObject({ ok: true, accountName: "Harbor Home", missingScopes: [] });
  });

  it("verifies webhooks with the app secret", async () => {
    const p = shopify([]);
    const raw = JSON.stringify({ admin_graphql_api_id: "gid://shopify/SubscriptionContract/5550001", id: 5550001, updated_at: "2026-09-04T10:16:02Z" });
    const hmac = createHmac("sha256", "secret").update(raw).digest("base64");
    const w = await p.verifyWebhook({ "x-shopify-hmac-sha256": hmac, "x-shopify-topic": "subscription_contracts/update", "x-shopify-event-id": "evt-1" }, raw);
    expect(w).toMatchObject({ topic: "subscription_contracts/update", externalId: "evt-1", contractExternalId: "5550001" });
    await expect(p.verifyWebhook({ "x-shopify-hmac-sha256": "bad" }, raw)).rejects.toBeInstanceOf(IntegrationError);
  });

  it("keeps a contract's discounted line price per unit", () => {
    expect(mapShopifyContract({ ...SHOPIFY_CONTRACT, lines: { nodes: [{ ...SHOPIFY_CONTRACT.lines.nodes[0], quantity: 1, lineDiscountedPrice: { amount: "14.40" } }] } }).priceMinor).toBe(1440);
  });
});

describe("Recharge", () => {
  const routes: Routes = [
    { match: (u) => u.includes("/subscriptions?"), body: RECHARGE_SUBSCRIPTIONS },
    { match: (u) => u.includes("/customers?ids="), body: RECHARGE_CUSTOMERS },
    { match: (u) => u.includes("/charges?"), body: RECHARGE_CHARGES },
  ];
  const make = (r: Routes = routes) => new RechargeSubscriptionProvider({ apiToken: "rc_test", webhookSecret: "rc_secret" }, { fetchImpl: fixtureFetch(r), ...noSleep });

  it("maps subscriptions (one product each) with the customer's Shopify id and the cancellation reason", async () => {
    const p = make();
    const page = await p.fetchContracts({ updatedSince: new Date("2026-01-01T00:00:00Z") });
    expect(page.nextCursor).toBe("eyJwYWdlIjoyfQ");
    expect(page.items[0]).toMatchObject({ externalId: "880001", status: "active", priceMinor: 2400, intervalUnit: "month", intervalCount: 1, customer: { externalId: "7002", email: "liam.jones@example.com" } });
    expect(page.items[1]).toMatchObject({ externalId: "880002", status: "cancelled", priceMinor: 6000, intervalCount: 2, cancellationReasonRaw: "I have too much product — piling up", cancelledForNonPayment: false });
    expect(decodeURIComponent(p.http.calls[0]!.url)).toContain("updated_at_min=2026-01-01T00:00:00");
  });

  it("maps charges into billing attempts: errors with retry date, successes with the order", async () => {
    const { items } = await make().fetchBillingAttempts({});
    expect(items.map((a) => [a.status, a.errorCode, a.cycleKey, a.orderExternalId])).toEqual([["failed", "card_expired", "2026-09-10", null], ["success", null, "2026-09-10", "9200011"]]);
    expect(items[0]!.nextRetryAt?.toISOString().slice(0, 10)).toBe("2026-09-13");
  });

  it("skips the next queued charge and has no pause capability", async () => {
    const one = { subscription: RECHARGE_SUBSCRIPTIONS.subscriptions[0] };
    const p = make([{ match: (u) => u.includes("/charges?subscription_id=880001&status=queued"), body: { charges: [{ id: 990003 }] } }, { match: (u, i) => u.endsWith("/charges/990003/skip") && i?.method === "POST", body: { charge: { id: 990003, status: "skipped" } } }, { match: (u) => u.endsWith("/subscriptions/880001"), body: one }, { match: (u) => u.includes("/customers?ids="), body: RECHARGE_CUSTOMERS }]);
    expect(p.capabilities.canPause).toBe(false);
    expect((p as SubscriptionProvider).pause).toBeUndefined();
    const c = await p.skipNext("880001");
    expect(c.externalId).toBe("880001");
    expect(JSON.parse(p.http.calls.find((x) => x.url.endsWith("/skip"))!.body!)).toEqual({ purchase_item_ids: [880001] });
  });

  it("retries a rate limit with Retry-After, then maps a 401 to an expired token", async () => {
    let n = 0;
    const p = make([{ match: (u) => u.endsWith("/store"), status: 429, headers: { "retry-after": "1" }, body: (() => { n++; return { errors: "throttled" }; }) as () => unknown }]);
    await expect(p.fetchContracts({})).rejects.toBeDefined();
    const ok = new RechargeSubscriptionProvider({ apiToken: "x", webhookSecret: "y" }, { fetchImpl: fixtureFetch([{ match: (u) => u.endsWith("/store"), status: 401, body: { errors: "unauthorized" } }]), ...noSleep });
    expect(await ok.testConnection()).toMatchObject({ ok: false });
    const limited = new RechargeSubscriptionProvider({ apiToken: "x", webhookSecret: "y" }, { fetchImpl: fixtureFetch([{ match: (u) => u.includes("/subscriptions?"), status: 429, headers: { "retry-after": "2" }, body: {} }]), ...noSleep, maxRetries: 1 });
    await expect(limited.fetchContracts({})).rejects.toMatchObject({ code: "rate_limited" });
    void n;
  });

  it("verifies webhooks: sha256 of secret + body", async () => {
    const raw = JSON.stringify({ subscription: { id: 880001, updated_at: "2026-09-10T09:00:05" } });
    const sig = createHash("sha256").update(`rc_secret${raw}`).digest("hex");
    const w = await make().verifyWebhook({ "x-recharge-hmac-sha256": sig, "x-recharge-topic": "subscription/updated" }, raw);
    expect(w.contractExternalId).toBe("880001");
    await expect(make().verifyWebhook({ "x-recharge-hmac-sha256": "00" }, raw)).rejects.toMatchObject({ code: "permission" });
  });
});

describe("Loop", () => {
  const make = (routes: Routes) => new LoopSubscriptionProvider({ apiToken: "loop_test", webhookSecret: "loop_secret" }, { fetchImpl: fixtureFetch(routes), ...noSleep });
  it("maps subscriptions and billing orders", async () => {
    const p = make([{ match: (u) => u.includes("/subscription?"), body: LOOP_SUBSCRIPTIONS }, { match: (u) => u.includes("/order?"), body: LOOP_ORDERS }]);
    const { items, nextCursor } = await p.fetchContracts({ limit: 50 });
    expect(nextCursor).toBeNull();
    expect(items[0]).toMatchObject({ externalId: "41001", status: "paused", intervalUnit: "week", intervalCount: 4, priceMinor: 2895, originOrderExternalId: "9300001", customer: { externalId: "7004" } });
    expect(items[0]!.discounts[0]).toEqual({ code: "LOOP10", title: "Loop 10%", amountMinor: 240 });
    const attempts = await p.fetchBillingAttempts({});
    expect(attempts.items[0]).toMatchObject({ status: "failed", errorCode: "card_declined", contractExternalId: "41001" });
    expect(attempts.items[0]!.nextRetryAt).not.toBeNull();
  });
  it("refuses a request Loop answered with success: false", async () => {
    const p = make([{ match: (u) => u.includes("/subscription/41001/pause"), body: { success: false, message: "Subscription already paused" } }]);
    await expect(p.pause("41001", {})).rejects.toMatchObject({ code: "invalid_request", message: "Subscription already paused" });
  });
});

describe("mock provider", () => {
  const base = { externalId: "c1", status: "active" as const, customer: null, currency: "USD", lines: [{ externalId: "l1", variantExternalId: "v1", productExternalId: "p1", sku: null, title: "Refill", variantTitle: null, quantity: 1, unitPriceMinor: 2000 }], intervalUnit: "month" as const, intervalCount: 1, nextBillingAt: new Date("2026-10-10T00:00:00Z"), priceMinor: 2000, discounts: [], createdAt: new Date("2026-01-01T00:00:00Z"), endedAt: null, pausedAt: null, cancellationReasonRaw: null, cancelledForNonPayment: false, originOrderExternalId: null, updatedAt: new Date("2026-09-10T00:00:00Z") };
  it("applies care actions, records each call and simulates declined renewals and rate limits", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const m = new MockSubscriptionProvider({ contracts: [base], now: () => now });
    expect((await m.pause("c1", {})).status).toBe("paused");
    await expect(m.pause("c1", {})).rejects.toMatchObject({ code: "invalid_request" });
    expect((await m.resume("c1")).status).toBe("active");
    expect((await m.skipNext("c1")).nextBillingAt?.toISOString().slice(0, 10)).toBe("2026-11-10");
    expect((await m.swapVariant("c1", { lineExternalId: "l1", variantExternalId: "v2" })).lines[0]!.variantExternalId).toBe("v2");
    expect(m.calls.map((c) => c.method)).toEqual(["pause", "pause", "resume", "skip", "swap"]);
    const declined = m.simulateRenewal("c1", "card_expired");
    expect(declined).toMatchObject({ status: "failed", errorCode: "card_expired" });
    expect(m.simulateRenewal("c1", "insufficient_funds", { retryInDays: null }).nextRetryAt).toBeNull();
    m.failures.failNext("rate_limited");
    await expect(m.fetchContracts({})).rejects.toMatchObject({ code: "rate_limited" });
    expect((await m.fetchBillingAttempts({})).items).toHaveLength(2);
    const raw = JSON.stringify({ contractId: "c1", updatedAt: "x" });
    expect((await m.verifyWebhook({ "x-mock-signature": m.signWebhook(raw) }, raw)).contractExternalId).toBe("c1");
  });
  it("normalizes decline reasons", () => {
    expect(normalizePaymentError("EXPIRED_PAYMENT_METHOD")).toBe("card_expired");
    expect(normalizePaymentError("INSUFFICIENT_FUNDS")).toBe("insufficient_funds");
    expect(normalizePaymentError("AUTHENTICATION_ERROR")).toBe("authentication_required");
    expect(normalizePaymentError("PAYMENT_METHOD_DECLINED")).toBe("card_declined");
    expect(normalizePaymentError(null)).toBeNull();
  });
});

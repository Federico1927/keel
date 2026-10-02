import { describe, expect, it } from "vitest";
import { billingCatalog } from "@hullwise/core";
import { CHECKOUT_COMPLETED, CUSTOMER_UPDATED, LEGACY_INVOICE_PAYMENT_FAILED, LEGACY_SUBSCRIPTION_UPDATED } from "./__fixtures__/stripe-events";
import { FakeStripe } from "./fake-stripe";
import { encodeForm, parseForm } from "./form";
import { MockBillingProvider, parseMockPriceId } from "./mock";
import { parseStripeEvent, toCheckoutSnapshot, toCustomerSnapshot, toInvoiceSnapshot, toSubscriptionSnapshot } from "./parse";
import { signStripePayload, verifyStripeSignature } from "./signature";
import { StripeBillingProvider } from "./stripe";

const SECRET = "whsec_fixture";
const KEY = "rk_test_fixture";

describe("Stripe webhook signature", () => {
  const body = JSON.stringify(CHECKOUT_COMPLETED);
  const now = 1790000200_000;
  it("accepts a valid signature within the tolerance and refuses everything else", () => {
    const header = signStripePayload(body, SECRET, now / 1000);
    expect(verifyStripeSignature(header, body, SECRET, { now })).toEqual({ ok: true, timestamp: now / 1000 });
    // several v1 entries (secret rotation): one match is enough
    expect(verifyStripeSignature(`${header},v1=${"0".repeat(64)}`, body, SECRET, { now }).ok).toBe(true);
    expect(verifyStripeSignature(header, body.replace("paid", "unpaid"), SECRET, { now })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyStripeSignature(header, body, "whsec_other", { now })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyStripeSignature(header, body, SECRET, { now: now + 301_000 })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(verifyStripeSignature(null, body, SECRET, { now })).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyStripeSignature("t=abc", body, SECRET, { now })).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("Stripe payloads", () => {
  it("reads the legacy layout (periods on the subscription, invoice.subscription, line.price)", () => {
    const ev = parseStripeEvent(LEGACY_SUBSCRIPTION_UPDATED)!;
    expect(ev).toMatchObject({ id: "evt_1QlegacySubUpdated", type: "customer.subscription.updated", livemode: false });
    const sub = toSubscriptionSnapshot(ev.object);
    expect(sub).toMatchObject({ id: "sub_1QlegacyA", customerId: "cus_QlegacyA", status: "past_due", metadata: { hullwise_tenant_id: "00000000-0000-4000-8000-00000000000a" }, latestInvoiceId: "in_1QlegacyA" });
    expect(sub.currentPeriodEnd?.toISOString()).toBe(new Date(1791600000_000).toISOString());
    expect(sub.items).toEqual([{ itemId: "si_QlegacyA", priceId: "price_1QlegacyPlan", lookupKey: "hullwise_plan_growth_monthly", unitAmountMinor: 59900, currency: "USD", interval: "month", quantity: 1 }]);
    const inv = toInvoiceSnapshot(parseStripeEvent(LEGACY_INVOICE_PAYMENT_FAILED)!.object);
    expect(inv).toMatchObject({ id: "in_1QlegacyA", subscriptionId: "sub_1QlegacyA", status: "open", totalMinor: 73078, taxMinor: 13178, attemptCount: 1, subscriptionTenantId: "00000000-0000-4000-8000-00000000000a", pdfUrl: "https://pay.stripe.com/invoice/acct_test/test_legacy/pdf" });
    expect(inv.lines[0]).toMatchObject({ priceId: "price_1QlegacyPlan", lookupKey: "hullwise_plan_growth_monthly", amountMinor: 59900 });
  });

  it("reads checkout sessions and customers with VAT ids", () => {
    expect(toCheckoutSnapshot(parseStripeEvent(CHECKOUT_COMPLETED)!.object)).toMatchObject({ customerId: "cus_QnewB", subscriptionId: "sub_1QnewB", clientReferenceId: "00000000-0000-4000-8000-00000000000b", paymentStatus: "paid" });
    expect(toCustomerSnapshot(parseStripeEvent(CUSTOMER_UPDATED)!.object)).toMatchObject({ country: "DE", taxIds: [{ type: "eu_vat", value: "DE123456789", verified: true }] });
    expect(parseStripeEvent({ id: "x" })).toBeNull();
  });

  it("encodes nested form bodies the way Stripe expects", () => {
    const body = encodeForm({ items: [{ id: "si_1", price: "price_2" }, { id: "si_3", deleted: true }], metadata: { hullwise_tenant_id: "t" }, skip: undefined });
    expect(decodeURIComponent(body)).toBe("items[0][id]=si_1&items[0][price]=price_2&items[1][id]=si_3&items[1][deleted]=true&metadata[hullwise_tenant_id]=t");
    expect(parseForm(body)).toEqual({ items: { "0": { id: "si_1", price: "price_2" }, "1": { id: "si_3", deleted: "true" } }, metadata: { hullwise_tenant_id: "t" } });
  });
});

describe("StripeBillingProvider (test double, no network)", () => {
  it("syncs the catalog: products and prices created once, a second run changes nothing, a new amount archives the old price", async () => {
    const fake = new FakeStripe();
    const p = new StripeBillingProvider(KEY, { fetchImpl: fake.fetch, maxRetries: 0 });
    expect(p.mode).toBe("test");
    const catalog = billingCatalog();
    const first = await p.syncCatalog(catalog);
    expect(first.every((r) => r.outcome === "created")).toBe(true);
    expect(fake.products.size).toBe(catalog.length);
    expect(fake.prices.size).toBe(catalog.length);
    // the key only travels in the auth header, creates are idempotent
    expect(fake.calls.every((c) => c.authorization === `Bearer ${KEY}` && !JSON.stringify(c.body).includes(KEY))).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST").every((c) => c.idempotencyKey)).toBe(true);
    const writes = fake.calls.filter((c) => c.method === "POST").length;
    const second = await p.syncCatalog(catalog);
    expect(second.every((r) => r.outcome === "unchanged")).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST").length).toBe(writes);
    expect(second.map((r) => r.priceId)).toEqual(first.map((r) => r.priceId));
    const changed = catalog.map((c) => (c.lookupKey === "hullwise_plan_growth_monthly" ? { ...c, amountMinor: c.amountMinor + 1000 } : c));
    const third = await p.syncCatalog(changed);
    const growth = third.find((r) => r.lookupKey === "hullwise_plan_growth_monthly")!;
    const old = first.find((r) => r.lookupKey === "hullwise_plan_growth_monthly")!;
    expect(growth).toMatchObject({ outcome: "created", archivedPriceId: old.priceId });
    expect(fake.prices.get(old.priceId)).toMatchObject({ active: false, lookupKey: null });
    expect(fake.prices.get(growth.priceId)).toMatchObject({ active: true, lookupKey: "hullwise_plan_growth_monthly", unitAmount: old.amountMinor + 1000 });
    expect(third.filter((r) => r.outcome !== "unchanged")).toHaveLength(1);
  });

  it("starts checkout with the setup fee as a one-off line, updates items with proration, opens the portal", async () => {
    const fake = new FakeStripe();
    const p = new StripeBillingProvider(KEY, { fetchImpl: fake.fetch, maxRetries: 0 });
    const prices = Object.fromEntries((await p.syncCatalog(billingCatalog())).map((r) => [r.lookupKey, r.priceId]));
    const customer = await p.ensureCustomer({ tenantId: "t-1", name: "Harbor Home", email: "billing@harbor.test", locale: "en" });
    expect(await p.ensureCustomer({ tenantId: "t-1", name: "Harbor Home" })).toBe(customer);
    const session = await p.createCheckoutSession({ customerId: customer, tenantId: "t-1", priceIds: [prices.hullwise_plan_starter_monthly!], oneOffPriceIds: [prices.hullwise_setup_starter!], trialDays: null, automaticTax: true, idempotencyKey: "k1", successUrl: "https://app/ok", cancelUrl: "https://app/no", locale: "en" });
    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const call = fake.calls.find((c) => c.path === "checkout/sessions")!;
    expect(call.body).toMatchObject({ mode: "subscription", tax_id_collection: { enabled: "true" }, automatic_tax: { enabled: "true" }, line_items: { "0": { price: prices.hullwise_plan_starter_monthly }, "1": { price: prices.hullwise_setup_starter } } });
    fake.completeCheckout(session.id);
    const subId = [...fake.subscriptions.keys()][0]!;
    const sub = (await p.fetchSubscription(subId))!;
    expect(sub.items.map((i) => i.lookupKey)).toEqual(["hullwise_plan_starter_monthly"]);
    expect(sub.paymentMethodSummary).toBe("visa •••• 4242");
    const updated = await p.updateSubscriptionItems(subId, { add: [prices.hullwise_addon_cod_monthly!], remove: [], swap: [{ itemId: sub.items[0]!.itemId, priceId: prices.hullwise_plan_growth_monthly! }] }, "k2");
    expect(updated.items.map((i) => i.lookupKey)).toEqual(["hullwise_plan_growth_monthly", "hullwise_addon_cod_monthly"]);
    expect(fake.calls.find((c) => c.path === `subscriptions/${subId}` && c.method === "POST")!.body).toMatchObject({ proration_behavior: "create_prorations" });
    const invoices = await p.listInvoices(customer);
    expect(invoices[0]).toMatchObject({ status: "paid", totalMinor: billingCatalog().find((c) => c.lookupKey === "hullwise_plan_starter_monthly")!.amountMinor + billingCatalog().find((c) => c.lookupKey === "hullwise_setup_starter")!.amountMinor });
    expect((await p.createPortalSession(customer, "https://app/billing", "it")).url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(await p.fetchSubscription("sub_missing")).toBeNull();
  });

  it("the mock keeps lookup keys and amounts in its price ids", async () => {
    const m = new MockBillingProvider();
    const [r] = await m.syncCatalog(billingCatalog().slice(0, 1));
    expect(parseMockPriceId(r!.priceId)).toEqual({ lookupKey: "hullwise_plan_starter_monthly", amountMinor: 24900 });
    expect((await m.createCheckoutSession({ customerId: "c", tenantId: "t", priceIds: [], oneOffPriceIds: [], trialDays: null, automaticTax: false, idempotencyKey: "x", successUrl: "https://app/b?x=1", cancelUrl: "https://app/b", locale: null })).url).toMatch(/^https:\/\/app\/b\?x=1&mock_checkout=mock_cs_/);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODULES, PLANS } from "@hullwise/config";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockBillingProvider, MockInvoicingProvider, StripeBillingProvider, signStripePayload } from "@hullwise/integrations";
import { FakeStripe } from "@hullwise/integrations/billing/fake-stripe";
import {
  applySuspensions,
  billingSettings,
  consoleBillingOverview,
  createBillingPortalSession,
  processBillingEvent,
  receiveStripeWebhook,
  resyncTenantBilling,
  setBillingProvider,
  setTenantAddon,
  setTenantPlan,
  simulateMockCheckout,
  simulateMockRenewal,
  startSubscription,
  syncBillingCatalog,
  tenantBillingBanner,
  tenantBillingOverview,
  tenantSubscriptionDetail,
  voidInvoice,
  type ServiceContext,
} from "../src";

/**
 * Stripe billing (#53) end to end against the Stripe test double: catalog sync, Checkout for
 * Harbor Home, signed webhooks (completed, paid, failed, action required, replays, bad
 * signatures), the lifecycle (past due → suspended after N days → reactivated), proration,
 * resync, portal, VAT and e-invoicing. No network: every call goes to FakeStripe.
 */
const pools = testPools();
const KEY = "rk_test_fixture";
const SECRET = "whsec_fixture";
const settings = billingSettings({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET });
const t0 = new Date();
const fake = new FakeStripe(t0);
const provider = new StripeBillingProvider(KEY, { fetchImpl: fake.fetch, maxRetries: 0 });
const invoicing = new MockInvoicingProvider();
let ctx: SeedContext;
let admin = "";
let harbor = "";
let northwind = "";

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  admin = ctx.userIds["superadmin@hullwise.demo"]!;
  harbor = ctx.tenantIds.harbor;
  northwind = ctx.tenantIds.northwind;
  setBillingProvider(provider);
});
afterAll(async () => {
  setBillingProvider(null);
  await pools.close();
});

async function deliver(events: Record<string, unknown>[], now = fake.now, opts: { settings?: typeof settings } = {}) {
  const out: string[] = [];
  for (const e of events) {
    const body = JSON.stringify(e);
    const r = await receiveStripeWebhook(pools.admin, { rawBody: body, signature: signStripePayload(body, SECRET, Math.floor(now.getTime() / 1000)), secret: SECRET, now, settings: opts.settings ?? settings });
    if (!r.ok) out.push(`rejected:${r.reason}`);
    else if (r.duplicate) out.push("duplicate");
    else out.push(await processBillingEvent(pools.admin, r.id!, { now, provider, invoicing, settings: opts.settings ?? settings }));
  }
  return out;
}
const sub = async (tenantId: string) => (await pools.admin.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)))[0]!;
const tenant = async (tenantId: string) => (await pools.admin.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0]!;
const stripeInvoices = async (tenantId: string) => pools.admin.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.provider, "stripe")));
const auditCount = async (action: string, tenantId?: string) => (await pools.admin.select().from(schema.auditLogs).where(tenantId ? and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.tenantId, tenantId)) : eq(schema.auditLogs.action, action))).length;
const asOwner = <T>(tenantId: string, fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@harborhome.demo"]! } }), pools.app);

describe("Stripe billing (test double)", () => {
  it("catalog sync creates products and prices; a second run changes nothing", async () => {
    const first = await syncBillingCatalog(pools.admin, { provider, actorUserId: admin, now: t0 });
    expect(first).toMatchObject({ created: 8, updated: 0, unchanged: 0 });
    expect(fake.products.size).toBe(8);
    const prices = await pools.admin.select().from(schema.billingPrices).where(eq(schema.billingPrices.provider, "stripe"));
    expect(prices.map((p) => p.lookupKey).sort()).toContain("hullwise_setup_starter");
    const posts = fake.calls.filter((c) => c.method === "POST").length;
    const second = await syncBillingCatalog(pools.admin, { provider, actorUserId: admin, now: t0 });
    expect(second).toEqual({ created: 0, updated: 0, unchanged: 8, archived: 0 });
    expect(fake.calls.filter((c) => c.method === "POST").length).toBe(posts);
    expect(await auditCount("billing.catalog_synced")).toBe(2);
  });

  it("starts Harbor Home's subscription: Checkout link, email in the customer's language, then the webhooks make it active with the first invoice paid", async () => {
    const r = await startSubscription(pools.admin, harbor, { planKey: "starter", addons: [], chargeSetupFee: true, trialDays: 0, billingEmail: "billing@harborhome.demo", collection: "checkout" }, { provider, actorUserId: admin, appUrl: "https://app.hullwise.test", now: t0, settings });
    expect(r.kind).toBe("checkout");
    if (r.kind !== "checkout") return;
    expect(r.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(r.email).toBe("queued");
    const [mail] = await pools.admin.select().from(schema.emailMessages).where(eq(schema.emailMessages.template, "billing_checkout"));
    expect(mail).toMatchObject({ locale: "en", kind: "transactional", status: "queued" });
    const pending = await sub(harbor);
    expect(pending).toMatchObject({ checkoutSessionId: r.sessionId, billingEmail: "billing@harborhome.demo", collectionMethod: "charge_automatically", provider: "stripe" });
    const checkoutCall = fake.calls.find((c) => c.path === "checkout/sessions")!;
    expect(checkoutCall.body).toMatchObject({ mode: "subscription", client_reference_id: harbor, tax_id_collection: { enabled: "true" } });
    // the customer pays on Stripe: checkout.session.completed, customer.subscription.created, invoice.finalized, invoice.paid
    const results = await deliver(fake.completeCheckout(r.sessionId));
    expect(results).toEqual(["processed", "processed", "processed", "processed"]);
    const active = await sub(harbor);
    expect(active).toMatchObject({ externalStatus: "active", checkoutSessionId: null, paymentMethodSummary: "visa •••• 4242", planKey: "starter" });
    expect(active.externalSubscriptionId).toMatch(/^sub_/);
    expect(active.items.map((i) => i.lookupKey)).toEqual(["hullwise_plan_starter_monthly"]);
    const [first] = await stripeInvoices(harbor);
    expect(first).toMatchObject({ status: "paid", amountMinor: PLANS.starter.monthlyPriceMinor + PLANS.starter.setupFeeMinor, kind: "subscription" });
    expect(first!.pdfUrl).toMatch(/\/pdf$/);
    expect((first!.lines as { kind: string }[]).map((l) => l.kind).sort()).toEqual(["plan", "setup"]);
    expect(await auditCount("billing.checkout_completed", harbor)).toBe(1);
    expect(await auditCount("billing.invoice_paid", harbor)).toBe(1);
    // e-invoicing slot: the paid invoice was handed to the (mock) connector
    expect(invoicing.pushed.map((p) => p.invoiceNumber)).toEqual([first!.number]);
    expect(first!.einvoiceStatus).toBe("queued");
  });

  it("replaying a webhook changes nothing; a bad signature is refused (400) and logged without secrets", async () => {
    const before = { audit: (await pools.admin.select().from(schema.auditLogs)).length, invoices: (await stripeInvoices(harbor)).map((i) => [i.status, i.attemptCount]) };
    const [paid] = fake.pay([...fake.invoices.keys()][0]!).slice(0, 1);
    expect(await deliver([paid!])).toEqual(["processed"]);
    expect(await deliver([paid!])).toEqual(["duplicate"]);
    expect((await stripeInvoices(harbor)).map((i) => [i.status, i.attemptCount])).toEqual(before.invoices.map(([s]) => [s, 2]));
    const audits = (await pools.admin.select().from(schema.auditLogs)).length;
    expect(audits).toBe(before.audit); // paid → paid: no status change, no audit row
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify(paid);
    const bad = await receiveStripeWebhook(pools.admin, { rawBody: body, signature: signStripePayload(body, "whsec_wrong"), secret: SECRET, settings });
    expect(bad).toEqual({ ok: false, status: 400, reason: "signature_mismatch" });
    const stale = await receiveStripeWebhook(pools.admin, { rawBody: body, signature: signStripePayload(body, SECRET, Math.floor(Date.now() / 1000) - 3600), secret: SECRET, settings });
    expect(stale).toMatchObject({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(await auditCount("billing.webhook_rejected")).toBe(1);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("signature_mismatch");
    expect(logged).not.toMatch(/whsec_|rk_test|sk_test/);
    warn.mockRestore();
  });

  it("a declined renewal makes the tenant past due at once (owner banner with the payment link), suspended after the grace period, active again once paid", async () => {
    // the seeded Hullwise-ledger invoice Harbor still owes is settled out of band, so only Stripe drives the state
    for (const inv of await pools.admin.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, harbor), eq(schema.invoices.status, "open")))) await voidInvoice(pools.admin, inv.id, admin, t0);
    expect((await tenant(harbor)).status).toBe("active");
    fake.now = new Date(t0.getTime() + 31 * 864e5);
    const subId = (await sub(harbor)).externalSubscriptionId!;
    expect(await deliver(fake.renew(subId, { fail: true }))).toEqual(["processed", "processed", "processed"]);
    expect((await tenant(harbor)).status).toBe("past_due");
    expect((await sub(harbor)).externalStatus).toBe("past_due");
    const failed = (await stripeInvoices(harbor)).find((i) => i.status === "open")!;
    expect(failed.paymentFailedAt).toBeTruthy();
    const banner = await asOwner(harbor, (s) => tenantBillingBanner(s, { status: "past_due", suspendAfterDays: 14 }, fake.now));
    expect(banner).toMatchObject({ kind: "past_due", payUrl: failed.hostedUrl, suspendsInDays: 14 });
    const overview = await consoleBillingOverview(pools.admin, fake.now, settings);
    expect(overview.failedPayments.map((f) => f.tenantId)).toContain(harbor);
    expect(overview.pastDue.map((p) => p.tenantId)).toContain(harbor);
    // time travel: 15 days later, retries exhausted and still unpaid → suspended by the existing rule
    await applySuspensions(pools.admin, { now: new Date(fake.now.getTime() + 15 * 864e5) });
    expect((await tenant(harbor)).status).toBe("suspended");
    fake.now = new Date(fake.now.getTime() + 16 * 864e5);
    expect(await deliver(fake.pay(failed.externalId!))).toEqual(["processed", "processed"]);
    expect((await tenant(harbor)).status).toBe("active");
    expect(await auditCount("tenant.reactivated", harbor)).toBeGreaterThan(0);
    expect(await auditCount("billing.payment_failed", harbor)).toBe(1);
  });

  it("an authentication request shows the action-required banner; marked uncollectible counts as unpaid", async () => {
    const subId = (await sub(harbor)).externalSubscriptionId!;
    fake.now = new Date(fake.now.getTime() + 864e5);
    await deliver(fake.renew(subId, { fail: true }));
    const open = [...fake.invoices.values()].find((i) => i.status === "open")!;
    await deliver(fake.actionRequired(open.id));
    expect(await asOwner(harbor, (s) => tenantBillingBanner(s, { status: "past_due", suspendAfterDays: 14 }, fake.now))).toMatchObject({ kind: "action_required" });
    await deliver(fake.markUncollectible(open.id));
    expect((await stripeInvoices(harbor)).find((i) => i.externalId === open.id)!.status).toBe("uncollectible");
    await deliver(fake.pay(open.id));
    expect((await tenant(harbor)).status).toBe("active");
    expect(await asOwner(harbor, (s) => tenantBillingBanner(s, { status: "active", suspendAfterDays: 14 }, fake.now))).toBeNull();
  });

  it("plan and add-on changes update the subscription items with proration; out-of-order events are skipped", async () => {
    await setTenantPlan(pools.admin, harbor, "growth", admin, fake.now, { provider });
    await setTenantAddon(pools.admin, harbor, "addon.cod", true, admin, "pilot", fake.now, { provider });
    const s = await sub(harbor);
    expect(s.items.map((i) => i.lookupKey)).toEqual(["hullwise_plan_growth_monthly", "hullwise_addon_cod_monthly"]);
    const stripeSub = fake.subscriptions.get(s.externalSubscriptionId!)!;
    expect(stripeSub.items.map((i) => i.lookupKey)).toEqual(["hullwise_plan_growth_monthly", "hullwise_addon_cod_monthly"]);
    expect(fake.calls.filter((c) => c.path === `subscriptions/${stripeSub.id}` && c.method === "POST").every((c) => c.body.proration_behavior === "create_prorations")).toBe(true);
    expect((await tenantSubscriptionDetail(pools.admin, harbor, settings)).drift).toBe(false);
    // a stale snapshot (older than the last applied event) does not roll the items back
    const stale = { ...fake.subJson(stripeSub), items: { object: "list", data: [] } };
    const old = { id: "evt_stale_1", object: "event", created: Math.floor(t0.getTime() / 1000), livemode: false, type: "customer.subscription.updated", data: { object: stale } };
    expect(await deliver([old])).toEqual(["processed"]);
    expect((await sub(harbor)).items).toHaveLength(2);
  });

  it("resync from Stripe restores the mirror; the owner's billing page and portal read it", async () => {
    await pools.admin.update(schema.subscriptions).set({ externalStatus: "incomplete", items: [] }).where(eq(schema.subscriptions.tenantId, harbor));
    const r = await resyncTenantBilling(pools.admin, harbor, { provider, actorUserId: admin, now: fake.now });
    expect(r.subscription).toBe(true);
    expect(r.invoices).toBeGreaterThanOrEqual(3);
    expect((await sub(harbor))).toMatchObject({ externalStatus: "active" });
    expect((await sub(harbor)).items).toHaveLength(2);
    const t = await tenant(harbor);
    const view = await asOwner(harbor, (s) => tenantBillingOverview(s, { planKey: t.planKey, status: t.status, suspendAfterDays: t.suspendAfterDays, activeAddons: ["addon.cod"] }, fake.now));
    expect(view).toMatchObject({ managed: true, planKey: "growth", monthlyMinor: PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!, banner: null });
    expect(view.invoices.some((i) => i.pdfUrl)).toBe(true);
    const portal = await asOwner(harbor, (s) => createBillingPortalSession(s, { returnUrl: "https://app.hullwise.test/t/harbor-home/settings/billing", locale: "en", provider }));
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(await auditCount("billing.portal_opened", harbor)).toBe(1);
  });

  it("without Stripe Tax, a verified EU VAT id abroad sets the reverse charge on the customer", async () => {
    const manual = billingSettings({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_TAX: "off", BILLING_SELLER_COUNTRY: "IT" });
    const customer = (await sub(harbor)).externalCustomerId!;
    await deliver(fake.updateCustomer(customer, { country: "DE", taxIds: [{ type: "eu_vat", value: "DE123456789", verified: true }] }), fake.now, { settings: manual });
    expect(fake.customers.get(customer)!.taxExempt).toBe("reverse");
    expect((await sub(harbor))).toMatchObject({ customerCountry: "DE" });
    expect((await tenantSubscriptionDetail(pools.admin, harbor, manual)).vat).toBe("reverse_charge");
  });

  it("a live-mode event on a test key is stored but ignored; the console overview reads the mirror", async () => {
    const live = { ...fake.updateCustomer((await sub(harbor)).externalCustomerId!, { email: "x@harborhome.demo" })[0]!, livemode: true };
    const body = JSON.stringify(live);
    const r = await receiveStripeWebhook(pools.admin, { rawBody: body, signature: signStripePayload(body, SECRET), secret: SECRET, settings });
    expect(r).toMatchObject({ ok: true, ignored: true });
    const o = await consoleBillingOverview(pools.admin, fake.now, settings);
    expect(o.settings.mode).toBe("test");
    expect(o.mrrMinor).toBe(PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!);
    expect(o.lastEvent).toBeTruthy();
    expect(o.catalog.every((c) => c.inStep)).toBe(true);
    expect(JSON.stringify(o)).not.toContain(KEY);
  });
});

describe("mock provider (default): the console simulates Stripe's webhooks", () => {
  const mock = new MockBillingProvider();
  it("checkout completion and a declined renewal go through the same processing; re-running is a no-op", async () => {
    setBillingProvider(mock);
    const s = billingSettings({});
    expect(s).toMatchObject({ provider: "mock", mode: "mock", automaticTax: false });
    await syncBillingCatalog(pools.admin, { provider: mock, actorUserId: admin });
    const r = await startSubscription(pools.admin, northwind, { planKey: "growth", addons: ["addon.cod", "addon.customer_campaigns"], chargeSetupFee: false, trialDays: 14, billingEmail: "billing@northwind.demo", collection: "checkout" }, { provider: mock, actorUserId: admin, appUrl: "http://localhost:3000", settings: s });
    expect(r.kind === "checkout" && r.url).toMatch(/\/t\/northwind-apparel\/settings\/billing\?checkout=success&mock_checkout=mock_cs_/);
    expect((await simulateMockCheckout(pools.admin, northwind, { actorUserId: admin })).processed).toBe(4);
    expect(await sub(northwind)).toMatchObject({ provider: "mock", externalStatus: "trialing" });
    await expect(simulateMockCheckout(pools.admin, northwind, { actorUserId: admin })).rejects.toThrow("no_checkout");
    const failed = await simulateMockRenewal(pools.admin, northwind, { actorUserId: admin, fail: true });
    expect(failed.processed).toBe(3);
    expect((await tenant(northwind)).status).toBe("past_due");
    expect((await simulateMockRenewal(pools.admin, northwind, { actorUserId: admin, fail: true })).processed).toBe(0);
    setBillingProvider(provider);
  });
});

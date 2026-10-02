import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { DEMO_TENANTS, seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { isPageEnabled, isWidgetAvailable } from "@hullwise/config";
import { parseTenantSettings, readyMadeSubscriptionSegment } from "@hullwise/core";
import { MockSubscriptionProvider } from "@hullwise/integrations";
import {
  SUBSCRIPTION_MCP_TOOLS,
  SUBSCRIPTION_WIDGET_LOADERS,
  addSubscriptionNote,
  assignSubscription,
  cancellationAnalysis,
  customerSubscriptions,
  getSubscriptionProviderFor,
  listSubscribers,
  mockSubscriptionsFor,
  orderSubscription,
  previewSegment,
  processSubscriptionWebhook,
  recoveryQueue,
  refreshSubscriberRisk,
  renewalStock,
  replenishmentPlan,
  resetMockSubscriptions,
  runSubscriptionSync,
  subscriptionAction,
  subscriptionProfitReport,
  subscriptionsOverview,
  toolDenial,
  type AnalyticsTenant,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let harbor = "";
let northwind = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  harbor = ctx.tenantIds.harbor;
  northwind = ctx.tenantIds.northwind;
  const [t] = await pools.admin.select().from(schema.tenants).where(eq(schema.tenants.id, harbor));
  tenant = { id: harbor, country: t!.country, currency: t!.currency, timezone: t!.timezone, settings: parseTenantSettings(t!.settings) };
  resetMockSubscriptions();
});
afterAll(() => pools.close());

const as = (tenantId: string, email: string, now?: Date) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! }, now }), pools.app);
const harborCare = <T>(fn: (s: ServiceContext) => Promise<T>) => as(harbor, "care@harborhome.demo")(fn);
const harborOwner = <T>(fn: (s: ServiceContext) => Promise<T>) => as(harbor, "owner@harborhome.demo")(fn);

describe("seeded Harbor Home", () => {
  it("has the add-on, subscribers, flagged subscription orders and Northwind has none", async () => {
    expect(DEMO_TENANTS.harbor.addons).toContain("addon.subscriptions");
    expect(DEMO_TENANTS.northwind.addons).not.toContain("addon.subscriptions");
    const [h] = (await pools.admin.execute<{ n: number; failing: number }>(sql`select count(*)::int as n, count(*) filter (where payment_failing_since is not null and status = 'active')::int as failing from subscription_contracts where tenant_id = ${harbor}`)).rows;
    expect(h!.n).toBeGreaterThanOrEqual(40);
    expect(h!.failing).toBeGreaterThanOrEqual(4);
    const [o] = (await pools.admin.execute<{ first: number; renewals: number; contracts: number }>(sql`select count(*) filter (where is_first_subscription_order)::int as first, count(*) filter (where renewal_number > 0)::int as renewals, count(distinct subscription_contract_id)::int as contracts from orders where tenant_id = ${harbor}`)).rows;
    expect(o!.first).toBe(h!.n);
    expect(o!.renewals).toBeGreaterThan(0);
    const [nw] = (await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from subscription_contracts where tenant_id = ${northwind}`)).rows;
    expect(nw!.n).toBe(0);
  });

  it("the renewal stock forecast flags the short variant and suggests a reorder quantity, also in reorder planning", async () => {
    const rows = await harborOwner((s) => renewalStock(s, { weeks: 1 }));
    const fig = rows.find((r) => r.label === "Candle Refill · Fig");
    expect(fig).toBeTruthy();
    expect(fig!.runOutAt).not.toBeNull();
    expect(fig!.runOutAt!.getTime()).toBeLessThan(Date.now() + 7 * 864e5);
    expect(fig!.units).toBeGreaterThan(fig!.available);
    expect(fig!.shortfall).toBe(fig!.units - fig!.available - fig!.incoming);
    // MOQ 24, multiple 12 on the seeded supplier link
    expect(fig!.suggestedQuantity).toBeGreaterThanOrEqual(Math.max(24, fig!.shortfall));
    expect(fig!.suggestedQuantity % 12).toBe(0);
    expect(rows.filter((r) => r.runOutAt).map((r) => r.label)).toEqual(["Candle Refill · Fig"]);
    const plan = await harborOwner((s) => replenishmentPlan(s, { id: harbor, timezone: tenant.timezone, currency: tenant.currency, settings: tenant.settings }, { variantIds: [fig!.variantId] }));
    expect(plan[0]!.renewalUnits).toBeGreaterThan(0);
    expect(plan[0]!.shouldOrder).toBe(true);
    expect(plan[0]!.quantity).toBeGreaterThan(0);
  });

  it("lists the failed-payment recovery queue with value at risk and the provider's retries", async () => {
    const q = await harborCare((s) => recoveryQueue(s));
    expect(q.rows.length).toBeGreaterThanOrEqual(4);
    expect(q.valueAtRiskMinor).toBe(q.rows.reduce((t, r) => t + r.valueAtRiskMinor, 0));
    expect(q.rows.every((r) => r.failures >= 1 && r.lastErrorCode)).toBe(true);
    expect(q.rows.some((r) => r.nextRetryAt && r.nextRetryAt.getTime() > Date.now())).toBe(true);
    expect(q.recoveryRate === null || (q.recoveryRate >= 0 && q.recoveryRate <= 1)).toBe(true);
  });
});

describe("customer care through the mock provider", () => {
  it("a care user pauses and skips a contract: one write each, idempotent, timeline author and diff", async () => {
    const [c] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.status, "active"), sql`${schema.subscriptionContracts.paymentFailingSince} is null`)).orderBy(schema.subscriptionContracts.externalId).limit(1);
    const provider = (await harborCare((s) => getSubscriptionProviderFor(s))) as MockSubscriptionProvider;
    expect(provider).toBeInstanceOf(MockSubscriptionProvider);
    const before = provider.calls.length;
    const paused = await harborCare((s) => subscriptionAction(s, { contractId: c!.id, action: "pause", requestKey: "dlg-pause-1" }));
    expect(paused).toMatchObject({ replayed: false, contract: { status: "paused" } });
    const again = await harborCare((s) => subscriptionAction(s, { contractId: c!.id, action: "pause", requestKey: "dlg-pause-1" }));
    expect(again.replayed).toBe(true);
    expect(provider.calls.slice(before).map((x) => x.method)).toEqual(["pause"]);
    // resume (owner), then skip the next renewal as the care user
    await harborOwner((s) => subscriptionAction(s, { contractId: c!.id, action: "resume", requestKey: "dlg-resume-1" }));
    const [mid] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, c!.id));
    const skipped = await harborCare((s) => subscriptionAction(s, { contractId: c!.id, action: "skip", requestKey: "dlg-skip-1" }));
    await harborCare((s) => subscriptionAction(s, { contractId: c!.id, action: "skip", requestKey: "dlg-skip-1" }));
    expect(skipped.contract.nextBillingAt!.getTime()).toBeGreaterThan(mid!.nextBillingAt!.getTime());
    expect(skipped.contract.skipsCount).toBe(c!.skipsCount + 1);
    expect(provider.calls.slice(before).map((x) => x.method)).toEqual(["pause", "resume", "skip"]);
    const writes = await pools.admin.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, harbor), eq(schema.platformWrites.entityId, c!.id)));
    expect(writes.map((w) => [w.kind, w.status, w.provider]).sort()).toEqual([["subscription.pause", "succeeded", "subscriptions"], ["subscription.resume", "succeeded", "subscriptions"], ["subscription.skip", "succeeded", "subscriptions"]]);
    const events = await pools.admin.select().from(schema.subscriptionEvents).where(and(eq(schema.subscriptionEvents.contractId, c!.id), sql`${schema.subscriptionEvents.metadata} ? 'requestKey'`)).orderBy(schema.subscriptionEvents.occurredAt);
    expect(events.map((e) => e.type)).toEqual(["paused", "resumed", "skipped"]);
    const pauseEvent = events[0]!;
    expect(pauseEvent).toMatchObject({ authorType: "staff", actorUserId: ctx.userIds["care@harborhome.demo"], diff: { status: { from: "active", to: "paused" } } });
    expect(Object.keys(events[2]!.diff as object)).toContain("nextBillingAt");
    const audits = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), eq(schema.auditLogs.entityId, c!.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["subscription.pause", "subscription.resume", "subscription.skip"]);
  });

  it("refuses an action the provider cannot do, and a failed provider call writes nothing locally", async () => {
    const [c] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.status, "cancelled"))).limit(1);
    await expect(harborCare((s) => subscriptionAction(s, { contractId: c!.id, action: "pause", requestKey: "x" }))).rejects.toMatchObject({ code: "not_allowed" });
    const [a] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.status, "active"))).orderBy(sql`${schema.subscriptionContracts.externalId} desc`).limit(1);
    mockSubscriptionsFor(harbor)!.failures.failNext("rate_limited");
    await expect(harborCare((s) => subscriptionAction(s, { contractId: a!.id, action: "pause", requestKey: "rl-1" }))).rejects.toMatchObject({ code: "rate_limited" });
    const [still] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, a!.id));
    expect(still!.status).toBe("active");
  });

  it("cancels with a reason from the tenant list, records notes, assignment and the payment link", async () => {
    const q = await harborCare((s) => recoveryQueue(s));
    const target = q.rows[0]!;
    await harborCare((s) => subscriptionAction(s, { contractId: target.contractId, action: "payment_link", requestKey: "link-1" }));
    await harborCare((s) => addSubscriptionNote(s, target.contractId, "Called, left a voicemail", { contacted: true }));
    await harborOwner((s) => assignSubscription(s, target.contractId, ctx.userIds["care@harborhome.demo"]!));
    const [after] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, target.contractId));
    expect(after!.lastContactAt).not.toBeNull();
    expect(after!.assignedTo).toBe(ctx.userIds["care@harborhome.demo"]);
    const [act] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.status, "active"), sql`${schema.subscriptionContracts.paymentFailingSince} is null`)).orderBy(sql`${schema.subscriptionContracts.externalId} desc`).limit(1);
    await expect(harborCare((s) => subscriptionAction(s, { contractId: act!.id, action: "cancel", requestKey: "c-0", reason: "not_a_reason" }))).rejects.toMatchObject({ code: "invalid_input" });
    const cancelled = await harborCare((s) => subscriptionAction(s, { contractId: act!.id, action: "cancel", requestKey: "c-1", reason: "too_much_product", note: "Has plenty at home" }));
    expect(cancelled.contract).toMatchObject({ status: "cancelled", cancellationKind: "voluntary", cancellationReasonCode: "too_much_product" });
    expect(cancelled.contract.cancellationReasonRaw).toContain("Has plenty at home");
  });

  it("syncs from the provider: a declined renewal opens a recovery episode, a later success closes it", async () => {
    const mock = mockSubscriptionsFor(harbor)!;
    const [c] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.status, "active"), sql`${schema.subscriptionContracts.paymentFailingSince} is null`)).orderBy(schema.subscriptionContracts.activatedAt).limit(1);
    mock.simulateRenewal(c!.externalId, "card_expired");
    const r = await harborOwner((s) => runSubscriptionSync(s, mock, { kind: "reconcile" }));
    expect(r.error).toBeNull();
    expect(r.finished).toBe(true);
    const [failing] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, c!.id));
    expect(failing!.paymentFailingSince).not.toBeNull();
    mock.simulateRenewal(c!.externalId, "success");
    await harborOwner((s) => runSubscriptionSync(s, mock, { kind: "reconcile" }));
    const [ok] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, c!.id));
    expect(ok!.paymentFailingSince).toBeNull();
    const types = (await pools.admin.select({ t: schema.subscriptionEvents.type }).from(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.contractId, c!.id))).map((e) => e.t);
    expect(types).toContain("payment_recovered");
    // a rate limit is recorded as a readable error on the source's health
    mock.failures.failNext("rate_limited");
    const limited = await harborOwner((s) => runSubscriptionSync(s, mock, { kind: "delta" }));
    expect(limited.error).toContain("rate_limited");
    const [health] = await pools.admin.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, harbor), eq(schema.integrationHealth.source, "shopify_subscriptions")));
    expect(health!.lastError).toContain("rate limit");
    // a signed webhook is stored once and imports the contract
    const raw = JSON.stringify({ id: "evt-1", contractId: c!.externalId, updatedAt: "2026-10-02" });
    const w1 = await harborOwner((s) => processSubscriptionWebhook(s, mock, { "x-mock-signature": mock.signWebhook(raw) }, raw));
    const w2 = await harborOwner((s) => processSubscriptionWebhook(s, mock, { "x-mock-signature": mock.signWebhook(raw) }, raw));
    expect([w1.status, w2.status]).toEqual(["processed", "duplicate"]);
  });

  it("shows the subscription card on the customer and on subscription orders", async () => {
    const [c] = await pools.admin.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.tenantId, harbor)).limit(1);
    const cards = await harborOwner((s) => customerSubscriptions(s, c!.customerId!));
    expect(cards.map((x) => x.id)).toContain(c!.id);
    const card = await harborOwner((s) => orderSubscription(s, c!.originOrderId!));
    expect(card).toMatchObject({ id: c!.id, isFirst: true, renewalNumber: 0 });
  });
});

describe("retention", () => {
  it("scores churn risk and serves the ready-made segments through the segment engine", async () => {
    const risks = await harborOwner((s) => refreshSubscriberRisk(s));
    expect(risks.size).toBeGreaterThan(0);
    const failing = await harborOwner((s) => previewSegment(s, readyMadeSubscriptionSegment("payment_failed")));
    const [n] = (await pools.admin.execute<{ n: number }>(sql`select count(distinct customer_id)::int as n from subscription_contracts where tenant_id = ${harbor} and status in ('active','paused') and payment_failing_since is not null`)).rows;
    expect(failing.count).toBe(n!.n);
    const paused = await harborOwner((s) => previewSegment(s, readyMadeSubscriptionSegment("paused_30")));
    expect(paused.count).toBeGreaterThanOrEqual(0);
    const high = await harborOwner((s) => listSubscribers(s, { risk: "high" }));
    expect(high.rows.every((r) => r.churnRisk === "high")).toBe(true);
  });

  it("analyses cancellation reasons by product, cohort and channel with a monthly trend", async () => {
    for (const dimension of ["product", "cohort", "channel"] as const) {
      const a = await harborOwner((s) => cancellationAnalysis(s, tenant, { dimension }));
      expect(a.total).toBe(a.byReason.reduce((t, r) => t + r.count, 0));
      expect(a.total).toBe(a.matrix.reduce((t, r) => t + r.total, 0));
      expect(a.voluntary + a.involuntary).toBe(a.total);
    }
  });
});

describe("gating with the add-on off (Northwind)", () => {
  it("pages, widgets, services and MCP tools are unavailable", async () => {
    const [nwAddons, hhAddons] = [DEMO_TENANTS.northwind.addons as readonly string[], DEMO_TENANTS.harbor.addons as readonly string[]];
    expect(isPageEnabled("subscriptions", nwAddons)).toBe(false);
    expect(isPageEnabled("subscriptions", hhAddons)).toBe(true);
    for (const w of Object.keys(SUBSCRIPTION_WIDGET_LOADERS)) expect(isWidgetAvailable(w as "subs_mrr", nwAddons)).toBe(false);
    for (const t of SUBSCRIPTION_MCP_TOOLS) {
      expect(toolDenial(t, { role: "owner", activeAddons: nwAddons, scopes: ["read"] })).toBe("module");
      expect(toolDenial(t, { role: "owner", activeAddons: hhAddons, scopes: ["read"] })).toBeNull();
    }
    const [order] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.tenantId, northwind)).limit(1);
    await expect(as(northwind, "owner@northwind.demo")((s) => subscriptionAction(s, { contractId: order!.id, action: "pause", requestKey: "x" }))).rejects.toMatchObject({ code: "disabled" });
    expect(await as(northwind, "owner@northwind.demo")((s) => orderSubscription(s, order!.id))).toBeNull();
    expect(await as(northwind, "owner@northwind.demo")((s) => getSubscriptionProviderFor(s))).toBeNull();
  });
});

/*
 * Hand-calculated fixture, as of 31 October 2026 (the same as the core test):
 *  A active since Jan (3000) · B since Mar, 2000 → 2500 on Oct 10 · C since Feb (4000), cancelled Oct 5 (voluntary)
 *  D since Apr (1500), paused Oct 12 · E new Oct 20 (3500) · F ended Jun (involuntary), back Oct 15 (1000)
 *  G since May (2200), cancelled Oct 25 after failed payments (involuntary)
 * October: start 12700, new 3500, expansion 500, reactivated 1000, contraction 1500, churned 6200, end 10000.
 */
describe("hand calculation on a fixture (Harbor)", () => {
  const asOf = new Date("2026-10-31T12:00:00Z");
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  beforeAll(async () => {
    await pools.admin.delete(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.tenantId, harbor));
    const customer = async (k: string) => (await pools.admin.insert(schema.customers).values({ tenantId: harbor, externalId: `fx-${k}`, email: `fx-${k}@example.com`, emailNormalized: `fx-${k}@example.com`, firstName: "Fixture", lastName: k }).returning({ id: schema.customers.id }))[0]!.id;
    const ids: Record<string, string> = {};
    for (const k of ["A", "B", "C", "D", "E", "F", "G"]) ids[k] = await customer(k);
    const contract = async (k: string, cust: string, o: { activated: string; mrr: number; status?: string; ended?: string; kind?: string; paused?: string }) => (await pools.admin.insert(schema.subscriptionContracts).values({ tenantId: harbor, provider: "shopify_subscriptions", externalId: `fx-${k}`, customerId: ids[cust]!, status: o.status ?? "active", currency: "USD", priceMinor: o.mrr, mrrMinor: o.mrr, intervalUnit: "month", intervalCount: 1, activatedAt: d(o.activated), endedAt: o.ended ? d(o.ended) : null, cancellationKind: o.kind ?? null, pausedAt: o.paused ? d(o.paused) : null, nextBillingAt: o.ended ? null : d("2026-11-10") }).returning({ id: schema.subscriptionContracts.id }))[0]!.id;
    await contract("A", "A", { activated: "2026-01-10", mrr: 3000 });
    const b = await contract("B", "B", { activated: "2026-03-03", mrr: 2500 });
    await pools.admin.insert(schema.subscriptionEvents).values({ tenantId: harbor, contractId: b, type: "swapped", authorType: "staff", diff: { mrrMinor: { from: 2000, to: 2500 } }, occurredAt: d("2026-10-10") });
    await contract("C", "C", { activated: "2026-02-01", mrr: 4000, status: "cancelled", ended: "2026-10-05", kind: "voluntary" });
    const dd = await contract("D", "D", { activated: "2026-04-15", mrr: 1500, status: "paused", paused: "2026-10-12" });
    await pools.admin.insert(schema.subscriptionEvents).values({ tenantId: harbor, contractId: dd, type: "paused", authorType: "customer", diff: { status: { from: "active", to: "paused" } }, occurredAt: d("2026-10-12") });
    await contract("E", "E", { activated: "2026-10-20", mrr: 3500 });
    await contract("F1", "F", { activated: "2026-01-05", mrr: 1000, status: "cancelled", ended: "2026-06-05", kind: "involuntary" });
    await contract("F2", "F", { activated: "2026-10-15", mrr: 1000 });
    await contract("G", "G", { activated: "2026-05-02", mrr: 2200, status: "cancelled", ended: "2026-10-25", kind: "involuntary" });
  });

  it("MRR, churn split and the cohort table match the hand calculation", async () => {
    const o = await harborOwner((s) => subscriptionsOverview(s, tenant, { period: { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") }, months: 12, asOf }));
    const oct = o.movement.at(-1)!;
    expect(oct).toMatchObject({ startMrrMinor: 12700, newMinor: 3500, expansionMinor: 500, contractionMinor: 1500, churnedMinor: 6200, reactivatedMinor: 1000, endMrrMinor: 10000 });
    expect(o.mrrMinor).toBe(10000);
    expect(o.counts).toMatchObject({ liveAtStart: 5, active: 4, paused: 1, new: 2, cancelled: 2, voluntary: 1, involuntary: 1 });
    expect(o.counts.churnRate).toBeCloseTo(0.4);
    // September: nothing moved but F's churn in June is long gone; start = end = 12700
    expect(o.movement.at(-2)).toMatchObject({ startMrrMinor: 12700, endMrrMinor: 12700, churnedMinor: 0 });
    const byCohort = new Map(o.cohorts.map((c) => [c.cohort, c]));
    expect([...byCohort.keys()]).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-10"]);
    // January: A and F1; F1 ended Jun 5, exactly 5 months after its activation
    expect(byCohort.get("2026-01")).toMatchObject({ size: 2, retention: [1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, null, null] });
    expect(byCohort.get("2026-02")!.retention).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, null, null, null]);
    expect(byCohort.get("2026-05")!.retention).toEqual([1, 1, 1, 1, 1, 1, null, null, null, null, null, null]);
    expect(byCohort.get("2026-10")).toMatchObject({ size: 2, retention: [1, null, null, null, null, null, null, null, null, null, null, null] });
  });

  it("profit per subscriber uses the real product cost and is lower than revenue by cost, shipping and fees", async () => {
    const [a] = await pools.admin.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, harbor), eq(schema.subscriptionContracts.externalId, "fx-A")));
    const [variant] = await pools.admin.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, harbor)).limit(1);
    const [max] = (await pools.admin.execute<{ n: number }>(sql`select max(order_number)::int as n from orders where tenant_id = ${harbor}`)).rows;
    for (const [i, at] of ["2026-09-10", "2026-10-10"].entries()) {
      const n = max!.n + 1 + i;
      const [o] = await pools.admin.insert(schema.orders).values({ tenantId: harbor, externalId: `fx-order-${n}`, orderNumber: n, name: `#HH-${n}`, customerId: a!.customerId, status: "delivered", paymentMethod: "card", paymentStatus: "paid", currency: "USD", subtotalMinor: 3000, totalMinor: 3000, placedAt: d(at), subscriptionContractId: a!.id, isFirstSubscriptionOrder: i === 0, renewalNumber: i }).returning({ id: schema.orders.id });
      await pools.admin.insert(schema.orderLines).values({ tenantId: harbor, orderId: o!.id, variantId: variant!.id, title: "Refill", quantity: 1, currentQuantity: 1, unitPriceMinor: 3000, totalMinor: 3000, unitCostMinor: 900 });
    }
    const report = await harborOwner((s) => subscriptionProfitReport(s, tenant, { asOf }));
    const row = report.subscribers.find((r) => r.contractId === a!.id)!;
    const fee = Math.round((3000 * (tenant.settings.paymentFeeBps.card ?? 0)) / 10_000) + (tenant.settings.paymentFeeFixedMinor.card ?? 0);
    const ships = await pools.admin.select().from(schema.costSettings).where(and(eq(schema.costSettings.tenantId, harbor), eq(schema.costSettings.kind, "shipping_per_order")));
    const shipOn = (day: string) => ships.find((r) => r.validFrom <= day && (!r.validTo || r.validTo >= day))?.amountMinor ?? tenant.settings.shippingCostMinor;
    const shipping = shipOn("2026-09-10") + shipOn("2026-10-10");
    expect(row.orders).toBe(2);
    expect(row.netRevenueMinor).toBe(6000);
    expect(row.costsMinor).toBe(2 * 900 + shipping + 2 * fee);
    expect(row.profitMinor).toBe(6000 - 1800 - shipping - 2 * fee);
    expect(row.profitMinor).toBeLessThan(row.netRevenueMinor);
    expect(report.byRenewal.map((b) => b.renewalNumber)).toEqual([0, 1]);
  });
});

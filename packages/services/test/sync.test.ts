import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockAdsPlatform, MockCommercePlatform } from "@hullwise/integrations";
import { importOrder, processWebhookEvent, recordWebhookEvent, retryFailedWebhooks, runAdsSync, runCatalogSync, runOrdersSync, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let platform: MockCommercePlatform;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
  const { variants, locations, customers } = await withTenant(tenantId, async (tx) => {
    const variants = await tx.select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, optionValues: schema.productVariants.optionValues, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, tenantId)).limit(60);
    const locations = await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, tenantId));
    const customers = await tx.select().from(schema.customers).where(eq(schema.customers.tenantId, tenantId)).limit(40);
    return { variants, locations, customers };
  }, pools.app);
  platform = new MockCommercePlatform({
    currency: "EUR",
    country: "IT",
    orderNumberPrefix: "NW",
    startOrderNumber: 500000,
    seed: 11,
    variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor })),
    locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })),
    customers: customers.map((c) => ({ externalId: c.externalId ?? c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt })),
  });
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "integration", userId: null } }), pools.app);
const opts = { country: "IT" };

describe("order import", () => {
  it("creates an order with lines, customer, attribution and shipment; re-import is idempotent; platform changes produce a diff event", async () => {
    const o = platform.generateOrder(new Date());
    o.landingSite = "/products/x?utm_source=facebook&utm_medium=paid&utm_campaign=summer&fbclid=F1";
    o.fulfillments = [{ externalId: `f-${o.externalId}`, status: "in_transit", externalStatus: "in_transit", trackingNumber: "TRK1", trackingUrl: null, carrier: "BRT", createdAt: new Date(), updatedAt: new Date(), deliveredAt: null }];
    const first = await run((s) => importOrder(s, o, { ...opts, source: "sync" }));
    expect(first.outcome).toBe("created");
    const again = await run((s) => importOrder(s, o, { ...opts, source: "sync" }));
    expect(again).toEqual({ id: first.id, outcome: "unchanged" });
    const detail = await withTenant(tenantId, async (tx) => {
      const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, first.id));
      const lines = await tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, first.id));
      const [attr] = await tx.select().from(schema.orderAttribution).where(eq(schema.orderAttribution.orderId, first.id));
      const shipments = await tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, first.id));
      const states = await tx.select().from(schema.shipmentSourceStates).where(eq(schema.shipmentSourceStates.shipmentId, shipments[0]!.id));
      const events = await tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, first.id)).orderBy(schema.orderEvents.createdAt);
      return { order: order!, lines, attr: attr!, shipments, states, events };
    }, pools.app);
    expect(detail.order.customerId).toBeTruthy();
    expect(detail.lines).toHaveLength(o.lines.length);
    expect(detail.lines.every((l) => l.variantId)).toBe(true);
    expect(detail.attr.channel).toBe("paid_social");
    expect(detail.attr.clickIds).toMatchObject({ fbclid: "F1" });
    expect(detail.shipments[0]).toMatchObject({ status: "in_transit", sourceOfTruth: "shopify", trackingNumber: "TRK1" });
    expect(detail.states).toHaveLength(1);
    expect(detail.events.filter((e) => e.type === "imported")).toHaveLength(1);
    expect(detail.events.filter((e) => e.type === "platform_update")).toHaveLength(0);
    expect(["new", "pending_review", "confirmed", "fulfilling", "shipped"]).toContain(detail.order.status);

    await platform.cancelOrder(o.externalId, { restock: true, refund: true });
    const changed = (await platform.fetchOrder(o.externalId))!;
    const third = await run((s) => importOrder(s, changed, { ...opts, source: "webhook" }));
    expect(third.outcome).toBe("updated");
    const after = await withTenant(tenantId, async (tx) => ({ order: (await tx.select().from(schema.orders).where(eq(schema.orders.id, first.id)))[0]!, events: await tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, first.id), eq(schema.orderEvents.type, "platform_update"))) }), pools.app);
    expect(after.order.status).toBe("cancelled");
    expect(after.events).toHaveLength(1);
    expect((after.events[0]!.diff as Record<string, unknown>).cancelledAt).toBeTruthy();
  });
});

describe("webhooks", () => {
  it("dedups by (source, topic, external id, updated_at), processes idempotently and retries failures", async () => {
    const o = platform.generateOrder(new Date());
    const env = platform.buildWebhook("orders/create", o);
    const verified = await platform.verifyWebhook(env.headers, env.rawBody);
    const a = await run((s) => recordWebhookEvent(s, { source: "shopify", ...verified }));
    const b = await run((s) => recordWebhookEvent(s, { source: "shopify", ...verified }));
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    const res = await run((s) => processWebhookEvent(s, platform, a.id!, opts));
    expect(res.status).toBe("processed");
    const again = await run((s) => processWebhookEvent(s, platform, a.id!, opts));
    expect(again.status).toBe("skipped");
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.externalId, o.externalId))), pools.app);
    expect(order).toBeTruthy();

    // a fulfillment webhook referencing an order id that needs a fetch
    const o2 = platform.generateOrder(new Date());
    const ev2 = await run((s) => recordWebhookEvent(s, { source: "shopify", topic: "fulfillments/create", externalId: "fulf-1", sourceUpdatedAt: new Date().toISOString(), payload: { id: "fulf-1", order_id: o2.externalId } }));
    platform.failures.failNext("rate_limited");
    const failed = await run((s) => processWebhookEvent(s, platform, ev2.id!, opts));
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("rate_limited");
    const [health] = await withTenant(tenantId, (tx) => tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "shopify:webhooks"))), pools.app);
    expect(health!.consecutiveFailures).toBe(1);
    const retry = await run((s) => retryFailedWebhooks(s, platform, opts));
    expect(retry.processed).toBeGreaterThanOrEqual(1);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, ev2.id!)), pools.app);
    expect(row!.status).toBe("processed");
    expect(row!.attempts).toBe(2);
  });
});

describe("sync runs", () => {
  it("delta sync writes rows, records the run and health, and a failure is visible then recovers", async () => {
    const ok = await run((s) => runOrdersSync(s, platform, { kind: "delta", country: "IT", pageSize: 3 }));
    expect(ok.error).toBeNull();
    expect(ok.finished).toBe(true);
    expect(ok.rowsWritten).toBeGreaterThan(0);
    const [runRow] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, ok.runId)), pools.app);
    expect(runRow!.status).toBe("success");
    expect((runRow!.cursor as { highWaterMark: string }).highWaterMark).toBeTruthy();
    expect((runRow!.cursor as { pages: number }).pages).toBeGreaterThan(1);

    platform.failures.failNext("token_expired");
    const bad = await run((s) => runOrdersSync(s, platform, { kind: "delta", country: "IT" }));
    expect(bad.error).toContain("token_expired");
    const [h1] = await withTenant(tenantId, (tx) => tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "shopify"))), pools.app);
    expect(h1!.status).toBe("degraded");
    expect(h1!.lastError).toContain("token_expired");
    const good = await run((s) => runOrdersSync(s, platform, { kind: "delta", country: "IT" }));
    expect(good.error).toBeNull();
    const [h2] = await withTenant(tenantId, (tx) => tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "shopify"))), pools.app);
    expect(h2!.status).toBe("ok");
    expect(h2!.consecutiveFailures).toBe(0);
  });

  it("pauses at the time budget and resumes from the saved cursor", async () => {
    for (let i = 0; i < 12; i++) platform.generateOrder(new Date());
    const paused = await run((s) => runOrdersSync(s, platform, { kind: "initial", country: "IT", pageSize: 2, budgetMs: 0 }));
    expect(paused.finished).toBe(false);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, paused.runId)), pools.app);
    expect(row!.status).toBe("paused");
    expect((row!.cursor as { nextCursor: string }).nextCursor).toBe("1");
    const resumed = await run((s) => runOrdersSync(s, platform, { kind: "initial", country: "IT", pageSize: 2, budgetMs: 60_000 }));
    expect(resumed.runId).toBe(paused.runId);
    expect(resumed.finished).toBe(true);
  });

  it("catalog sync upserts products, inventory and discounts; ads sync upserts campaigns and metrics idempotently", async () => {
    const cat = await run((s) => runCatalogSync(s, platform));
    expect(cat.error).toBeNull();
    expect(cat.products).toBeGreaterThan(0);
    const campaigns = await withTenant(tenantId, (tx) => tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, tenantId), eq(schema.campaigns.platform, "meta"))).limit(5), pools.app);
    const ads = new MockAdsPlatform({ provider: "meta", currency: "EUR", campaigns: campaigns.map((c) => ({ externalId: c.externalId, accountExternalId: "act_demo", name: c.name, status: "active", objective: c.objective, dailyBudgetMinor: c.dailyBudgetMinor, currency: c.currency, platformCreatedAt: c.platformCreatedAt })) });
    const window = { since: "2026-09-01", until: "2026-09-03" };
    const r1 = await run((s) => runAdsSync(s, ads, window));
    expect(r1.error).toBeNull();
    expect(r1.metrics).toBe(campaigns.length * 3);
    const r2 = await run((s) => runAdsSync(s, ads, window));
    expect(r2.metrics).toBe(r1.metrics);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.campaignId, campaigns[0]!.id), eq(schema.adMetricsDaily.date, "2026-09-02"))), pools.app);
    expect(rows).toHaveLength(1);
    const [lastRun] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, tenantId), eq(schema.syncRuns.provider, "meta"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1), pools.app);
    expect(lastRun!.status).toBe("success");
  });
});

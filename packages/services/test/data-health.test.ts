import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, inArray, isNull, lt, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { SALE_STATUSES, lastClosedMonth, parseTenantSettings, type DataHealthReport } from "@hullwise/core";
import type { TenantRole } from "@hullwise/config";
import { createTenant, dataHealthReport, loadWidgetData, type AnalyticsTenant, type ServiceContext } from "../src";

/**
 * Data completeness (#99) against the database: the seeded demo tenants, then gaps opened one by one
 * (costs cleared, links removed, rates deleted, integrations broken) and a store created empty.
 */
const pools = testPools();
let seed: SeedContext;
let A = "";
let B = "";
let nw: AnalyticsTenant;
let hb: AnalyticsTenant;
const now = new Date();
const since = new Date(now.getTime() - 90 * 864e5);

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.05 });
  A = seed.tenantIds.northwind;
  B = seed.tenantIds.harbor;
  const settingsOf = async (id: string) => parseTenantSettings((await pools.admin.select({ s: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, id)))[0]!.s);
  nw = { id: A, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: await settingsOf(A) };
  hb = { id: B, country: "US", currency: "USD", timezone: "America/New_York", settings: await settingsOf(B) };
});
afterAll(() => pools.close());

const run = <T>(tenantId: string, fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const report = (t: AnalyticsTenant) => run(t.id, (s) => dataHealthReport(s, t, now));
const item = (r: DataHealthReport, id: string) => r.items.find((i) => i.id === id);
const saleWindow = (tenantId: string) => and(eq(schema.orders.tenantId, tenantId), gte(schema.orders.placedAt, since), lt(schema.orders.placedAt, now), isNull(schema.orders.replacedByOrderId), inArray(schema.orders.status, [...SALE_STATUSES]));

describe("data completeness on the demo tenants", () => {
  it("Northwind shows a realistic mix and Harbor fewer gaps; nothing is about the payment method itself", async () => {
    const [a, b] = [await report(nw), await report(hb)];
    expect(a.items.length).toBeGreaterThanOrEqual(b.items.length);
    // the September carrier invoice is not in yet on Northwind (seed): its costs are still an estimate
    expect(item(a, "cost_actuals")).toMatchObject({ severity: "info", params: { month: lastClosedMonth(now), shipping: 1 } });
    expect(item(b, "cost_actuals")).toBeUndefined();
    // Harbor has rates for every country it ships to
    expect(item(b, "tax_rates")).toBeUndefined();
    for (const r of [a, b]) {
      expect(item(r, "commerce_connection")).toBeUndefined();
      expect(r.summary.score).toBeLessThan(100);
      expect(r.items.every((i) => i.fix.path.length > 0)).toBe(true);
    }
  });

  it("product costs: a sold line without a cost is counted once per variant and order", async () => {
    // give every line of the window a cost, then clear one order's
    await pools.admin.execute(sql`update order_lines l set unit_cost_minor = 100 from orders o where o.id = l.order_id and l.tenant_id = ${A} and l.unit_cost_minor is null`);
    expect(item(await report(nw), "product_costs")).toBeUndefined();
    const [order] = await pools.admin.select({ id: schema.orders.id }).from(schema.orders).where(saleWindow(A)).limit(1);
    const lines = await pools.admin.select({ variantId: schema.orderLines.variantId }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, order!.id), eq(schema.orderLines.isAncillary, false), sql`${schema.orderLines.currentQuantity} > 0`));
    await pools.admin.update(schema.orderLines).set({ unitCostMinor: null }).where(and(eq(schema.orderLines.orderId, order!.id), eq(schema.orderLines.isAncillary, false)));
    const gap = item(await report(nw), "product_costs")!;
    expect(gap).toMatchObject({ count: new Set(lines.map((l) => l.variantId)).size, affectedOrders: 1, fix: { page: "products", path: "products/quality", query: { issue: "missing_cost" } } });
    expect(gap.affectedRevenueMinor).toBeGreaterThan(0);
  });

  it("campaign links: spend of the last 30 days without a product, per tenant", async () => {
    const before = item(await report(hb), "campaign_links");
    await pools.admin.delete(schema.campaignProductLinks).where(eq(schema.campaignProductLinks.tenantId, A));
    const [{ n }] = (await pools.admin.execute(sql`select count(*)::int as n from (select campaign_id from ad_metrics_daily where tenant_id = ${A} and date >= ${new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10)} group by campaign_id having sum(spend_minor) > 0) x`)).rows as [{ n: number }];
    const gap = item(await report(nw), "campaign_links")!;
    expect(gap).toMatchObject({ count: n, sample: n, share: 1, severity: "warning", fix: { path: "campaigns", query: { links: "none", preset: "30d" } } });
    // the other tenant's figure does not move
    expect(item(await report(hb), "campaign_links")).toEqual(before);
  });

  it("tax rates: a destination without a rate is a warning, the home country a critical gap", async () => {
    await pools.admin.delete(schema.tenantTaxRates).where(and(eq(schema.tenantTaxRates.tenantId, A), eq(schema.tenantTaxRates.country, "IT")));
    const gap = item(await report(nw), "tax_rates")!;
    expect(gap.severity).toBe("critical");
    expect(gap.params.countries).toContain("IT");
    expect(gap.fix.query).toEqual({ tab: "taxes" });
  });

  it("shipping: without per-order costs, invoices or a default of the shop, every order uses the generic figure", async () => {
    await pools.admin.delete(schema.costSettings).where(and(eq(schema.costSettings.tenantId, A), eq(schema.costSettings.kind, "shipping_per_order")));
    await pools.admin.delete(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, A), eq(schema.periodCosts.kind, "shipping")));
    const [{ n }] = (await pools.admin.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(saleWindow(A))) as [{ n: number }];
    expect(item(await report(nw), "shipping_costs")).toMatchObject({ count: n, affectedOrders: n, share: 1, severity: "critical" });
    // the shop saves its own default: no longer Hullwise's
    await pools.admin.update(schema.tenants).set({ settings: sql`${schema.tenants.settings} || '{"shippingCostMinor": 700}'::jsonb` }).where(eq(schema.tenants.id, A));
    expect(item(await report(nw), "shipping_costs")).toBeUndefined();
  });

  it("fixed costs: the last closed month without any fixed cost", async () => {
    const closed = lastClosedMonth(now);
    await pools.admin.delete(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, A), eq(schema.periodCosts.period, closed)));
    await pools.admin.delete(schema.costSettings).where(and(eq(schema.costSettings.tenantId, A), eq(schema.costSettings.kind, "fixed_monthly")));
    expect(item(await report(nw), "fixed_costs")).toMatchObject({ severity: "warning", params: { month: closed }, fix: { path: "analytics/costs" } });
  });

  it("payment fees: methods still on the estimate with no fee configured", async () => {
    const free = { ...nw, settings: parseTenantSettings({ paymentFeeBps: { card: 0, wallet: 0, bank_transfer: 0, cod: 0, bnpl: 0, other: 0 }, paymentFeeFixedMinor: { card: 0, wallet: 0, bank_transfer: 0, cod: 0, bnpl: 0, other: 0 } }) };
    const [{ n }] = (await pools.admin.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(saleWindow(A), sql`not exists (select 1 from balance_transactions b where b.order_id = "orders"."id" and b.type = 'charge')`))) as [{ n: number }];
    const gap = item(await run(A, (s) => dataHealthReport(s, free, now)), "payment_fees")!;
    expect(gap.affectedOrders).toBe(n);
    expect(gap.severity).toBe("info");
  });

  it("integrations: the store connection is critical, another provider in error a warning", async () => {
    await pools.admin.update(schema.integrations).set({ status: "error" }).where(and(eq(schema.integrations.tenantId, A), inArray(schema.integrations.provider, ["shopify", "meta"])));
    const r = await report(nw);
    expect(r.items[0]).toMatchObject({ id: "commerce_connection", severity: "critical" });
    expect(item(r, "integration_errors")!.params.providers).toEqual(["meta"]);
    expect(r.summary.status).toBe("critical");
  });

  it("the widget shows each role only what it can fix, and nothing to a viewer", async () => {
    const env = (role: TenantRole) => ({ tenant: nw, role, activeAddons: [], userId: null, customs: [], now });
    const widget = (role: TenantRole) => run(A, (s) => loadWidgetData(s, env(role), { type: "setup_health", settings: {} }, { from: since, to: now }));
    const owner = await widget("owner");
    const ops = await widget("operations");
    const mk = await widget("marketing");
    expect(owner.ok && ops.ok && mk.ok).toBe(true);
    const ids = (r: typeof owner) => (r.ok ? (r.data as DataHealthReport).items.map((i) => i.fix.page) : []);
    expect(new Set(ids(owner))).toEqual(new Set(["integrations", "products", "settings", "campaigns", ...(ids(owner).includes("purchasing") ? ["purchasing"] : [])]));
    expect(ids(ops).every((p) => p === "products" || p === "purchasing")).toBe(true);
    expect(ids(mk)).toEqual(["campaigns"]);
    expect(await widget("viewer")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("a store created empty: only the store connection is missing, purchasing and fixed costs do not apply yet", async () => {
    const created = await createTenant(pools.admin, { name: "Empty Store", slug: "empty-store-health", country: "FR", currency: "EUR", timezone: "Europe/Paris", defaultLocale: "en", orderNumberPrefix: "ES-", planKey: "starter", taxRateBps: 2000, ownerEmail: "owner@empty-health.test", ownerName: "Empty Owner" }, seed.userIds["superadmin@hullwise.demo"]!);
    const t: AnalyticsTenant = { id: created.tenantId, country: "FR", currency: "EUR", timezone: "Europe/Paris", settings: parseTenantSettings({}) };
    const r = await report(t);
    expect(r.items.map((i) => i.id)).toEqual(["commerce_connection"]);
    expect(r.skipped).toEqual(expect.arrayContaining(["fixed_costs", "suppliers"]));
    expect(r.summary).toMatchObject({ score: 70, status: "critical", critical: 1 });
  });
});

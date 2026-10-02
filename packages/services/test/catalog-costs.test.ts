import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings } from "@hullwise/core";
import { MockCommercePlatform, type NormalizedOrder } from "@hullwise/integrations";
import { applyCostImport, catalogQualityReport, createTenant, importOrder, pnlForPeriod, previewCostImport, runCatalogSync, setVariantCosts, type AnalyticsTenant, type ServiceContext } from "../src";

/**
 * A store that starts empty: the catalog comes from the (mock) Shopify adapter with unit costs,
 * no purchase order ever arrives, and the P/L of one month is checked by hand on three orders.
 */
const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
let platform: MockCommercePlatform;
const from = new Date("2026-03-01T00:00:00Z");
const to = new Date("2026-04-01T00:00:00Z");
const period = { from, to };

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.01 });
  const created = await createTenant(pools.admin, { name: "Fresh Store", slug: "fresh-store-costs", country: "IT", currency: "EUR", timezone: "Europe/Rome", defaultLocale: "en", orderNumberPrefix: "FS-", planKey: "starter", taxRateBps: 2200, ownerEmail: "owner@fresh.test", ownerName: "Fresh Owner" }, seed.userIds["superadmin@hullwise.demo"]!);
  tenantId = created.tenantId;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({ shippingCostMinor: 500, paymentFeeBps: { card: 180, wallet: 250, bank_transfer: 0, cod: 0, bnpl: 0, other: 0 }, paymentFeeFixedMinor: { card: 25, wallet: 25, bank_transfer: 0, cod: 0, bnpl: 0, other: 0 } }) };
  platform = new MockCommercePlatform({
    currency: "EUR",
    country: "IT",
    orderNumberPrefix: "FS-",
    startOrderNumber: 1,
    locations: [{ externalId: "loc-1", name: "Main", country: "IT", isDefault: true, isActive: true }],
    customers: [],
    variants: [
      { externalId: "v1", productExternalId: "p1", inventoryItemExternalId: "i1", sku: "FS-1", title: "M", productTitle: "Jacket", optionValues: { Size: "M" }, priceMinor: 5000, unitCostMinor: 2000, barcode: "800001", productImageUrl: "https://cdn.example/jacket.jpg" },
      { externalId: "v2", productExternalId: "p2", inventoryItemExternalId: "i2", sku: "FS-2", title: "L", productTitle: "Shirt", optionValues: { Size: "L" }, priceMinor: 9900, unitCostMinor: 3000, barcode: "800002", productImageUrl: "https://cdn.example/shirt.jpg" },
      { externalId: "v3", productExternalId: "p3", inventoryItemExternalId: "i3", sku: "FS-3", title: "One size", productTitle: "Bag", optionValues: {}, priceMinor: 10000, unitCostMinor: null, barcode: null, productImageUrl: null },
    ],
  });
});
afterAll(() => pools.close());

const run = <T>(fn: (s: ServiceContext) => Promise<T>, userId: string | null = null) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: userId ? "user" : "integration", userId } }), pools.app);
const variant = (sku: string) => run(async (s) => (await s.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, tenantId), eq(schema.productVariants.sku, sku))))[0]!);
const lineCost = (sku: string) => run(async (s) => (await s.tx.select({ c: schema.orderLines.unitCostMinor }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, tenantId), eq(schema.orderLines.sku, sku))))[0]!.c);

function order(n: number, day: number, over: Partial<NormalizedOrder>): NormalizedOrder {
  const placedAt = new Date(`2026-03-${String(day).padStart(2, "0")}T10:00:00Z`);
  return {
    externalId: `fs-${n}`, orderNumber: n, name: `#FS-${n}`, customer: null, email: null, phone: null, customerName: null, currency: "EUR",
    subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 0, refundedMinor: 0,
    paymentGateways: ["shopify_payments"], paymentMethod: "card", paymentStatus: "paid", financialStatusRaw: "paid", fulfillmentStatusRaw: "fulfilled",
    tags: [], shippingAddress: { country: "IT" }, billingAddress: null, note: null, noteAttributes: [], landingSite: null, referringSite: null, sourceChannel: "web",
    placedAt, cancelledAt: null, cancelReason: null, closedAt: null, platformUpdatedAt: placedAt, lines: [], discounts: [],
    fulfillments: [{ externalId: `f-${n}`, status: "delivered", externalStatus: "delivered", trackingNumber: `T${n}`, trackingUrl: null, carrier: "Carrier", createdAt: placedAt, updatedAt: placedAt, deliveredAt: placedAt }],
    ...over,
  };
}
const line = (n: number, variantExternalId: string, sku: string, quantity: number, unitPriceMinor: number) => ({ externalId: `fs-${n}-l`, variantExternalId, productExternalId: null, sku, title: sku, variantTitle: null, quantity, currentQuantity: quantity, unitPriceMinor, discountMinor: 0, totalMinor: quantity * unitPriceMinor });

describe("product cost on a tenant synced from the platform", () => {
  it("fills costs from the platform unit cost, and the P/L of a month matches a hand calculation on three orders", async () => {
    const sync = await run((s) => runCatalogSync(s, platform));
    expect(sync.error).toBeNull();
    expect(await variant("FS-1")).toMatchObject({ costMinor: 2000, costSource: "platform" });
    expect(await variant("FS-2")).toMatchObject({ costMinor: 3000, costSource: "platform" });
    expect(await variant("FS-3")).toMatchObject({ costMinor: null, costSource: null });
    expect((await variant("FS-1")).costUpdatedAt).toBeInstanceOf(Date);

    const opts = { country: "IT", source: "sync" as const };
    await run(async (s) => {
      await importOrder(s, order(1, 5, { totalMinor: 12200, taxMinor: 2200, subtotalMinor: 10000, lines: [line(1, "v1", "FS-1", 2, 5000)] }), opts);
      await importOrder(s, order(2, 6, { totalMinor: 9900, taxMinor: 1785, subtotalMinor: 9900, refundedMinor: 9900, paymentStatus: "refunded", financialStatusRaw: "refunded", fulfillmentStatusRaw: null, fulfillments: [], cancelledAt: new Date("2026-03-06T12:00:00Z"), cancelReason: "customer", lines: [line(2, "v2", "FS-2", 1, 9900)] }), opts);
      await importOrder(s, order(3, 7, { paymentMethod: "wallet", paymentGateways: ["paypal"], totalMinor: 10700, taxMinor: 700, subtotalMinor: 10000, lines: [line(3, "v3", "FS-3", 1, 10000)] }), opts);
    });
    const statuses = await run(async (s) => (await s.tx.select({ name: schema.orders.name, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.tenantId, tenantId)).orderBy(schema.orders.orderNumber)).map((o) => o.status));
    expect(statuses).toEqual(["delivered", "cancelled", "delivered"]);
    // line costs are the snapshot at import: 20.00 for FS-1, none for FS-3
    expect(await lineCost("FS-1")).toBe(2000);
    expect(await lineCost("FS-3")).toBeNull();

    const pnl = await run((s) => pnlForPeriod(s, tenant, period));
    // A: net 122.00 − 22.00 = 100.00; cogs 2 × 20.00 = 40.00; shipping 5.00; card fee 1.8% × 122.00 + 0.25 = 2.45 → margin 52.55
    // B: cancelled, out of scope
    // C: net 107.00 − 7.00 = 100.00; cogs unknown (0); shipping 5.00; wallet fee 2.5% × 107.00 + 0.25 = 2.93 → margin 92.07
    expect(pnl.orders).toBe(2);
    expect(pnl.cancelledOrders).toBe(1);
    expect(pnl.netRevenueMinor).toBe(20000);
    expect(pnl.cogsMinor).toBe(4000);
    expect(pnl.cogsIncompleteOrders).toBe(1);
    expect(pnl.cogsIncompleteRevenueMinor).toBe(10000);
    expect(pnl.shippingCostMinor).toBe(1000);
    expect(pnl.paymentFeeMinor).toBe(245 + 293);
    expect(pnl.contributionMinor).toBe(5255 + 9207);
    expect(pnl.operatingProfitMinor).toBe(5255 + 9207);
    expect(pnl.costCoverage.byKey).toMatchObject({ platform: 10000, missing: 10000 });
    expect(pnl.costCoverage.coveredShare).toBe(0.5);
  });

  it("a manual edit writes an audit diff, fills the lines sold without a cost and the next P/L reflects it", async () => {
    const owner = seed.userIds["superadmin@hullwise.demo"]!;
    const v3 = await variant("FS-3");
    const res = await run((s) => setVariantCosts(s, [{ variantId: v3.id, costMinor: 4000 }], { source: "manual" }), owner);
    expect(res.changed).toHaveLength(1);
    expect(res.linesUpdated).toBe(1);
    expect(await variant("FS-3")).toMatchObject({ costMinor: 4000, costSource: "manual" });
    const [audit] = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "variant.cost_updated"))).orderBy(desc(schema.auditLogs.createdAt)).limit(1));
    expect(audit).toMatchObject({ entityType: "variant", entityId: v3.id, actorUserId: owner, actorType: "user", diff: { costMinor: { from: null, to: 4000 }, costSource: { from: null, to: "manual" } } });
    const pnl = await run((s) => pnlForPeriod(s, tenant, period));
    expect(pnl.cogsMinor).toBe(4000 + 4000);
    expect(pnl.cogsIncompleteOrders).toBe(0);
    expect(pnl.contributionMinor).toBe(5255 + 9207 - 4000);
    expect(pnl.costCoverage.byKey).toMatchObject({ platform: 10000, manual: 10000, missing: 0 });
    // the same cost again is a no-op: no line, no audit
    expect((await run((s) => setVariantCosts(s, [{ variantId: v3.id, costMinor: 4000 }], { source: "manual" }))).changed).toHaveLength(0);
    await expect(run((s) => setVariantCosts(s, [{ variantId: v3.id, costMinor: -1 }], { source: "manual" }))).rejects.toThrow("invalid_cost");
  });

  it("a later sync never overwrites a purchase-order or manual cost, but follows a cost that came from the platform", async () => {
    const v1 = await variant("FS-1");
    await run((s) => s.tx.update(schema.productVariants).set({ costMinor: 2100, costSource: "po_receipt" }).where(eq(schema.productVariants.id, v1.id)));
    await platform.updateVariantCost({ variantExternalId: "v2", inventoryItemExternalId: "i2" }, 3200);
    await platform.updateVariantCost({ variantExternalId: "v3", inventoryItemExternalId: "i3" }, 999);
    await run((s) => runCatalogSync(s, platform));
    expect(await variant("FS-1")).toMatchObject({ costMinor: 2100, costSource: "po_receipt" });
    expect(await variant("FS-2")).toMatchObject({ costMinor: 3200, costSource: "platform" });
    expect(await variant("FS-3")).toMatchObject({ costMinor: 4000, costSource: "manual" });
    // a platform cost change is not a restatement: the line sold at 30.00 keeps it
    expect(await lineCost("FS-2")).toBe(3000);
  });

  it("the CSV import previews unmatched and invalid rows without writing, then writes the matched ones with one audit entry", async () => {
    const csv = "SKU;Cost\nfs-1;25,00\nNOPE-9;3\nFS-2;abc\n";
    const preview = await run((s) => previewCostImport(s, csv));
    expect(preview.error).toBeNull();
    expect(preview.preview!.counts).toEqual({ matched: 1, unchanged: 0, unmatched: 1, ambiguous: 0, invalid: 1 });
    expect(preview.preview!.rows.find((r) => r.status === "unmatched")!.sku).toBe("NOPE-9");
    expect(await variant("FS-1")).toMatchObject({ costMinor: 2100, costSource: "po_receipt" });
    expect((await run((s) => previewCostImport(s, "name,price\nx,1"))).error).toBe("missing_columns");

    const applied = await run((s) => applyCostImport(s, csv, { fileName: "costs.csv" }), seed.userIds["superadmin@hullwise.demo"]!);
    expect(applied.result!.changed.map((c) => [c.sku, c.fromMinor, c.toMinor])).toEqual([["FS-1", 2100, 2500]]);
    expect(await variant("FS-1")).toMatchObject({ costMinor: 2500, costSource: "import" });
    // lines that already had a cost keep it unless the import restates them
    expect(await lineCost("FS-1")).toBe(2000);
    const [audit] = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "catalog.cost_import"))));
    expect(audit).toMatchObject({ diff: { "FS-1": { from: 2100, to: 2500 } }, metadata: { fileName: "costs.csv", written: 1, counts: { matched: 1, unmatched: 1, invalid: 1 } } });

    await run((s) => applyCostImport(s, "sku,cost\nFS-1,26\n", { applyTo: "all" }));
    expect(await lineCost("FS-1")).toBe(2600);
    expect((await run((s) => pnlForPeriod(s, tenant, period))).cogsMinor).toBe(2 * 2600 + 4000);
  });

  it("the data-quality report lists variants with missing cost, barcode or image and duplicate SKUs", async () => {
    const v2 = await variant("FS-2");
    await run((s) => s.tx.update(schema.productVariants).set({ sku: "FS-1" }).where(eq(schema.productVariants.id, v2.id)));
    const q = await run((s) => catalogQualityReport(s));
    expect(q.total).toBe(3);
    expect(q.counts).toMatchObject({ missing_cost: 0, duplicate_sku: 2, missing_barcode: 1, missing_image: 1 });
    expect(q.rows.find((r) => r.sku === "FS-3")!.issues).toEqual(["missing_barcode", "missing_image"]);
    // with a duplicate SKU the import refuses to guess
    const p = await run((s) => previewCostImport(s, "sku,cost\nFS-1,30\n"));
    expect(p.preview!.counts.ambiguous).toBe(1);
  });
});

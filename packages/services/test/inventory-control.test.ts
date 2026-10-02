import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import type { MockCommercePlatform } from "@hullwise/integrations";
import { parseTenantSettings, type TenantSettings } from "@hullwise/core";
import { InventoryControlError, adjustStock, applyMarkdowns, applyStockTake, createStockTake, executePlatformWrite, getCommercePlatformFor, importOrder, markdownSuggestions, mockCommerceFor, priceHistory, purgeExpiredPlatformRows, recordStockTakeCount, resetMockPlatforms, setStockTakeCount, stockTakeDetail, unexplainedLosses, type BulkRunner, type PlatformTenant, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: PlatformTenant;
let settings: TenantSettings;
let mock: MockCommercePlatform;
let owner = "";
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: owner } }), pools.app);
const sys = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const runner = (): BulkRunner => ({ tenantId, actor: { type: "user", userId: owner }, audit: { actorUserId: owner, actorType: "user", impersonatedBy: null }, run });

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.harbor;
  owner = seed.userIds["owner@harborhome.demo"]!;
  const [t] = await pools.admin.select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  tenant = t!;
  settings = parseTenantSettings(t!.settings);
  resetMockPlatforms();
  await run((s) => getCommercePlatformFor(s, tenant));
  mock = mockCommerceFor(tenantId)!;
});
afterAll(() => pools.close());

/** Seeded levels of catalogue variants known to the platform, with at least `min` units. */
// unique SKUs only: the seed reuses one SKU on two products (data-quality demo), and a scan of it would match either
async function stockedLevels(min: number, count: number, offset = 0) {
  return run((s) =>
    s.tx
      .select({ variantId: schema.inventoryLevels.variantId, locationId: schema.inventoryLevels.locationId, available: schema.inventoryLevels.available, inv: schema.productVariants.inventoryItemExternalId, loc: schema.locations.externalId, sku: schema.productVariants.sku })
      .from(schema.inventoryLevels)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId))
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(and(eq(schema.inventoryLevels.tenantId, tenantId), sql`${schema.inventoryLevels.available} >= ${min}`, sql`${schema.productVariants.inventoryItemExternalId} is not null`, sql`${schema.locations.externalId} is not null`, sql`${schema.productVariants.sku} is not null`, sql`not exists (select 1 from product_variants v2 where v2.tenant_id = ${schema.productVariants.tenantId} and v2.sku = ${schema.productVariants.sku} and v2.id <> ${schema.productVariants.id})`))
      .orderBy(schema.productVariants.sku, schema.locations.name)
      .offset(offset)
      .limit(count),
  );
}
const levelOf = async (variantId: string, locationId: string) => (await run((s) => s.tx.select().from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, variantId), eq(schema.inventoryLevels.locationId, locationId)))))[0]?.available ?? 0;

describe("stock adjustments", () => {
  it("−2 damaged lowers stock locally and on the platform, with a movement and an audit entry", async () => {
    const [l] = await stockedLevels(5, 1);
    const before = l!.available;
    // the platform starts where Hullwise is
    mock.adjustStock(l!.inv!, l!.loc!, before - (mock.stockOf(l!.inv!, l!.loc!) ?? before));
    const r = await run((s) => adjustStock(s, { variantId: l!.variantId, locationId: l!.locationId, delta: -2, reason: "damaged", note: "crushed box" }));
    expect(r).toMatchObject({ before, after: before - 2 });
    expect(await levelOf(l!.variantId, l!.locationId)).toBe(before - 2);
    const [m] = await run((s) => s.tx.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.id, r.movementId)));
    expect(m).toMatchObject({ delta: -2, reason: "adjustment", reasonCode: "damaged", note: "crushed box", actorUserId: owner, locationId: l!.locationId });
    const [audit] = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "inventory.adjusted"), eq(schema.auditLogs.entityId, l!.variantId))).orderBy(desc(schema.auditLogs.createdAt)).limit(1));
    expect(audit).toMatchObject({ actorUserId: owner, actorType: "user" });
    expect(Object.values(audit!.diff as Record<string, unknown>)).toEqual([{ from: before, to: before - 2 }]);
    expect(audit!.metadata).toMatchObject({ reason: "damaged", delta: -2 });
    // the outbox write carries the new absolute level and reaches the platform
    expect(r.write).toMatchObject({ kind: "inventory.set", status: "pending", payload: { inventoryItemExternalId: l!.inv, locationExternalId: l!.loc, available: before - 2 } });
    expect((await executePlatformWrite(run, tenant, r.write!.id)).status).toBe("succeeded");
    expect(mock.stockOf(l!.inv!, l!.loc!)).toBe(before - 2);
  });

  it("refuses wrong signs, stock below zero and other without a note, writing nothing", async () => {
    const [l] = await stockedLevels(1, 1, 3);
    const before = l!.available;
    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof InventoryControlError ? e.code : String(e)));
    expect(await err(run((s) => adjustStock(s, { variantId: l!.variantId, locationId: l!.locationId, delta: 2, reason: "damaged" })))).toBe("sign");
    expect(await err(run((s) => adjustStock(s, { variantId: l!.variantId, locationId: l!.locationId, delta: -(before + 1), reason: "lost" })))).toBe("negative_stock");
    expect(await err(run((s) => adjustStock(s, { variantId: l!.variantId, locationId: l!.locationId, delta: 1, reason: "other", note: "" })))).toBe("note_required");
    expect(await levelOf(l!.variantId, l!.locationId)).toBe(before);
  });

  it("found units cover a waiting order: the backorder is released", async () => {
    const [loc] = await run((s) => s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1));
    const v = await run(async (s) => {
      const [p] = await s.tx.insert(schema.products).values({ tenantId, externalId: "ic-p-1", title: "Adjust test", options: [] }).returning();
      const [row] = await s.tx.insert(schema.productVariants).values({ tenantId, productId: p!.id, externalId: "ic-v-1", inventoryItemExternalId: "ic-i-1", sku: "IC-1", title: "Default", optionValues: {}, priceMinor: 4900, costMinor: 2000 }).returning();
      await s.tx.insert(schema.inventoryLevels).values({ tenantId, variantId: row!.id, locationId: loc!.id, available: 0, onHand: 0, committed: 0, syncedAt: new Date(Date.now() - 36e5) });
      return row!;
    });
    const order = await mock.createOrder({ lines: [{ variantExternalId: v.externalId!, sku: null, title: "x", quantity: 2, unitPriceMinor: 4900 }], currency: "USD", email: "buyer@example.com", phone: null, customerExternalId: null, shippingAddress: { name: "Ann Lee", address1: "500 Congress Ave", city: "Austin", province: "TX", zip: "78701", country: "US" }, billingAddress: null, shippingMinor: 0, discountMinor: 0, note: null, tags: [], noteAttributes: [], replacesOrderName: null, payment: { method: "card", status: "paid", gateways: ["shopify_payments"] } });
    const imported = await sys((s) => importOrder(s, order, { country: "US", source: "webhook" }));
    expect((await run((s) => s.tx.select().from(schema.backorders).where(eq(schema.backorders.orderId, imported.id))))[0]).toMatchObject({ status: "pending" });
    const r = await run((s) => adjustStock(s, { variantId: v.id, locationId: loc!.id, delta: 2, reason: "found" }));
    expect(r.coverage.releasedOrders).toEqual([imported.id]);
    expect((await run((s) => s.tx.select().from(schema.backorders).where(eq(schema.backorders.orderId, imported.id))))[0]).toMatchObject({ status: "fulfilled" });
  });
});

describe("stock-take", () => {
  it("a partial count with 3 differences writes 3 count-correction movements in one batch; uncounted variants and unknown codes are left alone", async () => {
    const levels = await stockedLevels(4, 12, 10);
    const locationId = levels[0]!.locationId;
    const here = levels.filter((l) => l.locationId === locationId);
    expect(here.length).toBeGreaterThanOrEqual(5);
    const [a, b, c, d, untouched] = here as [typeof here[number], typeof here[number], typeof here[number], typeof here[number], typeof here[number]];
    const untouchedBefore = untouched.available;
    const take = await run((s) => createStockTake(s, { locationId, note: "Q4 count" }));
    // scans (+1 each) and typed quantities; matching ignores case
    for (let i = 0; i < a.available - 1; i++) await run((s) => recordStockTakeCount(s, take.id, { code: a.sku!.toLowerCase(), quantity: 1, mode: "add" }));
    await run((s) => recordStockTakeCount(s, take.id, { code: b.sku!, quantity: b.available + 3, mode: "set" }));
    await run((s) => recordStockTakeCount(s, take.id, { code: c.sku!, quantity: 0, mode: "set" }));
    await run((s) => recordStockTakeCount(s, take.id, { code: d.sku!, quantity: d.available, mode: "set" }));
    const unknown = await run((s) => recordStockTakeCount(s, take.id, { code: "NOT-A-SKU-42", quantity: 2, mode: "add" }));
    expect(unknown.kind).toBe("unknown");
    const review = await run((s) => stockTakeDetail(s, take.id));
    expect(review.summary).toMatchObject({ match: 1, missing: 2, surplus: 1, unknown: 1 });
    expect(review.lines.find((x) => x.variantId === a.variantId)).toMatchObject({ counted: a.available - 1, expected: a.available, delta: -1, status: "missing" });

    const r = await run((s) => applyStockTake(s, take.id));
    expect(r.movements).toBe(3);
    const moves = await run((s) => s.tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceType, "stock_take"), eq(schema.inventoryMovements.referenceId, take.id))));
    expect(moves).toHaveLength(3);
    expect(new Set(moves.map((m) => m.reasonCode))).toEqual(new Set(["count_correction"]));
    expect(new Set(moves.map((m) => m.createdAt.getTime())).size).toBe(1);
    expect(moves.map((m) => m.delta).sort((x, y) => x - y)).toEqual([-c.available, -1, 3].sort((x, y) => x - y));
    expect(await levelOf(a.variantId, locationId)).toBe(a.available - 1);
    expect(await levelOf(b.variantId, locationId)).toBe(b.available + 3);
    expect(await levelOf(c.variantId, locationId)).toBe(0);
    expect(await levelOf(d.variantId, locationId)).toBe(d.available);
    expect(await levelOf(untouched.variantId, locationId)).toBe(untouchedBefore);
    // one stock write per difference, one audit entry for the batch
    expect(r.writes.map((w) => (w.payload as { available: number }).available).sort((x, y) => x - y)).toEqual([0, a.available - 1, b.available + 3].sort((x, y) => x - y));
    const audits = await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "stock_take.applied"), eq(schema.auditLogs.entityId, take.id))));
    expect(audits).toHaveLength(1);
    expect(Object.keys(audits[0]!.diff as object)).toHaveLength(3);
    // applied: closed for counting, review frozen on the levels it was compared with
    const after = await run((s) => stockTakeDetail(s, take.id));
    expect(after.take).toMatchObject({ status: "applied", appliedMovements: 3 });
    expect(after.summary).toMatchObject({ missing: 2, surplus: 1, match: 1, unknown: 1 });
    await expect(run((s) => recordStockTakeCount(s, take.id, { code: a.sku!, quantity: 1, mode: "add" }))).rejects.toThrow("not_open");
    await expect(run((s) => applyStockTake(s, take.id))).rejects.toThrow("not_open");
  });

  it("a count can be corrected or removed before applying", async () => {
    const [l] = await stockedLevels(2, 1, 5);
    const take = await run((s) => createStockTake(s, { locationId: l!.locationId }));
    const scan = await run((s) => recordStockTakeCount(s, take.id, { code: l!.sku!, quantity: 1, mode: "add" }));
    await run((s) => setStockTakeCount(s, take.id, scan.countId, l!.available));
    expect((await run((s) => stockTakeDetail(s, take.id))).summary).toMatchObject({ match: 1 });
    await run((s) => setStockTakeCount(s, take.id, scan.countId, null));
    expect((await run((s) => stockTakeDetail(s, take.id))).lines).toHaveLength(0);
    expect((await run((s) => applyStockTake(s, take.id))).movements).toBe(0);
  });
});

describe("unexplained-loss report", () => {
  it("sums falls and unreported levels in the period, valued at cost, and keeps them past the platform retention", async () => {
    // two fresh variants: no seeded drift on them
    const [l1, l2] = await run(async (s) => {
      const [loc] = await s.tx.select().from(schema.locations).where(eq(schema.locations.tenantId, tenantId)).limit(1);
      const [p] = await s.tx.insert(schema.products).values({ tenantId, externalId: "ic-p-loss", title: "Loss test", options: [] }).returning();
      const vs = await s.tx.insert(schema.productVariants).values([1, 2].map((i) => ({ tenantId, productId: p!.id, externalId: `ic-loss-${i}`, sku: `IC-LOSS-${i}`, title: `V${i}`, optionValues: {}, priceMinor: 3000, costMinor: 1200 }))).returning();
      return vs.map((v) => ({ variantId: v.id, locationId: loc!.id }));
    });
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * 864e5);
    await run((s) =>
      s.tx.insert(schema.inventoryDrift).values([
        { tenantId, variantId: l1!.variantId, locationId: l1!.locationId, kind: "unexplained", source: "reconcile", localBefore: 10, expected: 10, observed: 7, delta: -3, applied: 7, dedupeKey: "t:loss:1", occurrences: 3, detectedAt: ago(20), lastSeenAt: ago(20) },
        { tenantId, variantId: l1!.variantId, locationId: l1!.locationId, kind: "not_reported", source: "reconcile", localBefore: 2, expected: 2, observed: 0, delta: -2, applied: 0, dedupeKey: "t:loss:2", detectedAt: ago(5), lastSeenAt: ago(5) },
        { tenantId, variantId: l2!.variantId, locationId: l2!.locationId, kind: "unexplained", source: "sync", localBefore: 4, expected: 4, observed: 9, delta: 5, applied: 9, dedupeKey: "t:gain:1", detectedAt: ago(5), lastSeenAt: ago(5) },
        { tenantId, variantId: l2!.variantId, locationId: l2!.locationId, kind: "negative", source: "sync", localBefore: 1, expected: 0, observed: -1, delta: -1, applied: 0, dedupeKey: "t:neg:1", detectedAt: ago(5), lastSeenAt: ago(5) },
        { tenantId, variantId: l2!.variantId, locationId: l2!.locationId, kind: "unexplained", source: "sync", localBefore: 4, expected: 4, observed: 3, delta: -1, applied: 3, dedupeKey: "t:old:1", detectedAt: ago(90), lastSeenAt: ago(90) },
        { tenantId, variantId: l2!.variantId, locationId: l2!.locationId, kind: "unexplained", source: "sync", localBefore: 4, expected: 4, observed: 6, delta: 2, applied: 6, dedupeKey: "t:gain:old", detectedAt: ago(20), lastSeenAt: ago(20) },
      ]),
    );
    const cost = (await run((s) => s.tx.select({ c: schema.productVariants.costMinor }).from(schema.productVariants).where(eq(schema.productVariants.id, l1!.variantId))))[0]!.c ?? 0;
    const r = await run((s) => unexplainedLosses(s, { from: ago(30), to: now }));
    const row = r.rows.find((x) => x.variantId === l1!.variantId);
    expect(row).toMatchObject({ units: 5, events: 2, valueMinor: 5 * cost });
    // a gain, a clamped negative and a fall outside the period are not losses of the period
    expect(r.rows.find((x) => x.variantId === l2!.variantId)).toBeUndefined();
    expect((await run((s) => unexplainedLosses(s, { from: ago(120), to: now }))).rows.find((x) => x.variantId === l2!.variantId)).toMatchObject({ units: 1 });
    // housekeeping drops ordinary drift after the window but keeps the loss rows for the report
    await run((s) => purgeExpiredPlatformRows(s, { days: 14 }));
    const left = await run((s) => s.tx.select({ k: schema.inventoryDrift.dedupeKey }).from(schema.inventoryDrift).where(sql`${schema.inventoryDrift.dedupeKey} like 't:%'`));
    expect(left.map((x) => x.k).sort()).toEqual(["t:gain:1", "t:loss:1", "t:loss:2", "t:neg:1", "t:old:1"]);
  });
});

describe("markdowns", () => {
  it("suggests markdowns above the margin floor and applies them in bulk with price history and outbox writes", async () => {
    const { rows } = await run((s) => markdownSuggestions(s, { country: tenant.country, settings }));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.suggestion.priceMinor).toBeGreaterThanOrEqual(r.suggestion.floorPriceMinor);
      expect(r.suggestion.priceMinor).toBeLessThan(r.priceMinor);
      expect(r.suggestion.marginBps!).toBeGreaterThanOrEqual(settings.markdownMinMarginBps);
    }
    const picked = rows.slice(0, 2);
    const { summary, writes } = await applyMarkdowns(runner(), { country: tenant.country, settings }, [...picked.map((p) => p.variantId), "00000000-0000-0000-0000-000000000000"], { concurrency: 2 });
    expect(summary).toMatchObject({ total: 3, done: 2, skipped: 1 });
    for (const p of picked) {
      const [v] = await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, p.variantId)));
      expect(v).toMatchObject({ priceMinor: p.suggestion.priceMinor, compareAtMinor: p.suggestion.compareAtMinor });
    }
    const history = await run((s) => priceHistory(s, { source: "markdown", limit: 10 }));
    expect(history.filter((h) => h.c.batchId === summary.batchId)).toHaveLength(2);
    expect(writes.map((w) => w.kind)).toEqual(["variant.prices", "variant.prices"]);
    expect((await executePlatformWrite(run, tenant, writes[0]!.id)).status).toBe("succeeded");
    expect(mock.writeLog.filter((w) => w.op === "updateVariant").at(-1)!.args).toMatchObject({ patch: { priceMinor: expect.any(Number), compareAtMinor: expect.any(Number) } });
    // applying again: already marked down, nothing changes
    const again = await applyMarkdowns(runner(), { country: tenant.country, settings }, [picked[0]!.variantId], { concurrency: 1 });
    expect(again.summary).toMatchObject({ done: 0, skipped: 1 });
  });

  it("never applies a markdown below the floor, even when the margin floor is raised after the suggestion", async () => {
    const { rows } = await run((s) => markdownSuggestions(s, { country: tenant.country, settings }));
    const target = rows.find((r) => r.costMinor !== null && r.costMinor > 0)!;
    const strict = { ...settings, markdownMinMarginBps: 9_500 };
    const r = await applyMarkdowns(runner(), { country: tenant.country, settings: strict }, [target.variantId], { concurrency: 1 });
    expect(r.summary.items[0]).toMatchObject({ status: "skipped", reason: "floor" });
    const [v] = await run((s) => s.tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, target.variantId)));
    expect(v!.priceMinor).toBe(target.priceMinor);
  });
});

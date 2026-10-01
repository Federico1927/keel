import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import type { MockCommercePlatform } from "@keel/integrations";
import { enqueuePlatformWrite, executePlatformWrite, getCommercePlatformFor, latestPlatformWrites, mockCommerceFor, processDuePlatformWrites, processWebhookEvent, purgeExpiredPlatformRows, recordWebhookEvent, refreshInventoryForVariants, resetMockPlatforms, retryPlatformWrite, runCatalogSync, runPlatformWriteNow, type PlatformTenant, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: PlatformTenant;
let mock: MockCommercePlatform;
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: null } }), pools.app);
const db = <T>(fn: (tx: ServiceContext["tx"]) => Promise<T>) => withTenant(tenantId, fn, pools.app);

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.harbor;
  const [t] = await pools.admin.select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  tenant = t!;
  resetMockPlatforms();
  await run((s) => getCommercePlatformFor(s, tenant));
  mock = mockCommerceFor(tenantId)!;
});
afterAll(() => pools.close());

async function aVariant(offset = 0) {
  const [v] = await db((tx) => tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, tenantId), sql`${schema.productVariants.externalId} is not null`)).orderBy(schema.productVariants.sku).offset(offset).limit(1));
  return v!;
}
const writesOf = (op: string) => mock.writeLog.filter((w) => w.op === op);

describe("platform write outbox", () => {
  it("retries a rate-limited price edit and reaches the platform exactly once, even when the request is repeated", async () => {
    const v = await aVariant();
    const before = writesOf("updateVariant").length;
    const input = { kind: "variant.update" as const, entityType: "variant", entityId: v.id, payload: { variantExternalId: v.externalId!, priceMinor: v.priceMinor + 500 } };
    const first = await run((s) => enqueuePlatformWrite(s, input));
    expect(first.status).toBe("pending");
    // double click: the same request maps to the same outbox row
    const again = await run((s) => enqueuePlatformWrite(s, input));
    expect(again.id).toBe(first.id);

    mock.failures.failNext("rate_limited");
    const r1 = await executePlatformWrite(run, tenant, first.id);
    expect(r1).toMatchObject({ status: "pending", errorCode: "rate_limited", retryInMs: 1200 });
    const [waiting] = await db((tx) => tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.id, first.id)));
    expect(waiting).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "rate_limited" });
    // not due yet: the retry loop leaves it alone
    expect((await processDuePlatformWrites(run, tenant)).processed).toBe(0);
    // a retry of the request while it waits is still the same row
    expect((await run((s) => enqueuePlatformWrite(s, input))).id).toBe(first.id);

    const later = await processDuePlatformWrites(run, tenant, { now: new Date(Date.now() + 5_000) });
    expect(later).toMatchObject({ processed: 1, succeeded: 1 });
    const [done] = await db((tx) => tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.id, first.id)));
    expect(done).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(done!.completedAt).toBeTruthy();
    // executing it once more is a no-op
    expect((await executePlatformWrite(run, tenant, first.id, { force: true })).status).toBe("skipped");
    const calls = writesOf("updateVariant").slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toMatchObject({ variantExternalId: v.externalId, patch: { priceMinor: v.priceMinor + 500 } });
    const badge = await run((s) => latestPlatformWrites(s, "variant", [v.id]));
    expect(badge.get(v.id)?.status).toBe("succeeded");
  });

  it("a newer value supersedes an older write still waiting on the same target; A → B → A is three writes", async () => {
    const v = await aVariant(1);
    const write = (priceMinor: number) => run((s) => enqueuePlatformWrite(s, { kind: "variant.update", entityType: "variant", entityId: v.id, payload: { variantExternalId: v.externalId!, priceMinor } }));
    const a = await write(1000);
    const b = await write(2000);
    const [old] = await db((tx) => tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.id, a.id)));
    expect(old!.status).toBe("superseded");
    expect((await executePlatformWrite(run, tenant, a.id)).status).toBe("skipped");
    expect((await executePlatformWrite(run, tenant, b.id)).status).toBe("succeeded");
    const a2 = await write(1000);
    expect(a2.id).not.toBe(a.id);
    expect(a2.status).toBe("pending");
  });

  it("a permanent error fails at once with a readable message; a manual retry sends it again", async () => {
    const [p] = await db((tx) => tx.select().from(schema.products).where(and(eq(schema.products.tenantId, tenantId), sql`${schema.products.externalId} is not null`)).limit(1));
    const w = await run((s) => enqueuePlatformWrite(s, { kind: "product.status", entityType: "product", entityId: p!.id, payload: { productExternalId: p!.externalId!, status: "draft" } }));
    mock.failures.failNext("permission");
    const r = await executePlatformWrite(run, tenant, w.id);
    expect(r).toMatchObject({ status: "failed", errorCode: "permission" });
    expect(r.error).toContain("missing scope");
    const [health] = await db((tx) => tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "shopify:writes"))));
    expect(health!.lastError).toContain("missing scope");
    const again = await run((s) => retryPlatformWrite(s, w.id));
    expect(again!.status).toBe("pending");
    expect((await executePlatformWrite(run, tenant, w.id)).status).toBe("succeeded");
  });

  it("synchronous writes are recorded; with a key the same request returns the stored answer instead of writing twice", async () => {
    const [o] = await db((tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.externalId} is not null`)).limit(1));
    const before = writesOf("updateOrderTags").length;
    const input = { kind: "order.tags" as const, entityType: "order", entityId: o!.id, payload: { orderExternalId: o!.externalId!, add: ["vip"], remove: [] }, idempotencyKey: `test:tags:${o!.id}` };
    await run((s) => runPlatformWriteNow(s, mock, input));
    await run((s) => runPlatformWriteNow(s, mock, input));
    expect(writesOf("updateOrderTags").length - before).toBe(1);
    const rows = await db((tx) => tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.idempotencyKey, input.idempotencyKey)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "sync", status: "succeeded" });
    // a failure is rethrown and, when the caller's transaction commits, kept on the row
    mock.failures.failNext("network");
    await expect(run((s) => runPlatformWriteNow(s, mock, { ...input, idempotencyKey: `test:tags2:${o!.id}` }))).rejects.toMatchObject({ code: "network" });
  });
});

describe("stock refresh, drift and reconciliation", () => {
  const levelsOf = (variantIds: string[]) => db((tx) => tx.select({ variantId: schema.inventoryLevels.variantId, available: schema.inventoryLevels.available, inv: schema.productVariants.inventoryItemExternalId, loc: schema.locations.externalId }).from(schema.inventoryLevels).innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId)).innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId)).where(inArray(schema.inventoryLevels.variantId, variantIds)));

  it("an order webhook updates stock for its variants in the same job, with no drift (the sale explains it)", async () => {
    const order = mock.generateOrder(new Date());
    const env = mock.buildWebhook("orders/create", order);
    const payload = JSON.parse(env.rawBody) as unknown;
    const ev = await run((s) => recordWebhookEvent(s, { source: "shopify", topic: "orders/create", externalId: order.externalId, sourceUpdatedAt: order.platformUpdatedAt.toISOString(), payload }));
    const driftBefore = await db((tx) => tx.select().from(schema.inventoryDrift).where(eq(schema.inventoryDrift.tenantId, tenantId)));
    const r = await run((s) => processWebhookEvent(s, mock, ev.id!, { country: tenant.country }));
    expect(r.status).toBe("processed");
    const variants = await db((tx) => tx.select({ id: schema.productVariants.id, ext: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, tenantId), inArray(schema.productVariants.externalId, order.lines.map((l) => l.variantExternalId!)))));
    const levels = await levelsOf(variants.map((v) => v.id));
    expect(levels.length).toBeGreaterThan(0);
    for (const l of levels) expect(l.available).toBe(Math.max(0, mock.stockOf(l.inv!, l.loc!) ?? -1));
    const driftAfter = await db((tx) => tx.select().from(schema.inventoryDrift).where(and(eq(schema.inventoryDrift.tenantId, tenantId), inArray(schema.inventoryDrift.variantId, variants.map((v) => v.id)))));
    expect(driftAfter.length).toBe(driftBefore.filter((d) => variants.some((v) => v.id === d.variantId)).length);
  });

  it("logs unexplained changes and clamps negative stock, deduplicated", async () => {
    const [lvl] = await db((tx) => tx.select({ variantId: schema.inventoryLevels.variantId, available: schema.inventoryLevels.available, inv: schema.productVariants.inventoryItemExternalId, loc: schema.locations.externalId }).from(schema.inventoryLevels).innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId)).innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId)).where(and(eq(schema.inventoryLevels.tenantId, tenantId), sql`${schema.inventoryLevels.available} >= 10`, eq(schema.productVariants.isActive, true))).orderBy(schema.productVariants.sku).offset(3).limit(1));
    const v = { id: lvl!.variantId };
    // someone edits stock in the store admin: no sale, return or receipt explains it
    mock.adjustStock(lvl!.inv!, lvl!.loc!, -7);
    await run((s) => refreshInventoryForVariants(s, mock, [v.id], { source: "manual" }));
    const unexplained = await db((tx) => tx.select().from(schema.inventoryDrift).where(and(eq(schema.inventoryDrift.variantId, v.id), eq(schema.inventoryDrift.kind, "unexplained"))));
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]!.observed - unexplained[0]!.expected).toBe(-7);
    // the platform goes negative (oversold): stored as zero, logged once however often it is read
    mock.adjustStock(lvl!.inv!, lvl!.loc!, -((mock.stockOf(lvl!.inv!, lvl!.loc!) ?? 0) + 3));
    await run((s) => refreshInventoryForVariants(s, mock, [v.id], { source: "manual" }));
    await run((s) => refreshInventoryForVariants(s, mock, [v.id], { source: "manual" }));
    const negative = await db((tx) => tx.select().from(schema.inventoryDrift).where(and(eq(schema.inventoryDrift.variantId, v.id), eq(schema.inventoryDrift.kind, "negative"))));
    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatchObject({ observed: -3, applied: 0, occurrences: 2 });
    const [after] = (await levelsOf([v.id])).filter((l) => l.loc === lvl!.loc);
    expect(after!.available).toBe(0);
  });

  it("the nightly run resumes from its cursor, zeroes levels no longer reported, keeps levels with a write in flight and records a summary", async () => {
    // a level at a location the platform does not report
    const v = await aVariant(7);
    const [ghost] = await db((tx) => tx.insert(schema.locations).values({ tenantId, externalId: "ghost-location", name: "Closed shop", isActive: false, isDefault: false }).returning());
    await db((tx) => tx.insert(schema.inventoryLevels).values({ tenantId, variantId: v.id, locationId: ghost!.id, available: 9, onHand: 9, committed: 0, syncedAt: new Date(Date.now() - 864e5) }));
    // a Keel stock write still waiting: the run must not overwrite that level
    const [held] = await levelsOf([(await aVariant(8)).id]);
    const pending = await run((s) => enqueuePlatformWrite(s, { kind: "inventory.set", entityType: "variant", entityId: held!.variantId, payload: { inventoryItemExternalId: held!.inv!, locationExternalId: held!.loc!, available: held!.available + 50 } }));
    await db((tx) => tx.update(schema.inventoryLevels).set({ available: held!.available + 50 }).where(and(eq(schema.inventoryLevels.variantId, held!.variantId), eq(schema.inventoryLevels.locationId, sql`(select id from locations where external_id = ${held!.loc} and tenant_id = ${tenantId})`))));

    const paused = await run((s) => runCatalogSync(s, mock, { kind: "reconcile", budgetMs: 0, batchSize: 20 }));
    expect(paused.finished).toBe(false);
    const [mid] = await db((tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, paused.runId)));
    expect(mid!.status).toBe("paused");
    let r = paused;
    for (let i = 0; i < 500 && !r.finished; i++) r = await run((s) => runCatalogSync(s, mock, { kind: "reconcile", budgetMs: 0, batchSize: 20 }));
    expect(r.runId).toBe(paused.runId);
    expect(r.finished).toBe(true);
    expect(r.zeroed).toBeGreaterThanOrEqual(1);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    const [summary] = await db((tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, r.runId)));
    expect(summary).toMatchObject({ status: "success", kind: "reconcile", objectType: "catalog", errorCount: 0 });
    expect(summary!.rowsScanned).toBeGreaterThan(0);
    expect(summary!.durationMs).not.toBeNull();
    const [zeroed] = await db((tx) => tx.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.locationId, ghost!.id)));
    expect(zeroed!.available).toBe(0);
    expect(await db((tx) => tx.select().from(schema.inventoryDrift).where(and(eq(schema.inventoryDrift.variantId, v.id), eq(schema.inventoryDrift.kind, "not_reported"))))).toHaveLength(1);
    const [kept] = (await levelsOf([held!.variantId])).filter((l) => l.loc === held!.loc);
    expect(kept!.available).toBe(held!.available + 50);
    // once the write lands, the next read agrees with Keel
    expect((await executePlatformWrite(run, tenant, pending.id)).status).toBe("succeeded");
    expect(mock.stockOf(held!.inv!, held!.loc!)).toBe(held!.available + 50);
  });
});

describe("retention", () => {
  it("deletes only finished rows older than the window; failures stay until resolved", async () => {
    const old = new Date(Date.now() - 20 * 864e5);
    const recent = new Date(Date.now() - 2 * 864e5);
    const ev = (externalId: string, status: string, at: Date) => ({ tenantId, source: "shopify", topic: "orders/updated", externalId, sourceUpdatedAt: at.toISOString(), payload: {}, status, attempts: 1, processedAt: status === "processed" ? at : null, receivedAt: at });
    const events = await db((tx) => tx.insert(schema.webhookEvents).values([ev("ret-old", "processed", old), ev("ret-new", "processed", recent), ev("ret-failed", "failed", old)]).returning({ id: schema.webhookEvents.id, externalId: schema.webhookEvents.externalId }));
    const w = (key: string, status: string, at: Date) => ({ tenantId, provider: "shopify", kind: "variant.update", mode: "async", entityType: "variant", targetKey: `ret:${key}`, payload: {}, payloadHash: key, idempotencyKey: `ret:${key}`, status, completedAt: status === "failed" ? null : at, createdAt: at, updatedAt: at });
    const writes = await db((tx) => tx.insert(schema.platformWrites).values([w("old-ok", "succeeded", old), w("new-ok", "succeeded", recent), w("old-failed", "failed", old)]).returning({ id: schema.platformWrites.id, key: schema.platformWrites.idempotencyKey }));
    const r = await run((s) => purgeExpiredPlatformRows(s, { days: 14 }));
    expect(r.webhookEvents).toBeGreaterThanOrEqual(1);
    const leftEvents = await db((tx) => tx.select({ externalId: schema.webhookEvents.externalId }).from(schema.webhookEvents).where(inArray(schema.webhookEvents.id, events.map((e) => e.id))));
    expect(leftEvents.map((e) => e.externalId).sort()).toEqual(["ret-failed", "ret-new"]);
    const leftWrites = await db((tx) => tx.select({ key: schema.platformWrites.idempotencyKey }).from(schema.platformWrites).where(inArray(schema.platformWrites.id, writes.map((x) => x.id))));
    expect(leftWrites.map((x) => x.key).sort()).toEqual(["ret:new-ok", "ret:old-failed"]);
  });
});

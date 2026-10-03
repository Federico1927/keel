import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { historyImportSince } from "@hullwise/core";
import { MockCommercePlatform } from "@hullwise/integrations";
import { historyImportStatus, restartHistoryImport, runOrdersSync, runReturnsSync, tenantChecklist, type ServiceContext } from "../src";

/**
 * Issue #87: the first import of a store's order history. A Shopify store connected for the first
 * time must get every order inside the tenant's window (24 months by default), not the 30 days a
 * first delta reads, and the import must survive time budgets and platform failures.
 */
const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let platform: MockCommercePlatform;
const now = new Date();
const DAY = 864e5;
const inWindow: string[] = [];
const outOfWindow: string[] = [];

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.harbor;
  const { variants, locations, customers } = await withTenant(tenantId, async (tx) => ({
    variants: await tx.select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, optionValues: schema.productVariants.optionValues, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, tenantId)).limit(30),
    locations: await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, tenantId)),
    customers: await tx.select().from(schema.customers).where(eq(schema.customers.tenantId, tenantId)).limit(20),
  }), pools.app);
  platform = new MockCommercePlatform({
    currency: "USD",
    country: "US",
    orderNumberPrefix: "HH",
    startOrderNumber: 900000,
    seed: 87,
    variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor })),
    locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })),
    customers: customers.map((c) => ({ externalId: c.externalId ?? c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt })),
  });
  // a store with 18 months of history inside the window and three older years outside it
  for (let i = 0; i < 24; i++) inWindow.push(platform.generateOrder(new Date(now.getTime() - (40 + i * 22) * DAY)).externalId);
  for (let i = 0; i < 6; i++) outOfWindow.push(platform.generateOrder(new Date(now.getTime() - (800 + i * 60) * DAY)).externalId);
});
afterAll(() => pools.close());

const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const imported = (ids: string[]) => withTenant(tenantId, (tx) => tx.select({ id: schema.orders.externalId }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.externalId, ids))), pools.app);

describe("first import of the order history (issue #87)", () => {
  it("imports every order inside the window across time budgets and a failure, then hands over to delta", async () => {
    expect((await run((s) => historyImportStatus(s))).state).toBe("not_started");
    const since = historyImportSince(now, 24)!;
    const opts = { kind: "initial" as const, country: "US", pageSize: 4, historySince: since };

    // a delta on a store never synced reads 30 days only: the gap this issue closes
    const firstDelta = await run((s) => runOrdersSync(s, platform, { kind: "delta", country: "US", pageSize: 50 }));
    expect(firstDelta.error).toBeNull();
    expect(await imported(inWindow)).toHaveLength(0);

    const paused = await run((s) => runOrdersSync(s, platform, { ...opts, budgetMs: 0 }));
    expect(paused.finished).toBe(false);
    const p = await run((s) => historyImportStatus(s));
    expect(p).toMatchObject({ state: "paused", runId: paused.runId });
    expect(p.since?.toISOString()).toBe(since.toISOString());

    // a platform failure mid-import keeps the cursor: the next call resumes the same run
    platform.failures.failNext("rate_limited");
    const failed = await run((s) => runOrdersSync(s, platform, { ...opts, budgetMs: 60_000 }));
    expect(failed.error).toContain("rate_limited");
    expect(failed.runId).toBe(paused.runId);
    const e = await run((s) => historyImportStatus(s));
    expect(e.state).toBe("error");
    expect(e.error).toContain("rate_limited");

    const done = await run((s) => runOrdersSync(s, platform, { ...opts, budgetMs: 60_000 }));
    expect(done).toMatchObject({ runId: paused.runId, finished: true, error: null });
    const d = await run((s) => historyImportStatus(s));
    expect(d.state).toBe("done");
    expect(d.finishedAt).toBeTruthy();
    expect(d.oldestOrderAt!.getTime()).toBeLessThanOrEqual(now.getTime() - (40 + 23 * 22) * DAY + 1000);

    // every order inside the window, none before it, each once
    expect(await imported(inWindow)).toHaveLength(inWindow.length);
    expect(await imported(outOfWindow)).toHaveLength(0);

    // the next delta starts from the import's high-water mark, not from 30 days ago
    const [initialRun] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, done.runId)), pools.app);
    const hwm = (initialRun!.cursor as { highWaterMark: string }).highWaterMark;
    expect(hwm).toBeTruthy();
    const delta = await run((s) => runOrdersSync(s, platform, { kind: "delta", country: "US", pageSize: 50 }));
    const [deltaRun] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, delta.runId)), pools.app);
    expect(new Date((deltaRun!.cursor as { updatedSince: string }).updatedSince).getTime()).toBe(new Date(hwm).getTime() - 120_000);

    // the console checklist counts the step done
    const checklist = await tenantChecklist(pools.admin, tenantId, now);
    expect(checklist.find((c) => c.key === "history_import")).toMatchObject({ done: true });
  });

  it("the first returns import reads the same window instead of the last 35 days", async () => {
    const since = historyImportSince(now, 24)!;
    const r = await run((s) => runReturnsSync(s, platform, { kind: "initial", country: "US", historySince: since }));
    expect(r.error).toBeNull();
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, r.runId)), pools.app);
    expect(row!.kind).toBe("initial");
    expect((row!.cursor as { updatedSince: string }).updatedSince).toBe(since.toISOString());
  });

  it("restarts the import with another window: an unfinished run is rewound in place, a finished one gets a new run", async () => {
    const svc = <T>(fn: (c: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
    // the earlier tests finished the import: a restart opens a new paused run with the new window
    const twoMonths = new Date(now.getTime() - 60 * DAY);
    const fresh = await svc((c) => restartHistoryImport(c, twoMonths));
    let status = await svc((c) => historyImportStatus(c));
    expect(status.runId).toBe(fresh.runId);
    expect(status.state).toBe("paused");
    expect(status.since?.toISOString()).toBe(twoMonths.toISOString());
    // one short step leaves it paused, then a restart with a shorter window rewinds the same run
    await svc((c) => runOrdersSync(c, platform, { kind: "initial", country: "US", budgetMs: 0, pageSize: 5, historySince: twoMonths }));
    const oneMonth = new Date(now.getTime() - 30 * DAY);
    const rewound = await svc((c) => restartHistoryImport(c, oneMonth));
    expect(rewound.runId).toBe(fresh.runId);
    expect(rewound.previousSince).toBe(twoMonths.toISOString());
    status = await svc((c) => historyImportStatus(c));
    expect(status).toMatchObject({ runId: fresh.runId, state: "paused", ordersImported: 0 });
    expect(status.since?.toISOString()).toBe(oneMonth.toISOString());
    // the next steps resume the rewound run and finish it with the new window
    for (let i = 0; i < 50; i++) {
      const r = await svc((c) => runOrdersSync(c, platform, { kind: "initial", country: "US", historySince: oneMonth }));
      if (r.finished) break;
    }
    status = await svc((c) => historyImportStatus(c));
    expect(status).toMatchObject({ runId: fresh.runId, state: "done" });
  });
});

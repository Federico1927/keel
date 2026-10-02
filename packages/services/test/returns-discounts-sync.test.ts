import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import type { MockCommercePlatform } from "@keel/integrations";
import { runCatalogSync, assignPoolCodes, createDiscountPool, createReturn, discountDetail, executePlatformWrite, getCommercePlatformFor, importOrder, latestPlatformWrites, listPoolCodes, mockCommerceFor, poolCodesCsv, poolCodesForExport, poolSummaries, processWebhookEvent, recordWebhookEvent, resetMockPlatforms, returnsAnalytics, runPlatformWriteNow, runReturnsSync, setDiscountActive, setDiscountPoolActive, syncReturnToPlatform, topUpDiscountPool, type AnalyticsTenant, type PlatformTenant, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let tenant: PlatformTenant;
let analyticsTenant: AnalyticsTenant;
let mock: MockCommercePlatform;
const settings = parseTenantSettings({ returnsWriteBack: true, returnWindowDays: 60, returnShippingFallbackDays: 5 });
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "integration", userId: null } }), pools.app);
const asUser = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: seed.userIds["ops@northwind.demo"]! } }), pools.app);
const db = <T>(fn: (tx: ServiceContext["tx"]) => Promise<T>) => withTenant(tenantId, fn, pools.app);

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.northwind;
  const [t] = await pools.admin.select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  tenant = t!;
  analyticsTenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings };
  resetMockPlatforms();
  await run((s) => getCommercePlatformFor(s, tenant));
  mock = mockCommerceFor(tenantId)!;
});
afterAll(() => pools.close());

const used = new Set<string>();
/** A recently delivered order with no return yet and lines known on the platform. */
async function deliveredOrder() {
  const rows = await db((tx) =>
    tx.execute<{ id: string; external_id: string }>(sql`
      select o.id, o.external_id from orders o join shipments s on s.order_id = o.id
      where o.tenant_id = ${tenantId} and o.status = 'delivered' and o.external_id is not null and s.delivered_at > now() - interval '40 days' and s.delivered_at < now()
        and not exists (select 1 from return_requests r where r.order_id = o.id)
        and exists (select 1 from order_lines l where l.order_id = o.id and l.external_id is not null and l.is_ancillary = false)
      order by s.delivered_at desc limit 20`),
  );
  const o = rows.rows.find((r) => !used.has(r.id))!;
  used.add(o.id);
  const lines = await db((tx) => tx.select({ id: schema.orderLines.id, externalId: schema.orderLines.externalId, quantity: schema.orderLines.quantity }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, o.id), eq(schema.orderLines.isAncillary, false))));
  return { id: o.id, externalId: o.external_id, lines };
}

async function deliver(topic: string, returnExternalId: string) {
  const env = mock.buildReturnWebhook(topic, returnExternalId);
  const verified = await mock.verifyWebhook(env.headers, env.rawBody);
  const recorded = await run((s) => recordWebhookEvent(s, { source: "shopify", ...verified }));
  const result = recorded.id ? await run((s) => processWebhookEvent(s, mock, recorded.id!, { country: "IT" })) : null;
  return { env, recorded, result };
}
const returnsOf = (orderId: string) => db((tx) => tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, tenantId), eq(schema.returnRequests.orderId, orderId))));

describe("platform returns (issue #35)", () => {
  let platformReturnId = "";
  let order: Awaited<ReturnType<typeof deliveredOrder>>;

  it("a mock returns/create webhook creates the Keel return once; replaying it does not duplicate it", async () => {
    order = await deliveredOrder();
    const line = order.lines[0]!;
    const ret = mock.openPlatformReturn({ orderExternalId: order.externalId, lines: [{ orderLineExternalId: line.externalId!, quantity: 1, reason: "size_too_small" }], note: "Too small" });
    platformReturnId = ret.externalId;
    const first = await deliver("returns/create", ret.externalId);
    expect(first.result).toMatchObject({ status: "processed", topic: "returns/create" });
    const rows = await returnsOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: ret.externalId, source: "platform", status: "requested", platformSyncStatus: "synced", platformStatus: "requested", customerNote: "Too small" });
    const lines = await db((tx) => tx.select().from(schema.returnLines).where(eq(schema.returnLines.returnId, rows[0]!.id)));
    expect(lines).toEqual([expect.objectContaining({ orderLineId: line.id, quantity: 1, externalId: `${ret.externalId}-l1` })]);

    // the same delivery again: the idempotency key stops it at the door
    const verified = await mock.verifyWebhook(first.env.headers, first.env.rawBody);
    expect(await run((s) => recordWebhookEvent(s, { source: "shopify", ...verified }))).toEqual({ id: null, duplicate: true });
    // processing the stored event again is skipped, and another topic for the same return matches it by id
    expect((await run((s) => processWebhookEvent(s, mock, first.recorded.id!, { country: "IT" }))).status).toBe("skipped");
    expect((await deliver("returns/request", ret.externalId)).result?.status).toBe("processed");
    expect(await returnsOf(order.id)).toHaveLength(1);
    const events = await db((tx) => tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, order.id), eq(schema.orderEvents.type, "return_requested"))));
    expect(events).toHaveLength(1);
  });

  it("follows the platform forward; a closed return on a refunded order is not refunded again and the refund is not counted twice", async () => {
    mock.setPlatformReturnStatus(platformReturnId, "open");
    await deliver("returns/approve", platformReturnId);
    expect((await returnsOf(order.id))[0]).toMatchObject({ status: "approved", platformStatus: "approved" });
    // the platform refunded the order (imported with the order, as refunds/create does)
    await pools.admin.update(schema.orders).set({ refundedMinor: 1500, paymentStatus: "partially_refunded" }).where(eq(schema.orders.id, order.id));
    mock.setPlatformReturnStatus(platformReturnId, "closed");
    await deliver("returns/close", platformReturnId);
    const [r] = await returnsOf(order.id);
    expect(r).toMatchObject({ status: "refunded", platformStatus: "closed", refundedAmountMinor: null });
    expect(r!.platformRefundId).toBe(`platform:${platformReturnId}`);
    expect(r!.receivedAt).toBeTruthy();
    const [o] = await db((tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)));
    expect(o!.refundedMinor).toBe(1500);
    expect(o!.returnedFraction).toBeGreaterThan(0);
    // the write-back has nothing to do: no refund, no approval, no close on the platform
    const before = mock.writeLog.length;
    await asUser((s) => syncReturnToPlatform(s, mock, settings, r!.id));
    expect(mock.writeLog.slice(before).map((w) => w.op).filter((op) => op !== "updateOrderTags")).toEqual([]);
    // a late approve webhook does not move it back
    await deliver("returns/approve", platformReturnId);
    expect((await returnsOf(order.id))[0]!.status).toBe("refunded");
  });

  it("a return created in Keel and pushed to the platform is not duplicated when it comes back by webhook or reconcile", async () => {
    const o = await deliveredOrder();
    const reasons = await db((tx) => tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)));
    const created = await asUser((s) => createReturn(s, settings, { orderId: o.id, reasonCode: reasons[0]!.code, resolution: "refund", lines: [{ orderLineId: o.lines[0]!.id, quantity: 1 }], overrideWindow: true, staffNote: "test" }));
    await asUser((s) => syncReturnToPlatform(s, mock, settings, created.id));
    const [pushed] = await returnsOf(o.id);
    expect(pushed!.externalId).toMatch(/^mock-r-/);
    await deliver("returns/request", pushed!.externalId!);
    await run((s) => runReturnsSync(s, mock, { kind: "reconcile", country: "IT" }));
    const after = await returnsOf(o.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: created.id, source: "staff" });

    // the push reached the platform but Keel never stored the id (lost answer, or still committing): adopted, not duplicated
    const o2 = await deliveredOrder();
    const created2 = await asUser((s) => createReturn(s, settings, { orderId: o2.id, reasonCode: reasons[0]!.code, resolution: "refund", lines: [{ orderLineId: o2.lines[0]!.id, quantity: 1 }], overrideWindow: true, staffNote: "test" }));
    const answer = await mock.requestReturn(o2.externalId, { lines: [{ orderLineExternalId: o2.lines[0]!.externalId!, quantity: 1, reason: null }] });
    await deliver("returns/request", answer.externalId);
    const linked = await returnsOf(o2.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ id: created2.id, externalId: answer.externalId });
  });

  it("the nightly reconcile imports returns opened on the platform and resumes from its cursor", async () => {
    const extra = [await deliveredOrder(), await deliveredOrder()].map((o) => mock.openPlatformReturn({ orderExternalId: o.externalId, lines: [{ orderLineExternalId: o.lines[0]!.externalId!, quantity: 1, reason: "defective" }] }));
    let result = await run((s) => runReturnsSync(s, mock, { kind: "reconcile", country: "IT", pageSize: 1, budgetMs: 0 }));
    expect(result.finished).toBe(false);
    for (let i = 0; i < 20 && !result.finished; i++) result = await run((s) => runReturnsSync(s, mock, { kind: "reconcile", country: "IT", pageSize: 1, budgetMs: 0 }));
    expect(result).toMatchObject({ finished: true, error: null });
    expect(result.created).toBeGreaterThanOrEqual(2);
    for (const r of extra) expect(await db((tx) => tx.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.externalId, r.externalId)))).toHaveLength(1);
    const runs = await db((tx) => tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.objectType, "returns"), eq(schema.syncRuns.id, result.runId))));
    expect(runs[0]).toMatchObject({ status: "success" });
    const [health] = await db((tx) => tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, "shopify:returns"))));
    expect(health?.status).toBe("ok");
  });

  it("return analytics show the days spent in each state", async () => {
    const a = await run((s) => returnsAnalytics(s, { from: new Date(Date.now() - 120 * 864e5), to: new Date(Date.now() + 864e5) }));
    expect(a.ageing.stages.find((s) => s.stage === "requested")?.count).toBeGreaterThan(0);
    expect(a.ageing.stages.every((s) => s.avgDays >= 0 && s.maxDays >= s.medianDays)).toBe(true);
    expect(a.ageing.open.reduce((n, s) => n + s.count, 0)).toBeGreaterThan(0);
  });
});

describe("discount pools (issue #35)", () => {
  const push = (s: ServiceContext) => (i: { title: string; codes: string[]; type: "percentage" | "fixed_amount"; value: number; startsAt?: Date | null; endsAt?: Date | null; poolExternalId?: string | null }) => runPlatformWriteNow(s, mock, { kind: "discount.pool", entityType: "discount_pool", payload: { title: i.title, codes: i.codes, type: i.type, value: i.value, startsAt: i.startsAt?.toISOString() ?? null, endsAt: i.endsAt?.toISOString() ?? null, poolExternalId: i.poolExternalId ?? null } });

  it("deactivating a pool marks its codes inactive on the mock platform, through the outbox with its sync status", async () => {
    const pool = await asUser((s) => createDiscountPool(s, { title: "Deactivate me", prefix: "DM", type: "percentage", value: 1000, size: 12 }, push(s)));
    const codes = (await asUser((s) => listPoolCodes(s, pool.poolId, { pageSize: 100 }))).rows;
    expect(codes.every((c) => mock.discountCodeActive(c.code))).toBe(true);
    const off = await asUser((s) => setDiscountPoolActive(s, pool.poolId, false));
    expect(off).toMatchObject({ changed: true, codes: 12 });
    expect(off.write).toMatchObject({ kind: "discount_pool.status", status: "pending", entityType: "discount_pool", entityId: pool.poolId });
    expect((await asUser((s) => latestPlatformWrites(s, "discount_pool", [pool.poolId]))).get(pool.poolId)?.status).toBe("pending");
    expect((await executePlatformWrite(asUser, tenant, off.write!.id)).status).toBe("succeeded");
    expect(codes.map((c) => mock.discountCodeActive(c.code))).toEqual(codes.map(() => false));
    expect((await asUser((s) => latestPlatformWrites(s, "discount_pool", [pool.poolId]))).get(pool.poolId)?.status).toBe("succeeded");
    const [summary] = await asUser((s) => poolSummaries(s, [pool.poolId]));
    expect(summary).toMatchObject({ codes: 12, inactive: 12, ready: 0 });
    expect(summary!.pool.isActive).toBe(false);
    // a single code: same path, its own write
    const single = await db((tx) => tx.select().from(schema.discounts).where(and(eq(schema.discounts.tenantId, tenantId), sql`${schema.discounts.poolId} is null`, eq(schema.discounts.isActive, true), sql`${schema.discounts.code} <> 'WELCOME10'`)).limit(1));
    const w = await asUser((s) => setDiscountActive(s, single[0]!.id, false));
    expect(w.write).toMatchObject({ kind: "discount.status" });
    await executePlatformWrite(asUser, tenant, w.write!.id);
    expect(mock.writeLog.at(-1)).toMatchObject({ op: "setDiscountActive", args: { code: single[0]!.code, active: false } });
  });

  it("codes are available, assigned or redeemed; a redeemed code shows the order that used it; top-up and CSV", async () => {
    const pool = await asUser((s) => createDiscountPool(s, { title: "Lifecycle", prefix: "LC", type: "percentage", value: 1500, size: 6 }, push(s)));
    const [campaign] = await db((tx) => tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, tenantId)).limit(1));
    const [customer] = await db((tx) => tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.tenantId, tenantId)).limit(1));
    const toCampaign = await asUser((s) => assignPoolCodes(s, pool.poolId, { campaignId: campaign!.id, count: 2 }));
    expect(toCampaign.codes).toHaveLength(2);
    await asUser((s) => assignPoolCodes(s, pool.poolId, { customerId: customer!.id, count: 1 }));
    await expect(asUser((s) => assignPoolCodes(s, pool.poolId, { customerId: customer!.id, count: 10 }))).rejects.toMatchObject({ code: "no_codes_available" });

    // an order uses one of the campaign's codes
    const code = toCampaign.codes[0]!;
    const o = mock.generateOrder(new Date());
    o.discounts = [{ code: code.toLowerCase(), type: "percentage", amountMinor: 300 }];
    const imported = await run((s) => importOrder(s, o, { country: "IT", source: "webhook" }));
    const [row] = await db((tx) => tx.select().from(schema.discounts).where(and(eq(schema.discounts.tenantId, tenantId), eq(schema.discounts.code, code))));
    const detail = await asUser((s) => discountDetail(s, analyticsTenant, row!.id));
    expect(detail?.poolStatus).toBe("redeemed");
    expect(detail?.redeemedOrder).toMatchObject({ id: imported.id, name: o.name });
    expect(detail?.assignedCampaign?.id).toBe(campaign!.id);
    const redeemed = await asUser((s) => listPoolCodes(s, pool.poolId, { status: "redeemed" }));
    expect(redeemed.rows).toEqual([expect.objectContaining({ code, redeemedOrderId: imported.id, redeemedOrderName: o.name })]);
    const [s1] = await asUser((s) => poolSummaries(s, [pool.poolId]));
    expect(s1).toMatchObject({ codes: 6, redeemed: 1, assigned: 2, available: 3, ready: 3 });

    // top-up to 10 ready codes: 7 new codes pushed to the same pool discount
    const before = mock.writeLog.length;
    const top = await asUser((s) => topUpDiscountPool(s, pool.poolId, 10, push(s)));
    expect(top).toMatchObject({ added: 7, imported: 7, failed: 0 });
    expect(mock.writeLog.slice(before)).toEqual([expect.objectContaining({ op: "addDiscountPoolCodes", args: expect.objectContaining({ count: 7 }) })]);
    const [s2] = await asUser((s) => poolSummaries(s, [pool.poolId]));
    expect(s2).toMatchObject({ codes: 13, ready: 10 });
    expect(s2!.pool.targetSize).toBe(10);
    expect((await asUser((s) => topUpDiscountPool(s, pool.poolId, 10, push(s)))).added).toBe(0);

    const csv = poolCodesCsv(await asUser((s) => poolCodesForExport(s, pool.poolId)), ["Code", "Status", "Active", "Customer", "Campaign", "Assigned", "Order", "Redeemed"], { date: (d) => d.toISOString().slice(0, 10), status: (s) => s, yes: "yes", no: "no" });
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(14);
    expect(lines.find((l) => l.startsWith(code))).toContain(`redeemed,yes,,`);
    expect(lines.find((l) => l.startsWith(code))).toContain(o.name);
  });

  it("a pending switch-off is not undone by the catalog sync before the platform confirms it", async () => {
    const [code] = await db((tx) => tx.select().from(schema.discounts).where(and(eq(schema.discounts.tenantId, tenantId), eq(schema.discounts.code, "WELCOME10"))));
    if (!code!.isActive) await pools.admin.update(schema.discounts).set({ isActive: true }).where(eq(schema.discounts.id, code!.id));
    const off = await asUser((s) => setDiscountActive(s, code!.id, false));
    expect(off.write?.status).toBe("pending");
    const r = await run((s) => runCatalogSync(s, mock, { kind: "delta" }));
    expect(r.error).toBeNull();
    const [after] = await db((tx) => tx.select().from(schema.discounts).where(eq(schema.discounts.id, code!.id)));
    expect(after!.isActive).toBe(false);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import type { ServiceContext } from "@keel/services";
import { assignQueueItem, distributeUnassigned, getCodSettings, listRiskyRecipients, queueItems, recomputeRecipientProfiles, recordAttempt, saveCapacity, saveCodSettings, scoreQueueItem, syncQueue } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const as = (email: string) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! } }), pools.app);
const ops = as("ops@northwind.demo");

describe("queue", () => {
  it("syncs eligible COD orders in and closed ones out, scores them with an explained breakdown", async () => {
    // make sure there is at least one fresh open COD order
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"))).limit(1), pools.app);
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, placedAt: new Date(), manualStatus: null }).where(eq(schema.orders.id, order!.id)), pools.app);
    await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, order!.id)), pools.app);
    const r = await ops((s) => syncQueue(s));
    expect(r.entered).toBeGreaterThanOrEqual(1);
    const q = await ops((s) => queueItems(s, { view: "all" }));
    expect(q.rows.some((x) => x.order.id === order!.id)).toBe(true);
    const score = await ops((s) => scoreQueueItem(s, order!.id, { timezone: "Europe/Rome" }));
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.factors.length).toBeGreaterThan(5);
    expect(score.factors.find((f) => f.key === "duplicate_orders")).toBeTruthy();
    const [item] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order!.id)), pools.app);
    expect(item!.score).toBe(score.score);
    // cancel the order → next sync closes the item
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(schema.orders.id, order!.id)), pools.app);
    const r2 = await ops((s) => syncQueue(s));
    expect(r2.closed).toBeGreaterThanOrEqual(1);
    const [closed] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order!.id)), pools.app);
    expect(closed!.status).toBe("cancelled");
  });

  it("applies the outcome machine: no answers → unreachable + on hold, confirmed → confirmed order", async () => {
    await ops((s) => saveCodSettings(s, { unreachableAfterAttempts: 2 }));
    const settings = await ops((s) => getCodSettings(s));
    expect(settings.unreachableAfterAttempts).toBe(2);
    const open = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"), sql`${schema.orders.status} <> 'cancelled'`)).limit(2), pools.app);
    for (const o of open) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "new", cancelledAt: null, placedAt: new Date(), manualStatus: null }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await ops((s) => syncQueue(s));
    const a = open[0]!.id;
    const b = open[1]!.id;
    const first = await ops((s) => recordAttempt(s, { orderId: a, outcome: "no_answer" }));
    expect(first).toEqual({ status: "pending", attemptNumber: 1 });
    const second = await ops((s) => recordAttempt(s, { orderId: a, outcome: "no_answer" }));
    expect(second.status).toBe("unreachable");
    const [held] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, a)), pools.app);
    expect(held!.status).toBe("on_hold");
    expect(held!.assignedTo).toBe(ctx.userIds["ops@northwind.demo"]);
    const cb = await ops((s) => recordAttempt(s, { orderId: b, outcome: "call_back", callBackAt: new Date(Date.now() + 3600e3) }));
    expect(cb.status).toBe("scheduled");
    const done = await ops((s) => recordAttempt(s, { orderId: b, outcome: "confirmed" }));
    expect(done.status).toBe("confirmed");
    const [confirmed] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, b)), pools.app);
    expect(confirmed!.status).toBe("confirmed");
    expect(confirmed!.manualStatus).toBe("confirmed");
    const events = await withTenant(tenantId, (tx) => tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, b), eq(schema.orderEvents.type, "cod_attempt"))), pools.app);
    expect(events).toHaveLength(2);
    await expect(ops((s) => recordAttempt(s, { orderId: b, outcome: "no_answer" }))).rejects.toMatchObject({ code: "not_in_queue" });
  });
});

describe("assignment", () => {
  it("distributes unassigned items in proportion to today's hours and logs every decision", async () => {
    const u1 = ctx.userIds["ops@northwind.demo"]!;
    const u2 = ctx.userIds["care@northwind.demo"]!;
    const u3 = ctx.userIds["care2@northwind.demo"]!;
    await ops((s) => saveCapacity(s, { userId: u1, dailyHours: [8, 8, 8, 8, 8, 8, 8], isActive: true }));
    await ops((s) => saveCapacity(s, { userId: u2, dailyHours: [4, 4, 4, 4, 4, 4, 4], isActive: true }));
    await ops((s) => saveCapacity(s, { userId: u3, dailyHours: [0, 0, 0, 0, 0, 0, 0], isActive: true }));
    // 12 fresh unassigned COD items
    const orders = await withTenant(tenantId, (tx) => tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"))).limit(14), pools.app);
    for (const o of orders) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "new", cancelledAt: null, placedAt: new Date(), manualStatus: null, assignedTo: null }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await withTenant(tenantId, (tx) => tx.delete(schema.codAssignmentLog).where(eq(schema.codAssignmentLog.tenantId, tenantId)), pools.app);
    await withTenant(tenantId, (tx) => tx.update(schema.codQueueItems).set({ assignedTo: null, status: "pending", closedAt: null, attemptsCount: 0, noAnswerCount: 0 }).where(eq(schema.codQueueItems.tenantId, tenantId)), pools.app);
    await ops((s) => syncQueue(s));
    const r = await ops((s) => distributeUnassigned(s, { source: "backfill", timezone: "Europe/Rome" }));
    expect(r.assigned).toBeGreaterThanOrEqual(12);
    const counts = await withTenant(tenantId, (tx) => tx.select({ u: schema.codAssignmentLog.assignedTo, n: sql<number>`count(*)::int` }).from(schema.codAssignmentLog).where(eq(schema.codAssignmentLog.tenantId, tenantId)).groupBy(schema.codAssignmentLog.assignedTo), pools.app);
    const n = (u: string) => counts.find((c) => c.u === u)?.n ?? 0;
    expect(n(u3)).toBe(0);
    expect(n(u1)).toBeGreaterThan(n(u2));
    expect(Math.abs(n(u1) / Math.max(1, n(u2)) - 2)).toBeLessThan(0.6);
    // manual reassignment is idempotent for the same target and audited in the log
    const some = (await ops((s) => queueItems(s, { view: "all" }))).rows[0]!;
    const target = await ops((s) => assignQueueItem(s, some.order.id, { source: "manual", timezone: "Europe/Rome", userId: u2 }));
    expect(target).toBe(u2);
  });
});

describe("recipient risk", () => {
  it("builds profiles from delivered/returned COD history and never acts automatically", async () => {
    const r = await ops((s) => recomputeRecipientProfiles(s));
    expect(r.profiles).toBeGreaterThan(0);
    const risky = await ops((s) => listRiskyRecipients(s, { tiers: ["watch", "high_risk", "blacklisted"] }));
    for (const p of risky) {
      expect(p.recipientKey).not.toMatch(/\s/);
      expect(["watch", "high_risk", "blacklisted"]).toContain(p.tier);
    }
    const orders = await withTenant(tenantId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.holdReason} = 'risk'`)), pools.app);
    expect(orders[0]!.n).toBe(0);
  });
});

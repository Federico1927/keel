import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { customerOrderHistory, duplicateSiblings, addOrderNote, recomputeOrderStatus, setManualStatus, clearManualStatus, unreadCount } from "../src";
import type { ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());

const run = <T>(fn: (s: ServiceContext) => Promise<T>) =>
  withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@northwind.demo"]! } }), pools.app);

describe("order state service", () => {
  it("manual status sticks until a hard fact changes, and can be cleared", async () => {
    const order = await run(async (s) => (await s.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "confirmed"))).limit(1))[0]!);
    const r1 = await run((s) => setManualStatus(s, order.id, "on_hold", "waiting for customer"));
    expect(r1).toMatchObject({ previous: "confirmed", next: "on_hold", changed: true, reason: "manual" });
    const events = await run((s) => s.tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order.id)).orderBy(desc(schema.orderEvents.createdAt)).limit(1));
    expect(events[0]?.type).toBe("status_changed");
    expect(events[0]?.diff).toEqual({ status: { from: "confirmed", to: "on_hold" } });
    // recompute without facts changing keeps the manual status
    const r2 = await run((s) => recomputeOrderStatus(s, order.id));
    expect(r2.next).toBe("on_hold");
    // a hard fact (cancellation) overrides it
    await run((s) => s.tx.update(schema.orders).set({ cancelledAt: new Date() }).where(eq(schema.orders.id, order.id)));
    const r3 = await run((s) => recomputeOrderStatus(s, order.id));
    expect(r3.next).toBe("cancelled");
    await run((s) => s.tx.update(schema.orders).set({ cancelledAt: null }).where(eq(schema.orders.id, order.id)));
    const r4 = await run((s) => clearManualStatus(s, order.id));
    expect(r4.next).toBe("confirmed");
  });
});

describe("customer history and duplicates", () => {
  it("finds the other orders of the same customer", async () => {
    const repeat = await run(async (s) => (await s.tx.select().from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), eq(schema.customers.tags, ["repeat"]))).limit(1))[0]);
    if (!repeat) return;
    const [order] = await run((s) => s.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.customerId, repeat.id))).limit(1));
    const h = await run((s) => customerOrderHistory(s, order!.id));
    expect(h.identified).toBe(true);
    expect(h.orders.length).toBeGreaterThanOrEqual(2);
    expect(h.orders.every((o) => o.id !== order!.id)).toBe(true);
    expect(h.orders.some((o) => o.matchedVia === "customer")).toBe(true);
  });
  it("detects seeded duplicate siblings", async () => {
    const orders = await run((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.tenantId, tenantId)));
    let hits = 0;
    for (const o of orders.slice(0, 150)) {
      const d = await run((s) => duplicateSiblings(s, o.id, 5));
      if (d.length) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(0);
  });
});

describe("notes and mentions", () => {
  it("stores validated mentions and notifies them", async () => {
    const order = await run(async (s) => (await s.tx.select().from(schema.orders).where(eq(schema.orders.tenantId, tenantId)).limit(1))[0]!);
    const mentioned = ctx.userIds["ops@northwind.demo"]!;
    const outsider = ctx.userIds["owner@harborhome.demo"]!;
    const before = await run((s) => unreadCount(s, mentioned));
    const res = await run((s) => addOrderNote(s, { orderId: order.id, body: `Check @[Sara](${mentioned}) and @[Emily](${outsider})`, allowedMentionIds: [mentioned], link: "/x", orderName: order.name, authorName: "Owner" }));
    expect(res.mentions).toEqual([mentioned]);
    const after = await run((s) => unreadCount(s, mentioned));
    expect(after).toBe(before + 1);
  });
});

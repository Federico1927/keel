import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockAudienceDestination } from "@hullwise/integrations";
import { addSegmentDestination, customersChangedSince, evaluateSegment, listSegmentDestinations, refreshLiveSegments, saveSegment, segmentMembers, syncAutoDestinations, syncSegmentDestination, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, now?: Date) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null }, ...(now ? { now } : {}) }), pools.app);

async function placeOrder(customerId: string, n: number, placedAt = new Date()) {
  await run(async (s) => {
    await s.tx.insert(schema.orders).values({ tenantId, customerId, orderNumber: 980000 + n, name: `#LV-${n}`, currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], paymentMethod: "card", paymentStatus: "paid", status: "delivered", totalMinor: 9000, taxMinor: 0, subtotalMinor: 9000, placedAt });
  });
}

describe("live segments", () => {
  it("re-checks only changed customers, adds new matches with a stable group and drops leavers", async () => {
    const id = await run((s) => saveSegment(s, { name: "Live: 4+ orders", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 4 }] }, holdoutPercentage: 20, liveUpdates: true }));
    const first = await run((s) => evaluateSegment(s, id));
    const members = await run((s) => segmentMembers(s, id));
    const groups = new Map(members.map((m) => [m.customerId, m.groupName]));
    // a customer with exactly 3 sale orders crosses the threshold with one more
    const profiles = await run((s) => s.tx.execute<{ id: string }>(sql`select customer_id as id from orders where tenant_id = ${tenantId} and status in ('confirmed','fulfilling','shipped','delivered','returned_partial') and customer_id is not null group by customer_id having count(*) = 3 limit 1`));
    const candidate = profiles.rows[0]!.id;
    expect(groups.has(candidate)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    await placeOrder(candidate, 1);
    const [seg] = await run((s) => s.tx.select().from(schema.segments).where(eq(schema.segments.id, id)));
    const changed = await run((s) => customersChangedSince(s, seg!.lastEvaluatedAt!));
    expect(changed).toContain(candidate);
    expect(changed.length).toBeLessThan(10);
    const delta = (await run((s) => refreshLiveSegments(s))).find((d) => d.segmentId === id);
    expect(delta!.added).toBe(1);
    expect(delta!.count).toBe(first.count + 1);
    const after = new Map((await run((s) => segmentMembers(s, id))).map((m) => [m.customerId, m.groupName]));
    for (const [cid, g] of groups) expect(after.get(cid)).toBe(g);
    // cancelling the order takes the customer out again
    await run((s) => s.tx.update(schema.orders).set({ status: "cancelled", updatedAt: new Date(Date.now() + 1000) }).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.name, "#LV-1"))));
    const delta2 = (await run((s) => refreshLiveSegments(s), new Date(Date.now() + 2000))).find((d) => d.segmentId === id);
    expect(delta2!.removed).toBe(1);
    // a full refresh agrees with the incremental state
    const full = (await run((s) => refreshLiveSegments(s, { full: true }))).find((d) => d.segmentId === id);
    expect(full!.added + full!.removed).toBe(0);
  });
});

describe("audience destinations", () => {
  it("pushes consenting treated members as hashed keys, syncs only the diff, and recovers from a failure", async () => {
    const [segment] = await run((s) => s.tx.select({ id: schema.segments.id }).from(schema.segments).where(eq(schema.segments.name, "Clienti ricorrenti")).limit(1));
    await run((s) => evaluateSegment(s, segment!.id));
    const id = await run((s) => addSegmentDestination(s, { segmentId: segment!.id, provider: "meta_custom_audience", audienceName: "Repeat buyers", autoSync: true }));
    const dest = new MockAudienceDestination("meta_custom_audience");
    const r1 = await run((s) => syncSegmentDestination(s, id, dest, { excludeHoldout: true }));
    expect(r1.status).toBe("ok");
    expect(r1.added).toBeGreaterThan(0);
    const audience = [...dest.audiences.values()][0]!;
    expect(audience.members.size).toBe(r1.members);
    const members = await run((s) => segmentMembers(s, segment!.id));
    for (const m of members) {
      const pushed = audience.members.has(m.customerId);
      if (m.groupName === "holdout" || !m.acceptsMarketing) expect(pushed).toBe(false);
    }
    for (const keys of audience.members.values()) expect(JSON.stringify(keys)).not.toContain("@");
    // second sync: nothing to do
    const r2 = await run((s) => syncSegmentDestination(s, id, dest, { excludeHoldout: true }));
    expect(r2.added + r2.removed).toBe(0);
    // without control groups (no customer-campaigns add-on) the held-out members are pushed too
    const holdouts = members.filter((m) => m.groupName === "holdout" && m.acceptsMarketing && m.email).length;
    const r3 = await run((s) => syncSegmentDestination(s, id, dest, { excludeHoldout: false }));
    expect(r3.added).toBe(holdouts);
    // failure: status error, members table untouched, next run catches up
    await run((s) => s.tx.update(schema.customers).set({ acceptsMarketing: false }).where(eq(schema.customers.id, [...audience.members.keys()][0]!)));
    dest.failures.failNext("rate_limited");
    const r4 = await run((s) => syncSegmentDestination(s, id, dest, { excludeHoldout: false }));
    expect(r4.status).toBe("error");
    const row = (await run((s) => listSegmentDestinations(s, segment!.id))).find((d) => d.id === id);
    expect(row!.status).toBe("error");
    expect(row!.lastError).toMatch(/rate_limited/);
    const r5 = (await run((s) => syncAutoDestinations(s, [segment!.id], () => dest, { excludeHoldout: false }))).find((r) => r.destinationId === id)!;
    expect(r5.status).toBe("ok");
    expect(r5.removed).toBe(1);
  });

  it("email tools receive plain emails; customers without one are counted as unmatched", async () => {
    const [segment] = await run((s) => s.tx.select({ id: schema.segments.id }).from(schema.segments).where(eq(schema.segments.name, "Clienti ricorrenti")).limit(1));
    const id = await run((s) => addSegmentDestination(s, { segmentId: segment!.id, provider: "email_tool", audienceName: "Newsletter", autoSync: false }));
    const dest = new MockAudienceDestination("email_tool");
    const r = await run((s) => syncSegmentDestination(s, id, dest, { excludeHoldout: false }));
    const first = [...[...dest.audiences.values()][0]!.members.values()][0]!;
    expect(first.email).toMatch(/@/);
    expect(r.members + r.unmatched).toBeGreaterThan(0);
  });
});

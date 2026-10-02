import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { buildRfmMatrix, evaluateRules, type SegmentGroup } from "@hullwise/core";
import { customerDetail, customerProfiles, evaluateSegment, listCustomers, previewSegment, saveSegment, segmentMembers, SegmentRuleError, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["marketing@northwind.demo"]! } }), pools.app);

describe("segments", () => {
  const nested: SegmentGroup = {
    match: "all",
    conditions: [
      { field: "orders_count", op: "gte", value: 1 },
      { match: "any", conditions: [{ field: "accepts_marketing", op: "eq", value: true }, { match: "all", conditions: [{ field: "total_spent", op: "gte", value: 15000 }, { field: "days_since_last_order", op: "lte", value: 365 }] }] },
      { field: "rfm_tier", op: "not_in", value: ["lost"] },
    ],
  };

  it("the SQL compiler and the in-memory evaluator agree on a nested segment", async () => {
    const now = new Date();
    const [profiles, preview] = await Promise.all([run((s) => customerProfiles({ ...s, now })), run((s) => previewSegment({ ...s, now }, nested))]);
    const expected = profiles.filter((p) => evaluateRules(nested, p, now));
    expect(profiles.length).toBeGreaterThan(50);
    expect(expected.length).toBeGreaterThan(0);
    expect(preview.count).toBe(expected.length);
    expect(preview.sample.length).toBeGreaterThan(0);
    for (const s of preview.sample) expect(expected.some((e) => e.customerId === s.customerId)).toBe(true);
  });

  it("array and product fields compile", async () => {
    const profiles = await run((s) => customerProfiles(s));
    const withProducts = profiles.find((p) => p.productIds.length > 0)!;
    const rules: SegmentGroup = { match: "all", conditions: [{ field: "bought_product", op: "any", value: [withProducts.productIds[0]!] }, { field: "payment_methods", op: "any", value: ["card", "cod", "wallet", "paypal", "bank_transfer", "bnpl", "other"] }] };
    const preview = await run((s) => previewSegment(s, rules));
    const expected = profiles.filter((p) => evaluateRules(rules, p));
    expect(preview.count).toBe(expected.length);
    expect(preview.count).toBeGreaterThan(0);
  });

  it("rejects invalid rules before touching SQL", async () => {
    await expect(run((s) => previewSegment(s, { match: "all", conditions: [{ field: "orders_count", op: "gte", value: "2; drop table customers" }] }))).rejects.toBeInstanceOf(SegmentRuleError);
    await expect(run((s) => saveSegment(s, { name: "x", rules: { match: "all", conditions: [] }, holdoutPercentage: 10 }))).rejects.toBeInstanceOf(SegmentRuleError);
  });

  it("evaluates a segment with a stable holdout and removes stale members", async () => {
    const id = await run((s) => saveSegment(s, { name: "Repeat buyers (test)", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] }, holdoutPercentage: 20 }));
    const first = await run((s) => evaluateSegment(s, id));
    expect(first.count).toBeGreaterThan(0);
    expect(first.holdout).toBeGreaterThan(0);
    const membersA = await run((s) => segmentMembers(s, id));
    const second = await run((s) => evaluateSegment(s, id));
    const membersB = await run((s) => segmentMembers(s, id));
    expect(second).toEqual(first);
    expect(new Map(membersB.map((m) => [m.customerId, m.groupName]))).toEqual(new Map(membersA.map((m) => [m.customerId, m.groupName])));
    // tighten the rule: members drop out, survivors keep their group
    await run((s) => saveSegment(s, { name: "Repeat buyers (test)", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 3 }] }, holdoutPercentage: 20 }, id));
    const third = await run((s) => evaluateSegment(s, id));
    const membersC = await run((s) => segmentMembers(s, id));
    expect(third.count).toBeLessThan(first.count);
    for (const m of membersC) {
      expect(m.ordersCount).toBeGreaterThanOrEqual(3);
      expect(membersA.find((a) => a.customerId === m.customerId)?.groupName).toBe(m.groupName);
    }
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.segments).where(eq(schema.segments.id, id)), pools.app);
    expect(row!.lastCount).toBe(third.count);
  });
});

describe("customers", () => {
  it("lists with search and filters, and the detail carries orders and segments", async () => {
    const all = await run((s) => listCustomers(s, { sort: "total_spent" }));
    expect(all.total).toBeGreaterThan(50);
    expect(all.rows[0]!.totalSpentMinor).toBeGreaterThanOrEqual(all.rows[1]!.totalSpentMinor);
    const top = all.rows[0]!;
    const byEmail = await run((s) => listCustomers(s, { q: top.email!.slice(0, 8) }));
    expect(byEmail.rows.some((r) => r.customerId === top.customerId)).toBe(true);
    const marketing = await run((s) => listCustomers(s, { acceptsMarketing: true, tier: "champions" }));
    for (const r of marketing.rows) {
      expect(r.acceptsMarketing).toBe(true);
      expect(r.tier).toBe("champions");
    }
    const detail = await run((s) => customerDetail(s, top.customerId));
    expect(detail!.orders.length).toBeGreaterThan(0);
    expect(detail!.customer.ordersCount).toBeLessThanOrEqual(detail!.orders.length);
  });

  it("rfm matrix covers every customer with at least one sale", async () => {
    const profiles = await run((s) => customerProfiles(s));
    const m = buildRfmMatrix(profiles);
    expect(m.total).toBe(profiles.filter((p) => p.ordersCount > 0).length);
    expect(m.cells.reduce((s, c) => s + c.customers, 0)).toBe(m.total);
    expect(m.tiers.reduce((s, t) => s + t.customers, 0)).toBe(m.total);
  });
});

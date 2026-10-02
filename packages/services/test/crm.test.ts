import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { buildRfmMatrix, dominantOptionValues, evaluateRules, type SegmentGroup } from "@hullwise/core";
import { customerDetail, customerProfiles, evaluateSegment, evaluateSegmentForCustomers, listCustomers, previewSegment, saveSegment, segmentInsights, segmentMembers, SegmentRuleError, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, id = tenantId) => withTenant(id, (tx) => fn({ tenantId: id, tx, actor: { type: "user", userId: ctx.userIds["marketing@northwind.demo"]! } }), pools.app);

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

describe("segment fields for campaigns (#34): same meaning in SQL and in memory", () => {
  const leaves = (profiles: Awaited<ReturnType<typeof customerProfiles>>) => {
    const withOptions = profiles.find((p) => Object.keys(p.dominantOptions ?? {}).length > 0)!;
    const [option, value] = Object.entries(withOptions.dominantOptions!)[0]!;
    const category = Object.keys(profiles.find((p) => Object.keys(p.categoryLastDays ?? {}).length > 0)!.categoryLastDays!)[0]!;
    return [
      { field: "open_order", op: "eq", value: true },
      { field: "open_order", op: "eq", value: false },
      { field: "bought_in_window", op: "any", value: [30, 90] },
      { field: "bought_in_window", op: "none", value: [0, 60] },
      { field: "bought_category", op: "any", value: [category] },
      { field: "bought_category", op: "any", value: [category], days: 120 },
      { field: "bought_category", op: "none", value: [category], days: 60 },
      { field: "bought_category", op: "all", value: [category], days: 365 },
      { field: "dominant_option", op: "in", value: [value], option },
      { field: "dominant_option", op: "not_in", value: [value], option },
      { field: "dominant_option", op: "in", value: [value], option: "No such option" },
      { field: "days_since_last_marketing", op: "lte", value: 60 },
      { field: "days_since_last_marketing", op: "is_null" },
    ] as const;
  };

  it("each new field, and a nested mix, count the same customers in SQL and in memory", async () => {
    const now = new Date();
    const profiles = await run((s) => customerProfiles({ ...s, now }, undefined, { extended: true }));
    for (const leaf of leaves(profiles)) {
      const rules: SegmentGroup = { match: "all", conditions: [leaf as never] };
      const preview = await run((s) => previewSegment({ ...s, now }, rules, 50));
      const expected = profiles.filter((p) => evaluateRules(rules, p, now));
      expect({ leaf, count: preview.count }).toEqual({ leaf, count: expected.length });
      for (const x of preview.sample) expect(expected.some((e) => e.customerId === x.customerId)).toBe(true);
    }
    const [a, , , b, c, , , , d] = leaves(profiles);
    const nested: SegmentGroup = { match: "any", conditions: [{ match: "all", conditions: [a as never, b as never] }, { match: "all", conditions: [c as never, { match: "any", conditions: [d as never, { field: "days_since_last_marketing", op: "not_null" }] }] }] };
    const preview = await run((s) => previewSegment({ ...s, now }, nested));
    expect(preview.count).toBe(profiles.filter((p) => evaluateRules(nested, p, now)).length);
    expect(preview.count).toBeGreaterThan(0);
  });

  it("the profile's dominant option is the core rule applied to the customer's bought lines", async () => {
    const profiles = await run((s) => customerProfiles(s, undefined, { extended: true }));
    const sample = profiles.filter((p) => p.ordersCount > 1).slice(0, 25);
    const lines = await run((s) => s.tx.execute<{ customer_id: string; option_values: Record<string, string>; quantity: number }>(sql`
      select o.customer_id, pv.option_values, l.quantity from orders o join order_lines l on l.order_id = o.id join product_variants pv on pv.id = l.variant_id
      where o.tenant_id = ${tenantId} and o.status in ('confirmed', 'fulfilling', 'shipped', 'delivered', 'returned_partial') and o.customer_id = any(${sql.param(sample.map((p) => p.customerId))}::uuid[])`));
    for (const p of sample) expect(p.dominantOptions).toEqual(dominantOptionValues(lines.rows.filter((l) => l.customer_id === p.customerId).map((l) => ({ optionValues: l.option_values, quantity: l.quantity }))));
  });

  it("incremental evaluation agrees with a full one on the new fields", async () => {
    const profiles = await run((s) => customerProfiles(s, undefined, { extended: true }));
    const [, , win, , , cat, , , dom] = leaves(profiles);
    const id = await run((s) => saveSegment(s, { name: "New fields (test)", rules: { match: "all", conditions: [win as never, { match: "any", conditions: [cat as never, dom as never] }] }, holdoutPercentage: 0 }));
    const full = await run((s) => evaluateSegment(s, id));
    const members = new Set((await run((s) => segmentMembers(s, id))).map((m) => m.customerId));
    const some = profiles.slice(0, 200).map((p) => p.customerId);
    const delta = await run((s) => evaluateSegmentForCustomers(s, id, some));
    expect(delta.added + delta.removed).toBe(0);
    expect(delta.count).toBe(full.count);
    expect(members.size).toBe(full.count);
  });
});

describe("segment insights (core CRM)", () => {
  it("top products, categories and option values, average spend and channel mix of the members", async () => {
    const id = await run((s) => saveSegment(s, { name: "Insights (test)", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] }, holdoutPercentage: 0 }));
    await run((s) => evaluateSegment(s, id));
    const members = await run((s) => segmentMembers(s, id));
    const ins = await run((s) => segmentInsights(s, id));
    expect(ins.members).toBe(members.length);
    expect(ins.buyers).toBe(members.length);
    const spent = members.reduce((a, m) => a + m.totalSpentMinor, 0);
    expect(ins.avgSpentMinor).toBe(Math.round(spent / members.length));
    expect(ins.topProducts.length).toBeGreaterThan(0);
    expect(ins.topProducts[0]!.units).toBeGreaterThanOrEqual(ins.topProducts.at(-1)!.units);
    expect(ins.topCategories.length).toBeGreaterThan(0);
    expect(ins.topOptionValues.length).toBeGreaterThan(0);
    expect(ins.channels.reduce((a, c) => a + c.orders, 0)).toBe(members.reduce((a, m) => a + m.ordersCount, 0));
    expect(ins.reachable.email).toBeLessThanOrEqual(ins.members);
  });

  it("work on a store without the customer-campaigns add-on", async () => {
    const harbor = ctx.tenantIds.harbor;
    const id = await run((s) => saveSegment(s, { name: "Harbor new fields", rules: { match: "all", conditions: [{ field: "bought_in_window", op: "any", value: [0, 365] }, { field: "open_order", op: "eq", value: false }, { field: "days_since_last_marketing", op: "is_null" }] }, holdoutPercentage: 0 }), harbor);
    const r = await run((s) => evaluateSegment(s, id), harbor);
    expect(r.count).toBeGreaterThan(0);
    const ins = await run((s) => segmentInsights(s, id), harbor);
    expect(ins.members).toBe(r.count);
    expect(ins.topProducts.length).toBeGreaterThan(0);
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

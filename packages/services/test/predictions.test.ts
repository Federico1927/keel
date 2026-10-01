import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { CHURN_RISKS, evaluateRules, type SegmentGroup } from "@keel/core";
import { customerDetail, customerProfiles, listCustomers, predictionModelInfo, predictionOverview, previewSegment, recomputePredictions, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, id = tenantId) => withTenant(id, (tx) => fn({ tenantId: id, tx, actor: { type: "system", userId: null } }), pools.app);
const DEFAULTS = { churnLowPct: 70, churnMediumPct: 40 };

describe("customer predictions", () => {
  it("the seed stores a fitted model with a back-test and one prediction per buying customer", async () => {
    const info = await run((s) => predictionModelInfo(s));
    expect(info?.status).toBe("ok");
    expect(info!.params!.mbg.a).toBeGreaterThan(1);
    expect(info!.calibration!.customers).toBeGreaterThan(0);
    const profiles = await run((s) => customerProfiles(s));
    const buyers = profiles.filter((p) => p.ordersCount > 0);
    expect(profiles.filter((p) => p.churnRisk).length).toBe(buyers.length);
  });

  it("recompute replaces the predictions and honours the tenant thresholds", async () => {
    const r = await run((s) => recomputePredictions(s, { churnLowPct: 100, churnMediumPct: 0 }));
    expect(r.status).toBe("ok");
    const strict = await run((s) => predictionOverview(s));
    expect(strict.byRisk.find((b) => b.risk === "low")!.customers).toBe(0);
    expect(strict.byRisk.find((b) => b.risk === "high")!.customers).toBe(0);
    await run((s) => recomputePredictions(s, DEFAULTS));
    const o = await run((s) => predictionOverview(s));
    expect(o.byRisk.reduce((sum, b) => sum + b.customers, 0)).toBe(r.customers);
    expect(o.byRisk.filter((b) => b.customers > 0).length).toBeGreaterThan(1);
    expect(o.expectedOrders365).toBeGreaterThan(o.expectedOrders90);
    expect(o.top[0]!.predictedValue365Minor).toBeGreaterThanOrEqual(o.top[o.top.length - 1]!.predictedValue365Minor);
    for (const s of o.slipping) expect(["medium", "high"]).toContain(s.churnRisk);
  });

  it("prediction fields compile to SQL with the same result as the evaluator", async () => {
    const now = new Date();
    const rules: SegmentGroup = {
      match: "any",
      conditions: [
        { field: "churn_risk", op: "in", value: ["high"] },
        { match: "all", conditions: [{ field: "p_alive", op: "gte", value: 55.5 }, { field: "predicted_value", op: "gte", value: 5000 }] },
        { field: "days_to_next_order", op: "lte", value: -10 },
      ],
    };
    const [profiles, preview] = await Promise.all([run((s) => customerProfiles({ ...s, now })), run((s) => previewSegment({ ...s, now }, rules))]);
    const expected = profiles.filter((p) => evaluateRules(rules, p, now));
    expect(expected.length).toBeGreaterThan(0);
    expect(preview.count).toBe(expected.length);
  });

  it("the customer list filters by churn risk and sorts by predicted value; the detail carries the prediction", async () => {
    const list = await run((s) => listCustomers(s, { churnRisk: "low", sort: "predicted_value", pageSize: 20 }));
    expect(list.rows.length).toBeGreaterThan(0);
    for (const r of list.rows) expect(r.churnRisk).toBe("low");
    for (let i = 1; i < list.rows.length; i++) expect(list.rows[i - 1]!.predictedValueMinor!).toBeGreaterThanOrEqual(list.rows[i]!.predictedValueMinor!);
    const d = await run((s) => customerDetail(s, list.rows[0]!.customerId));
    expect(CHURN_RISKS).toContain(d!.prediction!.churnRisk);
    expect(d!.prediction!.predictedValue365Minor).toBe(list.rows[0]!.predictedValueMinor);
  });

  it("a tenant never sees another tenant's predictions", async () => {
    const other = ctx.tenantIds.harbor;
    const [a] = await withTenant(tenantId, (tx) => tx.select({ customerId: schema.customerPredictions.customerId }).from(schema.customerPredictions).limit(1), pools.app);
    const leaked = await withTenant(other, (tx) => tx.select().from(schema.customerPredictions).where(eq(schema.customerPredictions.customerId, a!.customerId)), pools.app);
    expect(leaked).toHaveLength(0);
  });
});

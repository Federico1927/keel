import { describe, expect, it } from "vitest";
import { assignHoldout, buildRfmMatrix, evaluateRules, normCdf, rfmTier, stableBucket, twoProportionTest, validateSegmentRules, type CustomerProfile, type SegmentGroup } from "./segments";

const base: CustomerProfile = { customerId: "c1", ordersCount: 3, cancelledCount: 0, returnsCount: 1, totalSpentMinor: 30000, aovMinor: 10000, daysSinceLastOrder: 20, daysSinceFirstOrder: 400, acceptsMarketing: true, country: "IT", tags: ["vip"], paymentMethods: ["card"], productIds: ["11111111-1111-4111-8111-111111111111"], productTypes: ["Shoes"], randomPct: 42 };

describe("segment rules", () => {
  it("validates shape, fields, ops, depth and leaf count", () => {
    expect(validateSegmentRules({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] }).errors).toEqual([]);
    expect(validateSegmentRules({ match: "all", conditions: [{ field: "nope", op: "gte", value: 2 }] }).errors[0]?.code).toBe("unknown_field");
    expect(validateSegmentRules({ match: "all", conditions: [{ field: "accepts_marketing", op: "gte", value: 2 }] }).errors[0]?.code).toBe("bad_op");
    expect(validateSegmentRules({ match: "all", conditions: [{ field: "bought_product", op: "any", value: ["not-a-uuid"] }] }).errors[0]?.code).toBe("bad_value");
    expect(validateSegmentRules({ match: "all", conditions: [{ match: "any", conditions: [] }] }).errors[0]?.code).toBe("empty_group");
    const deep = { match: "all", conditions: [{ match: "any", conditions: [{ match: "all", conditions: [{ match: "any", conditions: [{ field: "orders_count", op: "gte", value: 1 }] }] }] }] };
    expect(validateSegmentRules(deep).errors.map((e) => e.code)).toContain("too_deep");
    const many = { match: "all", conditions: Array.from({ length: 31 }, () => ({ field: "orders_count", op: "gte", value: 1 })) };
    expect(validateSegmentRules(many).errors.map((e) => e.code)).toContain("too_many");
  });

  it("evaluates nested AND/OR groups", () => {
    const rules: SegmentGroup = { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }, { match: "any", conditions: [{ field: "country", op: "in", value: ["FR"] }, { match: "all", conditions: [{ field: "tags", op: "any", value: ["vip"] }, { field: "days_since_last_order", op: "lte", value: 30 }] }] }] };
    expect(evaluateRules(rules, base)).toBe(true);
    expect(evaluateRules(rules, { ...base, tags: [] })).toBe(false);
    expect(evaluateRules(rules, { ...base, tags: [], country: "FR" })).toBe(true);
    expect(evaluateRules(rules, { ...base, ordersCount: 1, country: "FR" })).toBe(false);
  });

  it("handles null-aware operators and arrays", () => {
    expect(evaluateRules({ match: "all", conditions: [{ field: "days_since_last_order", op: "is_null" }] }, { ...base, daysSinceLastOrder: null })).toBe(true);
    expect(evaluateRules({ match: "all", conditions: [{ field: "aov", op: "between", value: [5000, 12000] }] }, base)).toBe(true);
    expect(evaluateRules({ match: "all", conditions: [{ field: "bought_product_type", op: "none", value: ["Shoes"] }] }, base)).toBe(false);
    expect(evaluateRules({ match: "all", conditions: [{ field: "rfm_tier", op: "in", value: ["loyal"] }] }, base)).toBe(true);
    expect(evaluateRules({ match: "all", conditions: [{ field: "random_pct", op: "lt", value: 50 }] }, base)).toBe(true);
  });
});

describe("rfm", () => {
  it("tiers top-down", () => {
    expect(rfmTier(0, null)).toBeNull();
    expect(rfmTier(6, 800)).toBe("lost");
    expect(rfmTier(6, 400)).toBe("dormant");
    expect(rfmTier(5, 100)).toBe("champions");
    expect(rfmTier(5, 300)).toBe("loyal");
    expect(rfmTier(3, 100)).toBe("loyal");
    expect(rfmTier(2, 300)).toBe("at_risk");
    expect(rfmTier(2, 100)).toBe("promising");
    expect(rfmTier(1, 30)).toBe("new");
    expect(rfmTier(1, 200)).toBe("one_time");
  });
  it("builds the matrix with totals per cell and tier", () => {
    const m = buildRfmMatrix([
      { ordersCount: 1, daysSinceLastOrder: 10, totalSpentMinor: 1000, acceptsMarketing: true },
      { ordersCount: 1, daysSinceLastOrder: 50, totalSpentMinor: 3000, acceptsMarketing: false },
      { ordersCount: 5, daysSinceLastOrder: 100, totalSpentMinor: 9000, acceptsMarketing: true },
      { ordersCount: 0, daysSinceLastOrder: null, totalSpentMinor: 0, acceptsMarketing: true },
    ]);
    expect(m.total).toBe(3);
    const c = m.cells.find((x) => x.recency === "r0_90" && x.frequency === "f1")!;
    expect(c.customers).toBe(2);
    expect(c.contactable).toBe(1);
    expect(c.aovMinor).toBe(2000);
    expect(m.tiers.find((t) => t.tier === "champions")!.customers).toBe(1);
  });
});

describe("holdout", () => {
  it("is deterministic and close to the requested share", () => {
    expect(stableBucket("a")).toBe(stableBucket("a"));
    expect(assignHoldout("s", "c", 0)).toBe("treated");
    let holdout = 0;
    for (let i = 0; i < 10000; i++) if (assignHoldout("seg-1", `cust-${i}`, 20) === "holdout") holdout++;
    expect(holdout).toBeGreaterThan(1850);
    expect(holdout).toBeLessThan(2150);
    expect(assignHoldout("seg-1", "cust-7", 20)).toBe(assignHoldout("seg-1", "cust-7", 20));
  });
});

describe("statistics", () => {
  it("normal cdf and two-proportion test", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    const r = twoProportionTest(120, 2000, 80, 2000);
    expect(r.diff).toBeCloseTo(0.02, 6);
    expect(r.pValue!).toBeLessThan(0.01);
    expect(r.ci95![0]).toBeLessThan(0.02);
    expect(r.ci95![1]).toBeGreaterThan(0.02);
    expect(twoProportionTest(0, 0, 0, 0).z).toBeNull();
  });
});

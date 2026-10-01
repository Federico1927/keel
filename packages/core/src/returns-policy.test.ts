import { describe, expect, it } from "vitest";
import { customerLimitReached, customerReturnRisk, lineBlock, lineWindowDays, parseReturnPolicy, selectAutomations, type ReturnFacts } from "./returns-policy";

const policy = parseReturnPolicy({
  windows: [
    { countries: ["DE", "AT"], days: 30 },
    { tags: ["holiday"], days: 60 },
    { countries: ["US"], productTypes: ["Furniture"], days: 14 },
  ],
  exclusions: { productTypes: ["Gift card"], skuPrefixes: ["MB-"], titleContains: ["mystery"], tags: ["final-sale"] },
  finalSaleDiscountBps: 5000,
  customerLimit: { count: 3, days: 90 },
  automations: [
    { id: "a1", name: "Flag risky", action: "flag", conditions: { minRisk: "watch" }, note: "Check history" },
    { id: "a2", name: "Approve small first returns", action: "approve", conditions: { maxAmountMinor: 5000, maxRisk: "none", firstReturnOnly: true } },
    { id: "a3", name: "Keep cheap damaged items", action: "returnless", conditions: { maxAmountMinor: 1500, reasonCodes: ["damaged"] } },
  ],
});
const line = { id: "l", productType: "Shirt", sku: "SH-1", title: "Linen Shirt", tags: [] as string[], discountBps: 0 };

describe("return policy", () => {
  it("blocks excluded and final-sale lines with the reason", () => {
    expect(lineBlock(line, policy)).toBeNull();
    expect(lineBlock({ ...line, productType: "gift card" }, policy)).toBe("excluded_type");
    expect(lineBlock({ ...line, sku: "mb-77" }, policy)).toBe("excluded_sku");
    expect(lineBlock({ ...line, title: "Mystery Box" }, policy)).toBe("excluded_title");
    expect(lineBlock({ ...line, tags: ["Final-Sale"] }, policy)).toBe("excluded_tag");
    expect(lineBlock({ ...line, discountBps: 5000 }, policy)).toBe("final_sale");
    expect(lineBlock({ ...line, productType: "Socks" }, policy, ["socks"])).toBe("excluded_type");
  });
  it("uses the longest matching window, else the default", () => {
    expect(lineWindowDays(line, "IT", policy, 14)).toBe(14);
    expect(lineWindowDays(line, "de", policy, 14)).toBe(30);
    expect(lineWindowDays({ ...line, tags: ["holiday"] }, "DE", policy, 14)).toBe(60);
    // a matching rule replaces the default, also when it is shorter
    expect(lineWindowDays({ ...line, productType: "Furniture" }, "US", policy, 30)).toBe(14);
    expect(lineWindowDays({ ...line, productType: "Furniture" }, null, policy, 10)).toBe(10);
  });
  it("counts the customer's recent returns against the limit", () => {
    const now = new Date("2026-06-01");
    const d = (days: number) => new Date(now.getTime() - days * 864e5);
    expect(customerLimitReached(policy, [d(10), d(20)], now)).toBe(false);
    expect(customerLimitReached(policy, [d(10), d(20), d(80)], now)).toBe(true);
    expect(customerLimitReached(policy, [d(10), d(20), d(120)], now)).toBe(false);
  });
  it("explains the customer risk", () => {
    const base = { ordersCount: 6, itemsBought: 10, itemsReturned: 1, returnsCount: 1, returnedValueMinor: 3000, quickCustomerFaultReturns: 0 };
    expect(customerReturnRisk(base, policy.risk)).toEqual({ level: "none", rateBps: 1000, reasons: [] });
    expect(customerReturnRisk({ ...base, itemsReturned: 4, returnsCount: 3 }, policy.risk).level).toBe("watch");
    expect(customerReturnRisk({ ...base, itemsReturned: 6, returnsCount: 4 }, policy.risk)).toMatchObject({ level: "high", reasons: ["serial_returner"] });
    expect(customerReturnRisk({ ...base, quickCustomerFaultReturns: 3 }, policy.risk)).toMatchObject({ level: "high", reasons: ["wear_and_return"] });
    expect(customerReturnRisk({ ...base, returnsCount: 2, returnedValueMinor: 80000 }, policy.risk).reasons).toEqual(["high_returned_value"]);
  });
  it("applies flags and stops at the first decision", () => {
    const f: ReturnFacts = { amountMinor: 3000, reasonCode: "wrong_size", resolution: "refund", source: "portal", productTypes: ["Shirt"], risk: "none", previousReturns: 0 };
    expect(selectAutomations(policy.automations, f).map((a) => a.id)).toEqual(["a2"]);
    expect(selectAutomations(policy.automations, { ...f, previousReturns: 1 })).toEqual([]);
    expect(selectAutomations(policy.automations, { ...f, risk: "watch" }).map((a) => a.id)).toEqual(["a1"]);
    expect(selectAutomations(policy.automations, { ...f, amountMinor: 1000, reasonCode: "damaged", previousReturns: 2 }).map((a) => a.id)).toEqual(["a3"]);
  });
  it("refuses reject or returnless automations without any condition", () => {
    expect(parseReturnPolicy({ automations: [{ id: "x", name: "Reject all", action: "reject" }] }).automations).toEqual([]);
    expect(parseReturnPolicy({ automations: [{ id: "x", name: "Approve all", action: "approve" }] }).automations).toHaveLength(1);
    expect(parseReturnPolicy({ automations: [{ id: "x", name: "Reject big", action: "reject", conditions: { minAmountMinor: 100000 } }] }).automations).toHaveLength(1);
  });
  it("falls back to an empty policy on invalid input", () => {
    expect(parseReturnPolicy({ windows: "nope" }).windows).toEqual([]);
  });
});

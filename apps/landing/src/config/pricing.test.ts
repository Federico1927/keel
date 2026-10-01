import { describe, expect, it } from "vitest";
import {
  ADDONS,
  ANNUAL_MONTHS_CHARGED,
  FOUNDING_OFFER,
  PLANS,
  annualMonthlyEquivalent,
  annualTotal,
  foundingPrice,
} from "./pricing";

describe("pricing config", () => {
  it("annual billing gives two months free", () => {
    expect(ANNUAL_MONTHS_CHARGED).toBe(10);
    expect(annualTotal(249)).toBe(2490);
    expect(annualMonthlyEquivalent(599)).toBe(499);
  });
  it("founding price applies the configured discount", () => {
    expect(foundingPrice(1000)).toBe(1000 - FOUNDING_OFFER.discountPercent * 10);
  });
  it("plans are ordered by included orders and exactly one is recommended", () => {
    const limits = PLANS.map((p) => p.includedOrdersPerMonth ?? Number.POSITIVE_INFINITY);
    expect([...limits].sort((a, b) => a - b)).toEqual(limits);
    expect(PLANS.filter((p) => p.recommended)).toHaveLength(1);
  });
  it("every inheritsFrom points to an earlier plan", () => {
    const ids = PLANS.map((p) => p.id);
    for (const p of PLANS)
      if (p.inheritsFrom) expect(ids.indexOf(p.inheritsFrom)).toBeLessThan(ids.indexOf(p.id));
  });
  it("add-on ids are unique", () => {
    expect(new Set(ADDONS.map((a) => a.id)).size).toBe(ADDONS.length);
  });
});

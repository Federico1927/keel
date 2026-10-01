import { describe, expect, it } from "vitest";
import { MODULES, OVERAGE as PRODUCT_OVERAGE, PLANS as PRODUCT_PLANS } from "@keel/config";
import {
  ADDONS,
  ANNUAL_MONTHS_CHARGED,
  FOUNDING_OFFER,
  OVERAGE,
  PLANS,
  PRICING_CURRENCY,
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

describe("landing pricing matches the product plan config", () => {
  it("monthly price, setup fee and included orders agree with @keel/config", () => {
    for (const plan of PLANS) {
      if (plan.id === "enterprise") continue;
      const product = PRODUCT_PLANS[plan.id];
      expect(product.monthlyPriceMinor).toBe((plan.monthlyPrice ?? 0) * 100);
      expect(product.setupFeeMinor).toBe((plan.setupFee ?? 0) * 100);
      expect(product.maxOrdersPerMonth).toBe(plan.includedOrdersPerMonth);
      expect(product.currency).toBe(PRICING_CURRENCY);
    }
  });
  it("overage and the cash-on-delivery add-on agree with @keel/config", () => {
    expect(PRODUCT_OVERAGE.pricePerBlockMinor).toBe(OVERAGE.pricePerBlock * 100);
    expect(PRODUCT_OVERAGE.blockOrders).toBe(OVERAGE.blockSize);
    const cod = ADDONS.find((a) => a.id === "cod");
    expect(cod?.kind === "monthly" && cod.price * 100).toBe(MODULES["addon.cod"].monthlyPriceMinor);
  });
});

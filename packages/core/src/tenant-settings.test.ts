import { describe, expect, it } from "vitest";
import { normalizePaymentMethod, parseTenantSettings } from "./tenant-settings";

describe("tenant settings", () => {
  it("fills defaults for an empty blob", () => {
    const s = parseTenantSettings({});
    expect(s.lowStockThreshold).toBe(10);
    expect(s.paymentFeeBps.card).toBe(180);
  });
  it("keeps overrides and ignores invalid blobs", () => {
    expect(parseTenantSettings({ lowStockThreshold: 3 }).lowStockThreshold).toBe(3);
    expect(parseTenantSettings("garbage").lowStockThreshold).toBe(10);
  });
});

describe("normalizePaymentMethod", () => {
  it("maps common gateways", () => {
    expect(normalizePaymentMethod(["shopify_payments"])).toBe("card");
    expect(normalizePaymentMethod(["PayPal Express Checkout"])).toBe("wallet");
    expect(normalizePaymentMethod(["Cash on Delivery (COD)"])).toBe("cod");
    expect(normalizePaymentMethod(["Klarna"])).toBe("bnpl");
    expect(normalizePaymentMethod(["bank_deposit"])).toBe("bank_transfer");
    expect(normalizePaymentMethod([]) ).toBe("other");
  });
  it("respects tenant overrides first", () => {
    expect(normalizePaymentMethod(["my_local_gateway"], { my_local_gateway: "bnpl" })).toBe("bnpl");
  });
});

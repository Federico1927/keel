import { describe, expect, it } from "vitest";
import { addressKey, nameZipKey, normalizeEmail, normalizePhone } from "./identity";

describe("identity normalisation", () => {
  it("normalises phones with the tenant country, not a fixed prefix", () => {
    expect(normalizePhone("349 131 7813", "IT")).toBe("+393491317813");
    expect(normalizePhone("(212) 555-0147", "US")).toBe("+12125550147");
    expect(normalizePhone("+34 612 34 56 78", "IT")).toBe("+34612345678");
    expect(normalizePhone("123", "IT")).toBeNull();
  });
  it("normalises emails and addresses", () => {
    expect(normalizeEmail("  Mario.Rossi@Example.COM ")).toBe("mario.rossi@example.com");
    expect(normalizeEmail("nope")).toBeNull();
    expect(addressKey({ address1: "Via Roma, 10", zip: "20100", city: "Milano" })).toBe("via roma 10|20100|milano");
    expect(addressKey({ address1: "Via", zip: "20100" })).toBeNull();
    expect(nameZipKey("Mario  Rossi", "20100")).toBe("mario rossi|20100");
  });
});

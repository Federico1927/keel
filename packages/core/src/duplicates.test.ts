import { describe, expect, it } from "vitest";
import { findDuplicateOrders, type DuplicateCandidateOrder } from "./duplicates";

const base = (over: Partial<DuplicateCandidateOrder>): DuplicateCandidateOrder => ({
  id: "x",
  placedAt: new Date("2026-09-10T10:00:00Z"),
  customerId: "c1",
  emailNormalized: "a@b.c",
  phoneE164: "+391111",
  cancelledAt: null,
  status: "confirmed",
  lines: [{ variantId: "v1", productId: "p1", sku: "S1", title: "Tee", isAncillary: false }],
  ...over,
});

describe("findDuplicateOrders", () => {
  const target = base({ id: "t" });
  it("matches same variant within the window", () => {
    const r = findDuplicateOrders(target, [base({ id: "a", placedAt: new Date("2026-09-12T09:00:00Z") })], 5);
    expect(r).toEqual([{ orderId: "a", matchType: "same_variant", identityVia: ["customer", "email", "phone"] }]);
  });
  it("matches same product with another variant, by email only", () => {
    const r = findDuplicateOrders(target, [base({ id: "b", customerId: null, phoneE164: null, lines: [{ variantId: "v2", productId: "p1", sku: "S2", title: "Tee", isAncillary: false }] })], 5);
    expect(r[0]).toMatchObject({ matchType: "same_product", identityVia: ["email"] });
  });
  it("ignores cancelled, out-of-window, lineage and unrelated orders", () => {
    const r = findDuplicateOrders(target, [
      base({ id: "c", cancelledAt: new Date() }),
      base({ id: "d", placedAt: new Date("2026-09-20T10:00:00Z") }),
      base({ id: "e", customerId: "zz", emailNormalized: "z@z.z", phoneE164: "+39999" }),
      base({ id: "f", lines: [{ variantId: "v9", productId: "p9", sku: "S9", title: "Other", isAncillary: false }] }),
    ], 5);
    expect(r).toEqual([]);
    expect(findDuplicateOrders({ ...target, replacesOrderId: "g" }, [base({ id: "g" })], 5)).toEqual([]);
  });
});

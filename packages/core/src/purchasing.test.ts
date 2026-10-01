import { describe, expect, it } from "vitest";
import { canDeletePo, canEditPo, inspectReceipt, poLinesDiff, supplierLinkState } from "./purchasing";

describe("purchase order rules", () => {
  it("edits draft and sent POs, deletes only draft or cancelled ones", () => {
    expect(["draft", "sent", "confirmed", "received"].map(canEditPo)).toEqual([true, true, false, false]);
    expect(["draft", "cancelled", "sent", "partially_received"].map(canDeletePo)).toEqual([true, true, false, false]);
  });

  it("inspection keeps only good units for stock", () => {
    expect(inspectReceipt({ remaining: 10, received: 10, damaged: 2, rejected: 1 })).toEqual({ received: 10, damaged: 2, rejected: 1, good: 7 });
    // capped at what is still expected; damaged and rejected never exceed what arrived
    expect(inspectReceipt({ remaining: 4, received: 9, damaged: 3, rejected: 5 })).toEqual({ received: 4, damaged: 3, rejected: 1, good: 0 });
    expect(inspectReceipt({ remaining: 5, received: -2, damaged: Number.NaN })).toEqual({ received: 0, damaged: 0, rejected: 0, good: 0 });
  });

  it("diffs lines by variant or free-text description", () => {
    const d = poLinesDiff(
      [{ variantId: "a", description: null, quantity: 5, unitCostMinor: 100 }, { variantId: null, description: "Labels", quantity: 1, unitCostMinor: 900 }],
      [{ variantId: "a", description: null, quantity: 8, unitCostMinor: 100 }, { variantId: "b", description: null, quantity: 2, unitCostMinor: 50 }, { variantId: null, description: " labels ", quantity: 1, unitCostMinor: 900 }],
    );
    expect(d.added.map((l) => l.variantId)).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([{ key: "v:a", from: { quantity: 5, unitCostMinor: 100 }, to: { quantity: 8, unitCostMinor: 100 } }]);
  });

  it("supplier links expire and can be revoked", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    expect(supplierLinkState({ expiresAt: new Date("2026-10-02T00:00:00Z"), revokedAt: null }, now)).toBe("active");
    expect(supplierLinkState({ expiresAt: new Date("2026-10-01T10:00:00Z"), revokedAt: null }, now)).toBe("expired");
    expect(supplierLinkState({ expiresAt: new Date("2026-12-01T00:00:00Z"), revokedAt: now }, now)).toBe("revoked");
  });
});

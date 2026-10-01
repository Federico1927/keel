import { describe, expect, it } from "vitest";
import { defaultStateRules, deriveOrderStatus, previewRules, type StateInput, type StateRule } from "./state-rules";

const base: StateInput = {
  platformTags: [],
  paymentMethod: "card",
  paymentStatus: "paid",
  financialStatusRaw: "paid",
  fulfillmentStatusRaw: null,
  cancelledAt: null,
  placedAt: new Date("2026-09-01T10:00:00Z"),
  now: new Date("2026-09-03T10:00:00Z"),
};

describe("deriveOrderStatus", () => {
  it("hard facts override rules and manual statuses", () => {
    expect(deriveOrderStatus({ ...base, cancelledAt: new Date(), manualStatus: "confirmed" }, defaultStateRules()).status).toBe("cancelled");
    expect(deriveOrderStatus({ ...base, paymentStatus: "refunded" }, []).status).toBe("refunded");
    expect(deriveOrderStatus({ ...base, returnedFraction: 1 }, []).status).toBe("returned");
    expect(deriveOrderStatus({ ...base, returnedFraction: 0.5 }, []).status).toBe("returned_partial");
    expect(deriveOrderStatus({ ...base, shipmentStatus: "delivered", manualStatus: "on_hold" }, []).status).toBe("delivered");
  });
  it("manual status sticks when no hard fact applies", () => {
    expect(deriveOrderStatus({ ...base, manualStatus: "on_hold" }, defaultStateRules())).toEqual({ status: "on_hold", reason: "manual" });
  });
  it("applies tenant rules by priority, first match wins", () => {
    const rules: StateRule[] = [
      { id: "b", name: "b", priority: 20, conditions: { tagsAny: ["vip"] }, resultStatus: "confirmed", isActive: true },
      { id: "a", name: "a", priority: 10, conditions: { tagsAny: ["VIP"], paymentMethods: ["cod"] }, resultStatus: "pending_review", isActive: true },
      { id: "off", name: "off", priority: 1, conditions: {}, resultStatus: "on_hold", isActive: false },
    ];
    expect(deriveOrderStatus({ ...base, platformTags: ["vip"], paymentMethod: "cod", paymentStatus: "pending" }, rules)).toEqual({ status: "pending_review", reason: "rule:a" });
    expect(deriveOrderStatus({ ...base, platformTags: ["vip"] }, rules)).toEqual({ status: "confirmed", reason: "rule:b" });
  });
  it("falls back to platform facts", () => {
    expect(deriveOrderStatus({ ...base, fulfillmentStatusRaw: "fulfilled" }, []).status).toBe("shipped");
    expect(deriveOrderStatus({ ...base, fulfillmentStatusRaw: "partial" }, []).status).toBe("fulfilling");
    expect(deriveOrderStatus(base, []).status).toBe("confirmed");
    expect(deriveOrderStatus({ ...base, paymentStatus: "pending", financialStatusRaw: "pending" }, []).status).toBe("new");
  });
  it("supports age-based rules", () => {
    const rules: StateRule[] = [{ id: "stale", name: "stale", priority: 1, conditions: { paymentStatuses: ["pending"], minAgeHours: 24 }, resultStatus: "pending_review", isActive: true }];
    expect(deriveOrderStatus({ ...base, paymentStatus: "pending" }, rules).status).toBe("pending_review");
    expect(deriveOrderStatus({ ...base, paymentStatus: "pending", placedAt: new Date("2026-09-03T09:00:00Z") }, rules).status).toBe("new");
  });
  it("previews changes against samples", () => {
    const out = previewRules([{ id: "o1", input: { ...base, paymentStatus: "pending" }, currentStatus: "new" }], defaultStateRules());
    expect(out[0]).toMatchObject({ next: "pending_review", changed: true });
  });
});

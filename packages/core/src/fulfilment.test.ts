import { describe, expect, it } from "vitest";
import { applyStatusMapping, businessDaysElapsed, isToShip, lateToShipCutoff, localDateKey, packStage, planShipmentCases, shipmentNeedsCase, suggestRtsFollowUps, validateResolution, validateShipInput, zonedDayStart } from "./fulfilment";
import { isLateToShip } from "./notifications";
import { resolveShipmentStatus, DEFAULT_PRECEDENCE } from "./shipment-resolver";

// 2026-10-01 is a Thursday
const at = (iso: string) => new Date(iso);

describe("business days in the tenant time zone", () => {
  it("counts working days after the day of placement up to today", () => {
    const now = at("2026-10-01T10:00:00Z"); // Thu
    expect(businessDaysElapsed(at("2026-10-01T08:00:00Z"), now, "UTC")).toBe(0);
    expect(businessDaysElapsed(at("2026-09-30T08:00:00Z"), now, "UTC")).toBe(1);
    expect(businessDaysElapsed(at("2026-09-28T23:00:00Z"), now, "UTC")).toBe(3); // Mon → Tue, Wed, Thu
    // placed on Saturday: Monday counts 1, the weekend nothing
    expect(businessDaysElapsed(at("2026-09-26T12:00:00Z"), at("2026-09-28T12:00:00Z"), "UTC")).toBe(1);
    expect(businessDaysElapsed(at("2026-09-25T12:00:00Z"), at("2026-09-28T12:00:00Z"), "UTC")).toBe(1); // Fri → Mon
    // custom working week (Sunday to Thursday)
    expect(businessDaysElapsed(at("2026-09-25T12:00:00Z"), at("2026-09-28T12:00:00Z"), "UTC", [7, 1, 2, 3, 4])).toBe(2);
  });

  it("uses local dates: the same instants give different ages in different zones", () => {
    const placed = at("2026-09-29T23:30:00Z"); // Tue in UTC, Wed 01:30 in Rome
    const now = at("2026-10-01T09:00:00Z");
    expect(localDateKey(placed, "Europe/Rome")).toBe("2026-09-30");
    expect(businessDaysElapsed(placed, now, "UTC")).toBe(2);
    expect(businessDaysElapsed(placed, now, "Europe/Rome")).toBe(1);
    expect(businessDaysElapsed(at("2026-09-30T02:00:00Z"), now, "America/New_York")).toBe(2); // Tue 22:00 in New York
  });

  it("the cutoff matches the count: placed before it ⇔ late", () => {
    const now = at("2026-10-01T15:00:00Z");
    for (const tz of ["UTC", "Europe/Rome", "America/New_York"]) {
      for (const threshold of [0, 1, 2, 5]) {
        const cutoff = lateToShipCutoff(now, threshold, tz);
        for (let h = 0; h < 24 * 14; h += 5) {
          const placed = new Date(now.getTime() - h * 3600e3);
          expect(placed < cutoff, `${tz} t=${threshold} h=${h}`).toBe(businessDaysElapsed(placed, now, tz) > threshold);
        }
      }
    }
    expect(zonedDayStart("2026-10-01", "Europe/Rome").toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(zonedDayStart("2026-03-29", "Europe/Rome").toISOString()).toBe("2026-03-28T23:00:00.000Z"); // DST day starts at +01:00
  });

  it("late to ship: only orders ready to ship, over the threshold in working days", () => {
    const now = at("2026-10-01T10:00:00Z");
    const opts = { thresholdDays: 2, timeZone: "UTC" };
    expect(isLateToShip({ status: "confirmed", placedAt: at("2026-09-28T10:00:00Z") }, opts, now)).toBe(true); // 3 days
    expect(isLateToShip({ status: "confirmed", placedAt: at("2026-09-29T10:00:00Z") }, opts, now)).toBe(false); // 2 days
    expect(isLateToShip({ status: "fulfilling", placedAt: at("2026-09-24T10:00:00Z") }, opts, now)).toBe(true);
    expect(isLateToShip({ status: "shipped", placedAt: at("2026-09-01T10:00:00Z") }, opts, now)).toBe(false);
    expect(isLateToShip({ status: "pending_review", placedAt: at("2026-09-01T10:00:00Z") }, opts, now)).toBe(false);
  });
});

describe("to ship and pick/pack", () => {
  it("ready to ship whatever the payment, until something shipped", () => {
    expect(isToShip({ status: "confirmed", fulfillmentStatusRaw: null, hasShipment: false })).toBe(true);
    expect(isToShip({ status: "fulfilling", fulfillmentStatusRaw: "partial", hasShipment: false })).toBe(true);
    expect(isToShip({ status: "confirmed", fulfillmentStatusRaw: null, hasShipment: true })).toBe(false);
    expect(isToShip({ status: "confirmed", fulfillmentStatusRaw: "fulfilled", hasShipment: false })).toBe(false);
    expect(isToShip({ status: "on_hold", fulfillmentStatusRaw: null, hasShipment: false })).toBe(false);
    expect(packStage({ hasShipment: false, packedAt: null })).toBe("pending");
    expect(packStage({ hasShipment: false, packedAt: new Date() })).toBe("packed");
    expect(packStage({ hasShipment: true, packedAt: null })).toBe("shipped");
  });
  it("ship input needs a carrier and a tracking number", () => {
    expect(validateShipInput({ carrier: "UPS", trackingNumber: "1Z999AA10123456784" })).toEqual([]);
    expect(validateShipInput({ carrier: " ", trackingNumber: "" }).map((i) => `${i.field}:${i.code}`)).toEqual(["carrier:required", "trackingNumber:required"]);
    expect(validateShipInput({ carrier: "X", trackingNumber: "abc<script>" })[0]).toEqual({ field: "trackingNumber", code: "invalid" });
    expect(validateShipInput({ carrier: "X", trackingNumber: "A1", trackingUrl: "javascript:alert(1)" })[0]).toEqual({ field: "trackingUrl", code: "invalid" });
  });
});

describe("status mappings and the resolver", () => {
  const mappings = [
    { source: "shopify", externalStatus: "Held_At_Customs", canonicalStatus: "in_transit" as const, isException: true, isFinal: false },
    { source: "shopify", externalStatus: "failure", canonicalStatus: "failed" as const, isException: true, isFinal: true },
    { source: "carrier", externalStatus: "RTS", canonicalStatus: "in_transit" as const, isException: false, isFinal: true },
  ];
  it("the tenant row wins, matching ignores case; unknown statuses keep the adapter's normalization", () => {
    expect(applyStatusMapping(mappings, "shopify", " held_at_customs ", "in_transit")).toEqual({ status: "in_transit", isException: true, isFinal: false, mapped: true });
    expect(applyStatusMapping(mappings, "shopify", "in_transit", "in_transit")).toEqual({ status: "in_transit", isException: false, isFinal: false, mapped: false });
    expect(applyStatusMapping(mappings, "carrier", "held_at_customs", "attempted")).toMatchObject({ status: "attempted", isException: true, mapped: false });
  });
  it("flags from the mapping drive the resolver: exception and final", () => {
    const now = at("2026-10-01T10:00:00Z");
    const base = { previousStatus: null, exceptionReason: null, exceptionSince: null, precedence: DEFAULT_PRECEDENCE, stickyExceptionDays: 15, now };
    const customs = resolveShipmentStatus({ ...base, states: [{ source: "shopify", status: "in_transit", lastEventAt: now, isException: true }] });
    expect(customs.status).toBe("exception");
    expect(customs.exceptionReason).toBe("source_exception");
    // a source marked final beats a fresher non-final one
    const final = resolveShipmentStatus({ ...base, states: [{ source: "carrier", status: "in_transit", lastEventAt: new Date(now.getTime() - 36e5), isFinal: true }, { source: "shopify", status: "out_for_delivery", lastEventAt: now }] });
    expect(final.sourceOfTruth).toBe("carrier");
  });
});

describe("delivery-exception and return-to-sender cases", () => {
  it("opens one case per need, closes exception cases when the shipment moves on", () => {
    expect(shipmentNeedsCase({ id: "a", status: "attempted" })).toBe("exception");
    expect(shipmentNeedsCase({ id: "a", status: "in_transit", flaggedException: true })).toBe("exception");
    expect(shipmentNeedsCase({ id: "a", status: "returned" })).toBe("return_to_sender");
    expect(shipmentNeedsCase({ id: "a", status: "delivered" })).toBeNull();
    const plan = planShipmentCases(
      [{ id: "s1", status: "exception" }, { id: "s2", status: "in_transit" }, { id: "s3", status: "returned" }, { id: "s4", status: "attempted" }],
      [{ id: "c2", shipmentId: "s2", kind: "exception" }, { id: "c3", shipmentId: "s3", kind: "exception" }, { id: "c4", shipmentId: "s4", kind: "exception" }],
    );
    expect(plan.open).toEqual([{ shipmentId: "s1", kind: "exception" }, { shipmentId: "s3", kind: "return_to_sender" }]);
    expect(plan.close).toEqual([{ caseId: "c2", reason: "moved_on" }, { caseId: "c3", reason: "moved_on" }]);
    // an open review is never opened twice; a closed one is never reopened
    expect(planShipmentCases([{ id: "s3", status: "returned" }], [{ id: "r3", shipmentId: "s3", kind: "return_to_sender" }])).toEqual({ open: [], close: [] });
    const closedAt = new Date("2026-10-01T10:00:00Z");
    expect(planShipmentCases([{ id: "s3", status: "returned", changedAt: new Date("2026-10-02T10:00:00Z") }], [], [{ shipmentId: "s3", kind: "return_to_sender", closedAt }]).open).toEqual([]);
    // an exception closed by hand stays closed until the shipment falls into exception again
    expect(planShipmentCases([{ id: "s1", status: "exception", changedAt: new Date("2026-09-30T10:00:00Z") }], [], [{ shipmentId: "s1", kind: "exception", closedAt }]).open).toEqual([]);
    expect(planShipmentCases([{ id: "s1", status: "attempted", changedAt: new Date("2026-10-01T12:00:00Z") }], [], [{ shipmentId: "s1", kind: "exception", closedAt }]).open).toEqual([{ shipmentId: "s1", kind: "exception" }]);
  });
  it("validates resolutions", () => {
    expect(validateResolution({ resolution: "redeliver" })).toEqual([]);
    expect(validateResolution({ resolution: "pickup_point", pickupPoint: "" })).toEqual([{ field: "pickupPoint", code: "required" }]);
    expect(validateResolution({ resolution: "new_address", address: { name: "A", address1: "Via Roma 1", city: "Milano", zip: "123", country: "IT" } })[0]).toMatchObject({ field: "address", code: "invalid" });
    expect(validateResolution({ resolution: "new_address", address: { name: "A", address1: "Via Roma 1", city: "Milano", zip: "20121", country: "IT" } })).toEqual([]);
    expect(validateResolution({ resolution: "teleport" as "return" })).toEqual([{ field: "resolution", code: "invalid" }]);
  });
  it("suggests a refund only when money was captured, for any payment method", () => {
    const paid = suggestRtsFollowUps({ paymentStatus: "paid", totalMinor: 5000, refundedMinor: 0, restocked: false, hasContact: true });
    expect(paid.filter((s) => s.suggested).map((s) => s.kind)).toEqual(["restock", "refund", "contact"]);
    const pending = suggestRtsFollowUps({ paymentStatus: "pending", totalMinor: 5000, refundedMinor: 0, restocked: true, hasContact: false });
    expect(pending.find((s) => s.kind === "refund")).toEqual({ kind: "refund", reason: "nothing_captured", suggested: false });
    expect(pending.filter((s) => s.suggested)).toEqual([]);
    expect(suggestRtsFollowUps({ paymentStatus: "paid", totalMinor: 5000, refundedMinor: 5000, restocked: false, hasContact: true }).find((s) => s.kind === "refund")!.reason).toBe("already_refunded");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_PRECEDENCE, daysInTransit, isStuck, resolveShipmentStatus } from "./shipment-resolver";

const now = new Date("2026-09-10T12:00:00Z");
const h = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 36e5);
const base = { previousStatus: null, exceptionReason: null, exceptionSince: null, precedence: DEFAULT_PRECEDENCE, stickyExceptionDays: 15, now };

describe("resolveShipmentStatus", () => {
  it("fresh higher-priority source wins and logs conflicts", () => {
    const r = resolveShipmentStatus({ ...base, states: [{ source: "shopify", status: "in_transit", lastEventAt: h(5) }, { source: "carrier", status: "out_for_delivery", lastEventAt: h(1) }] });
    expect(r.status).toBe("out_for_delivery");
    expect(r.sourceOfTruth).toBe("carrier");
    expect(r.conflicts).toHaveLength(1);
  });
  it("stale carrier loses to the platform", () => {
    const r = resolveShipmentStatus({ ...base, states: [{ source: "shopify", status: "delivered", lastEventAt: h(2) }, { source: "carrier", status: "in_transit", lastEventAt: h(60) }] });
    expect(r.status).toBe("delivered");
  });
  it("final beats non-final, and terminal statuses are never demoted", () => {
    const r = resolveShipmentStatus({ ...base, states: [{ source: "carrier", status: "delivered", lastEventAt: h(30) }, { source: "shopify", status: "in_transit", lastEventAt: h(1) }] });
    expect(r.status).toBe("delivered");
    const r2 = resolveShipmentStatus({ ...base, previousStatus: "delivered", states: [{ source: "shopify", status: "in_transit", lastEventAt: h(1) }] });
    expect(r2.status).toBe("delivered");
  });
  it("keeps a real young exception sticky against in_transit, clears when stale", () => {
    const sticky = resolveShipmentStatus({ ...base, previousStatus: "exception", exceptionReason: "delivery_error", exceptionSince: h(48), states: [{ source: "shopify", status: "in_transit", lastEventAt: h(1) }] });
    expect(sticky.status).toBe("exception");
    const released = resolveShipmentStatus({ ...base, previousStatus: "exception", exceptionReason: "delivery_error", exceptionSince: h(24 * 20), states: [{ source: "shopify", status: "in_transit", lastEventAt: h(1) }] });
    expect(released.status).toBe("in_transit");
    expect(released.exceptionReason).toBeNull();
  });
  it("stamps exception bookkeeping", () => {
    const r = resolveShipmentStatus({ ...base, states: [{ source: "shopify", status: "attempted", lastEventAt: h(3) }] });
    expect(r.exceptionReason).toBe("source_exception");
    expect(r.exceptionSince).toEqual(h(3));
  });
  it("transit helpers", () => {
    expect(daysInTransit(h(72), null, now)).toBe(3);
    expect(isStuck("in_transit", h(24 * 9), 7, now)).toBe(true);
    expect(isStuck("delivered", h(24 * 9), 7, now)).toBe(false);
  });
});

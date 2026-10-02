import { describe, expect, it } from "vitest";
import { matchReturnReason, nextReturnStatusFromPlatform, platformReturnTarget, returnStageDays, returnsAgeing } from "./returns-sync";

const d = (day: number) => new Date(Date.UTC(2026, 8, day));

describe("platform returns", () => {
  it("maps the platform status, a closed return refunded only when the order carries a refund", () => {
    expect(platformReturnTarget("REQUESTED", { orderRefunded: false })).toEqual({ status: "requested", needsReview: false, platformStatus: "requested" });
    expect(platformReturnTarget("open", { orderRefunded: false }).status).toBe("approved");
    expect(platformReturnTarget("declined", { orderRefunded: false }).status).toBe("rejected");
    expect(platformReturnTarget("canceled", { orderRefunded: true }).status).toBe("rejected");
    expect(platformReturnTarget("closed", { orderRefunded: true })).toEqual({ status: "refunded", needsReview: false, platformStatus: "closed" });
    expect(platformReturnTarget("closed", { orderRefunded: false })).toEqual({ status: "received", needsReview: true, platformStatus: "closed" });
  });

  it("only moves a return forward and never reopens a closed one", () => {
    expect(nextReturnStatusFromPlatform("requested", "approved")).toBe("approved");
    expect(nextReturnStatusFromPlatform("inspected", "approved")).toBeNull();
    expect(nextReturnStatusFromPlatform("approved", "approved")).toBeNull();
    expect(nextReturnStatusFromPlatform("approved", "rejected")).toBe("rejected");
    expect(nextReturnStatusFromPlatform("received", "rejected")).toBeNull();
    expect(nextReturnStatusFromPlatform("refunded", "requested")).toBeNull();
    expect(nextReturnStatusFromPlatform("inspected", "refunded")).toBe("refunded");
  });

  it("matches the tenant reason mapped to the platform code, else other", () => {
    const reasons = [{ code: "too_small", platformReason: "SIZE_TOO_SMALL" }, { code: "other", platformReason: null }, { code: "old", platformReason: "DEFECTIVE", isActive: false }];
    expect(matchReturnReason("size_too_small", reasons)).toBe("too_small");
    expect(matchReturnReason("defective", reasons)).toBe("other");
    expect(matchReturnReason(null, reasons)).toBe("other");
    expect(matchReturnReason("color", [])).toBe("color");
  });
});

describe("returns ageing", () => {
  it("measures each stage from its start to the next known one, the current one up to now", () => {
    expect(returnStageDays({ status: "refunded", requestedAt: d(1), approvedAt: d(2), receivedAt: d(6), inspectedAt: d(7), closedAt: d(10) }, d(20))).toEqual({ requested: 1, approved: 4, received: 1, inspected: 3 });
    expect(returnStageDays({ status: "approved", requestedAt: d(1), approvedAt: d(3), receivedAt: null, inspectedAt: null, closedAt: null }, d(13))).toEqual({ requested: 2, approved: 10 });
    // received → closed without an inspection on the timeline: the time counts as received
    expect(returnStageDays({ status: "refunded", requestedAt: d(1), approvedAt: d(2), receivedAt: d(5), inspectedAt: null, closedAt: d(9) }, d(20))).toEqual({ requested: 1, approved: 3, received: 4 });
    // rejected at request
    expect(returnStageDays({ status: "rejected", requestedAt: d(1), approvedAt: null, receivedAt: null, inspectedAt: null, closedAt: d(4) }, d(20))).toEqual({ requested: 3 });
  });

  it("summarises stages and open returns with the stale count", () => {
    const a = returnsAgeing(
      [
        { status: "approved", requestedAt: d(1), approvedAt: d(2), receivedAt: null, inspectedAt: null, closedAt: null },
        { status: "approved", requestedAt: d(10), approvedAt: d(12), receivedAt: null, inspectedAt: null, closedAt: null },
        { status: "refunded", requestedAt: d(1), approvedAt: d(4), receivedAt: d(8), inspectedAt: null, closedAt: d(9) },
      ],
      d(14),
    );
    expect(a.stages.find((s) => s.stage === "requested")).toEqual({ stage: "requested", count: 3, avgDays: 2, medianDays: 2, maxDays: 3 });
    expect(a.stages.find((s) => s.stage === "approved")).toEqual({ stage: "approved", count: 3, avgDays: 6, medianDays: 4, maxDays: 12 });
    expect(a.open).toEqual([{ stage: "approved", count: 2, avgDays: 7, oldestDays: 12, stale: 1 }]);
  });
});

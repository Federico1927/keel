import { describe, expect, it } from "vitest";
import { backorderStatus, canTransitionPo, movingAverageCost, reorderSuggestion, stockVelocity, variantCapacity, worstRisk } from "./inventory";

describe("stock velocity and risk", () => {
  const base = { lookbackDays: 30, criticalDays: 7, warningDays: 21 };
  it("computes cover from stock plus incoming", () => {
    const r = stockVelocity({ ...base, unitsSold: 60, available: 10, incoming: 30 });
    expect(r.velocityPerDay).toBe(2);
    expect(r.daysOfCover).toBe(20);
    expect(r.risk).toBe("warning");
  });
  it("flags critical at zero stock or short cover, ok otherwise", () => {
    expect(stockVelocity({ ...base, unitsSold: 30, available: 0, incoming: 0 }).risk).toBe("critical");
    expect(stockVelocity({ ...base, unitsSold: 30, available: 5, incoming: 0 }).risk).toBe("critical");
    expect(stockVelocity({ ...base, unitsSold: 30, available: 100, incoming: 0 }).risk).toBe("ok");
    expect(stockVelocity({ ...base, unitsSold: 0, available: 100, incoming: 0 })).toMatchObject({ risk: "no_sales", daysOfCover: null });
  });
  it("suggests reorders rounded to pack size", () => {
    expect(reorderSuggestion(2, 10, 30, null)).toBe(50);
    expect(reorderSuggestion(2, 10, 30, 12)).toBe(60);
    expect(reorderSuggestion(0, 10, 30, 12)).toBe(0);
    expect(reorderSuggestion(1, 100, 30, 6)).toBe(0);
  });
  it("picks the worst risk", () => {
    expect(worstRisk(["ok", "warning", "no_sales"])).toBe("warning");
    expect(worstRisk([])).toBe("no_sales");
  });
});

describe("capacity, cost, backorders, transitions", () => {
  it("variant capacity", () => {
    expect(variantCapacity({ available: 5, incoming: 10, committedOpen: 3, backorderOpen: 1, originalInOrder: 2 })).toMatchObject({ cap: 17, netAvailable: 1 });
  });
  it("moving average cost", () => {
    expect(movingAverageCost(null, 0, 10, 500)).toBe(500);
    expect(movingAverageCost(400, 10, 10, 600)).toBe(500);
    expect(movingAverageCost(400, 10, 0, 600)).toBe(400);
  });
  it("backorder status", () => {
    expect(backorderStatus(2, 3, 0)).toBe("fulfilled");
    expect(backorderStatus(2, 1, 5)).toBe("covered");
    expect(backorderStatus(2, 1, 0)).toBe("pending");
  });
  it("purchase order transitions", () => {
    expect(canTransitionPo("draft", "sent")).toBe(true);
    expect(canTransitionPo("received", "draft")).toBe(false);
    expect(canTransitionPo("in_transit", "received")).toBe(true);
  });
});

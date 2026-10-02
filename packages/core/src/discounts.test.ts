import { describe, expect, it } from "vitest";
import { poolCodeStatus, poolTopUpCount } from "./discounts";

describe("discount pools", () => {
  it("derives the code status: redeemed beats assigned beats available", () => {
    expect(poolCodeStatus({})).toBe("available");
    expect(poolCodeStatus({ assignedCampaignId: "c" })).toBe("assigned");
    expect(poolCodeStatus({ assignedCustomerId: "u", redeemedOrderId: "o" })).toBe("redeemed");
    expect(poolCodeStatus({ usedCount: 1 })).toBe("redeemed");
  });
  it("tops up to the target of available codes", () => {
    expect(poolTopUpCount(40, 100)).toBe(60);
    expect(poolTopUpCount(120, 100)).toBe(0);
    expect(poolTopUpCount(0, 50_000, 10_000)).toBe(10_000);
  });
});

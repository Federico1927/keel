import { describe, expect, it } from "vitest";
import { ASSISTANT_DEFAULT_DAYS, AssistantInputError, assistantPeriod, threadTitle } from "./assistant";

const today = new Date("2026-10-01T15:00:00Z");

describe("assistant period", () => {
  it("reads inclusive days as a half-open period", () => {
    const p = assistantPeriod({ from: "2026-09-01", to: "2026-09-30" }, today);
    expect(p.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect([p.fromDay, p.toDay]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("defaults to the last 30 days ending today", () => {
    const p = assistantPeriod({}, today);
    expect(p.toDay).toBe("2026-10-01");
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 864e5)).toBe(ASSISTANT_DEFAULT_DAYS);
  });

  it("rejects what the model must correct", () => {
    expect(() => assistantPeriod({ from: "2026-09-30", to: "2026-09-01" }, today)).toThrow(AssistantInputError);
    expect(() => assistantPeriod({ from: "last month" }, today)).toThrow(/YYYY-MM-DD/);
    expect(() => assistantPeriod({ from: "2024-01-01", to: "2026-01-01" }, today)).toThrow(/maximum/);
  });
});

describe("assistant threads", () => {
  it("titles a thread from its first question", () => {
    expect(threadTitle("  How did\nrevenue go?  ")).toBe("How did revenue go?");
    expect(threadTitle("x".repeat(200))).toHaveLength(80);
  });
});

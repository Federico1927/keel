import { describe, expect, it } from "vitest";
import { ASSISTANT_DEFAULT_DAYS, AssistantInputError, aiUsageCharge, assistantPeriod, threadTitle, tokenBudget } from "./assistant";

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

describe("assistant usage", () => {
  it("bills tokens beyond the allowance, split in proportion", () => {
    const pricing = { inputPerMillionMinor: 1000, outputPerMillionMinor: 5000, includedTokens: 100_000 };
    // 900k input + 100k output = 1M; 900k billable = 90% of each
    const c = aiUsageCharge({ inputTokens: 900_000, outputTokens: 100_000 }, pricing);
    expect(c.billableInputTokens).toBe(810_000);
    expect(c.billableOutputTokens).toBe(90_000);
    expect(c.amountMinor).toBe(Math.round((810_000 * 1000 + 90_000 * 5000) / 1e6));
    expect(aiUsageCharge({ inputTokens: 50_000, outputTokens: 10_000 }, pricing).amountMinor).toBe(0);
    expect(aiUsageCharge({ inputTokens: 0, outputTokens: 0 }, pricing).amountMinor).toBe(0);
  });

  it("tracks the monthly budget", () => {
    expect(tokenBudget(250, 1000)).toMatchObject({ remainingTokens: 750, usedShare: 0.25, exceeded: false });
    expect(tokenBudget(1000, 1000).exceeded).toBe(true);
  });

  it("titles a thread from its first question", () => {
    expect(threadTitle("  How did\nrevenue go?  ")).toBe("How did revenue go?");
    expect(threadTitle("x".repeat(200))).toHaveLength(80);
  });
});

import { describe, expect, it } from "vitest";
import { creativeFatigue, evaluateAlert, parseCreativeName, robustSpread } from "./alerts";

describe("alerts", () => {
  it("threshold needs N consecutive days", () => {
    expect(evaluateAlert({ kind: "threshold", op: "lt", value: 1.5, days: 2 }, [2, 1.4, 1.2]).fired).toBe(true);
    expect(evaluateAlert({ kind: "threshold", op: "lt", value: 1.5, days: 2 }, [1.2, 1.8, 1.2]).fired).toBe(false);
    expect(evaluateAlert({ kind: "threshold", op: "gt", value: 100, days: 1 }, [null]).reason).toBe("insufficient_data");
  });
  it("anomaly uses a robust baseline and respects direction", () => {
    const base = [100, 104, 98, 101, 99, 102, 97, 103, 100, 101];
    const spike = evaluateAlert({ kind: "anomaly", direction: "both", sensitivity: 3, baselineDays: 28 }, [...base, 180]);
    expect(spike.fired).toBe(true);
    expect(spike.reason).toBe("anomaly_up");
    expect(spike.baseline).toBe(100.5);
    expect(evaluateAlert({ kind: "anomaly", direction: "down", sensitivity: 3, baselineDays: 28 }, [...base, 180]).fired).toBe(false);
    expect(evaluateAlert({ kind: "anomaly", direction: "both", sensitivity: 3, baselineDays: 28 }, [...base, 101]).fired).toBe(false);
    expect(evaluateAlert({ kind: "anomaly", direction: "both", sensitivity: 3, baselineDays: 28 }, [1, 2, 180]).reason).toBe("insufficient_data");
    expect(robustSpread([1, 1, 1])).toBe(0);
  });
});

describe("creatives", () => {
  const day = (i: number, ctr: number, reach?: number) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, impressions: 1000, clicks: Math.round(1000 * ctr), spendMinor: 1000, reach });
  it("flags fatigue when CTR falls by a quarter", () => {
    const days = Array.from({ length: 14 }, (_, i) => day(i, i < 7 ? 0.02 : 0.013));
    expect(creativeFatigue(days)).toMatchObject({ fatigued: true, level: "fatigued" });
    expect(creativeFatigue(Array.from({ length: 14 }, (_, i) => day(i, 0.02))).level).toBe("fresh");
    expect(creativeFatigue(days.slice(0, 5)).level).toBe("no_data");
    const highFreq = Array.from({ length: 14 }, (_, i) => day(i, i < 7 ? 0.02 : 0.019, 250));
    expect(creativeFatigue(highFreq).fatigued).toBe(true);
  });
  it("parses the naming convention", () => {
    expect(parseCreativeName("VIDEO | UGC unboxing | Price")).toEqual({ format: "video", hook: "ugc unboxing", angle: "price" });
    expect(parseCreativeName("carousel - new in")).toEqual({ format: "carousel", hook: "new in", angle: null });
  });
});

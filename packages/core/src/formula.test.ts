import { describe, expect, it } from "vitest";
import { compileFormula, evaluateFormula, parseFormula } from "./formula";

describe("custom metric formulas", () => {
  it("parses precedence, parentheses and unary minus", () => {
    const v = (src: string, vals: Record<string, number | null> = {}) => evaluateFormula(parseFormula(src), vals);
    expect(v("1 + 2 * 3")).toBe(7);
    expect(v("(1 + 2) * 3")).toBe(9);
    expect(v("-2 * -3")).toBe(6);
    expect(v("(net_revenue - ad_spend) / orders", { net_revenue: 1000, ad_spend: 200, orders: 40 })).toBe(20);
    expect(v("net_revenue / orders", { net_revenue: 1000, orders: 0 })).toBeNull();
    expect(v("x + 1", { x: null })).toBeNull();
  });
  it("rejects bad syntax and unknown metrics without evaluating code", () => {
    expect(compileFormula("1 +", ["a"]).ok).toBe(false);
    expect(compileFormula("a + b", ["a"])).toEqual({ ok: false, error: "unknown metric: b" });
    expect(compileFormula("process.exit()", ["a"]).ok).toBe(false);
    expect(compileFormula("A * 2", ["a"]).ok).toBe(true);
  });
});

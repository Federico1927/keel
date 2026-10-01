import { describe, expect, it } from "vitest";
import { fromMinor, pct, safeDiv, toMinor } from "./money";

describe("money", () => {
  it("round-trips minor units", () => {
    expect(toMinor("19.99")).toBe(1999);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(fromMinor(1999)).toBe(19.99);
  });
  it("applies basis points", () => {
    expect(pct(10_000, 180)).toBe(180);
  });
  it("never divides by zero", () => {
    expect(safeDiv(1, 0)).toBeNull();
    expect(safeDiv(1, 2)).toBe(0.5);
  });
});

import { describe, expect, it } from "vitest";
import { AA_TEXT, brandColorsFor, contrastRatio, ensureContrast, mixColors, parseHex, readableOn, relativeLuminance, toHex } from "./color";

const LIGHT = { surfaces: ["#f7f8fa", "#ffffff", "#f1f3f6"], onCandidates: ["#ffffff", "#0b0d12"], direction: "darken" as const };
const DARK = { surfaces: ["#0b0d12", "#12151c", "#181c25"], onCandidates: ["#0b0d12", "#ffffff"], direction: "lighten" as const };

describe("contrast helpers", () => {
  it("parses and prints hex colours", () => {
    expect(parseHex("#2b59ff")).toEqual({ r: 43, g: 89, b: 255 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("blue")).toBeNull();
    expect(toHex({ r: 43, g: 89, b: 255 })).toBe("#2b59ff");
  });
  it("matches the WCAG reference values", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // #767676 is the classic lightest grey that passes AA on white
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#2b59ff", "#ffffff")).toBeCloseTo(5.28, 1);
  });
  it("mixes a tint over a surface", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#2b59ff", "#ffffff", 0)).toBe("#ffffff");
  });
  it("picks the readable label colour", () => {
    expect(readableOn("#2b59ff", ["#ffffff", "#0b0d12"])).toBe("#ffffff");
    expect(readableOn("#ffd600", ["#ffffff", "#0b0d12"])).toBe("#0b0d12");
  });
  it("moves lightness only as much as needed", () => {
    expect(ensureContrast("#2b59ff", ["#ffffff"], AA_TEXT, "darken")).toBe("#2b59ff");
    const fixed = ensureContrast("#7aa2ff", ["#ffffff"], AA_TEXT, "darken");
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(fixed, "#ffffff")).toBeLessThan(5.2);
  });
});

describe("brand colour per theme", () => {
  const brands = ["#2b59ff", "#ffd600", "#ff5a5f", "#00a86b", "#1f3a5f", "#000000", "#ffffff", "#7c3aed", "#3d5a40", "#f97316"];
  it.each(brands)("%s passes AA as fill, as text and as link in light and dark", (brand) => {
    for (const theme of [LIGHT, DARK]) {
      const c = brandColorsFor(brand, theme);
      expect(contrastRatio(c.primary, c.onPrimary)).toBeGreaterThanOrEqual(AA_TEXT);
      for (const s of theme.surfaces) expect(contrastRatio(c.primary, s)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
  it("keeps a colour that already passes and flags adjusted ones", () => {
    expect(brandColorsFor("#2b59ff", LIGHT)).toEqual({ primary: "#2b59ff", onPrimary: "#ffffff", adjusted: false });
    const yellow = brandColorsFor("#ffd600", LIGHT);
    expect(yellow.adjusted).toBe(true);
    expect(relativeLuminance(yellow.primary)).toBeLessThan(relativeLuminance("#ffd600"));
    const navyOnDark = brandColorsFor("#1f3a5f", DARK);
    expect(navyOnDark.adjusted).toBe(true);
    expect(navyOnDark.onPrimary).toBe("#0b0d12");
  });
});

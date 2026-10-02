import { describe, expect, it } from "vitest";
import { driftLossUnits, marginBpsAt, marginFloorPrice, normalizeScanCode, reviewStockTake, suggestMarkdown, validateAdjustment, type MarkdownInput } from "./inventory-control";

describe("stock adjustments", () => {
  it("damaged and lost take units away, found brings them back, other needs a note", () => {
    expect(validateAdjustment({ reason: "damaged", delta: -2, current: 10 })).toEqual({ ok: true, next: 8 });
    expect(validateAdjustment({ reason: "damaged", delta: 2, current: 10 })).toEqual({ ok: false, error: "sign" });
    expect(validateAdjustment({ reason: "lost", delta: 1, current: 10 })).toEqual({ ok: false, error: "sign" });
    expect(validateAdjustment({ reason: "found", delta: -1, current: 10 })).toEqual({ ok: false, error: "sign" });
    expect(validateAdjustment({ reason: "found", delta: 3, current: 0 })).toEqual({ ok: true, next: 3 });
    expect(validateAdjustment({ reason: "count_correction", delta: -4, current: 4 })).toEqual({ ok: true, next: 0 });
    expect(validateAdjustment({ reason: "other", delta: 1, current: 0, note: " " })).toEqual({ ok: false, error: "note_required" });
    expect(validateAdjustment({ reason: "other", delta: 1, current: 0, note: "sample back" })).toEqual({ ok: true, next: 1 });
  });
  it("refuses a zero change and stock below zero", () => {
    expect(validateAdjustment({ reason: "count_correction", delta: 0, current: 5 })).toEqual({ ok: false, error: "zero" });
    expect(validateAdjustment({ reason: "lost", delta: -6, current: 5 })).toEqual({ ok: false, error: "negative_stock" });
  });
});

describe("stock-take review", () => {
  it("classifies counted lines and ignores variants not counted", () => {
    const expected = new Map([["a", 5], ["b", 3], ["c", 0], ["d", 9]]);
    const r = reviewStockTake([{ id: "1", variantId: "a", counted: 5 }, { id: "2", variantId: "b", counted: 1 }, { id: "3", variantId: "c", counted: 2 }, { id: "4", variantId: null, counted: 4 }, { id: "5", variantId: "e", counted: 1 }], expected);
    expect(r.rows.map((x) => [x.id, x.status, x.delta])).toEqual([["1", "match", 0], ["2", "missing", -2], ["3", "surplus", 2], ["4", "unknown", 0], ["5", "surplus", 1]]);
    expect(r.summary).toEqual({ match: 1, missing: 1, surplus: 2, unknown: 1, unitsMissing: 2, unitsSurplus: 3 });
    // "d" was not counted: not part of the review
    expect(r.rows.some((x) => x.variantId === "d")).toBe(false);
  });
  it("normalizes scanned codes", () => {
    expect(normalizeScanCode("  AB-12  x ")).toBe("ab-12 x");
  });
});

describe("unexplained losses", () => {
  it("counts falls and unreported levels only", () => {
    expect(driftLossUnits("unexplained", -3)).toBe(3);
    expect(driftLossUnits("unexplained", 2)).toBe(0);
    expect(driftLossUnits("not_reported", -6)).toBe(6);
    expect(driftLossUnits("negative", -2)).toBe(0);
  });
});

describe("markdown margin floor", () => {
  const vat = { taxRateBps: 2200, pricesIncludeTax: true };
  const noTax = { taxRateBps: 0, pricesIncludeTax: false };
  const base: MarkdownInput = { priceMinor: 10_000, compareAtMinor: null, costMinor: 3_000, available: 40, unitsSold: 0, daysOfCover: null, minMarginBps: 2_000, excessCoverDays: 120, slowCoverDays: 180, ...noTax };

  it("computes the floor on the net-of-tax price", () => {
    // 30.00 cost, 20% margin → 37.50 net; with 22% VAT included → 45.75
    expect(marginFloorPrice(3_000, 2_000, noTax)).toBe(3_750);
    expect(marginFloorPrice(3_000, 2_000, vat)).toBe(4_575);
    expect(marginBpsAt(3_750, 3_000, noTax)).toBe(2_000);
    expect(marginBpsAt(4_575, 3_000, vat)).toBeGreaterThanOrEqual(2_000);
  });

  it("suggests the deep markdown for stock without sales and the light one for excess cover", () => {
    expect(suggestMarkdown(base)).toMatchObject({ kind: "suggest", reason: "no_sales", priceMinor: 7_000, compareAtMinor: 10_000, discountBps: 3_000, clampedByFloor: false });
    expect(suggestMarkdown({ ...base, unitsSold: 5, daysOfCover: 150 })).toMatchObject({ kind: "suggest", reason: "excess", priceMinor: 8_500 });
    expect(suggestMarkdown({ ...base, unitsSold: 2, daysOfCover: 200 })).toMatchObject({ kind: "suggest", reason: "slow", priceMinor: 7_000 });
    expect(suggestMarkdown({ ...base, unitsSold: 20, daysOfCover: 60 })).toEqual({ kind: "skip", reason: "not_excess", floorPriceMinor: null });
  });

  it("stops at the floor and never goes below it", () => {
    const r = suggestMarkdown({ ...base, costMinor: 6_000 });
    // floor 75.00 is above the 30% target (70.00)
    expect(r).toMatchObject({ kind: "suggest", priceMinor: 7_500, floorPriceMinor: 7_500, clampedByFloor: true, marginBps: 2_000 });
    expect(suggestMarkdown({ ...base, costMinor: 8_500 })).toEqual({ kind: "skip", reason: "floor", floorPriceMinor: 10_625 });
  });

  it("starts from the compare-at price when already marked down, and skips when it is deep enough", () => {
    expect(suggestMarkdown({ ...base, priceMinor: 9_000, compareAtMinor: 10_000 })).toMatchObject({ kind: "suggest", priceMinor: 7_000, compareAtMinor: 10_000, regularPriceMinor: 10_000 });
    expect(suggestMarkdown({ ...base, priceMinor: 6_500, compareAtMinor: 10_000 })).toMatchObject({ kind: "skip", reason: "already_marked_down" });
  });

  it("needs stock and a cost", () => {
    expect(suggestMarkdown({ ...base, available: 0 })).toMatchObject({ kind: "skip", reason: "no_stock" });
    expect(suggestMarkdown({ ...base, costMinor: null })).toMatchObject({ kind: "skip", reason: "no_cost" });
  });

  it("no suggestion is ever below the minimum-margin floor (exhaustive sweep)", () => {
    let suggested = 0;
    for (const price of [999, 1_990, 4_590, 12_900, 49_999])
      for (const costPct of [5, 20, 35, 50, 65, 80, 95])
        for (const minMarginBps of [0, 1_000, 2_500, 4_000, 6_000])
          for (const tax of [noTax, vat, { taxRateBps: 1_900, pricesIncludeTax: true }, { taxRateBps: 825, pricesIncludeTax: false }])
            for (const situation of [{ unitsSold: 0, daysOfCover: null }, { unitsSold: 3, daysOfCover: 130 }, { unitsSold: 1, daysOfCover: 400 }])
              for (const compareAtMinor of [null, Math.round(price * 1.3)]) {
                const costMinor = Math.round((price * costPct) / 100);
                const r = suggestMarkdown({ ...base, ...tax, ...situation, priceMinor: price, compareAtMinor, costMinor, minMarginBps });
                if (r.kind !== "suggest") continue;
                suggested++;
                expect(r.priceMinor).toBeGreaterThanOrEqual(r.floorPriceMinor);
                expect(r.priceMinor).toBeLessThan(price);
                // exact check on the net-of-tax margin: net × (1 − m) ≥ cost
                const den = tax.pricesIncludeTax ? 10_000 + tax.taxRateBps : 10_000;
                expect(r.priceMinor * 10_000 * (10_000 - minMarginBps)).toBeGreaterThanOrEqual(costMinor * den * 10_000);
                expect(r.marginBps!).toBeGreaterThanOrEqual(minMarginBps);
              }
    expect(suggested).toBeGreaterThan(100);
  });
});

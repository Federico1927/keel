import { describe, expect, it } from "vitest";
import { allocateByShare, allocationToPoLines, optionMixShares, optionValueOf, packAllocation, packFitsProduct, packGroups, packUnits, packsForDemand, type CasePackDef } from "./packs";

const sizeRun: CasePackDef = { name: "Size run", optionName: "Size", units: { S: 1, M: 2, L: 2, XL: 1 } };
const variants: { id: string; optionValues: Record<string, string> }[] = [
  { id: "n-s", optionValues: { Size: "S", Color: "Navy" } },
  { id: "n-m", optionValues: { Size: "M", Color: "Navy" } },
  { id: "n-l", optionValues: { Size: "L", Color: "Navy" } },
  { id: "n-xl", optionValues: { Size: "XL", Color: "Navy" } },
  { id: "s-s", optionValues: { Color: "Sand", Size: "S" } },
  { id: "s-m", optionValues: { Color: "Sand", Size: "M" } },
  { id: "nosize", optionValues: { Color: "Sand" } },
];

describe("case packs", () => {
  it("counts units and matches option names and values case-insensitively", () => {
    expect(packUnits(sizeRun)).toBe(6);
    expect(optionValueOf({ size: "M" }, "Size")).toBe("M");
    expect(optionValueOf({ Color: "Navy" }, "Size")).toBeNull();
    expect(packFitsProduct(sizeRun, [{ name: "SIZE", values: ["m", "XXL"] }])).toBe(true);
    expect(packFitsProduct(sizeRun, [{ name: "Material", values: ["S"] }])).toBe(false);
    expect(packFitsProduct(sizeRun, [{ name: "Size", values: ["XXL"] }])).toBe(false);
  });

  it("groups variants by the other options, whatever their order", () => {
    const groups = packGroups(variants, "size");
    expect(groups.map((g) => g.key)).toEqual(["Color=Navy", "Color=Sand"]);
    expect(groups[0]!.members.map((m) => m.value)).toEqual(["S", "M", "L", "XL"]);
    expect(groups[1]!.members.map((m) => m.variant.id)).toEqual(["s-s", "s-m"]);
    // a product with only the pack's option is one group with an empty key
    expect(packGroups([{ id: "a", optionValues: { Scent: "Fig" } }], "Scent")[0]!.key).toBe("");
  });

  it("buys N cartons for the group's total need, or enough to cover every value", () => {
    // need 3 S, 5 M, 4 L, 0 XL = 12 units → 2 cartons (12 / 6)
    const total = packsForDemand(sizeRun, { S: 3, M: 5, L: 4, XL: 0 });
    expect(total.packs).toBe(2);
    expect(total.unitsByValue).toEqual({ S: 2, M: 4, L: 4, XL: 2 });
    expect(total.surplusByValue).toEqual({ S: -1, M: -1, L: 0, XL: 2 });
    // cover: S needs 3 cartons (3 / 1), M 3 (5 / 2), L 2 → 3
    expect(packsForDemand(sizeRun, { S: 3, M: 5, L: 4, XL: 0 }, "cover").packs).toBe(3);
    // nothing needed → no carton; values outside the pack stay short
    expect(packsForDemand(sizeRun, {}).packs).toBe(0);
    const outside = packsForDemand(sizeRun, { XXL: 4, M: 1 });
    expect(outside.packs).toBe(1);
    expect(outside.surplusByValue.XXL).toBe(-4);
  });

  it("turns cartons into units per variant", () => {
    const [navy] = packGroups(variants, "Size");
    expect(packAllocation(sizeRun, navy!, 3)).toEqual({ "n-s": 3, "n-m": 6, "n-l": 6, "n-xl": 3 });
  });
});

describe("option mix", () => {
  const sales = [
    { optionValues: { Size: "S", Color: "Navy" }, units: 10 },
    { optionValues: { Size: "M", Color: "Navy" }, units: 30 },
    { optionValues: { Size: "M", Color: "Sand" }, units: 20 },
    { optionValues: { Size: "L", Color: "Sand" }, units: 40 },
  ];
  it("gives the share of each combination, aggregated on chosen options", () => {
    const full = optionMixShares(sales);
    expect(full[0]).toMatchObject({ key: "Color=Sand|Size=L", units: 40, share: 0.4 });
    const bySize = optionMixShares(sales, ["size"]);
    expect(bySize.map((r) => [r.key, r.share])).toEqual([["Size=M", 0.5], ["Size=L", 0.4], ["Size=S", 0.1]]);
    // nothing sold: equal shares
    expect(optionMixShares([{ optionValues: { A: "1" }, units: 0 }, { optionValues: { A: "2" }, units: 0 }]).map((r) => r.share)).toEqual([0.5, 0.5]);
  });

  it("allocates by largest remainder, in multiples when asked, and builds PO lines", () => {
    const shares = [{ key: "a", share: 0.5 }, { key: "b", share: 0.3 }, { key: "c", share: 0.2 }];
    expect(allocateByShare(10, shares)).toEqual({ a: 5, b: 3, c: 2 });
    // 7 units: exact 3.5 / 2.1 / 1.4 → 3/2/1 + 1 to the largest remainder (a)
    expect(allocateByShare(7, shares)).toEqual({ a: 4, b: 2, c: 1 });
    // multiples of 6: 20 → 4 blocks (24 units): 2 / 1.2 / 0.8 → 2/1/0 + 1 to c
    const m = allocateByShare(20, shares, { multiple: 6 });
    expect(m).toEqual({ a: 12, b: 6, c: 6 });
    expect(Object.values(m).reduce((s, n) => s + n, 0)).toBe(24);
    expect(allocateByShare(0, shares)).toEqual({ a: 0, b: 0, c: 0 });
    expect(allocateByShare(3, [{ key: "x", share: 0 }, { key: "y", share: 0 }])).toEqual({ x: 2, y: 1 });
    expect(allocationToPoLines({ a: 12, b: 0, c: 6 }, { a: 450, c: null })).toEqual([{ variantId: "a", quantity: 12, unitCostMinor: 450 }, { variantId: "c", quantity: 6, unitCostMinor: 0 }]);
  });
});

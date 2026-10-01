import { describe, expect, it } from "vitest";
import { catalogQuality, costCoverage, matchCostRows, parseAmountToMinor, parseCostCsv, parseCsv, shouldTakePlatformCost } from "./product-costs";

describe("platform cost import", () => {
  it("fills a missing cost and follows the platform, never overwriting a manual, imported or PO cost", () => {
    expect(shouldTakePlatformCost({ costMinor: null, costSource: null }, 1250)).toBe(true);
    expect(shouldTakePlatformCost({ costMinor: null, costSource: null }, null)).toBe(false);
    expect(shouldTakePlatformCost({ costMinor: null, costSource: null }, undefined)).toBe(false);
    expect(shouldTakePlatformCost({ costMinor: 1000, costSource: "platform" }, 1250)).toBe(true);
    expect(shouldTakePlatformCost({ costMinor: 1250, costSource: "platform" }, 1250)).toBe(false);
    for (const source of ["po_receipt", "manual", "import", null]) expect(shouldTakePlatformCost({ costMinor: 1000, costSource: source }, 1250)).toBe(false);
    expect(shouldTakePlatformCost({ costMinor: null, costSource: null }, -5)).toBe(false);
  });
});

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, CRLF, semicolons and a BOM", () => {
    expect(parseCsv('\uFEFFsku,cost\r\n"A,1",12.5\r\n"say ""hi""",3\n\n')).toEqual([["sku", "cost"], ["A,1", "12.5"], ['say "hi"', "3"]]);
    expect(parseCsv("sku;cost\nB;12,50")).toEqual([["sku", "cost"], ["B", "12,50"]]);
    expect(parseCsv("sku\tcost\nC\t7")).toEqual([["sku", "cost"], ["C", "7"]]);
  });
  it("reads amounts written the European or the US way", () => {
    expect(parseAmountToMinor("12.5")).toBe(1250);
    expect(parseAmountToMinor("12,50")).toBe(1250);
    expect(parseAmountToMinor("1.234,56")).toBe(123456);
    expect(parseAmountToMinor("1,234.56")).toBe(123456);
    expect(parseAmountToMinor("1,234")).toBe(123400);
    expect(parseAmountToMinor("€ 9.90")).toBe(990);
    expect(parseAmountToMinor("0")).toBe(0);
    for (const bad of ["", "abc", "-3", "1.2.3,4,5", "1,2,3.4.5"]) expect(parseAmountToMinor(bad)).toBeNull();
  });
  it("needs a cost column and a SKU or supplier SKU column; flags invalid and repeated rows", () => {
    expect(parseCostCsv("").error).toBe("empty");
    expect(parseCostCsv("name,price\nx,1").error).toBe("missing_columns");
    const { rows, error } = parseCostCsv("SKU,Unit cost,Supplier SKU\nA-1,10.00,\n,5,\nB-2,abc,\nA-1,11,\n,7,SUP-9");
    expect(error).toBeNull();
    expect(rows.map((r) => [r.line, r.sku, r.supplierSku, r.costMinor, r.error])).toEqual([
      [2, "A-1", null, 1000, null],
      [3, null, null, 500, "missing_sku"],
      [4, "B-2", null, null, "invalid_cost"],
      [5, "A-1", null, 1100, "duplicate_row"],
      [6, null, "SUP-9", 700, null],
    ]);
    expect(parseCostCsv("Variant SKU,Cost per item\nX,1").rows[0]).toMatchObject({ sku: "X", costMinor: 100 });
  });
});

describe("cost import matching", () => {
  const catalog = [
    { id: "v1", sku: "A-1", supplierSkus: [], costMinor: null, costSource: null, label: "Jacket M" },
    { id: "v2", sku: "B-2", supplierSkus: ["SUP-9"], costMinor: 700, costSource: "platform", label: "Shirt L" },
    { id: "v3", sku: "DUP", supplierSkus: [], costMinor: 100, costSource: "manual", label: "Cap" },
    { id: "v4", sku: "dup", supplierSkus: [], costMinor: 100, costSource: "manual", label: "Cap 2" },
  ];
  it("matches by SKU case-insensitively, then by supplier SKU; reports unmatched, ambiguous, unchanged and invalid rows", () => {
    const { rows } = parseCostCsv("sku,cost,supplier sku\na-1,10,\nZZZ,4,\nDUP,3,\n,7,sup-9\nQ,x,");
    const p = matchCostRows(rows, catalog);
    expect(p.rows.map((r) => [r.status, r.variantId, r.fromMinor])).toEqual([
      ["matched", "v1", null],
      ["unmatched", null, null],
      ["ambiguous", null, null],
      ["unchanged", "v2", 700],
      ["invalid", null, null],
    ]);
    expect(p.counts).toEqual({ matched: 1, unchanged: 1, unmatched: 1, ambiguous: 1, invalid: 1 });
  });
  it("never lets two rows write the same variant", () => {
    const { rows } = parseCostCsv("sku,cost,supplier sku\nB-2,8,\n,9,SUP-9");
    expect(matchCostRows(rows, catalog).rows.map((r) => r.status)).toEqual(["matched", "ambiguous"]);
  });
});

describe("catalog data quality", () => {
  it("lists variants with missing cost, SKU, barcode or image, and duplicate SKUs", () => {
    const q = catalogQuality([
      { id: "a", sku: "S1", barcode: "1", costMinor: 100, imageUrl: "x" },
      { id: "b", sku: "S2", barcode: null, costMinor: null, imageUrl: "x" },
      { id: "c", sku: " s2 ", barcode: "2", costMinor: 5, imageUrl: null },
      { id: "d", sku: "", barcode: "3", costMinor: 5, imageUrl: "x" },
    ]);
    expect(q.rows.map((r) => [r.id, r.issues])).toEqual([
      ["b", ["missing_cost", "duplicate_sku", "missing_barcode"]],
      ["c", ["duplicate_sku", "missing_image"]],
      ["d", ["missing_sku"]],
    ]);
    expect(q.counts).toEqual({ missing_cost: 1, missing_sku: 1, duplicate_sku: 2, missing_barcode: 1, missing_image: 1 });
    expect(q).toMatchObject({ affected: 3, total: 4 });
  });
});

describe("cost coverage", () => {
  it("splits line revenue by cost source and reports the share with a known cost", () => {
    const c = costCoverage([
      { revenueMinor: 6000, hasCost: true, source: "platform" },
      { revenueMinor: 2000, hasCost: true, source: "po_receipt" },
      { revenueMinor: 1000, hasCost: true, source: null },
      { revenueMinor: 1000, hasCost: false, source: "platform" },
    ]);
    expect(c.byKey).toEqual({ platform: 6000, manual: 0, import: 0, po_receipt: 2000, unknown: 1000, missing: 1000 });
    expect(c.totalMinor).toBe(10000);
    expect(c.coveredShare).toBeCloseTo(0.9);
    expect(costCoverage([]).coveredShare).toBeNull();
  });
});

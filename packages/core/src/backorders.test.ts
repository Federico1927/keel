import { describe, expect, it } from "vitest";
import { AWAITING_STOCK_REASON, allocateRelease, isBackorderOpen, lineShortage, optionStockGrid, pickIncomingLine } from "./backorders";
import { defaultStateRules, deriveOrderStatus, type StateInput } from "./state-rules";

describe("lineShortage", () => {
  it("serves what is free and backorders the rest", () => {
    expect(lineShortage({ quantity: 3, available: 5 })).toBe(0);
    expect(lineShortage({ quantity: 3, available: 1 })).toBe(2);
    expect(lineShortage({ quantity: 3, available: 0 })).toBe(3);
    expect(lineShortage({ quantity: 3, available: -4 })).toBe(3);
  });
  it("takes earlier unreflected orders off first", () => {
    expect(lineShortage({ quantity: 2, available: 3, aheadUnits: 2 })).toBe(1);
    expect(lineShortage({ quantity: 2, available: 3, aheadUnits: 9 })).toBe(2);
  });
  it("a level that already reflects the order only shows an overcommit", () => {
    expect(lineShortage({ quantity: 2, available: 0, reflected: true })).toBe(0);
    expect(lineShortage({ quantity: 2, available: 0, reflected: true, overcommitted: 1 })).toBe(1);
    expect(lineShortage({ quantity: 2, available: 0, reflected: true, overcommitted: 7 })).toBe(2);
  });
});

describe("pickIncomingLine", () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  const lines = [
    { id: "late", remaining: 50, claimed: 0, expectedAt: d("2026-11-01") },
    { id: "undated", remaining: 50, claimed: 0, expectedAt: null },
    { id: "soon-small", remaining: 3, claimed: 2, expectedAt: d("2026-10-05") },
    { id: "soon", remaining: 10, claimed: 0, expectedAt: d("2026-10-10") },
  ];
  it("links the earliest line whose unclaimed units cover the shortage", () => {
    expect(pickIncomingLine(lines, 1)?.id).toBe("soon-small");
    expect(pickIncomingLine(lines, 2)?.id).toBe("soon");
    expect(pickIncomingLine(lines, 20)?.id).toBe("late");
    expect(pickIncomingLine(lines.slice(1, 2), 20)?.id).toBe("undated");
    expect(pickIncomingLine(lines, 60)).toBeNull();
  });
});

describe("allocateRelease", () => {
  it("first fit in age order", () => {
    const bs = [{ id: "a", quantity: 3 }, { id: "b", quantity: 5 }, { id: "c", quantity: 2 }];
    expect([...allocateRelease(bs, 2)]).toEqual(["c"]);
    expect([...allocateRelease(bs, 5)]).toEqual(["a", "c"]);
    expect([...allocateRelease(bs, 10)]).toEqual(["a", "b", "c"]);
    expect(allocateRelease(bs, 0).size).toBe(0);
  });
  it("open statuses", () => {
    expect(isBackorderOpen("pending") && isBackorderOpen("covered")).toBe(true);
    expect(isBackorderOpen("fulfilled") || isBackorderOpen("cancelled")).toBe(false);
  });
});

describe("awaiting stock in the state engine", () => {
  const base: StateInput = { platformTags: [], paymentMethod: "card", paymentStatus: "paid", financialStatusRaw: "paid", fulfillmentStatusRaw: null, cancelledAt: null, placedAt: new Date("2026-09-01T10:00:00Z"), now: new Date("2026-09-02T10:00:00Z") };
  it("holds an open order, after hard facts and manual decisions, before the tenant rules", () => {
    expect(deriveOrderStatus({ ...base, awaitingStock: true }, defaultStateRules())).toEqual({ status: "on_hold", reason: AWAITING_STOCK_REASON });
    expect(deriveOrderStatus({ ...base, awaitingStock: false }, defaultStateRules()).status).toBe("confirmed");
    expect(deriveOrderStatus({ ...base, awaitingStock: true, cancelledAt: new Date() }, defaultStateRules()).status).toBe("cancelled");
    expect(deriveOrderStatus({ ...base, awaitingStock: true, manualStatus: "confirmed" }, defaultStateRules()).reason).toBe("manual");
    expect(deriveOrderStatus({ ...base, awaitingStock: true, fulfillmentStatusRaw: "fulfilled" }, defaultStateRules()).status).toBe("shipped");
  });
});

describe("optionStockGrid", () => {
  const options = [{ name: "Material", values: ["Oak", "Walnut"] }, { name: "Length", values: ["120", "160", "200"] }, { name: "Finish", values: ["Matte", "Gloss"] }];
  const variants = [
    { id: "1", optionValues: { Material: "Oak", Length: "120", Finish: "Matte" }, available: 4, incoming: 0, committed: 1 },
    { id: "2", optionValues: { Material: "Oak", Length: "120", Finish: "Gloss" }, available: 1, incoming: 5, committed: 0 },
    { id: "3", optionValues: { Material: "Walnut", Length: "200", Finish: "Matte" }, available: 0, incoming: 10, committed: 2 },
    { id: "4", optionValues: { Material: "Walnut", Length: "240", Finish: "Matte" }, available: 2, incoming: 0, committed: 0 },
  ];
  it("lays stock out by any two options, folds the others and totals to the levels", () => {
    const g = optionStockGrid(options, variants);
    expect(g.rowOption).toBe("Material");
    expect(g.colOption).toBe("Length");
    expect(g.folded).toEqual(["Finish"]);
    expect(g.rows).toEqual(["Oak", "Walnut"]);
    // a value only a variant carries is appended
    expect(g.cols).toEqual(["120", "160", "200", "240"]);
    expect(g.cells[0]![0]).toMatchObject({ available: 5, incoming: 5, committed: 1, variantIds: ["1", "2"] });
    expect(g.cells[0]![1]!.variantIds).toEqual([]);
    expect(g.total).toMatchObject({ available: 7, incoming: 15, committed: 3 });
    expect(g.rowTotals.reduce((s, c) => s + c.available, 0)).toBe(7);
    expect(g.colTotals.reduce((s, c) => s + c.incoming, 0)).toBe(15);
  });
  it("honours the picked options and works with one option or none", () => {
    const g = optionStockGrid(options, variants, { rows: "Finish", cols: "Material" });
    expect([g.rowOption, g.colOption, g.folded]).toEqual(["Finish", "Material", ["Length"]]);
    expect(g.cells[0]![1]!.available).toBe(2);
    const one = optionStockGrid([{ name: "Size", values: ["S", "M"] }], [{ id: "a", optionValues: { Size: "M" }, available: 3, incoming: 1, committed: 0 }]);
    expect([one.rows, one.cols, one.colOption]).toEqual([["S", "M"], [""], null]);
    expect(one.cells[1]![0]!.available).toBe(3);
    const none = optionStockGrid([], [{ id: "a", optionValues: {}, available: 3, incoming: 1, committed: 0 }]);
    expect(none.total.available).toBe(3);
  });
});

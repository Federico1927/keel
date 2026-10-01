import { describe, expect, it } from "vitest";
import { applyBulkCompareAt, applyBulkPrice, csvAmount, csvCell, csvLine, parseSearchTerms, planTagChange } from "./lists";

describe("bulk helpers", () => {
  it("plans tag changes without duplicates", () => {
    expect(planTagChange(["vip", "Gift"], [" VIP ", "sale", "sale"], ["gift", "missing"])).toEqual({ add: ["sale"], remove: ["gift"], next: ["vip", "sale"] });
    expect(planTagChange([], [], [])).toEqual({ add: [], remove: [], next: [] });
  });
  it("computes bulk prices", () => {
    expect(applyBulkPrice(4990, { mode: "set", valueMinor: 3990 })).toBe(3990);
    expect(applyBulkPrice(4990, { mode: "percent", bps: -1000 })).toBe(4491);
    expect(applyBulkPrice(100, { mode: "percent", bps: -20000 })).toBe(0);
    expect(applyBulkCompareAt({ mode: "clear" })).toBeNull();
    expect(applyBulkCompareAt({ mode: "set", valueMinor: 5990 })).toBe(5990);
  });
});

describe("search terms", () => {
  const it_ = { country: "IT", orderNumberPrefix: "NW-" };
  it("reads order numbers with or without prefix", () => {
    expect(parseSearchTerms("#NW-1042", it_).orderNumber).toBe(1042);
    expect(parseSearchTerms("1042", it_).orderNumber).toBe(1042);
    expect(parseSearchTerms("nw-1042", it_).orderNumber).toBe(1042);
    expect(parseSearchTerms("rossi", it_).orderNumber).toBeNull();
  });
  it("normalises phones in local and international format to the same E.164", () => {
    expect(parseSearchTerms("+39 333 123 4567", it_).phoneE164).toBe("+393331234567");
    expect(parseSearchTerms("333 1234567", it_).phoneE164).toBe("+393331234567");
    expect(parseSearchTerms("(212) 555-0142", { country: "US", orderNumberPrefix: "" }).phoneE164).toBe("+12125550142");
    expect(parseSearchTerms("1042", it_).phoneE164).toBeNull();
  });
  it("detects emails", () => {
    expect(parseSearchTerms(" Anna@Example.com ", it_)).toMatchObject({ email: "anna@example.com", text: "anna@example.com" });
  });
});

describe("csv", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell(null)).toBe("");
    expect(csvLine([1, true, new Date("2026-01-02T00:00:00Z"), csvAmount(1234)])).toBe("1,true,2026-01-02T00:00:00.000Z,12.34");
  });
});

import { describe, expect, it } from "vitest";
import { pdfString, renderPdf, tablePdf, textWidth } from "./pdf";

const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

describe("pdf", () => {
  it("escapes delimiters and maps the euro sign to WinAnsi", () => {
    expect(pdfString("a(b)c\\")).toBe("a\\(b\\)c\\\\");
    expect(pdfString("1.234,56 €").charCodeAt(9)).toBe(0x80);
    expect(pdfString("è")).toBe("\xe8");
    expect(pdfString("中")).toBe("?");
  });
  it("writes a structurally valid file with a correct xref", () => {
    const s = text(renderPdf([[{ x: 10, y: 10, text: "Hello" }], [{ kind: "rule", x1: 0, x2: 10, y: 5 }]]));
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/Count 2");
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    // every offset in the table points at "N 0 obj"
    const entries = s.slice(xref).split("\n").slice(3).filter((l) => / n $/.test(l));
    entries.forEach((e, i) => expect(s.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
  it("paginates long tables and right-aligns numbers", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Item ${i}`, String(i)]);
    const s = text(tablePdf({ title: "PO-1", header: ["Supplier"], columns: [{ label: "Item", width: 300 }, { label: "Qty", width: 100, align: "right" }], rows, totals: [["Total", "120"]] }));
    expect(Number(/\/Count (\d+)/.exec(s)![1])).toBeGreaterThan(1);
    expect(textWidth("10", 10)).toBeCloseTo(11.12, 2);
  });
});

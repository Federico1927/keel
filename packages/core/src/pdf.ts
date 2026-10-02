/**
 * Minimal PDF writer for text documents (purchase orders, packing lists): A4 pages, the
 * standard Helvetica fonts with WinAnsi encoding, text and horizontal rules. No dependency,
 * no I/O: returns the bytes. Characters outside WinAnsi are replaced with "?".
 */

export interface PdfText {
  kind?: "text";
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  /** Right-align at x. */
  align?: "left" | "right";
}
export interface PdfRule {
  kind: "rule";
  x1: number;
  x2: number;
  y: number;
}
export type PdfItem = PdfText | PdfRule;

export const A4 = { width: 595, height: 842 } as const;

const WIN_ANSI_EXTRA: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97, "™": 0x99 };

/** Encodes a string to WinAnsi bytes as a latin1 JS string, escaping PDF string delimiters. */
export function pdfString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    let b: number;
    if (code >= 0x20 && code < 0x7f) b = code;
    else if (code >= 0xa0 && code <= 0xff) b = code;
    else b = WIN_ANSI_EXTRA[ch] ?? 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\";
    out += String.fromCharCode(b);
  }
  return out;
}

/** Helvetica advance widths (1/1000 em) for ASCII; others approximated. Used for right alignment. */
const HELV: number[] = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 32 && c < 127 ? HELV[c - 32]! : 556;
  }
  return (w * size * (bold ? 1.05 : 1)) / 1000;
}

function contentStream(items: readonly PdfItem[]): string {
  const ops: string[] = [];
  for (const it of items) {
    if (it.kind === "rule") {
      ops.push(`0.6 w ${it.x1} ${it.y} m ${it.x2} ${it.y} l S`);
      continue;
    }
    const size = it.size ?? 10;
    const x = it.align === "right" ? it.x - textWidth(it.text, size, it.bold) : it.x;
    ops.push(`BT /${it.bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${it.y.toFixed(2)} Td (${pdfString(it.text)}) Tj ET`);
  }
  return ops.join("\n");
}

/** Builds a PDF with one page per item list; returns the file bytes. */
export function renderPdf(pages: readonly (readonly PdfItem[])[], meta: { title?: string } = {}): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then page/content pairs
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Producer (Keel) /Title (${pdfString(meta.title ?? "")}) >>`;
  let next = 6;
  for (const items of pages.length ? pages : [[]]) {
    const pageId = next++;
    const contentId = next++;
    const stream = contentStream(items);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    pageIds.push(pageId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

export interface TableDocument {
  title: string;
  /** Lines under the title (company, supplier, dates). */
  header: string[];
  columns: { label: string; width: number; align?: "left" | "right" }[];
  rows: string[][];
  /** Label/value pairs printed right-aligned under the table. */
  totals: [string, string][];
  footer?: string[];
}

/** Lays out a titled table over as many A4 pages as needed. */
export function tablePdf(doc: TableDocument): Uint8Array {
  return renderPdf(tablePages(doc), { title: doc.title });
}

/** Several documents in one file (bulk packing slips): each starts on a new page. */
export function tablesPdf(docs: readonly TableDocument[], meta: { title?: string } = {}): Uint8Array {
  return renderPdf(docs.flatMap(tablePages), { title: meta.title ?? docs[0]?.title });
}

/** The pages of one table document, for `renderPdf`. */
export function tablePages(doc: TableDocument): PdfItem[][] {
  const margin = 48;
  const lineH = 15;
  const pages: PdfItem[][] = [];
  let page: PdfItem[] = [];
  let y = A4.height - margin;
  const newPage = () => {
    if (page.length) pages.push(page);
    page = [];
    y = A4.height - margin;
  };
  const tableHeader = () => {
    let x = margin;
    for (const c of doc.columns) {
      page.push({ x: c.align === "right" ? x + c.width : x, y, text: c.label, size: 9, bold: true, align: c.align });
      x += c.width;
    }
    y -= 6;
    page.push({ kind: "rule", x1: margin, x2: A4.width - margin, y });
    y -= lineH;
  };
  page.push({ x: margin, y, text: doc.title, size: 18, bold: true });
  y -= 26;
  for (const h of doc.header) {
    page.push({ x: margin, y, text: h, size: 10 });
    y -= lineH;
  }
  y -= 10;
  tableHeader();
  for (const row of doc.rows) {
    if (y < margin + 60) {
      newPage();
      tableHeader();
    }
    let x = margin;
    for (const [i, c] of doc.columns.entries()) {
      let text = row[i] ?? "";
      const max = c.width - 6;
      while (text.length > 3 && textWidth(text, 9) > max) text = `${text.slice(0, -2)}…`.replace(/……$/, "…");
      page.push({ x: c.align === "right" ? x + c.width : x, y, text, size: 9, align: c.align });
      x += c.width;
    }
    y -= lineH;
  }
  y += 6;
  page.push({ kind: "rule", x1: margin, x2: A4.width - margin, y });
  y -= lineH + 2;
  for (const [label, value] of doc.totals) {
    if (y < margin) newPage();
    page.push({ x: A4.width - margin - 110, y, text: label, size: 10, align: "right" });
    page.push({ x: A4.width - margin, y, text: value, size: 10, bold: true, align: "right" });
    y -= lineH;
  }
  if (doc.footer?.length) {
    y -= 10;
    for (const f of doc.footer) {
      if (y < margin) newPage();
      page.push({ x: margin, y, text: f, size: 9 });
      y -= 13;
    }
  }
  newPage();
  return pages;
}

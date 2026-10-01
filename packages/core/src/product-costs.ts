/**
 * Product cost: where each variant's cost came from, when a platform cost may replace it,
 * the CSV cost import (parse → match → preview) and the catalog data-quality checks.
 * Pure: the services load rows and write the results.
 */

/** Where a variant's current cost came from; null on rows written before the column existed. */
export const PRODUCT_COST_SOURCES = ["platform", "manual", "import", "po_receipt"] as const;
export type ProductCostSource = (typeof PRODUCT_COST_SOURCES)[number];

/**
 * A cost read from the commerce platform (Shopify `inventoryItem.unitCost`) fills the variant only
 * when Keel has none, or when the current one came from the platform itself (kept in step with it).
 * A manual, imported or purchase-order cost is never overwritten by a sync.
 */
export function shouldTakePlatformCost(current: { costMinor: number | null; costSource: string | null }, platformCostMinor: number | null | undefined): boolean {
  if (platformCostMinor === null || platformCostMinor === undefined || !Number.isFinite(platformCostMinor) || platformCostMinor < 0) return false;
  if (current.costMinor === null) return true;
  return current.costSource === "platform" && current.costMinor !== platformCostMinor;
}

/* ---------- CSV ---------- */

/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF; the delimiter (`,` `;` or tab) is detected on the first line. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  const delim = counts.reduce((best, c) => (c[1] > best[1] ? c : best), counts[0]!)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Amount typed by a person → minor units, or null when it is not a non-negative amount.
 * Accepts "12.5", "12,50", "1.234,56", "1,234.56", "€ 12.50", "12.50 EUR".
 */
export function parseAmountToMinor(input: string): number | null {
  let s = input.trim().replace(/[^\d.,-]/g, "");
  if (!s || s.includes("-")) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    const thousands = dec === "." ? "," : ".";
    s = s.split(thousands).join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    // a single comma followed by one or two digits is a decimal comma ("12,50"); otherwise commas group thousands ("1,234")
    const parts = s.split(",");
    s = parts.length === 2 && parts[1]!.length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join("");
  } else if (s.split(".").length > 2) s = s.split(".").join("");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n > 10_000_000) return null;
  return Math.round(n * 100);
}

export const COST_IMPORT_MAX_ROWS = 20_000;
const HEADER_ALIASES: Record<"sku" | "cost" | "supplierSku", string[]> = {
  sku: ["sku", "variant sku", "codice", "codice sku", "código", "codigo"],
  cost: ["cost", "unit cost", "cost per item", "costo", "costo unitario", "coste", "coste unitario", "costo por artículo"],
  supplierSku: ["supplier sku", "supplier_sku", "vendor sku", "sku fornitore", "codice fornitore", "sku proveedor"],
};

export type CostRowError = "missing_sku" | "invalid_cost" | "duplicate_row";
export interface CostCsvRow {
  /** 1-based line in the file, header included. */
  line: number;
  sku: string | null;
  supplierSku: string | null;
  costMinor: number | null;
  rawCost: string;
  error: CostRowError | null;
}
export type CostCsvFileError = "empty" | "missing_columns" | "too_many_rows";

/** Parses a cost file with a header row: `sku` and `cost` are required, `supplier sku` is optional. */
export function parseCostCsv(text: string): { rows: CostCsvRow[]; error: CostCsvFileError | null } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: "empty" };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " "));
  const col = (k: keyof typeof HEADER_ALIASES) => header.findIndex((h) => HEADER_ALIASES[k].map((a) => a.replace(/_/g, " ")).includes(h));
  const iSku = col("sku");
  const iCost = col("cost");
  const iSupplier = col("supplierSku");
  if (iCost < 0 || (iSku < 0 && iSupplier < 0)) return { rows: [], error: "missing_columns" };
  if (table.length - 1 > COST_IMPORT_MAX_ROWS) return { rows: [], error: "too_many_rows" };
  const seen = new Set<string>();
  const rows = table.slice(1).map((r, idx): CostCsvRow => {
    const sku = iSku >= 0 ? (r[iSku] ?? "").trim() || null : null;
    const supplierSku = iSupplier >= 0 ? (r[iSupplier] ?? "").trim() || null : null;
    const rawCost = (r[iCost] ?? "").trim();
    const costMinor = parseAmountToMinor(rawCost);
    let error: CostRowError | null = null;
    if (!sku && !supplierSku) error = "missing_sku";
    else if (costMinor === null) error = "invalid_cost";
    else {
      const key = `${sku?.toLowerCase() ?? ""}\u0000${supplierSku?.toLowerCase() ?? ""}`;
      if (seen.has(key)) error = "duplicate_row";
      seen.add(key);
    }
    return { line: idx + 2, sku, supplierSku, costMinor, rawCost, error };
  });
  return { rows, error: null };
}

export interface CostCatalogVariant {
  id: string;
  sku: string | null;
  supplierSkus: string[];
  costMinor: number | null;
  costSource: string | null;
  label: string;
}

export type CostMatchStatus = "matched" | "unchanged" | "unmatched" | "ambiguous" | "invalid";
export interface CostMatchRow extends CostCsvRow {
  status: CostMatchStatus;
  variantId: string | null;
  label: string | null;
  fromMinor: number | null;
}
export interface CostImportPreview {
  rows: CostMatchRow[];
  counts: Record<CostMatchStatus, number>;
}

const normSku = (s: string) => s.trim().toLowerCase();

/**
 * Matches parsed rows to the catalog: by SKU first (case-insensitive), then by supplier SKU.
 * A key shared by several variants is `ambiguous` and never written; same cost is `unchanged`.
 */
export function matchCostRows(rows: readonly CostCsvRow[], catalog: readonly CostCatalogVariant[]): CostImportPreview {
  const bySku = new Map<string, CostCatalogVariant[]>();
  const bySupplier = new Map<string, CostCatalogVariant[]>();
  for (const v of catalog) {
    if (v.sku?.trim()) bySku.set(normSku(v.sku), [...(bySku.get(normSku(v.sku)) ?? []), v]);
    for (const s of new Set(v.supplierSkus.filter((x) => x.trim()).map(normSku))) bySupplier.set(s, [...(bySupplier.get(s) ?? []), v]);
  }
  const counts: Record<CostMatchStatus, number> = { matched: 0, unchanged: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
  const claimed = new Set<string>();
  const out = rows.map((r): CostMatchRow => {
    const base = { ...r, variantId: null, label: null, fromMinor: null };
    if (r.error) {
      counts.invalid++;
      return { ...base, status: "invalid" };
    }
    const hits = (r.sku ? bySku.get(normSku(r.sku)) : undefined) ?? (r.supplierSku ? bySupplier.get(normSku(r.supplierSku)) : undefined) ?? [];
    if (hits.length === 0) {
      counts.unmatched++;
      return { ...base, status: "unmatched" };
    }
    if (hits.length > 1 || claimed.has(hits[0]!.id)) {
      counts.ambiguous++;
      return { ...base, status: "ambiguous" };
    }
    const v = hits[0]!;
    claimed.add(v.id);
    const status: CostMatchStatus = v.costMinor === r.costMinor ? "unchanged" : "matched";
    counts[status]++;
    return { ...base, status, variantId: v.id, label: v.label, fromMinor: v.costMinor };
  });
  return { rows: out, counts };
}

/* ---------- catalog data quality ---------- */

export const CATALOG_ISSUES = ["missing_cost", "missing_sku", "duplicate_sku", "missing_barcode", "missing_image"] as const;
export type CatalogIssue = (typeof CATALOG_ISSUES)[number];

export interface QualityVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  costMinor: number | null;
  imageUrl: string | null;
}

/** Issues of every variant that has at least one, plus a count per issue and of affected variants. */
export function catalogQuality<T extends QualityVariant>(variants: readonly T[]): { rows: (T & { issues: CatalogIssue[] })[]; counts: Record<CatalogIssue, number>; affected: number; total: number } {
  const skuCount = new Map<string, number>();
  for (const v of variants) if (v.sku?.trim()) skuCount.set(normSku(v.sku), (skuCount.get(normSku(v.sku)) ?? 0) + 1);
  const counts = Object.fromEntries(CATALOG_ISSUES.map((k) => [k, 0])) as Record<CatalogIssue, number>;
  const rows: (T & { issues: CatalogIssue[] })[] = [];
  for (const v of variants) {
    const issues: CatalogIssue[] = [];
    if (v.costMinor === null) issues.push("missing_cost");
    if (!v.sku?.trim()) issues.push("missing_sku");
    else if ((skuCount.get(normSku(v.sku)) ?? 0) > 1) issues.push("duplicate_sku");
    if (!v.barcode?.trim()) issues.push("missing_barcode");
    if (!v.imageUrl?.trim()) issues.push("missing_image");
    for (const i of issues) counts[i]++;
    if (issues.length) rows.push({ ...v, issues });
  }
  return { rows, counts, affected: rows.length, total: variants.length };
}

/* ---------- cost reliability in the P/L ---------- */

export type CostCoverageKey = ProductCostSource | "unknown" | "missing";
export interface CostCoverage {
  totalMinor: number;
  byKey: Record<CostCoverageKey, number>;
  /** Share of line revenue whose cost is known (any source). */
  coveredShare: number | null;
}

/**
 * Line revenue split by where its cost came from: `missing` when the line has no cost, the
 * variant's cost source otherwise (`unknown` for rows older than the source column).
 */
export function costCoverage(lines: readonly { revenueMinor: number; hasCost: boolean; source: string | null }[]): CostCoverage {
  const byKey: Record<CostCoverageKey, number> = { platform: 0, manual: 0, import: 0, po_receipt: 0, unknown: 0, missing: 0 };
  let total = 0;
  for (const l of lines) {
    const rev = Math.max(0, l.revenueMinor);
    total += rev;
    const key: CostCoverageKey = !l.hasCost ? "missing" : (PRODUCT_COST_SOURCES as readonly string[]).includes(l.source ?? "") ? (l.source as ProductCostSource) : "unknown";
    byKey[key] += rev;
  }
  return { totalMinor: total, byKey, coveredShare: total ? (total - byKey.missing) / total : null };
}

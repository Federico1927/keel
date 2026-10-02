/**
 * Generic import of carrier outcomes (C.19): a CSV exported from the carrier's billing or COD
 * remittance, with a header row. Columns are recognised by name in en / it / es; the separator is
 * detected (`;`, `,` or tab). Nothing here is carrier-specific.
 */
export type CarrierOutcome = "delivered" | "refused";
export interface CarrierRow {
  line: number;
  reference: string;
  outcome: CarrierOutcome;
  occurredAt: Date | null;
  costMinor: number | null;
}
export interface CarrierParseResult {
  rows: CarrierRow[];
  errors: { line: number; code: "missing_reference" | "unknown_outcome" | "bad_date" | "bad_cost" }[];
  missingColumns: ("reference" | "outcome")[];
}

const HEADERS: Record<"reference" | "outcome" | "date" | "cost", string[]> = {
  reference: ["reference", "tracking", "tracking_number", "tracking number", "order", "order_name", "order name", "ordine", "riferimento", "spedizione", "pedido", "referencia", "seguimiento"],
  outcome: ["outcome", "status", "esito", "stato", "resultado", "estado"],
  date: ["date", "delivered_at", "data", "fecha"],
  cost: ["cost", "amount", "costo", "importo", "coste", "importe"],
};
const DELIVERED = ["delivered", "consegnato", "consegnata", "entregado", "entregada", "ok", "paid", "incassato", "pagato"];
const REFUSED = ["refused", "returned", "rejected", "rifiutato", "rifiutata", "reso", "respinto", "rechazado", "devuelto", "return_to_sender", "rts", "undelivered", "non consegnato"];

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function outcomeOfText(raw: string): CarrierOutcome | null {
  const v = norm(raw);
  if (DELIVERED.includes(v)) return "delivered";
  if (REFUSED.includes(v)) return "refused";
  return null;
}

/** Decimal amount ("12,50", "12.50", "1.234,50") to minor units; null when empty. */
export function parseAmount(raw: string, decimals = 2): number | null | "bad" {
  const s = raw.replace(/[^\d,.-]/g, "");
  if (!s) return null;
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const normalized = lastSep >= 0 && s.length - lastSep - 1 <= decimals ? `${s.slice(0, lastSep).replace(/[,.]/g, "")}.${s.slice(lastSep + 1)}` : s.replace(/[,.]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 10 ** decimals) : "bad";
}

/** ISO dates, or day-first `dd/mm/yyyy` / `dd-mm-yyyy` (carrier files in Europe). */
export function parseDay(raw: string): Date | null | "bad" {
  const s = raw.trim();
  if (!s) return null;
  const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  const d = dm ? new Date(Date.UTC(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]), 12)) : new Date(s);
  return Number.isNaN(d.getTime()) ? "bad" : d;
}

export function parseCarrierCsv(text: string, opts: { decimals?: number; maxRows?: number } = {}): CarrierParseResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim().length > 0);
  if (headerIdx < 0) return { rows: [], errors: [], missingColumns: ["reference", "outcome"] };
  const header = lines[headerIdx]!;
  const sep = [";", "\t", ","].sort((a, b) => header.split(b).length - header.split(a).length)[0]!;
  const cols = splitLine(header, sep).map(norm);
  const idx = (k: keyof typeof HEADERS) => cols.findIndex((c) => HEADERS[k].includes(c));
  const at = { reference: idx("reference"), outcome: idx("outcome"), date: idx("date"), cost: idx("cost") };
  const missingColumns = (["reference", "outcome"] as const).filter((k) => at[k] < 0);
  if (missingColumns.length) return { rows: [], errors: [], missingColumns: [...missingColumns] };
  const rows: CarrierRow[] = [];
  const errors: CarrierParseResult["errors"] = [];
  for (let i = headerIdx + 1; i < lines.length && rows.length < (opts.maxRows ?? 5000); i++) {
    if (!lines[i]!.trim()) continue;
    const cells = splitLine(lines[i]!, sep);
    const line = i + 1;
    const reference = (cells[at.reference] ?? "").trim();
    if (!reference) {
      errors.push({ line, code: "missing_reference" });
      continue;
    }
    const outcome = outcomeOfText(cells[at.outcome] ?? "");
    if (!outcome) {
      errors.push({ line, code: "unknown_outcome" });
      continue;
    }
    const date = at.date >= 0 ? parseDay(cells[at.date] ?? "") : null;
    if (date === "bad") {
      errors.push({ line, code: "bad_date" });
      continue;
    }
    const cost = at.cost >= 0 ? parseAmount(cells[at.cost] ?? "", opts.decimals ?? 2) : null;
    if (cost === "bad") {
      errors.push({ line, code: "bad_cost" });
      continue;
    }
    rows.push({ line, reference, outcome, occurredAt: date, costMinor: cost });
  }
  return { rows, errors, missingColumns: [] };
}

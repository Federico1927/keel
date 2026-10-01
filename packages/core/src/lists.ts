import { normalizeEmail, normalizePhone } from "./identity";

/* ---------- list queries ---------- */

/**
 * List filters live in the URL query. Saved views store it, CSV exports replay it, and the page,
 * the export and the background job all parse it the same way (services `parse*Filters`).
 */
export type QueryParams = Record<string, string | string[] | undefined>;

/** URL query string → params object (repeated keys joined with commas, like the list pages do). */
export function queryParams(query: string): QueryParams {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ""))) out[k] = out[k] ? `${out[k]},${v}` : v;
  return out;
}

/** The query string a saved view stores: the filters without the page number, keys sorted. */
export function canonicalQuery(params: QueryParams | string): string {
  const p = typeof params === "string" ? queryParams(params) : params;
  const u = new URLSearchParams();
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    if (k === "page" || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    u.set(k, Array.isArray(v) ? v.join(",") : v);
  }
  return u.toString();
}

/* ---------- bulk edits ---------- */

/** Tags to write and the resulting set: adds only what is missing, removes only what is there (case-insensitive, stored lower-case). */
export function planTagChange(current: readonly string[], add: readonly string[], remove: readonly string[]): { add: string[]; remove: string[]; next: string[] } {
  const clean = (xs: readonly string[]) => [...new Set(xs.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 255))];
  const have = new Set(current.map((t) => t.toLowerCase()));
  const toRemove = clean(remove).filter((t) => have.has(t));
  const toAdd = clean(add).filter((t) => !have.has(t) && !toRemove.includes(t));
  const next = [...current.filter((t) => !toRemove.includes(t.toLowerCase())), ...toAdd];
  return { add: toAdd, remove: toRemove, next };
}

export type BulkPriceChange = { mode: "set"; valueMinor: number } | { mode: "percent"; bps: number };

/** New price of a variant: a fixed amount, or the current price moved by a percentage (rounded to the minor unit, never negative). */
export function applyBulkPrice(currentMinor: number, change: BulkPriceChange): number {
  if (change.mode === "set") return Math.max(0, Math.round(change.valueMinor));
  return Math.max(0, Math.round((currentMinor * (10_000 + change.bps)) / 10_000));
}

export type BulkCompareAtChange = { mode: "set"; valueMinor: number } | { mode: "clear" };

export function applyBulkCompareAt(change: BulkCompareAtChange): number | null {
  return change.mode === "clear" ? null : Math.max(0, Math.round(change.valueMinor));
}

/* ---------- global search ---------- */

export interface SearchTerms {
  /** Trimmed text, lower-case, for name/email/title matches. */
  text: string;
  /** Order number when the query is one (`1042`, `#1042`, `#NW-1042`). */
  orderNumber: number | null;
  /** E.164 when the query reads as a phone number in international or the tenant's local format. */
  phoneE164: string | null;
  email: string | null;
}

/**
 * Reads a search box query: an order number (with or without the tenant prefix), a phone number
 * (normalised to E.164 with the tenant's country, so `+39 333 1234567` and `333 1234567` match the
 * same orders) or an email; everything else is text.
 */
export function parseSearchTerms(raw: string, opts: { country: string; orderNumberPrefix: string }): SearchTerms {
  const text = raw.trim().replace(/\s+/g, " ").slice(0, 120);
  const lower = text.toLowerCase();
  const prefix = opts.orderNumberPrefix.toLowerCase();
  const stripped = lower.replace(/^#/, "");
  const numeric = prefix && stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
  const orderNumber = /^\d{2,9}$/.test(numeric) ? Number(numeric) : null;
  const digits = text.replace(/\D/g, "");
  const phoneish = /^[+(\d][\d\s().\-/]*$/.test(text) && digits.length >= 6;
  const phoneE164 = phoneish ? normalizePhone(text, opts.country) : null;
  return { text: lower, orderNumber, phoneE164, email: text.includes("@") ? normalizeEmail(text) : null };
}

/* ---------- CSV ---------- */

/**
 * One CSV cell: quoted when needed, and text that a spreadsheet would run as a formula (`=`, `+`,
 * `@`, or `-` not followed by a digit) is prefixed with an apostrophe.
 */
export function csvCell(v: string | number | boolean | Date | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== "string") return String(v);
  const s = /^[=+@\t\r]/.test(v) || /^-(?![\d.])/.test(v) ? `'${v}` : v;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly (string | number | boolean | Date | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/** Amount in minor units as a plain decimal for spreadsheets (`1234` → `12.34`). */
export function csvAmount(minor: number | null | undefined): string | null {
  return minor === null || minor === undefined ? null : (minor / 100).toFixed(2);
}

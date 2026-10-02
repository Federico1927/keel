import { z } from "zod";
import { addDaysToKey, zonedDayStart } from "./fulfilment";
import { parseRateKey, type SalesSummaryDay } from "./daily-sales";

/**
 * Accounting push (add-on `addon.accounting`, issue #85): one journal per closed local day built
 * from the daily sales summary and the tenant's account mapping, pushed only when it reconciles.
 * Pure rules here; the provider adapters and the push log live in integrations and services.
 */

/** Summary lines an account code is mapped to. Sales and tax can be mapped per tax rate. */
export const ACCOUNTING_LINES = ["sales", "tax", "shipping", "discounts", "refunds", "fees", "clearing"] as const;
export type AccountingLine = (typeof ACCOUNTING_LINES)[number];

const accountCode = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._\-/ ]+$/);
const optionalCode = accountCode.nullable().default(null);
export const RATE_KEY_PATTERN = /^[A-Z]{2}\|\d{1,5}$/;

export const accountingMappingSchema = z.object({
  /** Default accounts for every tax rate without its own. */
  sales: optionalCode,
  tax: optionalCode,
  shipping: optionalCode,
  discounts: optionalCode,
  refunds: optionalCode,
  fees: optionalCode,
  /** Money due from the payment processors (and cash on delivery remittances): the day's net. */
  clearing: optionalCode,
  /** Per tax rate (`IT|2200`): sales and tax accounts overriding the defaults. */
  byRate: z.record(z.string().regex(RATE_KEY_PATTERN), z.object({ sales: optionalCode, tax: optionalCode })).default({}),
});
export type AccountingMapping = z.infer<typeof accountingMappingSchema>;

export const ACCOUNTING_JOURNAL_STATUSES = ["draft", "posted"] as const;

export const accountingSettingsSchema = z.object({
  mapping: accountingMappingSchema.prefault({}),
  /** First local day pushed (YYYY-MM-DD); earlier days are never pushed. Null = the first day of the window. */
  startDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** How far back the daily tick looks for days to push. */
  lookbackDays: z.number().int().min(1).max(90).default(35),
  /** Hours after local midnight before a day counts as closed (late webhooks and refunds settle). */
  closeDelayHours: z.number().int().min(0).max(48).default(2),
  /** Status the journals are created with in the accounting system. */
  journalStatus: z.enum(ACCOUNTING_JOURNAL_STATUSES).default("draft"),
});
export type AccountingSettings = z.infer<typeof accountingSettingsSchema>;

export function parseAccountingSettings(raw: unknown): AccountingSettings {
  const r = accountingSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : accountingSettingsSchema.parse({});
}

export interface JournalLine {
  line: AccountingLine;
  rateKey: string | null;
  accountCode: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
}
export interface DailyJournal {
  day: string;
  currency: string;
  narration: string;
  /** Stable reference in the accounting system: one per tenant, day and version. */
  reference: string;
  lines: JournalLine[];
  debitMinor: number;
  creditMinor: number;
}

const ratePercent = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
function rateLabel(rateKey: string): string {
  const { country, rateBps } = parseRateKey(rateKey);
  return `${country} ${ratePercent(rateBps)}`;
}

/** The account a line goes to: the rate's own for sales and tax, else the default; null = not mapped. */
export function accountFor(mapping: AccountingMapping, line: AccountingLine, rateKey: string | null = null): string | null {
  if (rateKey && (line === "sales" || line === "tax")) {
    const own = mapping.byRate[rateKey]?.[line];
    if (own) return own;
  }
  return mapping[line] ?? null;
}

/**
 * The journal of one summary day. Credits: sales per rate, output tax per rate, shipping. Debits:
 * discounts, refunds, payment fees and the clearing account for the net. A negative amount (a day of
 * refunds only) moves to the other side. Lines without an account are reported in `missing` and
 * left out; a day with nothing to post has no lines. Narration and descriptions are written for
 * the accounting system (one language for every tenant, like the platform's own exports).
 */
export function buildDailyJournal(day: SalesSummaryDay, mapping: AccountingMapping, opts: { currency: string; version: number; referencePrefix?: string }): { journal: DailyJournal; missing: { line: AccountingLine; rateKey: string | null }[] } {
  const lines: JournalLine[] = [];
  const missing: { line: AccountingLine; rateKey: string | null }[] = [];
  const push = (line: AccountingLine, rateKey: string | null, description: string, amount: number, side: "debit" | "credit") => {
    if (!amount) return;
    const code = accountFor(mapping, line, rateKey);
    if (!code) {
      if (!missing.some((m) => m.line === line && m.rateKey === (line === "sales" || line === "tax" ? rateKey : null))) missing.push({ line, rateKey: line === "sales" || line === "tax" ? rateKey : null });
      return;
    }
    const debit = (side === "debit") === amount > 0;
    lines.push({ line, rateKey, accountCode: code, description, debitMinor: debit ? Math.abs(amount) : 0, creditMinor: debit ? 0 : Math.abs(amount) });
  };
  for (const r of day.rates) {
    push("sales", r.rateKey, `Sales ${rateLabel(r.rateKey)}`, r.grossSalesMinor, "credit");
    push("tax", r.rateKey, `Output tax ${rateLabel(r.rateKey)}`, r.taxMinor, "credit");
  }
  push("shipping", null, "Shipping income", day.shippingMinor, "credit");
  push("discounts", null, "Discounts", day.discountsMinor, "debit");
  push("refunds", null, "Refunds", day.refundsMinor, "debit");
  push("fees", null, "Payment fees", day.feesMinor, "debit");
  push("clearing", null, "Payment processors clearing", day.netMinor, "debit");
  const debitMinor = lines.reduce((s, l) => s + l.debitMinor, 0);
  const creditMinor = lines.reduce((s, l) => s + l.creditMinor, 0);
  return { journal: { day: day.day, currency: opts.currency, narration: `Daily sales ${day.day}`, reference: `${opts.referencePrefix ?? "sales"}-${day.day}-v${opts.version}`, lines, debitMinor, creditMinor }, missing };
}

export function journalIsBalanced(j: Pick<DailyJournal, "debitMinor" | "creditMinor" | "lines">): boolean {
  return j.debitMinor === j.creditMinor && j.lines.every((l) => Number.isInteger(l.debitMinor) && Number.isInteger(l.creditMinor) && l.debitMinor >= 0 && l.creditMinor >= 0);
}

export type AccountingWaitReason =
  | { code: "before_start"; startDay: string }
  | { code: "day_open"; closesAt: string }
  | { code: "mapping_incomplete"; lines: string[] }
  | { code: "unbalanced"; differenceMinor: number }
  | { code: "orders_syncing"; count: number; orders: string[] }
  | { code: "orders_pending_write"; count: number; orders: string[] };

/** The instant a local day counts as closed: the next local midnight plus the settle delay. */
export function dayClosesAt(day: string, timeZone: string, closeDelayHours: number): Date {
  return new Date(zonedDayStart(addDaysToKey(day, 1), timeZone).getTime() + closeDelayHours * 3600e3);
}

/**
 * Whether a day may be pushed: on or after the start day, closed in the tenant's time zone, every
 * line mapped, debits equal to credits, and no order of the day still syncing from the platform or
 * waiting for a write to it. Every failed check is a reason the push log shows.
 */
export function dayReadiness(i: { day: string; now: Date; timeZone: string; settings: Pick<AccountingSettings, "startDay" | "closeDelayHours">; journal: DailyJournal; missing: readonly { line: AccountingLine; rateKey: string | null }[]; syncingOrders: readonly string[]; pendingWriteOrders: readonly string[] }): { ready: boolean; reasons: AccountingWaitReason[] } {
  const reasons: AccountingWaitReason[] = [];
  if (i.settings.startDay && i.day < i.settings.startDay) reasons.push({ code: "before_start", startDay: i.settings.startDay });
  const closes = dayClosesAt(i.day, i.timeZone, i.settings.closeDelayHours);
  if (i.now < closes) reasons.push({ code: "day_open", closesAt: closes.toISOString() });
  if (i.missing.length) reasons.push({ code: "mapping_incomplete", lines: i.missing.map((m) => (m.rateKey ? `${m.line}:${m.rateKey}` : m.line)) });
  // an unmapped line is left out of the journal: the balance only means something once every line has an account
  if (!i.missing.length && !journalIsBalanced(i.journal)) reasons.push({ code: "unbalanced", differenceMinor: i.journal.debitMinor - i.journal.creditMinor });
  const list = (xs: readonly string[]) => [...new Set(xs)].sort().slice(0, 5);
  if (i.syncingOrders.length) reasons.push({ code: "orders_syncing", count: new Set(i.syncingOrders).size, orders: list(i.syncingOrders) });
  if (i.pendingWriteOrders.length) reasons.push({ code: "orders_pending_write", count: new Set(i.pendingWriteOrders).size, orders: list(i.pendingWriteOrders) });
  return { ready: reasons.length === 0, reasons };
}

/** Days the daily tick looks at: from the start day (or the window's first day) to the last closed day, oldest first. */
export function accountingWindow(now: Date, timeZone: string, settings: Pick<AccountingSettings, "startDay" | "lookbackDays" | "closeDelayHours">, today: string): string[] {
  const out: string[] = [];
  const first = addDaysToKey(today, -settings.lookbackDays);
  for (let d = settings.startDay && settings.startDay > first ? settings.startDay : first; d < today; d = addDaysToKey(d, 1)) {
    if (now < dayClosesAt(d, timeZone, settings.closeDelayHours)) break;
    out.push(d);
  }
  return out;
}

/** Retry delay after a failed push: 15 min × 2^(attempts − 1), at most 12 h. */
export function accountingRetryDelayMs(attempts: number, retryAfterMs?: number): number {
  const base = Math.min(12 * 3600e3, 15 * 60e3 * 2 ** Math.max(0, attempts - 1));
  return Math.max(base, retryAfterMs ?? 0);
}

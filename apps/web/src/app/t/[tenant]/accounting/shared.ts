import { formatDateTime, formatMoney, type AccountingWaitReason, type JournalDriftLine } from "@hullwise/core";

/* Readable texts of the accounting push log (#85). */

type T = { (key: string, values?: Record<string, string | number>): string; has(key: string): boolean };

/** One wait reason as a sentence: `accounting.reasons.<code>` with its numbers, order names and dates. */
export function reasonText(t: T, r: AccountingWaitReason, o: { locale: string; timezone: string; currency: string; day: (d: string) => string; rate?: (rateKey: string) => string }): string {
  switch (r.code) {
    case "day_open":
      return t("reasons.day_open", { at: formatDateTime(r.closesAt, o.locale, o.timezone) });
    case "before_start":
      return t("reasons.before_start", { day: o.day(r.startDay) });
    case "mapping_incomplete":
      return t("reasons.mapping_incomplete", { lines: r.lines.map((l) => { const [line, rate] = l.split(":"); return t.has(`settings.lines.${line}`) ? `${t(`settings.lines.${line}`)}${rate ? ` (${o.rate ? o.rate(rate) : rate.replace("|", " ")})` : ""}` : l; }).join(", ") });
    case "unbalanced":
      return t("reasons.unbalanced", { difference: formatMoney(r.differenceMinor, o.currency, o.locale) });
    case "orders_syncing":
      return t("reasons.orders_syncing", { count: r.count, orders: r.orders.join(", ") });
    case "orders_pending_write":
      return t("reasons.orders_pending_write", { count: r.count, orders: r.orders.join(", ") });
  }
}

export const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "outline"> = { pushed: "success", waiting: "warning", failed: "destructive", voided: "muted", empty: "outline", pushing: "warning" };

/** One moved line of a pushed day: "Sales (IT 22%) 4000: €100.00 → €150.00" (amounts as credits or debits, never signed). */
export function driftLineText(t: T, l: JournalDriftLine, money: (minor: number) => string, rate: (rateKey: string) => string): string {
  const name = t.has(`settings.lines.${l.line}`) ? t(`settings.lines.${l.line}`) : l.line;
  return t("reconcile.line", { line: `${name}${l.rateKey ? ` (${rate(l.rateKey)})` : ""}`, account: l.accountCode, from: money(Math.abs(l.pushedMinor)), to: money(Math.abs(l.currentMinor)) });
}

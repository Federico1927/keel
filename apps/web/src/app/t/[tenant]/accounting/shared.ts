import { formatDateTime, formatMoney, type AccountingWaitReason } from "@hullwise/core";

/* Readable texts of the accounting push log (#85). */

type T = { (key: string, values?: Record<string, string | number>): string; has(key: string): boolean };

/** One wait reason as a sentence: `accounting.reasons.<code>` with its numbers, order names and dates. */
export function reasonText(t: T, r: AccountingWaitReason, o: { locale: string; timezone: string; currency: string; day: (d: string) => string }): string {
  switch (r.code) {
    case "day_open":
      return t("reasons.day_open", { at: formatDateTime(r.closesAt, o.locale, o.timezone) });
    case "before_start":
      return t("reasons.before_start", { day: o.day(r.startDay) });
    case "mapping_incomplete":
      return t("reasons.mapping_incomplete", { lines: r.lines.map((l) => { const [line, rate] = l.split(":"); return t.has(`settings.lines.${line}`) ? `${t(`settings.lines.${line}`)}${rate ? ` (${rate.replace("|", " ")})` : ""}` : l; }).join(", ") });
    case "unbalanced":
      return t("reasons.unbalanced", { difference: formatMoney(r.differenceMinor, o.currency, o.locale) });
    case "orders_syncing":
      return t("reasons.orders_syncing", { count: r.count, orders: r.orders.join(", ") });
    case "orders_pending_write":
      return t("reasons.orders_pending_write", { count: r.count, orders: r.orders.join(", ") });
  }
}

export const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "outline"> = { pushed: "success", waiting: "warning", failed: "destructive", voided: "muted", empty: "outline", pushing: "warning" };

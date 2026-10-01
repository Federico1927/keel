/** Intl-based formatting. Locale from the user, currency and timezone from the tenant. */
export function formatMoney(minor: number, currency: string, locale: string, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency, ...opts }).format(minor / 100);
}
export function formatNumber(value: number, locale: string, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, opts).format(value);
}
export function formatPercent(ratio: number | null | undefined, locale: string, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(ratio);
}
export function formatDate(value: Date | string | null | undefined, locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(d);
}
export function formatDateTime(value: Date | string | null | undefined, locale: string, timeZone: string): string {
  return formatDate(value, locale, timeZone, { dateStyle: "medium", timeStyle: "short" });
}
export function formatRelative(value: Date | string, locale: string, now = new Date()): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), "day");
  return rtf.format(Math.round(diffSec / (86400 * 30)), "month");
}

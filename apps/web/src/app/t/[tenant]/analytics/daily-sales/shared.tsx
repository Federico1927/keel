import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate, formatPercent, parseRateKey } from "@hullwise/core";
import { cn } from "@hullwise/ui";

/* Shared bits of the daily sales summary pages (#85). */

/** A local day key shown in the user's language (noon UTC, so no zone shifts it). */
export const dayLabel = (day: string, locale: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) => formatDate(`${day}T12:00:00Z`, locale, "UTC", opts);
export const ratePercent = (bps: number, locale: string) => formatPercent(bps / 10_000, locale, bps % 100 ? 2 : 0);
export function rateText(rateKey: string, locale: string, label: (v: { country: string; rate: string }) => string): string {
  const { country, rateBps } = parseRateKey(rateKey);
  return label({ country, rate: ratePercent(rateBps, locale) });
}

/** The orders behind one number of a day: kind (sale, refund, fee), tax rate or payment method. */
export function dayHref(tenant: string, day: string, filter: { kind?: "sale" | "refund" | "fee"; rate?: string; method?: string } = {}): string {
  const q = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])));
  return `/t/${tenant}/analytics/daily-sales/${day}${q.size ? `?${q}` : ""}`;
}

/** A number that opens the orders behind it when there are any. */
export function Num({ href, value, children, className }: { href?: string; value: number; children: ReactNode; className?: string }) {
  const cls = cn("tabular", value < 0 && "text-destructive", className);
  return href && value !== 0 ? <Link href={href} className={cn(cls, "hover:underline")}>{children}</Link> : <span className={cn(cls, value === 0 && "text-muted-foreground")}>{children}</span>;
}

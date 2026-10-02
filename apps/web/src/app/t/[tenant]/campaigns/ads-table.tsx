import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent, type AdEntityEconomics, type AdMetricValues, type Period } from "@hullwise/core";
import { periodQuery, type OrdersFilter } from "@hullwise/services";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";

export interface AdsTableRow {
  key: string;
  name: ReactNode;
  sub?: ReactNode;
  metrics: AdMetricValues;
  economics: AdEntityEconomics;
  /** Orders list behind the Hullwise numbers; null when Hullwise cannot tie orders to this row. */
  ordersHref: string | null;
  extra?: ReactNode[];
  muted?: boolean;
}

/** Orders list URL for a row's UTM filter over the page's period (inclusive local days). */
export function ordersHref(tenant: string, filter: OrdersFilter | null, period: Period, timezone: string): string | null {
  if (!filter) return null;
  return `/t/${tenant}/orders?${new URLSearchParams(filter)}&${periodQuery(period, timezone)}`;
}

/**
 * Platform numbers next to Hullwise's for one level (ad sets, ads, assets, keywords, search terms):
 * spend, impressions, CTR, the platform's conversions, Hullwise's sale orders (clickable), net revenue,
 * profit (margin − spend, sale orders only) and ROAS. Columns fold away on narrow screens.
 */
export async function AdsTable({ rows, currency, locale, extraHeads = [], testId, rowTestId, emptyHullwise }: { rows: AdsTableRow[]; currency: string; locale: string; extraHeads?: string[]; testId?: string; rowTestId?: string; emptyHullwise?: string }) {
  const t = await getTranslations("ads");
  const money = (m: number) => formatMoney(m, currency, locale);
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("cols.name")}</TableHead>
          <TableHead className="text-right">{t("cols.spend")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("cols.impressions")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t("cols.ctr")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t("cols.platform_conv")}</TableHead>
          <TableHead className="text-right">{t("cols.hullwise_orders")}</TableHead>
          <TableHead className="hidden text-right xl:table-cell">{t("cols.revenue")}</TableHead>
          <TableHead className="text-right">{t("cols.profit")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("cols.roas")}</TableHead>
          {extraHeads.map((h) => <TableHead key={h}>{h}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const e = r.economics;
          const hullwise = r.ordersHref !== null || e.attributedOrders > 0;
          return (
            <TableRow key={r.key} data-testid={rowTestId} className={cn(r.muted && "text-muted-foreground")}>
              <TableCell className="max-w-[20rem]">
                <div className="truncate font-medium">{r.name}</div>
                {r.sub && <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{r.sub}</div>}
              </TableCell>
              <TableCell className="text-right tabular">{money(r.metrics.spendMinor)}</TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(r.metrics.impressions, locale)}</TableCell>
              <TableCell className="hidden text-right tabular lg:table-cell">{formatPercent(e.ctr, locale, 2)}</TableCell>
              <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(Math.round(r.metrics.conversions * 10) / 10, locale)} · {money(r.metrics.conversionValueMinor)}</TableCell>
              <TableCell className="text-right tabular">
                {!hullwise ? <span className="text-xs text-muted-foreground" title={emptyHullwise}>—</span> : r.ordersHref ? <Link href={r.ordersHref} className="underline-offset-4 hover:underline" data-testid="hullwise-orders-link">{formatNumber(e.attributedOrders, locale)}</Link> : formatNumber(e.attributedOrders, locale)}
                {e.excludedOrders > 0 && <span className="ml-1 text-xs text-muted-foreground">{t("excluded_n", { n: e.excludedOrders })}</span>}
              </TableCell>
              <TableCell className="hidden text-right tabular xl:table-cell">{hullwise ? money(e.netRevenueMinor) : "—"}</TableCell>
              <TableCell className={cn("text-right tabular font-medium", e.profitMinor < 0 && "text-destructive")}>{money(e.profitMinor)}</TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">{e.roas === null ? "—" : `${e.roas.toFixed(2)}×`}</TableCell>
              {(r.extra ?? []).map((x, i) => <TableCell key={i}>{x}</TableCell>)}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Tabs across the campaign analysis pages. */
export async function AdsNav({ tenant, active, qs }: { tenant: string; active: "keywords" | "words" | "recommendations" | "creatives"; qs?: string }) {
  const t = await getTranslations("ads.nav");
  const base = `/t/${tenant}/campaigns`;
  const items = [["campaigns", base], ["creatives", `${base}/creatives`], ["keywords", `${base}/keywords`], ["words", `${base}/words`], ["recommendations", `${base}/recommendations`]] as const;
  return (
    <nav className="mb-4 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm" aria-label={t("label")}>
      {items.map(([k, href]) => <Link key={k} href={qs ? `${href}?${qs}` : href} className={cn("rounded-sm px-3 py-1.5", k === active ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")} data-testid={`ads-nav-${k}`}>{t(k)}</Link>)}
    </nav>
  );
}

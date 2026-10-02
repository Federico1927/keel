import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent, type AdEntityEconomics, type AdMetricValues, type Period } from "@hullwise/core";
import { periodQuery, type OrdersFilter } from "@hullwise/services";
import { DataList, cn, type DataListColumn } from "@hullwise/ui";

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
 * profit (margin − spend, sale orders only) and ROAS. A table from `md` up (less important columns from
 * `lg`/`xl`), a card per row on phones with every number (#49).
 */
export async function AdsTable({ rows, currency, locale, extraHeads = [], testId, rowTestId, emptyHullwise }: { rows: AdsTableRow[]; currency: string; locale: string; extraHeads?: string[]; testId?: string; rowTestId?: string; emptyHullwise?: string }) {
  const t = await getTranslations("ads");
  const money = (m: number) => formatMoney(m, currency, locale);
  const hullwiseOf = (r: AdsTableRow) => r.ordersHref !== null || r.economics.attributedOrders > 0;
  const columns: DataListColumn<AdsTableRow>[] = [
    { key: "name", header: t("cols.name"), mobile: "title", className: "md:max-w-[20rem]", cell: (r) => <><div className="truncate font-medium">{r.name}</div>{r.sub && <div className="flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">{r.sub}</div>}</> },
    { key: "spend", header: t("cols.spend"), align: "right", className: "tabular", cell: (r) => money(r.metrics.spendMinor) },
    { key: "impressions", header: t("cols.impressions"), align: "right", className: "tabular", cell: (r) => formatNumber(r.metrics.impressions, locale) },
    { key: "ctr", header: t("cols.ctr"), align: "right", priority: 2, className: "tabular", cell: (r) => formatPercent(r.economics.ctr, locale, 2) },
    { key: "conv", header: t("cols.platform_conv"), align: "right", priority: 2, className: "tabular", cell: (r) => <>{formatNumber(Math.round(r.metrics.conversions * 10) / 10, locale)} · {money(r.metrics.conversionValueMinor)}</> },
    {
      key: "orders",
      header: t("cols.hullwise_orders"),
      align: "right",
      className: "tabular",
      cell: (r) => (
        <>
          {!hullwiseOf(r) ? <span className="text-xs text-muted-foreground" title={emptyHullwise}>—</span> : r.ordersHref ? <Link href={r.ordersHref} className="underline-offset-4 hover:underline" data-testid="hullwise-orders-link">{formatNumber(r.economics.attributedOrders, locale)}</Link> : formatNumber(r.economics.attributedOrders, locale)}
          {r.economics.excludedOrders > 0 && <span className="ml-1 text-xs text-muted-foreground">{t("excluded_n", { n: r.economics.excludedOrders })}</span>}
        </>
      ),
    },
    { key: "revenue", header: t("cols.revenue"), align: "right", priority: 3, className: "tabular", cell: (r) => (hullwiseOf(r) ? money(r.economics.netRevenueMinor) : "—") },
    { key: "profit", header: t("cols.profit"), mobile: "badge", align: "right", className: "tabular font-medium", cell: (r) => <span className={cn(r.economics.profitMinor < 0 && "text-destructive")}>{money(r.economics.profitMinor)}</span> },
    { key: "roas", header: t("cols.roas"), align: "right", className: "tabular", cell: (r) => (r.economics.roas === null ? "—" : `${r.economics.roas.toFixed(2)}×`) },
    ...extraHeads.map((h, i): DataListColumn<AdsTableRow> => ({ key: `extra-${i}`, header: h, label: h, cell: (r) => r.extra?.[i] })),
  ];
  return <DataList data-testid={testId} rows={rows} rowKey={(r) => r.key} rowProps={(r) => ({ "data-testid": rowTestId, className: cn(r.muted && "text-muted-foreground") })} columns={columns} />;
}

/** Tabs across the campaign analysis pages. */
export async function AdsNav({ tenant, active, qs }: { tenant: string; active: "keywords" | "words" | "recommendations" | "creatives"; qs?: string }) {
  const t = await getTranslations("ads.nav");
  const base = `/t/${tenant}/campaigns`;
  const items = [["campaigns", base], ["creatives", `${base}/creatives`], ["keywords", `${base}/keywords`], ["words", `${base}/words`], ["recommendations", `${base}/recommendations`]] as const;
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto rounded-md bg-muted p-1 text-sm md:flex-wrap" aria-label={t("label")}>
      {items.map(([k, href]) => <Link key={k} href={qs ? `${href}?${qs}` : href} className={cn("shrink-0 whitespace-nowrap rounded-sm px-3 py-1.5 pointer-coarse:py-2.5", k === active ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")} data-testid={`ads-nav-${k}`}>{t(k)}</Link>)}
    </nav>
  );
}

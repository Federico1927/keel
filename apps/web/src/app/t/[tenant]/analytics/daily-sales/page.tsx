import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { formatMoney, formatNumber, summaryDayRange, type SalesSummaryDay } from "@hullwise/core";
import { dailySalesSummaryFor } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant, runAnalytics } from "@/server/analytics";
import { PeriodPicker } from "@/components/period-picker";
import { Num, dayHref, dayLabel, rateText } from "./shared";

import { withIntl } from "@/i18n/intl-scope";
/**
 * Daily sales summary (issue #85, core: every tenant). Per local day and tax rate: gross sales,
 * discounts, refunds, net sales, shipping, tax and total, then payment fees by method and the net.
 * Each number opens the orders behind it; the per-rate grid scrolls inside its own container.
 */
async function DailySalesPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("daily_sales");
  const tp = await getTranslations("payment_methods");
  const range = summaryDayRange(sp, ctx.tenant.timezone, new Date());
  const s = await runAnalytics(ctx, (svc) => dailySalesSummaryFor(svc, analyticsTenant(ctx), range));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/analytics/daily-sales`;
  const keep: Record<string, string> = range.preset ? { preset: range.preset } : { from: range.fromDay, to: range.toDay };
  const exportHref = `/t/${tenant}/analytics/export/daily_sales?${new URLSearchParams(keep)}`;
  const days = [...s.days].filter((d) => d.rates.length || d.fees.length).reverse();
  const rate = (k: string) => rateText(k, ctx.locale, (v) => t("rate_label", v));
  const methods = [...new Set(s.days.flatMap((d) => d.fees.map((f) => f.method)))];
  const amount = (d: SalesSummaryDay, v: number, kind?: "sale" | "refund" | "fee") => <Num href={dayHref(tenant, d.day, { kind })} value={v}>{money(v)}</Num>;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics?tab=pnl`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex flex-wrap items-center gap-2"><PeriodPicker basePath={base} preset={range.preset} from={sp.from} to={sp.to} /><a href={exportHref} className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline" data-testid="export-csv"><Download className="h-4 w-4" /> {t("export")}</a></div>} />
      <p className="mb-4 text-xs text-muted-foreground" data-testid="summary-scope">{t("scope", { from: dayLabel(range.fromDay, ctx.locale), to: dayLabel(range.toDay, ctx.locale), tz: ctx.tenant.timezone, currency: ctx.tenant.currency })}</p>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="summary-totals">
        <Stat label={t("columns.gross")} value={money(s.totals.grossSalesMinor)} />
        <Stat label={t("columns.discounts")} value={money(s.totals.discountsMinor)} />
        <Stat label={t("columns.refunds")} value={money(s.totals.refundsMinor)} />
        <Stat label={t("columns.net_sales")} value={money(s.totals.netSalesMinor)} />
        <Stat label={t("columns.shipping")} value={money(s.totals.shippingMinor)} />
        <Stat label={t("columns.tax")} value={money(s.totals.taxMinor)} />
        <Stat label={t("columns.total")} value={money(s.totals.totalMinor)} hint={t("orders_value", { sales: formatNumber(s.totals.saleOrders, ctx.locale), refunds: formatNumber(s.totals.refundOrders, ctx.locale) })} />
        <Stat label={t("columns.fees")} value={money(s.totals.feesMinor)} />
        <Stat label={t("columns.net")} value={money(s.totals.netMinor)} />
      </div>
      {days.length === 0 ? (
        <EmptyState title={t("empty")} description={t("empty_hint")} />
      ) : (
        <div className="space-y-6">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{t("days_title")}</CardTitle>
              <CardDescription>{t("identity")}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <DataList
                data-testid="summary-days"
                rows={days}
                rowKey={(d) => d.day}
                rowProps={(d) => ({ "data-testid": "summary-day", "data-day": d.day })}
                columns={[
                  { key: "day", header: t("columns.day"), mobile: "title", className: "whitespace-nowrap", cell: (d) => <Link href={dayHref(tenant, d.day)} className="font-medium text-primary hover:underline">{dayLabel(d.day, ctx.locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</Link> },
                  { key: "orders", header: t("columns.orders"), mobile: "subtitle", className: "whitespace-nowrap text-xs text-muted-foreground", cell: (d) => t("orders_value", { sales: formatNumber(d.saleOrders, ctx.locale), refunds: formatNumber(d.refundOrders, ctx.locale) }) },
                  { key: "gross", header: t("columns.gross"), align: "right", cell: (d) => amount(d, d.grossSalesMinor, "sale") },
                  { key: "discounts", header: t("columns.discounts"), align: "right", priority: 2, cell: (d) => amount(d, d.discountsMinor, "sale") },
                  { key: "refunds", header: t("columns.refunds"), align: "right", cell: (d) => amount(d, d.refundsMinor, "refund") },
                  { key: "net_sales", header: t("columns.net_sales"), align: "right", priority: 2, cell: (d) => amount(d, d.netSalesMinor) },
                  { key: "shipping", header: t("columns.shipping"), align: "right", priority: 3, cell: (d) => amount(d, d.shippingMinor, "sale") },
                  { key: "tax", header: t("columns.tax"), align: "right", cell: (d) => amount(d, d.taxMinor) },
                  { key: "total", header: t("columns.total"), align: "right", cell: (d) => amount(d, d.totalMinor) },
                  { key: "fees", header: t("columns.fees"), align: "right", priority: 2, cell: (d) => amount(d, d.feesMinor, "fee") },
                  { key: "net", header: t("columns.net"), align: "right", className: "font-medium", cell: (d) => amount(d, d.netMinor) },
                ]}
                footer={{ day: <span data-testid="summary-total-row">{t("totals")}</span>, gross: money(s.totals.grossSalesMinor), discounts: money(s.totals.discountsMinor), refunds: money(s.totals.refundsMinor), net_sales: money(s.totals.netSalesMinor), shipping: money(s.totals.shippingMinor), tax: money(s.totals.taxMinor), total: money(s.totals.totalMinor), fees: money(s.totals.feesMinor), net: money(s.totals.netMinor) }}
              />
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{t("rates_title")}</CardTitle>
              <CardDescription>{t("rates_description")}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {/* wide by nature (two columns per tax rate): it scrolls inside this marked region, never the page */}
              <div role="region" aria-label={t("rates_region")} tabIndex={0} data-scroll="x" data-testid="rates-scroll" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring">
                <table className="w-max min-w-full text-sm" data-testid="rates-table">
                  <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th rowSpan={2} className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">{t("columns.day")}</th>
                      {s.rateKeys.map((r) => <th key={r.rateKey} colSpan={2} className="whitespace-nowrap border-l px-3 pt-2 text-center font-medium">{rate(r.rateKey)}</th>)}
                    </tr>
                    <tr>
                      {s.rateKeys.flatMap((r) => [<th key={`${r.rateKey}-n`} className="border-l px-3 pb-2 text-right font-normal">{t("net_short")}</th>, <th key={`${r.rateKey}-t`} className="px-3 pb-2 text-right font-normal">{t("tax_short")}</th>])}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.day} className="border-b last:border-0">
                        <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-1.5"><Link href={dayHref(tenant, d.day)} className="hover:underline">{dayLabel(d.day, ctx.locale)}</Link></td>
                        {s.rateKeys.flatMap((r) => {
                          const row = d.rates.find((x) => x.rateKey === r.rateKey);
                          const href = dayHref(tenant, d.day, { rate: r.rateKey });
                          return [<td key={`${r.rateKey}-n`} className="whitespace-nowrap border-l px-3 py-1.5 text-right"><Num href={href} value={row?.netSalesMinor ?? 0}>{money(row?.netSalesMinor ?? 0)}</Num></td>, <td key={`${r.rateKey}-t`} className="whitespace-nowrap px-3 py-1.5 text-right"><Num href={href} value={row?.taxMinor ?? 0}>{money(row?.taxMinor ?? 0)}</Num></td>];
                        })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t bg-muted/40 font-medium">
                    <tr>
                      <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">{t("totals")}</td>
                      {s.rateKeys.flatMap((r) => {
                        const rows = s.days.flatMap((d) => d.rates.filter((x) => x.rateKey === r.rateKey));
                        return [<td key={`${r.rateKey}-n`} className="whitespace-nowrap border-l px-3 py-1.5 text-right tabular">{money(rows.reduce((a, x) => a + x.netSalesMinor, 0))}</td>, <td key={`${r.rateKey}-t`} className="whitespace-nowrap px-3 py-1.5 text-right tabular">{money(rows.reduce((a, x) => a + x.taxMinor, 0))}</td>];
                      })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
          {methods.length > 0 && (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">{t("fees_title")}</CardTitle>
                <CardDescription>{t("fees_description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <DataList
                  data-testid="summary-fees"
                  rows={methods.map((m) => ({ method: m, fee: s.days.reduce((a, d) => a + (d.fees.find((f) => f.method === m)?.feeMinor ?? 0), 0), orders: s.days.reduce((a, d) => a + (d.fees.find((f) => f.method === m)?.orders ?? 0), 0), estimated: s.days.reduce((a, d) => a + (d.fees.find((f) => f.method === m)?.estimatedOrders ?? 0), 0) }))}
                  rowKey={(r) => r.method}
                  columns={[
                    { key: "method", header: t("columns.method"), mobile: "title", cell: (r) => <span className="font-medium">{tp(r.method)}</span> },
                    { key: "orders", header: t("columns.orders"), align: "right", cell: (r) => formatNumber(r.orders, ctx.locale) },
                    { key: "estimated", header: t("columns.estimated"), align: "right", cell: (r) => <span className={r.estimated ? "text-warning" : "text-muted-foreground"}>{formatNumber(r.estimated, ctx.locale)}</span> },
                    { key: "fee", header: t("columns.fees"), align: "right", cell: (r) => <span className="tabular">{money(r.fee)}</span> },
                  ]}
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

export default withIntl(DailySalesPage, "app/t/[tenant]/analytics/daily-sales/page.tsx");

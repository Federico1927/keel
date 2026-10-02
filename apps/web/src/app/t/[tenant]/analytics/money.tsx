import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { SALE_STATUSES, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { paymentMethodReport, pnlForPeriod, taxReportForPeriod, type PnlReport } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { analyticsTenant, runAnalytics } from "@/server/analytics";

/* Money views of analytics (issue #27): fee source under the P/L, payment-method breakdown, tax report. */

const SALE = SALE_STATUSES.join(",");
const day = (d: Date) => d.toISOString().slice(0, 10);
type Period = { from: Date; to: Date };

function ordersHref(tenant: string, period: Period, extra: Record<string, string>) {
  return `/t/${tenant}/orders?${new URLSearchParams({ from: day(period.from), to: day(new Date(period.to.getTime() - 1)), ...extra })}`;
}
function Num({ href, children, className }: { href?: string; children: ReactNode; className?: string }) {
  return href ? <Link href={href} className={cn("hover:underline", className)}>{children}</Link> : <span className={className}>{children}</span>;
}
function exportHref(tenant: string, kind: string, keep: Record<string, string | undefined>) {
  return `/t/${tenant}/analytics/export/${kind}?${new URLSearchParams(Object.entries(keep).filter((e): e is [string, string] => Boolean(e[1])))}`;
}

/** Under the P/L: how much of the payment fees came from payouts and how much is still the estimate. */
export async function FeeSourceNote({ ctx, tenant, pnl }: { ctx: TenantContext; tenant: string; pnl: PnlReport }) {
  const t = await getTranslations("analytics_money");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  if (!pnl.orders) return null;
  return (
    <p className="border-t p-3 text-xs text-muted-foreground" data-testid="fee-sources">
      <Link href={ordersHref(tenant, pnl.period, { status: SALE, feeSource: "actual" })} className="underline-offset-4 hover:underline" data-testid="fee-actual">{t("fees.actual", { amount: money(pnl.paymentFeeActualMinor), n: pnl.paymentFeeActualOrders })}</Link>
      {" · "}
      <Link href={ordersHref(tenant, pnl.period, { status: SALE, feeSource: "estimated" })} className={cn("underline-offset-4 hover:underline", pnl.paymentFeeEstimatedOrders > 0 && "text-warning")} data-testid="fee-estimated">{t("fees.estimated", { amount: money(pnl.paymentFeeEstimatedMinor), n: pnl.paymentFeeEstimatedOrders })}</Link>
      {" · "}
      <Link href={`/t/${tenant}/analytics/payouts`} className="font-medium underline-offset-4 hover:underline">{t("fees.payouts")}</Link>
    </p>
  );
}

export async function PaymentMethodsTab({ ctx, tenant, period, keep }: { ctx: TenantContext; tenant: string; period: Period; keep: Record<string, string | undefined> }) {
  const t = await getTranslations("analytics_money");
  const tp = await getTranslations("payment_methods");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const r = await runAnalytics(ctx, (s) => paymentMethodReport(s, analyticsTenant(ctx), period));
  if (!r.rows.some((x) => x.placedOrders > 0)) return <EmptyState title={t("methods.empty")} />;
  return (
    <Card className="min-w-0" data-testid="payment-methods">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("methods.title")}</CardTitle>
          <CardDescription>{t("methods.description")}</CardDescription>
        </div>
        <a href={exportHref(tenant, "payment_methods", keep)} className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline" data-testid="export-csv"><Download className="h-4 w-4" /> {t("export")}</a>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("methods.method")}</TableHead>
              <TableHead className="text-right">{t("methods.placed")}</TableHead>
              <TableHead className="text-right">{t("methods.orders")}</TableHead>
              <TableHead className="text-right">{t("methods.net_revenue")}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t("methods.share")}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t("methods.aov")}</TableHead>
              <TableHead className="text-right">{t("methods.cancel_rate")}</TableHead>
              <TableHead className="text-right">{t("methods.return_rate")}</TableHead>
              <TableHead className="text-right">{t("methods.fees")}</TableHead>
              <TableHead className="hidden text-right lg:table-cell">{t("methods.fee_rate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((x) => (
              <TableRow key={x.method} className={x.placedOrders === 0 ? "text-muted-foreground" : ""} data-testid={`method-${x.method}`}>
                <TableCell className="font-medium">{tp(x.method)}</TableCell>
                <TableCell className="text-right tabular"><Num href={x.placedOrders ? ordersHref(tenant, period, { payment: x.method }) : undefined}>{formatNumber(x.placedOrders, ctx.locale)}</Num></TableCell>
                <TableCell className="text-right tabular"><Num href={x.orders ? ordersHref(tenant, period, { payment: x.method, status: SALE }) : undefined}>{formatNumber(x.orders, ctx.locale)}</Num></TableCell>
                <TableCell className="text-right tabular">{money(x.netRevenueMinor)}</TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">{formatPercent(x.revenueShare, ctx.locale)}</TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">{x.aovMinor === null ? "—" : money(x.aovMinor)}</TableCell>
                <TableCell className="text-right tabular"><Num href={x.cancelledOrders ? ordersHref(tenant, period, { payment: x.method, status: "cancelled" }) : undefined}>{formatPercent(x.cancelRate, ctx.locale)}</Num></TableCell>
                <TableCell className="text-right tabular"><Num href={x.returnedOrders ? ordersHref(tenant, period, { payment: x.method, status: "returned,returned_partial,refunded" }) : undefined}>{formatPercent(x.returnRate, ctx.locale)}</Num></TableCell>
                <TableCell className="text-right tabular">
                  {money(x.feesMinor)}
                  {x.estimatedFeeOrders > 0 && x.feesMinor > 0 && (
                    <Link href={ordersHref(tenant, period, { payment: x.method, status: SALE, feeSource: "estimated" })} className="block text-[11px] text-warning hover:underline">{x.actualFeesMinor > 0 ? t("methods.partly_estimated", { n: x.estimatedFeeOrders }) : t("methods.estimated")}</Link>
                  )}
                  {x.actualFeesMinor > 0 && x.estimatedFeeOrders === 0 && <span className="block text-[11px] text-muted-foreground">{t("methods.actual")}</span>}
                </TableCell>
                <TableCell className="hidden text-right tabular lg:table-cell">{formatPercent(x.feeRate, ctx.locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="border-t p-3 text-xs text-muted-foreground">{t("methods.footnote", { actual: money(r.fees.actualMinor), estimated: money(r.fees.estimatedMinor) })}</p>
      </CardContent>
    </Card>
  );
}

export async function TaxTab({ ctx, tenant, period, keep }: { ctx: TenantContext; tenant: string; period: Period; keep: Record<string, string | undefined> }) {
  const t = await getTranslations("analytics_money");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const [r, pnl] = await Promise.all([runAnalytics(ctx, (s) => taxReportForPeriod(s, analyticsTenant(ctx), period)), runAnalytics(ctx, (s) => pnlForPeriod(s, analyticsTenant(ctx), period))]);
  if (!r.rows.length) return <EmptyState title={t("tax.empty")} />;
  const rate = (bps: number) => `${formatNumber(bps / 100, ctx.locale)} %`;
  const matches = r.totals.taxMinor === pnl.taxMinor;
  return (
    <Card className="min-w-0" data-testid="tax-report">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("tax.title")}</CardTitle>
          <CardDescription>{t("tax.description")}</CardDescription>
        </div>
        <a href={exportHref(tenant, "tax", keep)} className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline" data-testid="export-csv"><Download className="h-4 w-4" /> {t("export")}</a>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("tax.country")}</TableHead>
              <TableHead className="text-right">{t("tax.rate")}</TableHead>
              <TableHead className="text-right">{t("tax.orders")}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t("tax.gross")}</TableHead>
              <TableHead className="text-right">{t("tax.taxable")}</TableHead>
              <TableHead className="text-right">{t("tax.tax")}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t("tax.refunded_tax")}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t("tax.net_tax")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((x) => (
              <TableRow key={`${x.country}-${x.rateBps}`} data-testid="tax-row">
                <TableCell className="font-medium">{x.country ?? "—"}</TableCell>
                <TableCell className="text-right tabular">{rate(x.rateBps)}</TableCell>
                <TableCell className="text-right tabular"><Num href={x.country ? ordersHref(tenant, period, { status: SALE, country: x.country }) : undefined}>{formatNumber(x.orders, ctx.locale)}</Num></TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">{money(x.grossMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(x.taxableMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(x.taxMinor)}</TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">{money(x.refundedTaxMinor)}</TableCell>
                <TableCell className="hidden text-right tabular md:table-cell">{money(x.netTaxMinor)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium">
              <TableCell>{t("tax.total")}</TableCell>
              <TableCell />
              <TableCell className="text-right tabular"><Num href={ordersHref(tenant, period, { status: SALE })}>{formatNumber(r.totals.orders, ctx.locale)}</Num></TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">{money(r.totals.grossMinor)}</TableCell>
              <TableCell className="text-right tabular">{money(r.totals.taxableMinor)}</TableCell>
              <TableCell className="text-right tabular" data-testid="tax-total">{money(r.totals.taxMinor)}</TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">{money(r.totals.refundedTaxMinor)}</TableCell>
              <TableCell className="hidden text-right tabular md:table-cell">{money(r.totals.netTaxMinor)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className={cn("border-t p-3 text-xs", matches ? "text-muted-foreground" : "text-destructive")} data-testid="tax-pnl-check">{matches ? t("tax.matches", { amount: money(pnl.taxMinor) }) : t("tax.mismatch", { amount: money(pnl.taxMinor) })}</p>
        <p className="border-t p-3 text-xs text-muted-foreground">{t("tax.footnote")}</p>
      </CardContent>
    </Card>
  );
}

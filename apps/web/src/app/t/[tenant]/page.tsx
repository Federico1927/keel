import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber } from "@keel/core";
import { backorderSummary, catalogQualityReport, countLateToShip, dashboardSummary, monthEndForecast } from "@keel/services";
import { canViewPage } from "@keel/config";
import { Card, CardContent, CardHeader, CardTitle, PageHeader, Stat } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { StatusBadge } from "@/components/status-badge";
import { Greeting } from "@/components/greeting";

export default async function DashboardPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  const t = await getTranslations("dashboard");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const { summary, forecast, quality, lateToShip, stock } = await ctx.run(async (tx) => ({ summary: await dashboardSummary({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at), forecast: await monthEndForecast({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at), quality: await catalogQualityReport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }), lateToShip: await countLateToShip({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { timezone: ctx.tenant.timezone, settings: ctx.settings }), stock: await backorderSummary({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { lowStockThreshold: ctx.settings.lowStockThreshold }) }));
  const ts = await getTranslations("dashboard.stock_tile");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const pctChange = (cur: number, prev: number) => (prev ? { value: (cur - prev) / prev } : null);
  const base = `/t/${tenant}`;
  const todayIso = summary.windows.today.from.toISOString().slice(0, 10);
  const openItems: { key: string; value: number; href: string }[] = [
    { key: "fresh", value: summary.open.fresh, href: `${base}/orders?status=new` },
    { key: "pending_review", value: summary.open.pendingReview, href: `${base}/orders?status=pending_review` },
    { key: "on_hold", value: summary.open.onHold, href: `${base}/orders?status=on_hold` },
    { key: "late_to_ship", value: lateToShip, href: `${base}/fulfilment?view=late` },
    { key: "shipment_exceptions", value: summary.open.shipmentExceptions, href: `${base}/fulfilment/exceptions` },
    { key: "stuck_shipments", value: summary.open.stuckShipments, href: `${base}/shipments?view=stuck` },
    { key: "returns_requested", value: summary.open.returnsRequested, href: `${base}/returns?status=requested` },
    { key: "critical_variants", value: summary.open.criticalVariants, href: `${base}/inventory?risk=critical` },
    { key: "failed_webhooks", value: summary.open.failedWebhooks, href: `${base}/integrations` },
    // variants without a cost make every margin optimistic: the catalog check sits with the other open items
    { key: "catalog_quality", value: quality.rows.filter((r) => r.issues.some((i) => i === "missing_cost" || i === "missing_sku" || i === "duplicate_sku")).length, href: `${base}/products/quality${quality.counts.missing_cost ? "?issue=missing_cost" : ""}` },
  ];
  return (
    <>
      <Greeting user={ctx.user} tenantTimeZone={ctx.tenant.timezone} locale={ctx.locale} line={t("greeting_line", { count: summary.today.placed })} />
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("kpi.revenue")} value={money(summary.today.grossRevenueMinor)} trend={pctChange(summary.today.grossRevenueMinor, summary.yesterday.grossRevenueMinor)} hint={`${t("vs_yesterday")} · ${money(summary.yesterday.grossRevenueMinor)}`} href={`${base}/orders?from=${todayIso}`} />
        <Stat label={t("kpi.orders")} value={formatNumber(summary.today.sales, ctx.locale)} trend={pctChange(summary.today.sales, summary.yesterday.sales)} hint={`${summary.today.placed} ${t("kpi.placed")} · ${t("vs_last_week")} ${summary.lastWeek.sales}`} href={`${base}/orders?from=${todayIso}`} />
        <Stat label={t("kpi.aov")} value={summary.today.aovMinor ? money(summary.today.aovMinor) : "—"} hint={summary.yesterday.sales ? `${t("vs_yesterday")} · ${money(Math.round(summary.yesterday.grossRevenueMinor / summary.yesterday.sales))}` : undefined} />
        <Stat label={t("kpi.cancel_rate")} value={summary.today.placed ? `${(((summary.today.byStatus.cancelled ?? 0) / summary.today.placed) * 100).toFixed(1)}%` : "—"} href={`${base}/orders?status=cancelled&from=${todayIso}`} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("revenue_30d")}</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueChart data={summary.series30d} locale={ctx.locale} currency={ctx.tenant.currency} ordersLabel={t("kpi.orders").toLowerCase()} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card data-testid="forecast-card">
            <CardHeader>
              <CardTitle className="text-base">{t("forecast.title", { month: forecast.month })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex items-center justify-between"><span>{t("forecast.revenue")}</span><span className="tabular font-medium">{money(forecast.revenue.projected)}</span></div>
              <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("forecast.band")}</span><span className="tabular">{money(forecast.revenue.low)} – {money(forecast.revenue.high)}</span></div>
              <div className="flex items-center justify-between"><span>{t("forecast.orders")}</span><span className="tabular font-medium">{formatNumber(forecast.orders.projected, ctx.locale)}</span></div>
              <div className="flex items-center justify-between"><span>{t("forecast.spend")}</span><span className="tabular font-medium">{money(forecast.spend.projected)}</span></div>
              <p className="pt-1 text-xs text-muted-foreground">{t("forecast.hint", { elapsed: forecast.elapsedDays, days: forecast.daysInMonth })} <Link href={`${base}/analytics`} className="underline-offset-4 hover:underline">{t("forecast.more")}</Link></p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("work_queue")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {openItems.map((i) => (
                <Link key={i.key} href={i.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                  <span>{t(`open.${i.key}`)}</span>
                  <span className={`tabular font-medium ${i.value > 0 && (i.key === "shipment_exceptions" || i.key === "failed_webhooks" || i.key === "critical_variants" || i.key === "late_to_ship") ? "text-destructive" : i.value > 0 && i.key === "catalog_quality" ? "text-warning" : ""}`}>{i.value}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card data-testid="stock-tile">
            <CardHeader>
              <CardTitle className="text-base">{ts("title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {canViewPage(ctx.role, "orders") ? (
                <Link href={`${base}/orders?stock=awaiting`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50" data-testid="stock-tile-holding">
                  <span>{ts("holding", { units: stock.holdingUnits })}</span>
                  <span className={`tabular font-medium ${stock.holdingOrders > 0 ? "text-warning" : ""}`}>{stock.holdingOrders}</span>
                </Link>
              ) : (
                <p className="flex items-center justify-between px-2">{ts("holding", { units: stock.holdingUnits })} <span className="tabular font-medium">{stock.holdingOrders}</span></p>
              )}
              <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">{ts("best_sellers_low")}</p>
              {stock.lowStockBestSellers.length === 0 && <p className="px-2 text-xs text-muted-foreground">{ts("none_low")}</p>}
              {stock.lowStockBestSellers.map((v) => {
                const body = (
                  <>
                    <span className="min-w-0 truncate">{v.label}</span>
                    <span className="shrink-0 text-xs tabular text-muted-foreground">{ts("cell", { sold: v.unitsSold, available: v.available, incoming: v.incoming })}{v.backordered > 0 ? ` · ${ts("waiting", { n: v.backordered })}` : ""}</span>
                  </>
                );
                return canViewPage(ctx.role, "products") ? (
                  <Link key={v.variantId} href={`${base}/products/${v.productId}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50">{body}</Link>
                ) : (
                  <div key={v.variantId} className="flex items-center justify-between gap-2 px-2 py-1">{body}</div>
                );
              })}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("today_by_status")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {Object.entries(summary.today.byStatus).map(([s, n]) => (
                <Link key={s} href={`${base}/orders?status=${s}&from=${todayIso}`} className="inline-flex items-center gap-1">
                  <StatusBadge status={s} /> <span className="tabular text-sm">{n}</span>
                </Link>
              ))}
              {Object.keys(summary.today.byStatus).length === 0 && <span className="text-sm text-muted-foreground">—</span>}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber } from "@keel/core";
import { dashboardSummary } from "@keel/services";
import { Card, CardContent, CardHeader, CardTitle, PageHeader, Stat } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { StatusBadge } from "@/components/status-badge";

export default async function DashboardPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  const t = await getTranslations("dashboard");
  const summary = await ctx.run((tx) => dashboardSummary({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const pctChange = (cur: number, prev: number) => (prev ? { value: (cur - prev) / prev } : null);
  const base = `/t/${tenant}`;
  const todayIso = summary.windows.today.from.toISOString().slice(0, 10);
  const openItems: { key: string; value: number; href: string }[] = [
    { key: "fresh", value: summary.open.fresh, href: `${base}/orders?status=new` },
    { key: "pending_review", value: summary.open.pendingReview, href: `${base}/orders?status=pending_review` },
    { key: "on_hold", value: summary.open.onHold, href: `${base}/orders?status=on_hold` },
    { key: "shipment_exceptions", value: summary.open.shipmentExceptions, href: `${base}/shipments?view=exceptions` },
    { key: "stuck_shipments", value: summary.open.stuckShipments, href: `${base}/shipments?view=stuck` },
    { key: "returns_requested", value: summary.open.returnsRequested, href: `${base}/returns?status=requested` },
    { key: "critical_variants", value: summary.open.criticalVariants, href: `${base}/inventory?risk=critical` },
    { key: "failed_webhooks", value: summary.open.failedWebhooks, href: `${base}/integrations` },
  ];
  return (
    <>
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("work_queue")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {openItems.map((i) => (
                <Link key={i.key} href={i.href} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                  <span>{t(`open.${i.key}`)}</span>
                  <span className={`tabular font-medium ${i.value > 0 && (i.key === "shipment_exceptions" || i.key === "failed_webhooks" || i.key === "critical_variants") ? "text-destructive" : ""}`}>{i.value}</span>
                </Link>
              ))}
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

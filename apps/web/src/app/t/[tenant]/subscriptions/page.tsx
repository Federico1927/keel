import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo, canViewPage } from "@hullwise/config";
import { formatDateTime, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { subscriptionIntegration, subscriptionProfitReport, subscriptionsOverview } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { and, eq, schema } from "@hullwise/db";
import { requirePage } from "@/server/tenant";
import { analyticsTenant } from "@/server/dashboards";
import { ProviderControls } from "./controls";
import { subscriptionSetups } from "@/server/integration-setup";
import { MrrMovementChart } from "./mrr-chart";
import { SubscriptionTabs, isoDay, svcOf } from "./shared";

import { withIntl } from "@/i18n/intl-scope";
const PERIODS = [30, 90, 365] as const;

/** addon.subscriptions (#67) overview: KPIs, MRR movement, survival cohorts, forecast, profit and LTV; every number links to its subscribers or orders. */
async function SubscriptionsOverviewPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ days?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "subscriptions");
  const t = await getTranslations("subscriptions");
  const days = (PERIODS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 30;
  const now = new Date();
  const period = { from: new Date(now.getTime() - days * 864e5), to: new Date(now.getTime() + 1) };
  const at = analyticsTenant(ctx);
  const { o, profit, integration, health } = await ctx.run(async (tx) => {
    const s = svcOf(ctx, tx);
    const integration = await subscriptionIntegration(s);
    const [health] = integration ? await tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenant.id), eq(schema.integrationHealth.source, integration.provider))).limit(1) : [];
    return { o: await subscriptionsOverview(s, at, { period, months: 12 }), profit: await subscriptionProfitReport(s, at), integration, health: health ?? null };
  });
  const base = `/t/${tenant}/subscriptions`;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const n = (v: number) => formatNumber(v, ctx.locale);
  const pct = (v: number | null) => (v === null ? "—" : formatPercent(v, ctx.locale));
  const range = `endedFrom=${isoDay(period.from)}&endedTo=${isoDay(new Date(now.getTime() + 864e5))}`;
  const trend = (cur: number, prev: number) => (prev ? { value: (cur - prev) / prev } : null);
  const connected = !!integration && integration.status !== "not_connected";
  const mock = integrationMode() === "mock" || integration?.mode !== "live";
  const showOrders = canViewPage(ctx.role, "orders");
  const hasData = o.movement.some((m) => m.endMrrMinor > 0 || m.startMrrMinor > 0) || o.counts.active > 0;
  const bucketCell = (month: string, bucket: "new" | "expansion" | "reactivated" | "contraction" | "churned", v: number, negative = false) => (v ? <Link href={`${base}/subscribers?movement=${month}:${bucket}`} className={cn("hover:underline", negative && "text-destructive")}>{negative ? "−" : "+"}{money(v)}</Link> : <span className="text-muted-foreground">—</span>);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex gap-1 rounded-md bg-muted p-1 text-sm">{PERIODS.map((d) => <Link key={d} href={`${base}?days=${d}`} className={cn("rounded-sm px-2 py-1", d === days ? "bg-card shadow-sm" : "text-muted-foreground")}>{t("period_days", { days: d })}</Link>)}</div>} />
      <SubscriptionTabs tenant={tenant} active="overview" />
      {!connected && <p className="mb-4 rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="subs-not-connected">{t("provider.none")}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="subs-kpis">
        <Stat label={t("kpi.mrr")} value={money(o.mrrMinor)} trend={trend(o.mrrMinor, o.mrrPreviousMinor)} hint={t("kpi.mrr_hint", { previous: money(o.mrrPreviousMinor) })} href={`${base}/subscribers?status=active`} />
        <Stat label={t("kpi.active")} value={n(o.counts.active)} hint={t("kpi.paused_hint", { n: o.counts.paused })} href={`${base}/subscribers?status=active`} />
        <Stat label={t("kpi.new")} value={n(o.counts.new)} trend={trend(o.counts.new, o.previous.new)} hint={t("kpi.vs_previous", { n: o.previous.new })} href={`${base}/subscribers?activatedFrom=${isoDay(period.from)}&activatedTo=${isoDay(new Date(now.getTime() + 864e5))}`} />
        <Stat label={t("kpi.churn")} value={pct(o.counts.churnRate)} hint={<><Link href={`${base}/subscribers?${range}&kind=voluntary`} className="hover:underline">{t("kpi.voluntary", { n: o.counts.voluntary })}</Link> · <Link href={`${base}/subscribers?${range}&kind=involuntary`} className="hover:underline">{t("kpi.involuntary", { n: o.counts.involuntary })}</Link></>} href={`${base}/subscribers?${range}`} />
        <Stat label={t("kpi.success_rate")} value={pct(o.successRate)} hint={t("kpi.success_hint")} href={`${base}/recovery`} />
        <Stat label={t("kpi.value_at_risk")} value={money(o.recovery.valueAtRiskMinor)} hint={t("kpi.failing", { n: o.recovery.open })} href={`${base}/recovery`} />
        <Stat label={t("kpi.recovery_rate")} value={pct(o.recovery.rate)} hint={t("kpi.recovery_hint", { recovered: o.recovery.recovered, lost: o.recovery.lost })} href={`${base}/recovery`} />
        <Stat label={t("kpi.avg_profit")} value={profit.totals.avgProfitPerSubscriberMinor === null ? "—" : money(profit.totals.avgProfitPerSubscriberMinor)} hint={t("kpi.avg_profit_hint")} href={`#profit`} />
      </div>
      {!hasData ? <EmptyState className="mt-6" title={t("empty_title")} description={t("empty_description")} /> : (
        <>
          <Card className="mt-6">
            <CardHeader><CardTitle className="text-base">{t("movement.title")}</CardTitle><CardDescription>{t("movement.description")}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <MrrMovementChart rows={o.movement.map((m) => ({ month: isoDay(m.from).slice(0, 7), newMinor: m.newMinor, expansionMinor: m.expansionMinor, reactivatedMinor: m.reactivatedMinor, contractionMinor: m.contractionMinor, churnedMinor: m.churnedMinor, endMrrMinor: m.endMrrMinor }))} locale={ctx.locale} currency={ctx.tenant.currency} labels={{ new: t("movement.new"), expansion: t("movement.expansion"), reactivated: t("movement.reactivated"), contraction: t("movement.contraction"), churned: t("movement.churned"), end: t("movement.end") }} />
              <div className="overflow-x-auto">
                <Table data-testid="mrr-movement">
                  <TableHeader><TableRow><TableHead>{t("movement.month")}</TableHead><TableHead className="text-right">{t("movement.start")}</TableHead><TableHead className="text-right">{t("movement.new")}</TableHead><TableHead className="text-right">{t("movement.expansion")}</TableHead><TableHead className="text-right">{t("movement.reactivated")}</TableHead><TableHead className="text-right">{t("movement.contraction")}</TableHead><TableHead className="text-right">{t("movement.churned")}</TableHead><TableHead className="text-right">{t("movement.end")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {[...o.movement].reverse().map((m) => {
                      const month = isoDay(m.from).slice(0, 7);
                      return (
                        <TableRow key={month} data-testid="mrr-row">
                          <TableCell className="whitespace-nowrap">{new Intl.DateTimeFormat(ctx.locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(m.from)}</TableCell>
                          <TableCell className="text-right tabular">{money(m.startMrrMinor)}</TableCell>
                          <TableCell className="text-right tabular">{bucketCell(month, "new", m.newMinor)}</TableCell>
                          <TableCell className="text-right tabular">{bucketCell(month, "expansion", m.expansionMinor)}</TableCell>
                          <TableCell className="text-right tabular">{bucketCell(month, "reactivated", m.reactivatedMinor)}</TableCell>
                          <TableCell className="text-right tabular">{bucketCell(month, "contraction", m.contractionMinor, true)}</TableCell>
                          <TableCell className="text-right tabular">{bucketCell(month, "churned", m.churnedMinor, true)}</TableCell>
                          <TableCell className="text-right font-medium tabular">{money(m.endMrrMinor)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("cohorts.title")}</CardTitle><CardDescription>{t("cohorts.description")}</CardDescription></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table data-testid="cohort-table">
                  <TableHeader><TableRow><TableHead>{t("cohorts.cohort")}</TableHead><TableHead className="text-right">{t("cohorts.size")}</TableHead>{(o.cohorts[0]?.retention ?? []).slice(1).map((_, k) => <TableHead key={k} className="text-right">{t("cohorts.month_n", { n: k + 1 })}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>
                    {o.cohorts.map((c) => (
                      <TableRow key={c.cohort} data-testid="cohort-row">
                        <TableCell className="whitespace-nowrap"><Link href={`${base}/subscribers?cohort=${c.cohort}`} className="hover:underline">{c.cohort}</Link></TableCell>
                        <TableCell className="text-right tabular">{n(c.size)}</TableCell>
                        {c.retention.slice(1).map((r, k) => <TableCell key={k} className="text-right text-xs tabular" style={r === null ? undefined : { backgroundColor: `color-mix(in oklab, var(--chart-1) ${Math.round(r * 45)}%, transparent)` }}>{r === null ? "" : formatPercent(r, ctx.locale, 0)}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <div className="space-y-6">
              <Card>
                <CardHeader><CardTitle className="text-base">{t("forecast.title")}</CardTitle><CardDescription>{t("forecast.description", { rate: pct(o.successRate) })}</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-3 gap-2 text-center" data-testid="subs-forecast">
                  {o.forecast.map((f) => (
                    <div key={f.days} className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{t("forecast.days", { days: f.days })}</p><p className="text-lg font-semibold tabular">{money(f.expectedMinor)}</p><p className="text-xs text-muted-foreground">{t("forecast.renewals", { n: f.renewals })}</p></div>
                  ))}
                </CardContent>
              </Card>
              <Card data-testid="subs-provider">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2"><CardTitle className="text-base">{t("provider.title")}</CardTitle>{integration && <Badge variant={integration.status === "connected" ? "success" : integration.status === "error" ? "destructive" : "muted"}>{t(`provider.status.${integration.status === "connected" || integration.status === "error" ? integration.status : "not_connected"}`)}</Badge>}</div>
                  <CardDescription>{integration ? t(`provider.apps.${integration.provider}`) : t("provider.none_short")}{connected && mock ? ` · ${t("provider.mock")}` : ""}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {integration && (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">{t("provider.last_sync")}</dt><dd>{integration.lastSyncAt ? formatDateTime(integration.lastSyncAt, ctx.locale, ctx.tenant.timezone) : "—"}</dd>
                      <dt className="text-muted-foreground">{t("provider.health")}</dt><dd>{health ? t.has(`provider.health_status.${health.status}`) ? t(`provider.health_status.${health.status}`) : health.status : "—"}</dd>
                      <dt className="text-muted-foreground">{t("provider.last_error")}</dt><dd className={integration.lastError ?? health?.lastError ? "text-destructive" : ""}>{integration.lastError ?? health?.lastError ?? "—"}</dd>
                    </dl>
                  )}
                  <ProviderControls slug={tenant} connected={connected} mock={mock} provider={integration?.provider ?? null} canManage={canDo(ctx.role, "manage_integrations")} setups={subscriptionSetups(ctx.tenant.id, tenant)} />
                  <p className="text-xs"><Link href={`/t/${tenant}/integrations/guide/subscriptions`} className="underline-offset-4 hover:underline">{t("provider.guide")}</Link></p>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2" id="profit">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("profit.title")}</CardTitle><CardDescription>{t("profit.description")}</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm" data-testid="subs-profit">
                  <dt className="text-muted-foreground">{t("profit.orders")}</dt><dd className="text-right tabular">{showOrders ? <Link href={`/t/${tenant}/orders?subscription=any`} className="hover:underline">{n(profit.totals.orders)}</Link> : n(profit.totals.orders)}</dd>
                  <dt className="text-muted-foreground">{t("profit.revenue")}</dt><dd className="text-right tabular">{money(profit.totals.netRevenueMinor)}</dd>
                  <dt className="text-muted-foreground">{t("profit.costs")}</dt><dd className="text-right tabular">−{money(profit.totals.costsMinor)}</dd>
                  <dt className="font-medium">{t("profit.profit")}</dt><dd className="text-right font-medium tabular">{money(profit.totals.profitMinor)}</dd>
                </dl>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>{t("profit.order_n")}</TableHead><TableHead className="text-right">{t("profit.orders")}</TableHead><TableHead className="text-right">{t("profit.avg_profit")}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {profit.byRenewal.slice(0, 13).map((b) => (
                        <TableRow key={b.renewalNumber}>
                          <TableCell>{b.renewalNumber === 0 ? t("profit.first_order") : t("profit.renewal_n", { n: b.renewalNumber })}</TableCell>
                          <TableCell className="text-right tabular">{showOrders ? <Link href={`/t/${tenant}/orders?subscription=${b.renewalNumber === 0 ? "first" : "renewal"}`} className="hover:underline">{n(b.orders)}</Link> : n(b.orders)}</TableCell>
                          <TableCell className="text-right tabular">{money(b.avgProfitMinor)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{t("acquisition.title")}</CardTitle><CardDescription>{t("acquisition.description")}</CardDescription></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table data-testid="subs-acquisition">
                  <TableHeader><TableRow><TableHead>{t("acquisition.source")}</TableHead><TableHead className="text-right">{t("acquisition.subscribers")}</TableHead><TableHead className="text-right">{t("acquisition.ltv")}</TableHead><TableHead className="text-right">{t("acquisition.cac")}</TableHead><TableHead className="text-right">{t("acquisition.ratio")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {profit.acquisition.slice(0, 15).map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="max-w-56 truncate">{r.kind === "campaign" && canViewPage(ctx.role, "campaigns") ? <Link href={`/t/${tenant}/campaigns/${r.key.split(":")[1]}`} className="hover:underline">{r.label}</Link> : r.kind === "channel" ? t.has(`acquisition.channels.${r.label}`) ? t(`acquisition.channels.${r.label}`) : r.label : r.label}</TableCell>
                        <TableCell className="text-right tabular">{n(r.subscribers)}</TableCell>
                        <TableCell className="text-right tabular">{money(r.ltvMinor)}</TableCell>
                        <TableCell className="text-right tabular">{r.cacMinor === null ? "—" : money(r.cacMinor)}</TableCell>
                        <TableCell className={cn("text-right tabular", r.ratio !== null && r.ratio < 1 && "text-destructive")}>{r.ratio === null ? "—" : `${formatNumber(r.ratio, ctx.locale, { maximumFractionDigits: 1 })}×`}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

export default withIntl(SubscriptionsOverviewPage, "app/t/[tenant]/subscriptions/page.tsx");

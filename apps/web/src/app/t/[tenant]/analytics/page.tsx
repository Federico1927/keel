import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent, previousPeriod, type AttributionModel } from "@keel/core";
import { ATTRIBUTION_MODELS, BASE_METRICS, attributionReport, getSurveySettings, surveyResults, blendedForPeriod, boughtTogether, dailySeries, entryProducts, kpisForPeriod, listCustomMetrics, ltvReport, metricValues, monthEndForecast, pnlForPeriod, productPerformance, repurchaseCohorts, secondPurchasePaths, userDashboard, type PnlReport } from "@keel/services";
import { canWritePage } from "@keel/config";
import { CustomMetricForm, DashboardEditor, DeleteMetricButton } from "./advanced-controls";
import { SurveySettings } from "./survey-settings";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { PeriodPicker } from "@/components/period-picker";
import { resolvePeriod } from "@/server/period";

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; from?: string; to?: string; preset?: string; by?: string; model?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("analytics");
  const tab = ["overview", "custom", "pnl", "attribution", "products", "cohorts", "ltv", "basket", "survey"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/analytics`;
  const fromIso = period.from.toISOString().slice(0, 10);
  const toIso = new Date(period.to.getTime() - 1).toISOString().slice(0, 10);
  const ordersLink = (extra = "") => `/t/${tenant}/orders?from=${fromIso}&to=${toIso}${extra}`;
  const query = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, preset: period.preset, from: period.preset ? undefined : sp.from, to: period.preset ? undefined : sp.to, ...patch })) if (v) u.set(k, v);
    return `${base}?${u}`;
  };

  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex flex-wrap items-center gap-2"><PeriodPicker basePath={base} keep={{ tab }} preset={period.preset} from={sp.from} to={sp.to} /><Link href={`${base}/alerts`} className="text-sm underline-offset-4 hover:underline" data-testid="alerts-link">{t("alerts_link")}</Link><Link href={`${base}/costs`} className="text-sm underline-offset-4 hover:underline">{t("costs_link")}</Link></div>} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
        {["overview", "custom", "pnl", "attribution", "products", "cohorts", "ltv", "basket", "survey"].map((k) => (
          <Link key={k} href={query({ tab: k })} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")}>
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </div>

      {tab === "overview" && (await (async () => {
        const { kpis, series, blended, forecast } = await ctx.run(async (tx) => ({ kpis: await kpisForPeriod(s(tx), at, period), series: await dailySeries(s(tx), at, period), blended: await blendedForPeriod(s(tx), at, period), forecast: await monthEndForecast(s(tx), at) }));
        const c = kpis.current;
        const ratio = (v: number | null, digits = 2) => (v === null ? "—" : `${v.toFixed(digits)}×`);
        return (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t("kpi.net_revenue")} value={money(c.netRevenueMinor)} trend={kpis.changes.netRevenue !== null ? { value: kpis.changes.netRevenue } : null} hint={t("vs_previous")} href={ordersLink("&status=confirmed,fulfilling,shipped,delivered,returned_partial")} />
              <Stat label={t("kpi.orders")} value={formatNumber(c.orders, ctx.locale)} trend={kpis.changes.orders !== null ? { value: kpis.changes.orders } : null} hint={t("vs_previous")} href={ordersLink("&status=confirmed,fulfilling,shipped,delivered,returned_partial")} />
              <Stat label={t("kpi.aov")} value={c.aovMinor ? money(c.aovMinor) : "—"} trend={kpis.changes.aov !== null ? { value: kpis.changes.aov } : null} hint={t("vs_previous")} />
              <Stat label={t("kpi.contribution")} value={money(c.contributionMinor)} trend={kpis.changes.contribution !== null ? { value: kpis.changes.contribution } : null} hint={formatPercent(c.contributionRate, ctx.locale)} href={query({ tab: "pnl" })} />
              <Stat label={t("kpi.cancel_rate")} value={formatPercent(kpis.cancelRate, ctx.locale)} trend={kpis.changes.cancelRate !== null ? { value: kpis.changes.cancelRate } : null} hint={`${c.cancelledOrders} / ${c.placedOrders}`} href={ordersLink("&status=cancelled")} />
              <Stat label={t("kpi.return_rate")} value={formatPercent(kpis.returnRate, ctx.locale)} trend={kpis.changes.returnRate !== null ? { value: kpis.changes.returnRate } : null} hint={`${c.returnedOrders}`} href={ordersLink("&status=returned,returned_partial,refunded")} />
              <Stat label={t("kpi.new_customers")} value={formatNumber(kpis.newCustomers, ctx.locale)} />
              <Stat label={t("kpi.returning_customers")} value={formatNumber(kpis.returningCustomers, ctx.locale)} />
            </div>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card data-testid="blended-card">
                <CardHeader>
                  <CardTitle className="text-base">{t("blended.title")}</CardTitle>
                  <CardDescription>{t("blended.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Stat label={t("blended.mer")} value={ratio(blended.mer)} hint={t("blended.mer_hint", { share: formatPercent(blended.spendShare, ctx.locale) })} />
                    <Stat label={t("blended.nc_roas")} value={ratio(blended.ncRoas)} hint={t("blended.nc_roas_hint", { n: formatNumber(blended.newCustomers, ctx.locale) })} />
                    <Stat label={t("blended.cac")} value={blended.cacMinor !== null ? money(blended.cacMinor) : "—"} hint={t("blended.cac_hint")} />
                    <Stat label={t("blended.poas")} value={ratio(blended.poas)} hint={t("blended.poas_hint")} />
                  </div>
                  {blended.cacByChannel.length > 0 && (
                    <ul className="mt-3 divide-y text-sm">
                      {blended.cacByChannel.map((ch) => (
                        <li key={ch.channel} className="flex items-center justify-between py-1.5"><span>{t(`blended.channel.${ch.channel}`, { default: ch.channel })}</span><span className="tabular text-muted-foreground">{money(ch.spendMinor)} · {ch.newCustomers} {t("blended.new")} · <span className="font-medium text-foreground">{ch.cacMinor !== null ? money(ch.cacMinor) : "—"}</span></span></li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card data-testid="forecast-card">
                <CardHeader>
                  <CardTitle className="text-base">{t("forecast.title", { month: forecast.month })}</CardTitle>
                  <CardDescription>{t("forecast.description", { elapsed: forecast.elapsedDays, days: forecast.daysInMonth })}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-3">
                  <Stat label={t("forecast.revenue")} value={money(forecast.revenue.projected)} hint={`${money(forecast.revenue.low)} – ${money(forecast.revenue.high)} · ${t("forecast.to_date", { v: money(forecast.revenue.toDate) })}`} />
                  <Stat label={t("forecast.orders")} value={formatNumber(forecast.orders.projected, ctx.locale)} hint={t("forecast.to_date", { v: formatNumber(forecast.orders.toDate, ctx.locale) })} />
                  <Stat label={t("forecast.spend")} value={money(forecast.spend.projected)} hint={t("forecast.to_date", { v: money(forecast.spend.toDate) })} />
                </CardContent>
              </Card>
            </div>
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">{t("series_title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <RevenueChart data={series} locale={ctx.locale} currency={ctx.tenant.currency} ordersLabel={t("orders_series")} />
              </CardContent>
            </Card>
          </>
        );
      })())}

      {tab === "pnl" && (await (async () => {
        const pnl = await ctx.run((tx) => pnlForPeriod(s(tx), at, period));
        // monthly breakdown within the period (max 13 months)
        const months: { label: string; from: Date; to: Date }[] = [];
        const cursor = new Date(Date.UTC(period.from.getUTCFullYear(), period.from.getUTCMonth(), 1));
        while (cursor < period.to && months.length < 13) {
          const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
          months.push({ label: cursor.toISOString().slice(0, 7), from: new Date(Math.max(cursor.getTime(), period.from.getTime())), to: new Date(Math.min(next.getTime(), period.to.getTime())) });
          cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        }
        const monthly: (PnlReport & { label: string })[] = months.length > 1 ? await ctx.run(async (tx) => Promise.all(months.map(async (m) => ({ ...(await pnlForPeriod(s(tx), at, { from: m.from, to: m.to })), label: m.label })))) : [];
        const rate = (v: number) => formatPercent(pnl.netRevenueMinor ? v / pnl.netRevenueMinor : null, ctx.locale);
        const lines: { key: string; value: number; bold?: boolean; neg?: boolean; href?: string }[] = [
          { key: "gross", value: pnl.grossRevenueMinor, href: ordersLink("&status=confirmed,fulfilling,shipped,delivered,returned_partial") },
          { key: "refunds", value: -pnl.refundedMinor, neg: true, href: ordersLink("&paymentStatus=partially_refunded,refunded") },
          { key: "tax", value: -pnl.taxMinor, neg: true },
          { key: "net", value: pnl.netRevenueMinor, bold: true },
          { key: "cogs", value: -pnl.cogsMinor, neg: true },
          { key: "gross_margin", value: pnl.grossMarginMinor, bold: true },
          { key: "shipping", value: -pnl.shippingCostMinor, neg: true, href: `${base}/costs` },
          { key: "fees", value: -pnl.paymentFeeMinor, neg: true },
          ...(pnl.returnCostsMinor ? [{ key: "return_costs", value: -pnl.returnCostsMinor, neg: true, href: `/t/${tenant}/returns/analytics` }] : []),
          { key: "contribution", value: pnl.contributionMinor, bold: true },
          { key: "ads", value: -pnl.adSpendMinor, neg: true, href: `/t/${tenant}/campaigns` },
          { key: "fixed", value: -pnl.fixedCostsMinor, neg: true, href: `${base}/costs` },
          { key: "operating", value: pnl.operatingProfitMinor, bold: true },
        ];
        return (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">{t("pnl.title")}</CardTitle>
                <CardDescription>{t("pnl.description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("pnl.line")}</TableHead>
                      <TableHead className="text-right">{t("pnl.amount")}</TableHead>
                      <TableHead className="text-right">{t("pnl.rate")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l) => (
                      <TableRow key={l.key} className={l.bold ? "bg-muted/40 font-medium" : ""}>
                        <TableCell>{l.href ? <Link href={l.href} className="hover:underline">{t(`pnl.${l.key}`)}</Link> : t(`pnl.${l.key}`)}</TableCell>
                        <TableCell className={cn("text-right tabular", l.value < 0 && "text-destructive")}>{money(l.value)}</TableCell>
                        <TableCell className="text-right tabular text-muted-foreground">{rate(Math.abs(l.value))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {pnl.cogsIncompleteOrders > 0 && <p className="border-t p-3 text-xs text-warning">{t("pnl.cogs_incomplete", { n: pnl.cogsIncompleteOrders })}</p>}
                <p className="border-t p-3 text-xs text-muted-foreground" data-testid="cost-sources">
                  {t("pnl.cost_sources", { shipping: t(`pnl.source.${pnl.costSources.shipping}`), fixed: t(`pnl.source.${pnl.costSources.fixed}`) })} <Link href={`${base}/costs`} className="underline-offset-4 hover:underline">{t("pnl.edit_costs")}</Link>
                </p>
                {monthly.length > 0 && (
                  <div className="border-t">
                    <p className="px-4 pt-4 text-sm font-medium">{t("pnl.by_month")}</p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("pnl.month")}</TableHead>
                          <TableHead className="text-right">{t("pnl.orders")}</TableHead>
                          <TableHead className="text-right">{t("pnl.net")}</TableHead>
                          <TableHead className="text-right">{t("pnl.cogs")}</TableHead>
                          <TableHead className="text-right">{t("pnl.contribution")}</TableHead>
                          <TableHead className="text-right">{t("pnl.ads")}</TableHead>
                          <TableHead className="text-right">{t("pnl.operating")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {monthly.map((m) => (
                          <TableRow key={m.label}>
                            <TableCell><Link href={`${base}?tab=pnl&from=${m.period.from.toISOString().slice(0, 10)}&to=${new Date(m.period.to.getTime() - 1).toISOString().slice(0, 10)}`} className="hover:underline">{m.label}</Link></TableCell>
                            <TableCell className="text-right tabular">{m.orders}</TableCell>
                            <TableCell className="text-right tabular">{money(m.netRevenueMinor)}</TableCell>
                            <TableCell className="text-right tabular">{money(m.cogsMinor)}</TableCell>
                            <TableCell className="text-right tabular">{money(m.contributionMinor)}</TableCell>
                            <TableCell className="text-right tabular">{money(m.adSpendMinor)}</TableCell>
                            <TableCell className={cn("text-right tabular font-medium", m.operatingProfitMinor < 0 && "text-destructive")}>{money(m.operatingProfitMinor)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
            <div className="space-y-3">
              <Stat label={t("pnl.placed")} value={pnl.placedOrders} href={ordersLink()} />
              <Stat label={t("pnl.orders")} value={pnl.orders} href={ordersLink("&status=confirmed,fulfilling,shipped,delivered,returned_partial")} />
              <Stat label={t("pnl.cancelled")} value={pnl.cancelledOrders} href={ordersLink("&status=cancelled")} />
              <Stat label={t("pnl.returned")} value={pnl.returnedOrders} href={ordersLink("&status=returned,returned_partial,refunded")} />
              <Stat label={t("pnl.pending")} value={pnl.pendingOrders} href={ordersLink("&status=new,pending_review,on_hold")} />
            </div>
          </div>
        );
      })())}

      {tab === "products" && (await (async () => {
        const rows = await ctx.run((tx) => productPerformance(s(tx), period));
        return rows.length === 0 ? (
          <EmptyState title={t("products.empty")} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("products.title")}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("products.product")}</TableHead>
                    <TableHead className="text-right">{t("products.units")}</TableHead>
                    <TableHead className="text-right">{t("products.orders")}</TableHead>
                    <TableHead className="text-right">{t("products.revenue")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{t("products.cogs")}</TableHead>
                    <TableHead className="text-right">{t("products.margin")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{t("products.returned")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell><Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.title}</Link></TableCell>
                      <TableCell className="text-right tabular">{r.units}</TableCell>
                      <TableCell className="text-right tabular">{r.orders}</TableCell>
                      <TableCell className="text-right tabular">{money(r.grossRevenueMinor)}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{money(r.cogsMinor)}</TableCell>
                      <TableCell className="text-right tabular">{money(r.marginMinor)} <span className="text-xs text-muted-foreground">{formatPercent(r.grossRevenueMinor ? r.marginMinor / r.grossRevenueMinor : null, ctx.locale, 0)}</span></TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{r.returnedUnits}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })())}

      {tab === "cohorts" && (await (async () => {
        const rows = await ctx.run((tx) => repurchaseCohorts(s(tx), at));
        return rows.length === 0 ? (
          <EmptyState title={t("cohorts.empty")} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("cohorts.title")}</CardTitle>
              <CardDescription>{t("cohorts.description")}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("cohorts.cohort")}</TableHead>
                    <TableHead className="text-right">{t("cohorts.customers")}</TableHead>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <TableHead key={n} className="text-right">{t("cohorts.month", { n })}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.cohort}>
                      <TableCell className="font-medium">{r.cohort}</TableCell>
                      <TableCell className="text-right tabular">{r.customers}</TableCell>
                      {r.retention.map((v, i) => (
                        <TableCell key={i} className="text-right tabular" style={v !== null ? { backgroundColor: `hsl(205 55% 40% / ${Math.min(0.6, v * 2)})` } : undefined}>
                          {v === null ? "" : formatPercent(v, ctx.locale, 0)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })())}

      {tab === "custom" && (await (async () => {
        const fallback = ["net_revenue", "orders", "aov", "mer", "poas", "new_customers", "contribution", "operating_profit"];
        const { dash, customs } = await ctx.run(async (tx) => ({ dash: await userDashboard(s(tx), ctx.user.id), customs: await listCustomMetrics(s(tx)) }));
        const keys = ((dash?.widgets as { metric: string }[] | undefined) ?? fallback.map((m) => ({ metric: m }))).map((w) => w.metric);
        const values = await ctx.run((tx) => metricValues(s(tx), at, period, previousPeriod(period), keys));
        const fmt = (v: number | null, f: string) => (v === null ? "—" : f === "money" ? money(Math.round(v)) : f === "percent" ? formatPercent(v, ctx.locale, 1) : f === "ratio" ? `${v.toFixed(2)}×` : formatNumber(Math.round(v * 100) / 100, ctx.locale));
        const labelOf = (k: string, l: string | null) => l ?? t(`metrics.${k}`);
        const options = [...BASE_METRICS.map((m) => ({ key: m, label: t(`metrics.${m}`) })), ...customs.map((c) => ({ key: `custom:${c.key}`, label: c.label }))];
        const canWrite = canWritePage(ctx.role, "analytics");
        return (
          <div className="space-y-6">
            <Card data-testid="my-dashboard">
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">{dash?.name ?? t("custom.title")}</CardTitle>
                  <CardDescription>{t("custom.description")}</CardDescription>
                </div>
                <DashboardEditor slug={tenant} options={options} selected={keys} />
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {values.map((v) => {
                  const ch = v.value !== null && v.previous ? (v.value - v.previous) / Math.abs(v.previous) : null;
                  return <Stat key={v.metric} label={labelOf(v.metric, v.label)} value={fmt(v.value, v.format)} trend={ch !== null ? { value: ch } : null} hint={`${t("vs_previous")} · ${fmt(v.previous, v.format)}`} />;
                })}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("custom.metrics_title")}</CardTitle>
                <CardDescription>{t("custom.metrics_description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {customs.length > 0 && (
                  <ul className="divide-y text-sm" data-testid="custom-metrics">
                    {customs.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span><span className="font-medium">{c.label}</span> <span className="font-mono text-xs text-muted-foreground">{c.formula}</span></span>
                        {canWrite && <DeleteMetricButton slug={tenant} id={c.id} />}
                      </li>
                    ))}
                  </ul>
                )}
                {canWrite && <CustomMetricForm slug={tenant} bases={[...BASE_METRICS]} />}
              </CardContent>
            </Card>
          </div>
        );
      })())}

      {tab === "attribution" && (await (async () => {
        const model = (ATTRIBUTION_MODELS as readonly string[]).includes(sp.model ?? "") ? (sp.model as AttributionModel) : "linear";
        const by = sp.by === "campaign" ? "campaign" : "channel";
        const rows = await ctx.run((tx) => attributionReport(s(tx), at, period, model, by));
        const ratio = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}×`);
        return (
          <Card data-testid="attribution-card">
            <CardHeader className="space-y-3">
              <div>
                <CardTitle className="text-base">{t("attribution.title")}</CardTitle>
                <CardDescription>{t("attribution.description")}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
                  {ATTRIBUTION_MODELS.map((m) => <Link key={m} href={`${query({ tab: "attribution" })}&model=${m}&by=${by}`} className={cn("rounded-sm px-2 py-1", model === m ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`model-${m}`}>{t(`attribution.models.${m}`)}</Link>)}
                </div>
                <div className="flex gap-1 rounded-md bg-muted p-1">
                  {(["channel", "campaign"] as const).map((b) => <Link key={b} href={`${query({ tab: "attribution" })}&model=${model}&by=${b}`} className={cn("rounded-sm px-2 py-1", by === b ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`attribution.by.${b}`)}</Link>)}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t(`attribution.model_help.${model}`)}</p>
            </CardHeader>
            <CardContent className="p-0">
              {rows.length === 0 ? <EmptyState title={t("products.empty")} /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t(`attribution.by.${by}`)}</TableHead>
                      <TableHead className="text-right">{t("attribution.orders")}</TableHead>
                      <TableHead className="text-right">{t("attribution.revenue")}</TableHead>
                      <TableHead className="hidden text-right md:table-cell">{t("attribution.spend")}</TableHead>
                      <TableHead className="text-right">{t("attribution.roas")}</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">{t("attribution.last_click")}</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">{t("attribution.platform_claim")}</TableHead>
                      <TableHead className="hidden text-right xl:table-cell">{t("attribution.declared")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 60).map((r) => (
                      <TableRow key={r.key} data-testid="attribution-row">
                        <TableCell className="max-w-[18rem] truncate font-medium">{by === "channel" ? t(`ltv.channel.${r.key}`, { default: r.key }) : <Link href={`/t/${tenant}/campaigns/${r.key}`} className="hover:underline">{r.label}</Link>}{r.platform && <Badge variant="outline" className="ml-1">{r.platform}</Badge>}</TableCell>
                        <TableCell className="text-right tabular">{formatNumber(r.orders, ctx.locale)}</TableCell>
                        <TableCell className="text-right tabular">{money(r.netMinor)}</TableCell>
                        <TableCell className="hidden text-right tabular md:table-cell">{r.spendMinor !== null ? money(r.spendMinor) : "—"}</TableCell>
                        <TableCell className="text-right tabular font-medium">{ratio(r.roas)}</TableCell>
                        <TableCell className="hidden text-right tabular lg:table-cell">{money(r.lastClick.netMinor)}</TableCell>
                        <TableCell className="hidden text-right tabular lg:table-cell">{money(r.platformClaim.netMinor)}</TableCell>
                        <TableCell className="hidden text-right tabular xl:table-cell">{r.declared ? `${formatNumber(r.declared.purchases, ctx.locale)} · ${money(r.declared.valueMinor)}` : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="border-t p-3 text-xs text-muted-foreground">{t("attribution.footnote")}</p>
            </CardContent>
          </Card>
        );
      })())}

      {tab === "ltv" && (await (async () => {
        const by = (["cohort", "channel", "product"] as const).find((b) => b === sp.by) ?? "cohort";
        const rows = await ctx.run((tx) => ltvReport(s(tx), at, by));
        const windows = [30, 60, 90, 180, 365] as const;
        return (
          <Card data-testid="ltv-card">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="text-base">{t("ltv.title")}</CardTitle>
                <CardDescription>{t("ltv.description")}</CardDescription>
              </div>
              <div className="flex gap-1 rounded-md bg-muted p-1 text-sm">
                {(["cohort", "channel", "product"] as const).map((b) => (
                  <Link key={b} href={`${query({ tab: "ltv" })}&by=${b}`} className={cn("rounded-sm px-3 py-1", by === b ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`ltv.by.${b}`)}</Link>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {rows.length === 0 ? <EmptyState title={t("cohorts.empty")} /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t(`ltv.by.${by}`)}</TableHead>
                      <TableHead className="text-right">{t("cohorts.customers")}</TableHead>
                      <TableHead className="hidden text-right md:table-cell">{t("ltv.first_order")}</TableHead>
                      {windows.map((w) => <TableHead key={w} className="text-right">{t("ltv.window", { d: w })}</TableHead>)}
                      <TableHead className="hidden text-right lg:table-cell">{t("ltv.repeat_90")}</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">{t("ltv.days_to_second")}</TableHead>
                      {by === "cohort" && <TableHead className="hidden text-right xl:table-cell">{t("ltv.cac")}</TableHead>}
                      {by === "cohort" && <TableHead className="hidden text-right xl:table-cell">{t("ltv.payback")}</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="max-w-[16rem] truncate font-medium">{by === "channel" ? t(`ltv.channel.${r.key}`, { default: r.key }) : r.key}</TableCell>
                        <TableCell className="text-right tabular">{formatNumber(r.customers, ctx.locale)}</TableCell>
                        <TableCell className="hidden text-right tabular md:table-cell">{r.firstOrderAvgNetMinor !== null ? money(r.firstOrderAvgNetMinor) : "—"}</TableCell>
                        {r.windows.map((w) => <TableCell key={w.window} className="text-right tabular" title={t("ltv.matured", { n: w.matured })}>{w.avgNetMinor !== null ? money(w.avgNetMinor) : <span className="text-muted-foreground">·</span>}</TableCell>)}
                        <TableCell className="hidden text-right tabular lg:table-cell">{formatPercent(r.windows.find((w) => w.window === 90)?.repeatRate ?? null, ctx.locale, 0)}</TableCell>
                        <TableCell className="hidden text-right tabular lg:table-cell">{r.medianDaysToSecond ?? "—"}</TableCell>
                        {by === "cohort" && <TableCell className="hidden text-right tabular xl:table-cell">{r.cacMinor !== null ? money(r.cacMinor) : "—"}</TableCell>}
                        {by === "cohort" && <TableCell className="hidden text-right tabular xl:table-cell">{r.paybackDays !== null ? t("ltv.days", { n: r.paybackDays }) : "—"}</TableCell>}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="border-t p-3 text-xs text-muted-foreground">{t("ltv.footnote")}</p>
            </CardContent>
          </Card>
        );
      })())}

      {tab === "basket" && (await (async () => {
        const { entries, pairs, paths } = await ctx.run(async (tx) => ({ entries: await entryProducts(s(tx), at), pairs: await boughtTogether(s(tx), period), paths: await secondPurchasePaths(s(tx)) }));
        return (
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="xl:col-span-2" data-testid="entry-products">
              <CardHeader>
                <CardTitle className="text-base">{t("basket.entry_title")}</CardTitle>
                <CardDescription>{t("basket.entry_description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("products.product")}</TableHead>
                      <TableHead className="text-right">{t("basket.acquired")}</TableHead>
                      <TableHead className="text-right">{t("basket.ltv365")}</TableHead>
                      <TableHead className="text-right">{t("basket.repeat")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...entries].sort((a, b) => (b.avgLtv365Minor ?? -1) - (a.avgLtv365Minor ?? -1)).map((r) => (
                      <TableRow key={r.title}>
                        <TableCell className="font-medium">{r.productId ? <Link href={`/t/${tenant}/products/${r.productId}`} className="hover:underline">{r.title}</Link> : r.title}</TableCell>
                        <TableCell className="text-right tabular">{formatNumber(r.customers, ctx.locale)}</TableCell>
                        <TableCell className="text-right tabular" title={t("ltv.matured", { n: r.matured })}>{r.avgLtv365Minor !== null ? money(r.avgLtv365Minor) : "—"}</TableCell>
                        <TableCell className="text-right tabular">{formatPercent(r.repeatRate, ctx.locale, 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card data-testid="bought-together">
              <CardHeader>
                <CardTitle className="text-base">{t("basket.pairs_title")}</CardTitle>
                <CardDescription>{t("basket.pairs_description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {pairs.length === 0 ? <EmptyState title={t("products.empty")} /> : (
                  <ul className="divide-y text-sm">
                    {pairs.map((p) => (
                      <li key={`${p.a.id}-${p.b.id}`} className="flex items-center justify-between gap-2 px-4 py-2">
                        <span className="min-w-0 truncate">{p.a.title} <span className="text-muted-foreground">+</span> {p.b.title}</span>
                        <span className="shrink-0 tabular text-muted-foreground">{p.orders} · {t("basket.lift", { v: p.lift?.toFixed(1) ?? "—" })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card data-testid="second-purchase">
              <CardHeader>
                <CardTitle className="text-base">{t("basket.paths_title")}</CardTitle>
                <CardDescription>{t("basket.paths_description")}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {paths.length === 0 ? <EmptyState title={t("cohorts.empty")} /> : (
                  <ul className="divide-y text-sm">
                    {paths.map((p) => (
                      <li key={`${p.first.id}-${p.second.id}`} className="flex items-center justify-between gap-2 px-4 py-2">
                        <span className="min-w-0 truncate">{p.first.title} <span className="text-muted-foreground">→</span> {p.second.title}</span>
                        <span className="shrink-0 tabular text-muted-foreground">{p.customers} · {p.medianDays !== null ? t("ltv.days", { n: p.medianDays }) : "—"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        );
      })())}
      {tab === "survey" && (await (async () => {
        const ts = await getTranslations("survey_admin");
        const { settings, results } = await ctx.run(async (tx) => ({ settings: await getSurveySettings(s(tx)), results: await surveyResults(s(tx), period, ctx.locale) }));
        const canWrite = canWritePage(ctx.role, "analytics");
        const origin = process.env.NEXT_PUBLIC_APP_URL || "https://<keel-host>";
        const liquid = `<a href="${origin}/s/${tenant}?o={{ order.id }}&t={{ order.id | hmac_sha256: '${settings.secret}' }}&lang=${ctx.tenant.defaultLocale}">{{ 'How did you hear about us?' }}</a>`;
        const share = (n: number, d: number) => (d ? formatPercent(n / d, ctx.locale, 0) : "—");
        return (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label={ts("kpi.responses")} value={formatNumber(results.responses, ctx.locale)} />
              <Stat label={ts("kpi.rate")} value={share(results.responses, results.orders)} hint={ts("kpi.rate_hint", { orders: formatNumber(results.orders, ctx.locale) })} />
              <Stat label={ts("kpi.invisible")} value={share(results.crosstab.reduce((a, c) => a + c.invisible, 0), results.responses)} hint={ts("kpi.invisible_hint")} />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-base">{ts("answers_title")}</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow><TableHead>{ts("answer")}</TableHead><TableHead className="text-right">{ts("responses")}</TableHead><TableHead className="text-right">{ts("share")}</TableHead><TableHead className="text-right">{ts("revenue")}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {results.answers.map((a) => (
                        <TableRow key={a.key} data-testid="survey-answer"><TableCell>{a.label}</TableCell><TableCell className="text-right tabular">{formatNumber(a.responses, ctx.locale)}</TableCell><TableCell className="text-right tabular">{share(a.responses, results.responses)}</TableCell><TableCell className="text-right tabular">{money(a.revenueMinor)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{ts("crosstab_title")}</CardTitle>
                  <CardDescription>{ts("crosstab_description")}</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader><TableRow><TableHead>{ts("reported")}</TableHead><TableHead className="text-right">{ts("responses")}</TableHead><TableHead className="text-right">{ts("agree")}</TableHead><TableHead className="text-right">{ts("invisible")}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {results.crosstab.map((c) => (
                        <TableRow key={c.channel}><TableCell>{t(`ltv.channel.${c.channel}`, { default: c.channel })}</TableCell><TableCell className="text-right tabular">{formatNumber(c.answers, ctx.locale)}</TableCell><TableCell className="text-right tabular">{share(c.agree, c.answers)}</TableCell><TableCell className="text-right tabular">{share(c.invisible, c.answers)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
            {results.others.length > 0 && <p className="text-sm text-muted-foreground">{ts("others")}: {results.others.join(" · ")}</p>}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{ts("settings_title")}</CardTitle>
                <CardDescription>{ts("settings_description")} <Link href={`/t/${tenant}/integrations/guide/survey`} className="underline">{ts("guide")}</Link></CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {canWrite && <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" data-testid="survey-liquid">{liquid}</pre>}
                <SurveySettings slug={tenant} enabled={settings.enabled} config={settings.config} canWrite={canWrite} />
              </CardContent>
            </Card>
          </div>
        );
      })())}
    </>
  );
}

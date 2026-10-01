import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent } from "@keel/core";
import { dailySeries, kpisForPeriod, pnlForPeriod, productPerformance, repurchaseCohorts, type PnlReport } from "@keel/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { PeriodPicker } from "@/components/period-picker";
import { resolvePeriod } from "@/server/period";

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; from?: string; to?: string; preset?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("analytics");
  const tab = ["overview", "pnl", "products", "cohorts"].includes(sp.tab ?? "") ? sp.tab! : "overview";
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
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<PeriodPicker basePath={base} keep={{ tab }} preset={period.preset} from={sp.from} to={sp.to} />} />
      <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {["overview", "pnl", "products", "cohorts"].map((k) => (
          <Link key={k} href={query({ tab: k })} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")}>
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </div>

      {tab === "overview" && (await (async () => {
        const [kpis, series] = await ctx.run(async (tx) => Promise.all([kpisForPeriod(s(tx), at, period), dailySeries(s(tx), at, period)]));
        const c = kpis.current;
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
          { key: "shipping", value: -pnl.shippingCostMinor, neg: true },
          { key: "fees", value: -pnl.paymentFeeMinor, neg: true },
          { key: "contribution", value: pnl.contributionMinor, bold: true },
          { key: "ads", value: -pnl.adSpendMinor, neg: true, href: `/t/${tenant}/campaigns` },
          { key: "fixed", value: -pnl.fixedCostsMinor, neg: true, href: `/t/${tenant}/settings` },
          { key: "operating", value: pnl.operatingProfitMinor, bold: true },
        ];
        return (
          <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
            <Card>
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
    </>
  );
}

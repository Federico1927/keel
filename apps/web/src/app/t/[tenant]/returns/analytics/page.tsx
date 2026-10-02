import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { returnsAnalytics } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader, Stat, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { WideTable } from "@/components/mobile/wide-table";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";

import { withIntl } from "@/i18n/intl-scope";
async function ReturnsAnalyticsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("returns_analytics");
  const tr = await getTranslations("returns");
  const td = await getTranslations("return_detail");
  const ts = await getTranslations("return_status");
  const period = resolvePeriod(sp, ctx.tenant.timezone, "90d");
  const a = await ctx.run((tx) => returnsAnalytics({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, period, { labelMinor: ctx.settings.returnLabelCostMinor, handlingMinor: ctx.settings.returnHandlingCostMinor }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/returns`;
  const avgOptionRate = a.byOption.reduce((s, x) => s + x.returned, 0) / Math.max(1, a.byOption.reduce((s, x) => s + x.sold, 0));
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={base} className="hover:underline">← {tr("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<PeriodPicker basePath={`${base}/analytics`} preset={period.preset} from={sp.from} to={sp.to} />} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("kpi.returns")} value={formatNumber(a.total, ctx.locale)} hint={t("kpi.closed", { n: formatNumber(a.closed, ctx.locale) })} href={`${base}?${qs}`} />
        <Stat label={t("kpi.rate")} value={a.returnRate === null ? "—" : formatPercent(a.returnRate, ctx.locale)} hint={t("kpi.of_orders", { n: formatNumber(a.soldOrders, ctx.locale) })} />
        <Stat label={t("kpi.refunded")} value={money(a.refundedMinor)} />
        <Stat label={t("kpi.merchant_fault")} value={a.total ? formatPercent((a.byFault.find((f) => f.fault === "merchant")?.count ?? 0) / a.total, ctx.locale) : "—"} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="returns-value">
        <Stat label={t("kpi.kept")} value={money(a.keptMinor)} hint={t("kpi.kept_hint")} />
        <Stat label={t("kpi.credit")} value={money(a.creditIssuedMinor)} hint={a.bonusMinor ? t("kpi.bonus", { amount: money(a.bonusMinor) }) : undefined} />
        <Stat label={t("kpi.exchanges")} value={formatNumber(a.exchanges, ctx.locale)} hint={a.upsellMinor ? t("kpi.upsell", { amount: money(a.upsellMinor) }) : undefined} />
        <Stat label={t("kpi.costs")} value={money(a.costs.totalMinor)} hint={ctx.settings.returnLabelCostMinor || ctx.settings.returnHandlingCostMinor ? t("kpi.costs_hint", { labels: money(a.costs.labelsMinor), handling: money(a.costs.handlingMinor), recovered: money(a.costs.recoveredMinor) }) : t("kpi.costs_unset")} href={`${base}/portal`} />
      </div>
      <Card className="mt-6" data-testid="returns-ageing">
        <CardHeader><CardTitle className="text-base">{t("ageing.title")}</CardTitle><CardDescription>{t("ageing.description", { days: a.ageing.staleDays })}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <WideTable label={t("ageing.title")} stickyFirst>
            <TableHeader>
              <TableRow>
                <TableHead>{t("ageing.state")}</TableHead>
                <TableHead className="text-right">{t("count")}</TableHead>
                <TableHead className="text-right">{t("ageing.avg")}</TableHead>
                <TableHead className="text-right">{t("ageing.median")}</TableHead>
                <TableHead className="text-right">{t("ageing.max")}</TableHead>
                <TableHead className="text-right">{t("ageing.open")}</TableHead>
                <TableHead className="text-right">{t("ageing.stale", { days: a.ageing.staleDays })}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.ageing.stages.map((st) => {
                const open = a.ageing.open.find((o) => o.stage === st.stage);
                const days = (n: number) => t("ageing.days", { n: formatNumber(n, ctx.locale, { maximumFractionDigits: 1 }) });
                return (
                  <TableRow key={st.stage}>
                    <TableCell><Link href={`${base}?status=${st.stage}`} className="hover:underline">{ts(st.stage)}</Link></TableCell>
                    <TableCell className="text-right tabular">{formatNumber(st.count, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{days(st.avgDays)}</TableCell>
                    <TableCell className="text-right tabular">{days(st.medianDays)}</TableCell>
                    <TableCell className="text-right tabular">{days(st.maxDays)}</TableCell>
                    <TableCell className="text-right tabular">{open ? `${formatNumber(open.count, ctx.locale)} · ${days(open.avgDays)}` : "—"}</TableCell>
                    <TableCell className={`text-right tabular ${open?.stale ? "font-medium text-destructive" : ""}`}>{open ? formatNumber(open.stale, ctx.locale) : "—"}</TableCell>
                  </TableRow>
                );
              })}
              {a.ageing.stages.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{t("ageing.empty")}</TableCell></TableRow>}
            </TableBody>
          </WideTable>
        </CardContent>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("by_reason")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={a.byReason}
              rowKey={(r) => r.reasonCode}
              rowProps={() => ({ "data-testid": "returns-reason-row" })}
              columns={[
                { key: "reason", header: tr("columns.reason"), mobile: "title", cell: (r) => <Link href={`${base}?reason=${r.reasonCode}`} className="hover:underline">{r.label}</Link> },
                { key: "count", header: t("count"), mobile: "badge", align: "right", className: "tabular", cell: (r) => formatNumber(r.count, ctx.locale) },
                { key: "share", header: t("share"), align: "right", className: "tabular", cell: (r) => formatPercent(r.share, ctx.locale) },
                { key: "amount", header: t("amount"), align: "right", className: "tabular", cell: (r) => money(r.amountMinor) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("by_fault_resolution")}</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="space-y-1">
              {a.byFault.map((f) => (
                <li key={f.fault} className="flex justify-between"><span>{td(`faults.${f.fault}`)}</span><span className="tabular">{formatNumber(f.count, ctx.locale)} · {money(f.amountMinor)}</span></li>
              ))}
            </ul>
            <ul className="space-y-1 border-t pt-3">
              {a.byResolution.map((r) => (
                <li key={r.resolution} className="flex justify-between"><span>{tr(`resolution.${r.resolution}`)}</span><span className="tabular">{formatNumber(r.count, ctx.locale)}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("by_product")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={a.byProduct}
            rowKey={(p) => p.productId ?? p.title}
            rowProps={() => ({ "data-testid": "returns-product-row" })}
            columns={[
              { key: "product", header: t("product"), mobile: "title", cell: (p) => (p.productId ? <Link href={`/t/${tenant}/products/${p.productId}`} className="hover:underline">{p.title}</Link> : p.title) },
              { key: "rate", header: t("rate"), mobile: "badge", align: "right", className: "tabular", cell: (p) => <span className={p.rate !== null && p.rate > 0.2 ? "text-destructive" : ""}>{p.rate === null ? "—" : formatPercent(p.rate, ctx.locale)}</span> },
              { key: "returned", header: t("returned_qty"), align: "right", className: "tabular", cell: (p) => formatNumber(p.returnedQty, ctx.locale) },
              { key: "sold", header: t("sold_qty"), align: "right", className: "tabular", cell: (p) => formatNumber(p.soldQty, ctx.locale) },
              { key: "amount", header: t("amount"), align: "right", className: "tabular", cell: (p) => money(p.amountMinor) },
            ]}
          />
        </CardContent>
      </Card>
      <Card className="mt-6" data-testid="returns-by-option">
        <CardHeader><CardTitle className="text-base">{t("by_option")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {a.byOption.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">{t("no_options")}</p> : (
            <DataList
              rows={a.byOption.slice(0, 40)}
              rowKey={(o) => `${o.option}-${o.value}`}
              columns={[
                { key: "option", header: t("option"), mobile: "title", cell: (o) => <><span className="font-normal text-muted-foreground">{o.option}:</span> {o.value}</> },
                { key: "rate", header: t("rate"), mobile: "badge", align: "right", className: "tabular", cell: (o) => <span className={o.rate >= 2 * avgOptionRate ? "font-medium text-destructive" : ""}>{formatPercent(o.rate, ctx.locale)}</span> },
                { key: "sold", header: t("sold"), align: "right", className: "tabular", cell: (o) => formatNumber(o.sold, ctx.locale) },
                { key: "returned", header: t("returned"), align: "right", className: "tabular", cell: (o) => formatNumber(o.returned, ctx.locale) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(ReturnsAnalyticsPage, "app/t/[tenant]/returns/analytics/page.tsx");

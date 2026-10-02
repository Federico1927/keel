import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { returnsAnalytics } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";

export default async function ReturnsAnalyticsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; preset?: string }> }) {
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("ageing.state")}</TableHead>
                <TableHead className="text-right">{t("count")}</TableHead>
                <TableHead className="text-right">{t("ageing.avg")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("ageing.median")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("ageing.max")}</TableHead>
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
                    <TableCell className="hidden text-right tabular md:table-cell">{days(st.medianDays)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{days(st.maxDays)}</TableCell>
                    <TableCell className="text-right tabular">{open ? `${formatNumber(open.count, ctx.locale)} · ${days(open.avgDays)}` : "—"}</TableCell>
                    <TableCell className={`text-right tabular ${open?.stale ? "font-medium text-destructive" : ""}`}>{open ? formatNumber(open.stale, ctx.locale) : "—"}</TableCell>
                  </TableRow>
                );
              })}
              {a.ageing.stages.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{t("ageing.empty")}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("by_reason")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("columns.reason")}</TableHead>
                  <TableHead className="text-right">{t("count")}</TableHead>
                  <TableHead className="text-right">{t("share")}</TableHead>
                  <TableHead className="text-right">{t("amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.byReason.map((r) => (
                  <TableRow key={r.reasonCode}>
                    <TableCell><Link href={`${base}?reason=${r.reasonCode}`} className="hover:underline">{r.label}</Link></TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.count, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatPercent(r.share, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{money(r.amountMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("product")}</TableHead>
                <TableHead className="text-right">{t("returned_qty")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("sold_qty")}</TableHead>
                <TableHead className="text-right">{t("rate")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.byProduct.map((p) => (
                <TableRow key={p.productId ?? p.title}>
                  <TableCell>{p.productId ? <Link href={`/t/${tenant}/products/${p.productId}`} className="hover:underline">{p.title}</Link> : p.title}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(p.returnedQty, ctx.locale)}</TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(p.soldQty, ctx.locale)}</TableCell>
                  <TableCell className={`text-right tabular ${p.rate !== null && p.rate > 0.2 ? "text-destructive" : ""}`}>{p.rate === null ? "—" : formatPercent(p.rate, ctx.locale)}</TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">{money(p.amountMinor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="mt-6" data-testid="returns-by-option">
        <CardHeader><CardTitle className="text-base">{t("by_option")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("option")}</TableHead>
                <TableHead className="text-right">{t("sold")}</TableHead>
                <TableHead className="text-right">{t("returned")}</TableHead>
                <TableHead className="text-right">{t("rate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.byOption.slice(0, 40).map((o) => (
                <TableRow key={`${o.option}-${o.value}`}>
                  <TableCell><span className="text-muted-foreground">{o.option}:</span> {o.value}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(o.sold, ctx.locale)}</TableCell>
                  <TableCell className="text-right tabular">{formatNumber(o.returned, ctx.locale)}</TableCell>
                  <TableCell className={`text-right tabular ${a.byOption.length && o.rate >= 2 * (a.byOption.reduce((s, x) => s + x.returned, 0) / Math.max(1, a.byOption.reduce((s, x) => s + x.sold, 0))) ? "font-medium text-destructive" : ""}`}>{formatPercent(o.rate, ctx.locale)}</TableCell>
                </TableRow>
              ))}
              {a.byOption.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t("no_options")}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

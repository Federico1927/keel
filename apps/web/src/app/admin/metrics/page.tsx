import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ADDON_MODULES, MODULES, PLATFORM_CURRENCY } from "@hullwise/config";
import { formatMoney, formatNumber } from "@hullwise/core";
import { platformSeriesReport, tenantsBehind } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { LifecycleBadge } from "../_components/badges";
import { MrrChart } from "./chart";

const SERIES = ["mrr", "active", "trial", "new", "churned"] as const;

/**
 * Platform metrics over time (#48): MRR and paying tenants by month, new vs churned, add-on adoption,
 * rebuilt from the lifecycle history. Every number links to the tenants behind it.
 */
export default async function AdminMetricsPage({ searchParams }: { searchParams: Promise<{ month?: string; metric?: string }> }) {
  const { db } = await requireSuperAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin");
  const tm = await getTranslations("modules");
  const locale = await getLocale();
  const { months, tenants } = await platformSeriesReport(db, { months: 12 });
  const addons = ADDON_MODULES.filter((a) => MODULES[a].availability === "implemented");
  const current = months[months.length - 1]!;
  const previous = months[months.length - 2];
  const money = (m: number) => formatMoney(m, PLATFORM_CURRENCY, locale);
  const monthLabel = (m: string) => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
  const selected = months.find((m) => m.month === sp.month);
  const metric = sp.metric && ((SERIES as readonly string[]).includes(sp.metric) || (addons as readonly string[]).includes(sp.metric)) ? sp.metric : "mrr";
  const drill = selected ? tenantsBehind(selected, metric) : [];
  const metricLabel = (m: string) => ((SERIES as readonly string[]).includes(m) ? t(`metrics.series.${m}`) : tm(`addon.${m.replace("addon.", "")}.name`));
  const cell = (month: string, m: string, value: React.ReactNode) => (
    <Link href={`/admin/metrics?month=${month}&metric=${m}#tenants`} className={cn("tabular hover:underline", sp.month === month && metric === m && "font-semibold text-primary")} data-testid={`metric-${m}-${month}`}>{value}</Link>
  );
  const trend = (a: number, b: number | undefined) => (b ? { value: (a - b) / b, label: "" } : null);
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("metrics.title")} description={t("metrics.description")} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("metrics.series.mrr")} value={money(current.mrrMinor)} trend={trend(current.mrrMinor, previous?.mrrMinor)} href={`/admin/metrics?month=${current.month}&metric=mrr#tenants`} />
        <Stat label={t("metrics.series.active")} value={formatNumber(current.active.length, locale)} hint={t("metrics.trial_hint", { n: current.trial.length })} href={`/admin/metrics?month=${current.month}&metric=active#tenants`} />
        <Stat label={t("metrics.new_vs_churned")} value={`${formatNumber(current.new.length, locale)} / ${formatNumber(current.churned.length, locale)}`} hint={t("metrics.this_month")} href={`/admin/metrics?month=${current.month}&metric=new#tenants`} />
        <Stat label={t("metrics.arr")} value={money(current.mrrMinor * 12)} hint={t("metrics.arr_hint")} />
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("metrics.chart_title")}</CardTitle>
          <CardDescription>{t("metrics.chart_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <MrrChart data={months.map((m) => ({ month: m.month, mrrMinor: m.mrrMinor, active: m.active.length }))} locale={locale} currency={PLATFORM_CURRENCY} labels={{ mrr: t("metrics.series.mrr"), active: t("metrics.series.active") }} />
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("metrics.table_title")}</CardTitle>
          <CardDescription>{t("metrics.table_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("metrics.month")}</TableHead>
                {SERIES.map((s) => <TableHead key={s} className="text-right">{t(`metrics.series.${s}`)}</TableHead>)}
                {addons.map((a) => <TableHead key={a} className="hidden text-right md:table-cell">{tm(`addon.${a.replace("addon.", "")}.name`)}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...months].reverse().map((m) => (
                <TableRow key={m.month} data-testid="metrics-row">
                  <TableCell className="whitespace-nowrap">{monthLabel(m.month)}</TableCell>
                  <TableCell className="text-right">{cell(m.month, "mrr", money(m.mrrMinor))}</TableCell>
                  <TableCell className="text-right">{cell(m.month, "active", formatNumber(m.active.length, locale))}</TableCell>
                  <TableCell className="text-right">{cell(m.month, "trial", formatNumber(m.trial.length, locale))}</TableCell>
                  <TableCell className="text-right">{cell(m.month, "new", formatNumber(m.new.length, locale))}</TableCell>
                  <TableCell className="text-right">{cell(m.month, "churned", formatNumber(m.churned.length, locale))}</TableCell>
                  {addons.map((a) => <TableCell key={a} className="hidden text-right md:table-cell">{cell(m.month, a, formatNumber(m.addons[a]?.length ?? 0, locale))}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {selected && (
        <Card className="mt-6" id="tenants" data-testid="metrics-drilldown">
          <CardHeader>
            <CardTitle className="text-base">{t("metrics.behind", { metric: metricLabel(metric), month: monthLabel(selected.month) })}</CardTitle>
            <CardDescription>{t("metrics.behind_count", { n: drill.length })}</CardDescription>
          </CardHeader>
          <CardContent>
            {drill.length === 0 ? <p className="text-sm text-muted-foreground">{t("metrics.none")}</p> : (
              <ul className="divide-y text-sm">
                {drill.map((id) => {
                  const x = tenants.get(id);
                  return (
                    <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex items-center gap-2"><Link href={`/admin/tenants/${id}`} className="font-medium hover:underline">{x?.name ?? id}</Link>{x && <LifecycleBadge status={x.status} label={t(`tenants.status.${x.status}`)} />}</span>
                      {(metric === "mrr" || metric === "active") && <span className="tabular">{money(selected.mrrByTenant[id] ?? 0)}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

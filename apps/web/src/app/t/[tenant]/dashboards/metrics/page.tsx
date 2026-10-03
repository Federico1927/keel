import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { METRICS, canDo, normalizeMetricFilters, type MetricFilters, type MetricFormat } from "@hullwise/config";
import { dashboardPeriod, localMonthKey } from "@hullwise/core";
import { customLabel, listMetricTargets, metricFilterOptions, tenantMetricValues } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant, pageNow, sharedMemo, tenantCustoms } from "@/server/dashboards";
import { formatMetric } from "@/components/dashboard/format";
import { DeleteMetricButton, MetricBuilder, TargetForm, type MetricDraft } from "@/components/dashboard/metric-builder";

import { withIntl } from "@/i18n/intl-scope";
/** Metric catalog, custom metric builder and monthly targets: only `manage_dashboard` (owner, admin). */
async function MetricsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "dashboard");
  if (!canDo(ctx.role, "manage_dashboard")) notFound();
  const t = await getTranslations("dashboards");
  const tb = await getTranslations("dashboards.builder");
  const customs = await tenantCustoms(ctx);
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const now = pageNow();
  const mtd = dashboardPeriod("mtd", now, ctx.tenant.timezone);
  const [options, targets, values] = await ctx.run(async (tx) => [await metricFilterOptions(s(tx)), await listMetricTargets(s(tx)), await tenantMetricValues(s(tx), analyticsTenant(ctx), mtd, null, customs.map((c) => `custom:${c.key}`), { customs, memo: sharedMemo, locale: ctx.locale })] as const);
  const fmt = (v: number | null, f: MetricFormat) => formatMetric(v, f, ctx.tenant.currency, ctx.locale, t("widget.days_unit"));
  const editing = sp.edit ? customs.find((c) => c.key === sp.edit) : null;
  const draft: MetricDraft | null = editing ? { key: editing.key, label: editing.label, formula: editing.formula, format: editing.format as MetricDraft["format"], filters: (normalizeMetricFilters(editing.filters) ?? {}) as MetricFilters, higherIsBetter: editing.higherIsBetter, translations: (editing.translations ?? {}) as Record<string, string>, description: editing.description } : null;
  const month = localMonthKey(now, ctx.tenant.timezone);
  const labelOf = (ref: string) => (ref.startsWith("custom:") ? (customs.find((c) => `custom:${c.key}` === ref) ? customLabel(customs.find((c) => `custom:${c.key}` === ref)!, ctx.locale) : ref) : t.has(`metrics.${ref}`) ? t(`metrics.${ref}`) : ref);
  const formatOf = (ref: string): MetricFormat => (ref.startsWith("custom:") ? ((customs.find((c) => `custom:${c.key}` === ref)?.format as MetricFormat) ?? "number") : (METRICS.find((m) => m.key === ref)?.format ?? "number"));
  const filterSummary = (f: MetricFilters | null) => (f ? Object.entries(f).map(([k, v]) => `${tb(`filter_names.${k}`)}: ${Array.isArray(v) ? v.map((x) => options.campaigns.find((c) => c.id === x)?.name ?? options.products.find((p) => p.id === x)?.title ?? (t.has(`channels.${x}`) ? t(`channels.${x}`) : x)).join(", ") : String(v)}`).join(" · ") : "—");
  const base = `/t/${tenant}`;
  return (
    <>
      <PageHeader eyebrow={t("title")} title={t("metrics_page")} description={t("metrics_description")} />
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_32rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("custom_metrics")}</CardTitle><CardDescription>{t("custom_metrics_hint")}</CardDescription></CardHeader>
            <CardContent>
              {customs.length === 0 ? <p className="text-sm text-muted-foreground">{t("custom_metrics_empty")}</p> : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>{tb("label")}</TableHead><TableHead>{tb("formula")}</TableHead><TableHead>{tb("filters")}</TableHead><TableHead className="text-right">{t("this_month")}</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>
                      {customs.map((c) => {
                        const v = values.find((x) => x.ref === `custom:${c.key}`);
                        return (
                          <TableRow key={c.id} data-testid={`custom-metric-${c.key}`}>
                            <TableCell><span className="font-medium">{customLabel(c, ctx.locale)}</span><span className="block font-mono text-xs text-muted-foreground">custom:{c.key}</span></TableCell>
                            <TableCell className="font-mono text-xs">{c.formula}</TableCell>
                            <TableCell className="text-xs">{filterSummary(normalizeMetricFilters(c.filters))}</TableCell>
                            <TableCell className="text-right tabular" data-testid="custom-metric-value">{fmt(v?.value ?? null, c.format as MetricFormat)}</TableCell>
                            <TableCell className="whitespace-nowrap text-right"><Link href={`${base}/dashboards/metrics?edit=${c.key}`} className="mr-2 text-xs underline-offset-4 hover:underline">{t("edit")}</Link><DeleteMetricButton slug={tenant} id={c.id} /></TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("targets")}</CardTitle><CardDescription>{t("targets_hint")}</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <TargetForm slug={tenant} month={month} metrics={[...METRICS.filter((m) => m.kind === "period").map((m) => ({ ref: m.key, label: t(`metrics.${m.key}`), format: m.format })), ...customs.map((c) => ({ ref: `custom:${c.key}`, label: customLabel(c, ctx.locale), format: c.format }))]} />
              {targets.length > 0 && (
                <ul className="divide-y text-sm" data-testid="targets-list">
                  {targets.map((r) => <li key={r.id} className="flex justify-between gap-2 py-1"><span>{labelOf(r.metric)} · {r.month}</span><span className="tabular">{fmt(r.target, formatOf(r.metric))}{r.month === month && <Badge variant="info" className="ml-2">{t("this_month")}</Badge>}</span></li>)}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("catalog")}</CardTitle><CardDescription>{t("catalog_hint")}</CardDescription></CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{tb("label")}</TableHead><TableHead>{tb("key")}</TableHead><TableHead>{t("catalog_group")}</TableHead><TableHead>{t("catalog_flags")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {METRICS.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell>{t(`metrics.${m.key}`)}</TableCell>
                      <TableCell className="font-mono text-xs">{m.key}</TableCell>
                      <TableCell className="text-xs">{t(`metric_groups.${m.group}`)}</TableCell>
                      <TableCell className="space-x-1 text-xs">{m.kind === "snapshot" && <Badge variant="muted">{t("flag_snapshot")}</Badge>}{m.filterable && <Badge variant="outline">{t("flag_filterable")}</Badge>}{m.series && <Badge variant="outline">{t("flag_series")}</Badge>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">{t("catalog_pending")}</p>
            </CardContent>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader><CardTitle className="text-base">{editing ? tb("edit_title", { name: customLabel(editing, ctx.locale) }) : tb("new_title")}</CardTitle><CardDescription>{tb("hint")}</CardDescription></CardHeader>
          <CardContent>
            <MetricBuilder key={editing?.id ?? "new"} slug={tenant} initial={draft} options={options} bases={METRICS.map((m) => ({ ref: m.key, label: t(`metrics.${m.key}`), filterable: m.filterable }))} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default withIntl(MetricsPage, "app/t/[tenant]/dashboards/metrics/page.tsx");

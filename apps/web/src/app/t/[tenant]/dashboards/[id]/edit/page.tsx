import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { METRICS, availableWidgetTypes, canEditDashboard, canViewPage, isTenantRole, hullwiseTemplate, metricPages, type TenantRole } from "@hullwise/config";
import { basesLookup, customLabel, dashboardView, getDashboard, isSeriesRef } from "@hullwise/services";
import { PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { tenantCustoms } from "@/server/dashboards";
import { DashboardEditor, type MetricOption } from "@/components/dashboard/editor";

export default async function EditDashboardPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await ctx.run((tx) => getDashboard({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  // tenant and role dashboards need manage_dashboard; a personal one is its owner's (checked again by every action)
  if (!row || !canEditDashboard(ctx.role, ctx.user.id, row, ctx.settings.personalDashboards)) notFound();
  const view = dashboardView(row);
  const t = await getTranslations("dashboards");
  const customs = await tenantCustoms(ctx);
  const lookup = basesLookup(customs);
  const canSee = (ref: string) => metricPages(ref, lookup).every((p) => canViewPage(ctx.role, p));
  const metrics: MetricOption[] = [
    ...METRICS.filter((m) => canSee(m.key)).map((m) => ({ ref: m.key, label: t(`metrics.${m.key}`), group: m.group, series: m.series })),
    ...customs.filter((c) => canSee(`custom:${c.key}`)).map((c) => ({ ref: `custom:${c.key}`, label: customLabel(c, ctx.locale), group: "custom", series: isSeriesRef(`custom:${c.key}`, customs) })),
  ];
  const base = `/t/${tenant}`;
  const homeBack = row.isHome ? base : `${base}/dashboards/${row.id}`;
  return (
    <>
      <PageHeader eyebrow={t(`scope.${row.scope}`)} title={t("editor.title", { name: row.name })} description={t("editor.description")} />
      <DashboardEditor
        slug={tenant}
        id={row.id}
        name={row.name}
        scope={row.scope as "tenant" | "role" | "personal"}
        isHome={row.isHome}
        roles={row.roles.filter((r): r is TenantRole => isTenantRole(r))}
        period={view.settings.period}
        widgets={view.draft ?? view.widgets}
        hasDraft={view.draft !== null}
        availableTypes={availableWidgetTypes(ctx.activeAddons)}
        metrics={metrics}
        template={hullwiseTemplate(ctx.activeAddons)}
        previewPath={row.isHome ? base : `${base}/dashboards/${row.id}`}
        backPath={row.scope === "role" ? `${base}?as=${row.roles[0] ?? ""}` : homeBack}
      />
    </>
  );
}

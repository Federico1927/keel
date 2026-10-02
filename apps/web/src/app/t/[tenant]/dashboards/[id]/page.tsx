import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DASHBOARD_PERIODS, WIDGETS, canDo, canEditDashboard, canSeeDashboard, isTenantRole, type DashboardPeriod } from "@hullwise/config";
import { dashboardView, getDashboard } from "@hullwise/services";
import { Badge, Button, PageHeader } from "@hullwise/ui";
import { TenantHistoryImportBanner } from "@/components/integrations/history-import";
import { requirePage } from "@/server/tenant";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { DeleteDashboardButton, DuplicateButton, PeriodLinks, PreviewAsSelect, PreviewBanner } from "@/components/dashboard/controls";

export default async function DashboardViewPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant, id } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "dashboard");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await ctx.run((tx) => getDashboard({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  const personal = ctx.settings.personalDashboards;
  if (!row || !canSeeDashboard(ctx.role, ctx.user.id, row, personal)) notFound();
  const t = await getTranslations("dashboards");
  const tr = await getTranslations("roles");
  const view = dashboardView(row);
  const manager = canDo(ctx.role, "manage_dashboard");
  const editable = canEditDashboard(ctx.role, ctx.user.id, row, personal);
  const previewRole = manager && isTenantRole(sp.as) ? sp.as : null;
  const showDraft = editable && sp.draft === "1" && view.draft !== null;
  const widgets = showDraft ? view.draft! : view.widgets;
  const periodKey: DashboardPeriod = (DASHBOARD_PERIODS as readonly string[]).includes(sp.period ?? "") ? (sp.period as DashboardPeriod) : view.settings.period;
  const base = `/t/${tenant}`;
  const path = `/dashboards/${row.id}`;
  return (
    <>
      <PageHeader
        eyebrow={t(`scope.${row.scope}`)}
        title={row.name}
        description={row.scope === "personal" ? t("personal_description") : row.roles.length ? t("visible_to", { roles: row.roles.map((r) => (isTenantRole(r) ? tr(r) : r)).join(", ") }) : t("visible_all")}
        actions={
          <>
            {widgets.some((w) => WIDGETS[w.type]?.usesPeriod && !w.period) && <PeriodLinks base={base} path={path} current={periodKey} keep={{ as: previewRole ?? undefined, draft: showDraft ? "1" : undefined }} />}
            {view.draft && editable && <Badge variant="warning">{t("draft_badge")}</Badge>}
            {manager && row.scope !== "personal" && <PreviewAsSelect base={base} path={path} current={previewRole} draft={showDraft} />}
            {personal && row.scope !== "personal" && <DuplicateButton slug={tenant} id={row.id} name={row.name} />}
            {editable && <Button asChild size="sm" variant="outline"><Link href={`${base}${path}/edit`} data-testid="edit-dashboard">{t("edit")}</Link></Button>}
            {editable && !row.isHome && <DeleteDashboardButton slug={tenant} id={row.id} back={`${base}/dashboards`} />}
          </>
        }
      />
      <TenantHistoryImportBanner ctx={ctx} />
      {(previewRole || showDraft) && <PreviewBanner base={base} path={path} role={previewRole} draft={showDraft} name={null} />}
      <DashboardGrid ctx={ctx} widgets={widgets} periodKey={periodKey} role={previewRole ?? ctx.role} />
    </>
  );
}

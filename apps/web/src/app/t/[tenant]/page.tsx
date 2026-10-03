import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DASHBOARD_PERIODS, WIDGETS, canDo, isTenantRole, type DashboardPeriod } from "@hullwise/config";
import { dashboardSummary, resolveHomeDashboard } from "@hullwise/services";
import { Button, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant, pageNow, sharedMemo } from "@/server/dashboards";
import { Greeting } from "@/components/greeting";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { SourceHealthWidget } from "@/components/dashboard/source-health-widget";
import { HistoryImportBanner } from "@/components/history-import-banner";
import { CustomiseHomeButton, PeriodLinks, PreviewAsSelect, PreviewBanner } from "@/components/dashboard/controls";

import { withIntl } from "@/i18n/intl-scope";
/**
 * The tenant home (issue #43): the role's home variant, else the tenant home, else Hullwise's template,
 * which is today's home tile for tile. Managers can preview it as another role and see the draft.
 */
async function DashboardPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "dashboard");
  const t = await getTranslations("dashboard");
  const tdb = await getTranslations("dashboards");
  const manager = canDo(ctx.role, "manage_dashboard");
  const previewRole = manager && isTenantRole(sp.as) ? sp.as : null;
  const role = previewRole ?? ctx.role;
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const view = await ctx.run((tx) => resolveHomeDashboard(s(tx), role, ctx.activeAddons));
  const showDraft = manager && sp.draft === "1" && view.draft !== null;
  const widgets = showDraft ? view.draft! : view.widgets;
  const periodKey: DashboardPeriod = (DASHBOARD_PERIODS as readonly string[]).includes(sp.period ?? "") ? (sp.period as DashboardPeriod) : view.settings.period;
  const now = pageNow();
  // same memo key as the template tiles: the greeting and the tiles share one summary
  const summary = await sharedMemo(`summary|${ctx.tenant.id}|${Math.floor(now.getTime() / 60_000)}`, () => ctx.run((tx) => dashboardSummary(s(tx), analyticsTenant(ctx), now)));
  const base = `/t/${tenant}`;
  const followsPeriod = widgets.some((w) => WIDGETS[w.type]?.usesPeriod && !w.period);
  return (
    <>
      <Greeting user={ctx.user} tenantTimeZone={ctx.tenant.timezone} locale={ctx.locale} line={t("greeting_line", { count: summary.today.placed })} />
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={view.isTemplate ? t("description") : tdb("home_description")}
        actions={
          <>
            {followsPeriod && <PeriodLinks base={base} current={periodKey} keep={{ as: previewRole ?? undefined, draft: showDraft ? "1" : undefined }} />}
            <Button asChild variant="ghost" size="sm"><Link href={`${base}/dashboards`} data-testid="dashboards-link">{tdb("title")}</Link></Button>
            {manager && <PreviewAsSelect base={base} current={previewRole} draft={showDraft} />}
            {manager && (view.id ? <Button asChild size="sm" variant="outline"><Link href={`${base}/dashboards/${view.id}/edit`} data-testid="edit-home">{tdb("edit")}</Link></Button> : <CustomiseHomeButton slug={tenant} />)}
          </>
        }
      />
      {(previewRole || showDraft) && <PreviewBanner base={base} role={previewRole} draft={showDraft} name={view.isTemplate ? null : view.name} />}
      {/* integration sources that aren't OK (#32), above every home layout; hidden without integrations or for roles that can't open them */}
      <HistoryImportBanner ctx={ctx} />
      <div className="mb-6">
        <SourceHealthWidget ctx={ctx} />
      </div>
      <DashboardGrid ctx={ctx} widgets={widgets} periodKey={periodKey} role={role} />
    </>
  );
}

export default withIntl(DashboardPage, "app/t/[tenant]/page.tsx");

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo, isTenantRole } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { listDashboards, tenantHomeView, type DashboardView } from "@hullwise/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CreateDashboardForm, CustomiseHomeButton, DuplicateButton, PersonalToggle, ResetHomeButton } from "@/components/dashboard/controls";

import { withIntl } from "@/i18n/intl-scope";
/** The tenant's dashboards: the home (template or customised), role variants, extra dashboards and the user's personal copies. */
async function DashboardsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  const t = await getTranslations("dashboards");
  const tr = await getTranslations("roles");
  const manager = canDo(ctx.role, "manage_dashboard");
  const personal = ctx.settings.personalDashboards;
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const [home, list] = await ctx.run(async (tx) => [await tenantHomeView(s(tx), ctx.activeAddons), await listDashboards(s(tx), { role: ctx.role, userId: ctx.user.id, personalAllowed: personal })] as const);
  const base = `/t/${tenant}`;
  const roleNames = (roles: string[]) => roles.map((r) => (isTenantRole(r) ? tr(r) : r)).join(", ");
  const row = (d: DashboardView) => (
    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2" data-testid="dashboard-row">
      <div className="min-w-0">
        <Link href={`${base}/dashboards/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
        <p className="text-xs text-muted-foreground">{d.scope === "personal" ? t("personal_description") : d.roles.length ? t("visible_to", { roles: roleNames(d.roles) }) : t("visible_all")} · {t("widgets_n", { n: d.widgets.length })}{d.publishedAt ? ` · ${formatDateTime(d.publishedAt, ctx.locale, ctx.tenant.timezone)}` : ""}</p>
      </div>
      <div className="flex items-center gap-2">
        {d.draft && <Badge variant="warning">{t("draft_badge")}</Badge>}
        {(manager || d.scope === "personal") && <Button asChild size="sm" variant="outline"><Link href={`${base}/dashboards/${d.id}/edit`}>{t("edit")}</Link></Button>}
      </div>
    </li>
  );
  const variants = list.filter((d) => d.scope === "role");
  const extras = list.filter((d) => d.scope === "tenant" && !d.isHome);
  const mine = list.filter((d) => d.scope === "personal");
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} actions={manager ? <Button asChild size="sm" variant="outline"><Link href={`${base}/dashboards/metrics`} data-testid="metrics-link">{t("metrics_page")}</Link></Button> : undefined} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card data-testid="home-card">
            <CardHeader>
              <CardTitle className="text-base">{t("home")}</CardTitle>
              <CardDescription>{home.isTemplate ? t("home_template") : t("home_custom", { name: home.name })}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              {home.isTemplate ? <Badge variant="muted" data-testid="template-badge">{t("template_badge")}</Badge> : <Badge variant="info">{t("customised_badge")}</Badge>}
              <Button asChild size="sm" variant="ghost"><Link href={base}>{t("open")}</Link></Button>
              {manager && (home.id ? <Button asChild size="sm" variant="outline"><Link href={`${base}/dashboards/${home.id}/edit`}>{t("edit")}</Link></Button> : <CustomiseHomeButton slug={tenant} />)}
              {personal && <DuplicateButton slug={tenant} id={home.id} name={home.name || t("home_name")} />}
              {manager && !home.isTemplate && <ResetHomeButton slug={tenant} scope="tenant" />}
              {manager && (variants.length > 0 || !home.isTemplate) && <ResetHomeButton slug={tenant} scope="all" />}
            </CardContent>
          </Card>
          {manager && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("variants")}</CardTitle><CardDescription>{t("variants_description")}</CardDescription></CardHeader>
              <CardContent>{variants.length ? <ul className="space-y-2">{variants.map(row)}</ul> : <p className="text-sm text-muted-foreground">{t("variants_empty")}</p>}</CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="text-base">{t("extras")}</CardTitle><CardDescription>{t("extras_description")}</CardDescription></CardHeader>
            <CardContent>{extras.length ? <ul className="space-y-2">{extras.map(row)}</ul> : <p className="text-sm text-muted-foreground">{t("extras_empty")}</p>}</CardContent>
          </Card>
          {personal && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("personal")}</CardTitle><CardDescription>{t("personal_hint")}</CardDescription></CardHeader>
              <CardContent>{mine.length ? <ul className="space-y-2">{mine.map(row)}</ul> : <p className="text-sm text-muted-foreground">{t("personal_empty")}</p>}</CardContent>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          {(manager || personal) && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("new_dashboard")}</CardTitle></CardHeader>
              <CardContent><CreateDashboardForm slug={tenant} scopes={[...(manager ? (["tenant", "role"] as const) : []), ...(personal ? (["personal"] as const) : [])]} /></CardContent>
            </Card>
          )}
          {manager && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("settings")}</CardTitle></CardHeader>
              <CardContent className="space-y-2"><PersonalToggle slug={tenant} enabled={personal} /><p className="text-xs text-muted-foreground">{t("personal_toggle_hint")}</p></CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export default withIntl(DashboardsPage, "app/t/[tenant]/dashboards/page.tsx");

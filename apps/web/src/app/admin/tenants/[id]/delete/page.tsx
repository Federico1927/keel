import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { latestTenantDeletion, tenantDeletionPreview } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { DeleteTenantForm, DeletionRefresher, RetryDeletionButton } from "./controls";

import { withIntl } from "@/i18n/intl-scope";

/**
 * Deleting a tenant (danger zone of the console's tenant page): what will be deleted, the confirmations,
 * then the progress of the `tenant.delete` job. The page keeps working once the tenant is gone: the
 * deletion record outlives it.
 */
async function DeleteTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { db } = await requireSuperAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("privacy");
  const locale = await getLocale();
  const deletion = await latestTenantDeletion(db, id);
  const active = deletion && (deletion.status === "pending" || deletion.status === "running");
  const preview = deletion && deletion.status !== "failed" ? null : await tenantDeletionPreview(db, id);
  if (!deletion && !preview) notFound();
  const name = preview?.tenant.name ?? deletion!.name;
  const slug = preview?.tenant.slug ?? deletion!.slug;
  const tables = Object.entries(preview?.counts ?? deletion?.counts ?? {}).sort((a, b) => b[1] - a[1]);
  const total = tables.reduce((a, [, n]) => a + n, 0);
  const done = deletion?.steps.length ?? 0;
  const pct = deletion?.totalSteps ? Math.min(100, Math.round((done / deletion.totalSteps) * 100)) : 0;
  return (
    <>
      <PageHeader eyebrow={slug} title={t("delete.title", { name })} description={t("delete.description")} actions={preview ? <Link href={`/admin/tenants/${id}`} className="text-sm hover:underline">← {name}</Link> : <Link href="/admin/tenants" className="text-sm hover:underline">← {t("delete.back_tenants")}</Link>} />
      {deletion && (
        <Card className="mb-6" data-testid="deletion-status" data-status={deletion.status}>
          {active && <DeletionRefresher />}
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">{t("delete.progress")} <Badge variant={deletion.status === "done" ? "success" : deletion.status === "failed" ? "destructive" : "warning"}>{t(`delete.statuses.${deletion.status as "pending"}`)}</Badge></CardTitle>
            <CardDescription>{t("delete.requested_at", { date: formatDateTime(deletion.createdAt, locale, "UTC") })}{deletion.completedAt ? ` · ${t("delete.completed_at", { date: formatDateTime(deletion.completedAt, locale, "UTC") })}` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("delete.progress")}><div className="h-full bg-destructive transition-all" style={{ width: `${deletion.status === "done" ? 100 : pct}%` }} /></div>
            <p className="text-muted-foreground tabular">{t("delete.steps_done", { done, total: deletion.totalSteps })}</p>
            <ul className="space-y-1">
              {deletion.steps.filter((s) => !s.step.startsWith("table:")).map((s) => <li key={s.step} className="text-xs"><span className="font-medium">{t.has(`delete.step.${s.step}`) ? t(`delete.step.${s.step as "billing"}`) : s.step}</span>{s.note ? ` — ${s.note}` : ""}</li>)}
            </ul>
            {deletion.error && <p className="text-destructive" role="alert">{deletion.error}</p>}
            {deletion.status === "failed" && <RetryDeletionButton deletionId={deletion.id} />}
            {deletion.status === "done" && <p data-testid="deletion-done">{t("delete.done_note")}</p>}
          </CardContent>
        </Card>
      )}
      {preview && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("delete.what_title", { n: formatNumber(total, locale) })}</CardTitle>
              <CardDescription>{t("delete.what_description", { users: preview.usersOnlyHere })}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <DataList rows={tables.slice(0, 40)} rowKey={([n]) => n} rowProps={() => ({ "data-testid": "delete-count-row" })} columns={[
                { key: "table", header: t("delete.table"), mobile: "title", className: "font-mono text-xs", cell: ([n]) => n },
                { key: "rows", header: t("delete.rows"), mobile: "badge", align: "right", className: "tabular", cell: ([, c]) => formatNumber(c, locale) },
              ]} />
              {tables.length > 40 && <p className="p-3 text-xs text-muted-foreground">{t("delete.more_tables", { n: tables.length - 40 })}</p>}
            </CardContent>
          </Card>
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("delete.before_title")}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p data-testid="delete-export-state">{preview.exportDownloaded ? t("delete.export_downloaded") : preview.lastExport?.status === "done" ? t("delete.export_not_downloaded") : t("delete.export_none")} <Link href={`/admin/tenants/${id}#data-export`} className="text-primary hover:underline">{t("delete.export_link")}</Link></p>
                <p>{preview.integrations.length ? t("delete.integrations", { list: preview.integrations.map((i) => `${i.provider} (${i.mode})`).join(", ") }) : t("delete.no_integrations")}</p>
                <p>{preview.subscription?.externalSubscriptionId ? t("delete.subscription", { provider: preview.subscription.provider, status: preview.subscription.status }) : t("delete.no_subscription")}</p>
                {preview.isDemo && <p className="rounded-md bg-warning/15 px-3 py-2" data-testid="delete-demo-warning">{t("delete.demo_warning")}</p>}
              </CardContent>
            </Card>
            <Card className="border-destructive/50">
              <CardHeader><CardTitle className="text-base text-destructive">{t("delete.confirm_title")}</CardTitle><CardDescription>{t("delete.confirm_description")}</CardDescription></CardHeader>
              <CardContent><DeleteTenantForm tenantId={id} slug={preview.tenant.slug} isDemo={preview.isDemo} exportDownloaded={preview.exportDownloaded} /></CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

export default withIntl(DeleteTenantPage, "app/admin/tenants/[id]/delete/page.tsx");

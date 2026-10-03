import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@hullwise/db";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { integrationIssues } from "@hullwise/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Label, PageHeader, Select, Stat, DataList } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { queryHref } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";

import { withIntl } from "@/i18n/intl-scope";
/** Integration errors across tenants, per tenant and source (#48); "Open as support" leads to the tenant's own integrations page. */
async function AdminIntegrationsPage({ searchParams }: { searchParams: Promise<{ tenant?: string; source?: string; status?: string }> }) {
  const { db } = await requireSuperAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const status = sp.status === "error" || sp.status === "degraded" || sp.status === "stale" || sp.status === "idle" || sp.status === "all" ? sp.status : undefined;
  const source = sp.source && /^[a-z0-9_-]{1,40}$/.test(sp.source) ? sp.source : undefined;
  const [data, tenants] = await Promise.all([integrationIssues(db, { tenantId: sp.tenant, source, status }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  const current = { tenant: sp.tenant, source, status };
  const drop = (k: string) => queryHref("/admin/integrations", current, { [k]: undefined });
  const chips: AdminFilterChip[] = [
    ...(sp.tenant ? [{ key: "tenant", label: tenants.find((x) => x.id === sp.tenant)?.name ?? t("tenants.columns.tenant"), href: drop("tenant") }] : []),
    ...(source ? [{ key: "source", label: source, href: drop("source") }] : []),
    ...(status ? [{ key: "status", label: status === "all" ? t("integrations.status_all") : status, href: drop("status") }] : []),
  ];
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("integrations.title")} description={t("integrations.description")} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("integrations.sources_in_error")} value={formatNumber(data.rows.length, locale)} />
        <Stat label={t("integrations.failed_webhooks")} value={formatNumber(data.failedWebhooks, locale)} />
        <Stat label={t("integrations.failed_writes")} value={formatNumber(data.failedWrites, locale)} />
      </div>
      <AdminFilters chips={chips}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" method="get" action="/admin/integrations">
          <div className="space-y-1.5">
            <Label htmlFor="i-tenant">{t("tenants.columns.tenant")}</Label>
            <Select id="i-tenant" name="tenant" defaultValue={sp.tenant ?? ""}>
              <option value="">{t("filters.all")}</option>
              {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-source">{t("integrations.source")}</Label>
            <Select id="i-source" name="source" defaultValue={source ?? ""}>
              <option value="">{t("filters.all")}</option>
              {data.sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-status">{t("integrations.status")}</Label>
            <Select id="i-status" name="status" defaultValue={status ?? ""}>
              <option value="">{t("integrations.status_problems")}</option>
              <option value="error">error</option>
              <option value="degraded">degraded</option>
              <option value="stale">stale</option>
              <option value="idle">idle</option>
              <option value="all">{t("integrations.status_all")}</option>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {(sp.tenant || source || status) && <Button variant="outline" asChild><Link href="/admin/integrations">{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <Card>
        <CardContent className="p-0">
          {data.rows.length === 0 ? <EmptyState title={t("integrations.empty")} /> : (
            <DataList
              rows={data.rows}
              rowKey={({ health: h }) => h.id}
              rowProps={() => ({ "data-testid": "integration-issue" })}
              columns={[
                { key: "tenant", header: t("tenants.columns.tenant"), mobile: "title", cell: ({ health: h, tenantName }) => <Link href={`/admin/tenants/${h.tenantId}`} className="font-medium hover:underline">{tenantName}</Link> },
                { key: "source", header: t("integrations.source"), mobile: "subtitle", className: "font-mono text-xs", cell: ({ health: h }) => h.source },
                { key: "status", header: t("integrations.status"), mobile: "badge", cell: ({ health: h }) => <><Badge variant={h.status === "error" || h.status === "stale" ? "destructive" : h.status === "degraded" || h.status === "idle" ? "warning" : "muted"}>{h.status}</Badge>{h.consecutiveFailures > 0 && <div className="text-xs text-muted-foreground max-md:hidden">{t("integrations.failures", { n: h.consecutiveFailures })}</div>}</> },
                { key: "last_success", header: t("integrations.last_success"), priority: 2, className: "text-xs", cell: ({ health: h }) => (h.lastSuccessAt ? formatDateTime(h.lastSuccessAt, locale, "UTC") : "—") },
                { key: "error", header: t("integrations.error"), mobile: "subtitle", className: "break-words text-xs text-destructive md:max-w-[28rem]", cell: ({ health: h }) => <>{h.lastError ?? "—"}{h.consecutiveFailures > 0 && <span className="block text-muted-foreground md:hidden">{t("integrations.failures", { n: h.consecutiveFailures })}</span>}</> },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("integrations.failed_runs")}</CardTitle><CardDescription>{t("integrations.failed_runs_hint")}</CardDescription></CardHeader>
        <CardContent>
          {data.runs.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
            <ul className="space-y-1 text-sm">{data.runs.map(({ run: r, tenantName }) => <li key={r.id} className="flex flex-wrap gap-2"><span className="text-xs text-muted-foreground tabular">{formatDateTime(r.startedAt, locale, "UTC")}</span><span className="font-medium">{tenantName}</span><span className="font-mono text-xs">{r.provider}/{r.objectType} · {r.kind}</span><span className="text-xs text-destructive">{r.error ?? ""}</span></li>)}</ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminIntegrationsPage, "app/admin/integrations/page.tsx");

import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@hullwise/db";
import { FAILURE_ALERT_WINDOW_HOURS, JOB_FAILURES_BEFORE_ALERT } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { exportStates, listPlatformAlerts } from "@hullwise/services";
import { Badge, Button, Card, CardContent, EmptyState, Label, PageHeader, Select, Stat, DataList } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";

import { withIntl } from "@/i18n/intl-scope";
const KINDS = ["job_failure", "sync_stale", "compliance_request"] as const;
import { CloseAlertButton } from "./controls";
import { RebuildCustomerExportButton } from "@/components/privacy/controls";

/** Platform failure alerts (#32): jobs failing N times in a row and sources without a success in their window. */
async function AdminAlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const status = query.status === "resolved" || query.status === "all" ? query.status : "open";
  const [data, tenants] = await Promise.all([listPlatformAlerts(db, { status: status === "all" ? undefined : status, kind: query.kind, tenantId: query.tenant }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  const tpv = await getTranslations("privacy");
  const exportIdOf = (meta: unknown) => (typeof (meta as { exportId?: unknown } | null)?.exportId === "string" ? ((meta as { exportId: string }).exportId) : null);
  const exports = await exportStates(db, data.rows.flatMap(({ alert: a }) => (a.kind === "compliance_request" && exportIdOf(a.meta) ? [exportIdOf(a.meta)!] : [])));
  const now = new Date();
  /** The data package a customers/data_request task points at: download while valid, rebuild once expired or failed. */
  const packageCell = (a: (typeof data.rows)[number]["alert"]) => {
    if (a.kind !== "compliance_request" || !a.subject.includes("customers/data_request") || !a.tenantId) return null;
    const exportId = exportIdOf(a.meta);
    const state = exportId ? exports.get(exportId) : undefined;
    const valid = state?.status === "done" && (!state.expiresAt || state.expiresAt > now);
    return (
      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs font-normal" data-testid="compliance-package">
        {valid ? <a href={`/admin/tenants/${a.tenantId}/data-export/${exportId}`} className="text-primary hover:underline" data-testid="compliance-package-download">{tpv("task.download", { date: formatDateTime(state.expiresAt!, locale, "UTC") })}</a> : state && (state.status === "pending" || state.status === "running") ? <span className="text-muted-foreground">{tpv("task.preparing")}</span> : <>{state && <span className="text-muted-foreground">{tpv(state.status === "failed" ? "task.failed" : "task.expired")}</span>}<RebuildCustomerExportButton alertId={a.id} /></>}
      </span>
    );
  };
  const drop = (k: string) => queryHref("/admin/alerts", query, { [k]: undefined });
  const chips: AdminFilterChip[] = [
    ...(status !== "open" ? [{ key: "status", label: t(`alerts.statuses.${status}`), href: drop("status") }] : []),
    ...((KINDS as readonly string[]).includes(query.kind ?? "") ? [{ key: "kind", label: t(`alerts.kinds.${query.kind as (typeof KINDS)[number]}`), href: drop("kind") }] : []),
    ...(query.tenant ? [{ key: "tenant", label: query.tenant === "platform" ? t("audit.platform") : (tenants.find((x) => x.id === query.tenant)?.name ?? t("tenants.columns.tenant")), href: drop("tenant") }] : []),
  ];
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("alerts.title")} description={t("alerts.description", { n: JOB_FAILURES_BEFORE_ALERT, hours: FAILURE_ALERT_WINDOW_HOURS })} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("alerts.open")} value={formatNumber(data.counts.open, locale)} href="/admin/alerts?status=open" />
        <Stat label={t("alerts.kinds.job_failure")} value={formatNumber(data.counts.jobs, locale)} href="/admin/alerts?status=open&kind=job_failure" />
        <Stat label={t("alerts.kinds.sync_stale")} value={formatNumber(data.counts.stale, locale)} href="/admin/alerts?status=open&kind=sync_stale" />
      </div>
      <AdminFilters chips={chips}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" method="get" action="/admin/alerts">
          <div className="space-y-1.5">
            <Label htmlFor="al-status">{t("alerts.status")}</Label>
            <Select id="al-status" name="status" defaultValue={status}>
              {(["open", "resolved", "all"] as const).map((s) => <option key={s} value={s}>{t(`alerts.statuses.${s}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="al-kind">{t("alerts.kind")}</Label>
            <Select id="al-kind" name="kind" defaultValue={query.kind ?? ""}>
              <option value="">{t("filters.all")}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(`alerts.kinds.${k}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="al-tenant">{t("tenants.columns.tenant")}</Label>
            <Select id="al-tenant" name="tenant" defaultValue={query.tenant ?? ""}>
              <option value="">{t("filters.all")}</option>
              <option value="platform">{t("audit.platform")}</option>
              {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {(query.kind || query.tenant || query.status) && <Button variant="outline" asChild><Link href="/admin/alerts">{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <Card>
        <CardContent className="p-0">
          {data.rows.length === 0 ? <EmptyState title={t("alerts.empty_title")} description={t("alerts.empty_description")} /> : (
            <DataList
              rows={data.rows}
              rowKey={({ alert: a }) => a.id}
              rowProps={({ alert: a }) => ({ "data-testid": "alert-row", "data-kind": a.kind, "data-status": a.status })}
              columns={[
                { key: "subject", header: t("alerts.subject"), mobile: "title", cell: ({ alert: a }) => <>
                  <Badge variant={a.status === "open" ? (a.kind === "job_failure" ? "destructive" : "warning") : "muted"} className="max-md:hidden">{t(`alerts.kinds.${a.kind as "job_failure"}`)}</Badge>
                  {a.kind === "compliance_request" ? <span className="break-all font-mono text-xs md:ml-2">{a.subject}</span> : <Link href={a.kind === "job_failure" ? queryHref("/admin/jobs", {}, { type: a.subject, tenant: a.tenantId ?? "platform" }) : queryHref("/admin/integrations", {}, { tenant: a.tenantId ?? undefined, source: a.subject.split(":")[0], status: "all" })} className="break-all font-mono text-xs hover:underline md:ml-2">{a.subject}</Link>}
                  {a.lastError && <p className="truncate text-xs font-normal text-destructive md:max-w-[28rem]" title={a.lastError}>{a.lastError}</p>}
                  {packageCell(a)}
                </> },
                { key: "kind", header: null, mobile: "badge", className: "md:hidden", headClassName: "md:hidden", cell: ({ alert: a }) => <Badge variant={a.status === "open" ? (a.kind === "job_failure" ? "destructive" : "warning") : "muted"}>{t(`alerts.kinds.${a.kind as "job_failure"}`)}</Badge> },
                { key: "tenant", header: t("tenants.columns.tenant"), className: "text-sm", cell: ({ alert: a, tenantName }) => (a.tenantId ? <Link href={`/admin/tenants/${a.tenantId}`} className="hover:underline">{tenantName}</Link> : <span className="text-muted-foreground">{t("audit.platform")}</span>) },
                { key: "last_seen", header: t("alerts.last_seen"), className: "text-xs", cell: ({ alert: a }) => <><span className="whitespace-nowrap">{formatDateTime(a.lastSeenAt, locale, "UTC")}</span><span className="block text-muted-foreground max-md:inline max-md:before:content-['_·_']">{t("alerts.since", { date: formatDateTime(a.firstSeenAt, locale, "UTC") })}</span></> },
                { key: "occurrences", header: t("alerts.occurrences"), align: "right", priority: 2, className: "tabular", cell: ({ alert: a }) => a.occurrences },
                { key: "notified", header: t("alerts.notified"), priority: 3, className: "text-xs text-muted-foreground", cell: ({ alert: a }) => (a.lastNotifiedAt ? t("alerts.notified_at", { n: a.notifiedCount, date: formatDateTime(a.lastNotifiedAt, locale, "UTC") }) : "—") },
                { key: "close", header: <span className="sr-only">{t("alerts.close")}</span>, mobile: "action", align: "right", cell: ({ alert: a }) => (a.status === "open" ? <CloseAlertButton alertId={a.id} /> : <span className="text-xs text-muted-foreground">{a.resolvedAt ? formatDateTime(a.resolvedAt, locale, "UTC") : ""}</span>) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminAlertsPage, "app/admin/alerts/page.tsx");

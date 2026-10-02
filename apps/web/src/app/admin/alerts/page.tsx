import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@keel/db";
import { FAILURE_ALERT_WINDOW_HOURS, JOB_FAILURES_BEFORE_ALERT } from "@keel/config";
import { formatDateTime, formatNumber } from "@keel/core";
import { listPlatformAlerts } from "@keel/services";
import { Badge, Button, Card, CardContent, EmptyState, Label, PageHeader, Select, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";
import { CloseAlertButton } from "./controls";

/** Platform failure alerts (#32): jobs failing N times in a row and sources without a success in their window. */
export default async function AdminAlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const status = query.status === "resolved" || query.status === "all" ? query.status : "open";
  const [data, tenants] = await Promise.all([listPlatformAlerts(db, { status: status === "all" ? undefined : status, kind: query.kind, tenantId: query.tenant }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("alerts.title")} description={t("alerts.description", { n: JOB_FAILURES_BEFORE_ALERT, hours: FAILURE_ALERT_WINDOW_HOURS })} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("alerts.open")} value={formatNumber(data.counts.open, locale)} href="/admin/alerts?status=open" />
        <Stat label={t("alerts.kinds.job_failure")} value={formatNumber(data.counts.jobs, locale)} href="/admin/alerts?status=open&kind=job_failure" />
        <Stat label={t("alerts.kinds.sync_stale")} value={formatNumber(data.counts.stale, locale)} href="/admin/alerts?status=open&kind=sync_stale" />
      </div>
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" method="get" action="/admin/alerts">
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
            {(["job_failure", "sync_stale"] as const).map((k) => <option key={k} value={k}>{t(`alerts.kinds.${k}`)}</option>)}
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
          <Button type="submit">{t("filters.apply")}</Button>
          {(query.kind || query.tenant || query.status) && <Button variant="outline" asChild><Link href="/admin/alerts">{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <Card>
        <CardContent className="p-0">
          {data.rows.length === 0 ? <EmptyState title={t("alerts.empty_title")} description={t("alerts.empty_description")} /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("alerts.subject")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("tenants.columns.tenant")}</TableHead>
                  <TableHead>{t("alerts.last_seen")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("alerts.occurrences")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("alerts.notified")}</TableHead>
                  <TableHead className="text-right"><span className="sr-only">{t("alerts.close")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map(({ alert: a, tenantName }) => (
                  <TableRow key={a.id} data-testid="alert-row" data-kind={a.kind} data-status={a.status}>
                    <TableCell>
                      <Badge variant={a.status === "open" ? (a.kind === "job_failure" ? "destructive" : "warning") : "muted"}>{t(`alerts.kinds.${a.kind as "job_failure"}`)}</Badge>
                      <Link href={a.kind === "job_failure" ? queryHref("/admin/jobs", {}, { type: a.subject, tenant: a.tenantId ?? "platform" }) : queryHref("/admin/integrations", {}, { tenant: a.tenantId ?? undefined, source: a.subject.split(":")[0], status: "all" })} className="ml-2 font-mono text-xs hover:underline">{a.subject}</Link>
                      {a.lastError && <p className="max-w-[28rem] truncate text-xs text-destructive" title={a.lastError}>{a.lastError}</p>}
                    </TableCell>
                    <TableCell className="hidden text-sm sm:table-cell">{a.tenantId ? <Link href={`/admin/tenants/${a.tenantId}`} className="hover:underline">{tenantName}</Link> : <span className="text-muted-foreground">{t("audit.platform")}</span>}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(a.lastSeenAt, locale, "UTC")}<span className="block text-muted-foreground">{t("alerts.since", { date: formatDateTime(a.firstSeenAt, locale, "UTC") })}</span></TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{a.occurrences}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{a.lastNotifiedAt ? t("alerts.notified_at", { n: a.notifiedCount, date: formatDateTime(a.lastNotifiedAt, locale, "UTC") }) : "—"}</TableCell>
                    <TableCell className="text-right">{a.status === "open" ? <CloseAlertButton alertId={a.id} /> : <span className="text-xs text-muted-foreground">{a.resolvedAt ? formatDateTime(a.resolvedAt, locale, "UTC") : ""}</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

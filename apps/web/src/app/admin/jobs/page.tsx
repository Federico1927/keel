import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@hullwise/db";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { jobRunsOverview } from "@hullwise/services";
import { runNowJob } from "@hullwise/jobs";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Label, PageHeader, Pagination, Select, DataList } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";
import { RunNowButton } from "./controls";

import { withIntl } from "@/i18n/intl-scope";
const STATUS_VARIANT = { succeeded: "success", failed: "destructive", running: "info" } as const;
const STATUSES = ["failed", "succeeded", "running"] as const;

function duration(ms: number | null, locale: string): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${formatNumber(ms, locale)} ms` : `${formatNumber(Math.round(ms / 100) / 10, locale)} s`;
}

/** Job run history (#32): the latest run per job type and tenant with "run now", and every run with filters. */
async function AdminJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const page = Math.max(1, Number(query.page) || 1);
  const [data, tenants] = await Promise.all([jobRunsOverview(db, { jobType: query.type, tenantId: query.tenant, status: query.status, page }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  const filtered = Boolean(query.type || query.tenant || query.status);
  const drop = (k: string) => queryHref("/admin/jobs", query, { [k]: undefined, page: undefined });
  const chips: AdminFilterChip[] = [
    ...(query.type ? [{ key: "type", label: query.type, href: drop("type") }] : []),
    ...(query.tenant ? [{ key: "tenant", label: query.tenant === "platform" ? t("audit.platform") : (tenants.find((x) => x.id === query.tenant)?.name ?? t("tenants.columns.tenant")), href: drop("tenant") }] : []),
    ...((STATUSES as readonly string[]).includes(query.status ?? "") ? [{ key: "status", label: t(`jobs.statuses.${query.status as (typeof STATUSES)[number]}`), href: drop("status") }] : []),
  ];
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("jobs.title")} description={t("jobs.description")} />
      <AdminFilters chips={chips}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" method="get" action="/admin/jobs">
          <div className="space-y-1.5">
            <Label htmlFor="j-type">{t("jobs.job_type")}</Label>
            <Select id="j-type" name="type" defaultValue={query.type ?? ""}>
              <option value="">{t("filters.all")}</option>
              {data.jobTypes.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="j-tenant">{t("tenants.columns.tenant")}</Label>
            <Select id="j-tenant" name="tenant" defaultValue={query.tenant ?? ""}>
              <option value="">{t("filters.all")}</option>
              <option value="platform">{t("audit.platform")}</option>
              {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="j-status">{t("jobs.status")}</Label>
            <Select id="j-status" name="status" defaultValue={query.status ?? ""}>
              <option value="">{t("filters.all")}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`jobs.statuses.${s}`)}</option>)}
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {filtered && <Button variant="outline" asChild><Link href="/admin/jobs">{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <Card className="mb-6" data-testid="jobs-latest">
        <CardHeader>
          <CardTitle className="text-base">{t("jobs.latest")}</CardTitle>
          <CardDescription>{t("jobs.latest_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.latest.length === 0 ? <EmptyState title={t("jobs.empty_title")} description={t("jobs.empty_description")} /> : (
            <DataList
              rows={data.latest}
              rowKey={({ run: r }) => `${r.jobType}:${r.tenantId ?? "platform"}`}
              rowProps={({ run: r }) => ({ "data-testid": "job-latest-row", "data-job": r.jobType })}
              columns={[
                { key: "type", header: t("jobs.job_type"), mobile: "title", className: "font-mono text-xs", cell: ({ run: r }) => <Link href={queryHref("/admin/jobs", {}, { type: r.jobType, tenant: r.tenantId ?? "platform" })} className="break-all hover:underline">{r.jobType}</Link> },
                { key: "tenant", header: t("tenants.columns.tenant"), mobile: "subtitle", className: "text-sm", cell: ({ tenantName }) => tenantName ?? <span className="text-muted-foreground">{t("audit.platform")}</span> },
                { key: "last", header: t("jobs.last_run"), mobile: "subtitle", className: "text-sm", cell: ({ run: r }) => <>
                  <Badge variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "muted"}>{t(`jobs.statuses.${r.status as "failed"}`)}</Badge>
                  <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.startedAt, locale, "UTC")} · {duration(r.durationMs, locale)}</span>
                  {r.error && <p className="truncate text-xs text-destructive md:max-w-[28rem]" title={r.error}>{r.error}</p>}
                </> },
                { key: "failed", header: t("jobs.failed_24h"), align: "right", priority: 2, cell: ({ failed24h }) => <span className={`tabular ${failed24h > 0 ? "text-destructive" : ""}`}>{failed24h}</span> },
                { key: "run", header: <span className="sr-only">{t("jobs.run_now")}</span>, mobile: "action", align: "right", cell: ({ run: r }) => (runNowJob(r.jobType, r.tenantId) ? <RunNowButton jobType={r.jobType} tenantId={r.tenantId} /> : null) },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t("jobs.history")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={data.rows}
            rowKey={({ run: r }) => r.id}
            rowProps={({ run: r }) => ({ "data-testid": "job-run-row", "data-status": r.status })}
            columns={[
              { key: "started", header: t("jobs.started"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: ({ run: r }) => formatDateTime(r.startedAt, locale, "UTC") },
              { key: "type", header: t("jobs.job_type"), mobile: "title", className: "break-all font-mono text-xs", cell: ({ run: r }) => r.jobType },
              { key: "tenant", header: t("tenants.columns.tenant"), className: "text-xs", cell: ({ tenantName }) => tenantName ?? "—" },
              { key: "status", header: t("jobs.status"), mobile: "badge", cell: ({ run: r }) => <><Badge variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "muted"}>{t(`jobs.statuses.${r.status as "failed"}`)}</Badge>{r.error && <p className="max-w-[20rem] truncate text-xs text-destructive max-md:hidden" title={r.error}>{r.error}</p>}</> },
              // the error under the card's title on phones (in the status cell on wider screens)
              { key: "error", header: null, mobile: "subtitle", className: "md:hidden", headClassName: "md:hidden", cell: ({ run: r }) => (r.error ? <p className="truncate text-xs text-destructive" title={r.error}>{r.error}</p> : null) },
              { key: "duration", header: t("jobs.duration"), align: "right", priority: 2, className: "text-xs tabular", cell: ({ run: r }) => duration(r.durationMs, locale) },
              { key: "rows", header: t("jobs.rows"), align: "right", priority: 2, className: "text-xs tabular", cell: ({ run: r }) => (r.rows === null ? "—" : formatNumber(r.rows, locale)) },
              { key: "trigger", header: t("jobs.trigger"), priority: 3, className: "text-xs", cell: ({ run: r, requestedByEmail }) => `${t(`jobs.triggers.${r.trigger as "queue"}`)}${requestedByEmail ? ` · ${requestedByEmail}` : ""}` },
            ]}
          />
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => queryHref("/admin/jobs", query, { page: String(p) })} summary={t("audit.summary", { from: data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1, to: Math.min(data.page * data.pageSize, data.total), total: data.total })} />
    </>
  );
}

export default withIntl(AdminJobsPage, "app/admin/jobs/page.tsx");

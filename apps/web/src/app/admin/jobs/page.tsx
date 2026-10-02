import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@keel/db";
import { formatDateTime, formatNumber } from "@keel/core";
import { jobRunsOverview } from "@keel/services";
import { runNowJob } from "@keel/jobs";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Label, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { flatParams, queryHref } from "../_components/table-query";
import { RunNowButton } from "./controls";

const STATUS_VARIANT = { succeeded: "success", failed: "destructive", running: "info" } as const;

function duration(ms: number | null, locale: string): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${formatNumber(ms, locale)} ms` : `${formatNumber(Math.round(ms / 100) / 10, locale)} s`;
}

/** Job run history (#32): the latest run per job type and tenant with "run now", and every run with filters. */
export default async function AdminJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const page = Math.max(1, Number(query.page) || 1);
  const [data, tenants] = await Promise.all([jobRunsOverview(db, { jobType: query.type, tenantId: query.tenant, status: query.status, page }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  const filtered = Boolean(query.type || query.tenant || query.status);
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("jobs.title")} description={t("jobs.description")} />
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" method="get" action="/admin/jobs">
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
            {(["failed", "succeeded", "running"] as const).map((s) => <option key={s} value={s}>{t(`jobs.statuses.${s}`)}</option>)}
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {filtered && <Button variant="outline" asChild><Link href="/admin/jobs">{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <Card className="mb-6" data-testid="jobs-latest">
        <CardHeader>
          <CardTitle className="text-base">{t("jobs.latest")}</CardTitle>
          <CardDescription>{t("jobs.latest_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.latest.length === 0 ? <EmptyState title={t("jobs.empty_title")} description={t("jobs.empty_description")} /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("jobs.job_type")}</TableHead>
                  <TableHead>{t("tenants.columns.tenant")}</TableHead>
                  <TableHead>{t("jobs.last_run")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("jobs.failed_24h")}</TableHead>
                  <TableHead className="text-right"><span className="sr-only">{t("jobs.run_now")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.latest.map(({ run: r, tenantName, failed24h }) => (
                  <TableRow key={`${r.jobType}:${r.tenantId ?? "platform"}`} data-testid="job-latest-row" data-job={r.jobType}>
                    <TableCell className="font-mono text-xs"><Link href={queryHref("/admin/jobs", {}, { type: r.jobType, tenant: r.tenantId ?? "platform" })} className="hover:underline">{r.jobType}</Link></TableCell>
                    <TableCell className="text-sm">{tenantName ?? <span className="text-muted-foreground">{t("audit.platform")}</span>}</TableCell>
                    <TableCell className="text-sm">
                      <Badge variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "muted"}>{t(`jobs.statuses.${r.status as "failed"}`)}</Badge>
                      <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.startedAt, locale, "UTC")} · {duration(r.durationMs, locale)}</span>
                      {r.error && <p className="max-w-[28rem] truncate text-xs text-destructive" title={r.error}>{r.error}</p>}
                    </TableCell>
                    <TableCell className={`hidden text-right tabular md:table-cell ${failed24h > 0 ? "text-destructive" : ""}`}>{failed24h}</TableCell>
                    <TableCell className="text-right">{runNowJob(r.jobType, r.tenantId) ? <RunNowButton jobType={r.jobType} tenantId={r.tenantId} /> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t("jobs.history")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("jobs.started")}</TableHead>
                <TableHead>{t("jobs.job_type")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("tenants.columns.tenant")}</TableHead>
                <TableHead>{t("jobs.status")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("jobs.duration")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("jobs.rows")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("jobs.trigger")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map(({ run: r, tenantName, requestedByEmail }) => (
                <TableRow key={r.id} data-testid="job-run-row" data-status={r.status}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.startedAt, locale, "UTC")}</TableCell>
                  <TableCell className="font-mono text-xs">{r.jobType}</TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">{tenantName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "muted"}>{t(`jobs.statuses.${r.status as "failed"}`)}</Badge>
                    {r.error && <p className="max-w-[20rem] truncate text-xs text-destructive" title={r.error}>{r.error}</p>}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs tabular md:table-cell">{duration(r.durationMs, locale)}</TableCell>
                  <TableCell className="hidden text-right text-xs tabular md:table-cell">{r.rows === null ? "—" : formatNumber(r.rows, locale)}</TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">{t(`jobs.triggers.${r.trigger as "queue"}`)}{requestedByEmail ? ` · ${requestedByEmail}` : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => queryHref("/admin/jobs", query, { page: String(p) })} summary={t("audit.summary", { from: data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1, to: Math.min(data.page * data.pageSize, data.total), total: data.total })} />
    </>
  );
}

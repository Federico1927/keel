import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { listMyExports } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { getTenantContext } from "@/server/tenant";
import { AutoRefresh } from "@/components/lists/auto-refresh";

import { withIntl } from "@/i18n/intl-scope";
/** The signed-in user's CSV exports that ran in the background; files are only ever shown to their owner. */
async function ExportsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ queued?: string }> }) {
  const { tenant } = await params;
  const { queued } = await searchParams;
  const ctx = await getTenantContext(tenant);
  const t = await getTranslations("lists");
  const rows = await ctx.run((tx) => listMyExports({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id));
  const pending = rows.some((r) => r.status === "pending" || r.status === "running");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("exports.title")} description={t("exports.description")} />
      {pending && <AutoRefresh seconds={3} />}
      {queued && (
        <Alert className="mb-4" data-testid="export-queued">
          <AlertDescription>{t("exports.queued")}</AlertDescription>
        </Alert>
      )}
      {rows.length === 0 ? (
        <EmptyState title={t("exports.empty_title")} description={t("exports.empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "export-row", "data-status": r.status })}
              columns={[
                { key: "list", header: t("exports.list"), mobile: "title", cell: (r) => <><Link href={`/t/${tenant}/${r.list}${r.query ? `?${r.query}` : ""}`} className="font-medium text-primary hover:underline">{t(`names.${r.list}`)}</Link>{r.query && <p className="max-w-[16rem] truncate text-xs font-normal text-muted-foreground">{r.query}</p>}</> },
                { key: "status", header: t("exports.status"), mobile: "badge", cell: (r) => <><Badge variant={r.status === "done" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{t(`exports.statuses.${r.status}`)}</Badge>{r.error && <p className="text-xs text-destructive">{r.error}</p>}</> },
                { key: "requested", header: t("exports.requested"), mobile: "subtitle", className: "whitespace-nowrap text-sm text-muted-foreground", cell: (r) => formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone) },
                { key: "rows", header: t("exports.rows"), align: "right", className: "tabular", cell: (r) => (r.rowCount === null ? "—" : formatNumber(r.rowCount, ctx.locale)) },
                { key: "file", header: t("exports.file"), mobile: "action", align: "right", cell: (r) => (r.status === "done" ? <a href={`/t/${tenant}/exports/${r.id}`} className="text-sm text-primary hover:underline max-md:inline-flex max-md:min-h-9 max-md:items-center" data-testid="export-download">{t("exports.download")}</a> : <span className="max-md:hidden">—</span>) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(ExportsPage, "app/t/[tenant]/exports/page.tsx");

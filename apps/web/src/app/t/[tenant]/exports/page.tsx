import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@keel/core";
import { listMyExports } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { getTenantContext } from "@/server/tenant";
import { AutoRefresh } from "@/components/lists/auto-refresh";

/** The signed-in user's CSV exports that ran in the background; files are only ever shown to their owner. */
export default async function ExportsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ queued?: string }> }) {
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("exports.list")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("exports.requested")}</TableHead>
                  <TableHead>{t("exports.status")}</TableHead>
                  <TableHead className="text-right">{t("exports.rows")}</TableHead>
                  <TableHead className="text-right">{t("exports.file")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="export-row" data-status={r.status}>
                    <TableCell>
                      <Link href={`/t/${tenant}/${r.list}${r.query ? `?${r.query}` : ""}`} className="font-medium text-primary hover:underline">{t(`names.${r.list}`)}</Link>
                      {r.query && <p className="max-w-[16rem] truncate text-xs text-muted-foreground">{r.query}</p>}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell">{formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "done" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{t(`exports.statuses.${r.status}`)}</Badge>
                      {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                    </TableCell>
                    <TableCell className="text-right tabular">{r.rowCount === null ? "—" : formatNumber(r.rowCount, ctx.locale)}</TableCell>
                    <TableCell className="text-right">{r.status === "done" ? <a href={`/t/${tenant}/exports/${r.id}`} className="text-sm text-primary hover:underline" data-testid="export-download">{t("exports.download")}</a> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

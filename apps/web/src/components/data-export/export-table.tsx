import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import type { listTenantExports } from "@hullwise/services";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";

type Row = Awaited<ReturnType<typeof listTenantExports>>[number];

function size(bytes: number | null, locale: string): string {
  if (!bytes) return "—";
  return bytes >= 1_048_576 ? `${formatNumber(Math.round((bytes / 1_048_576) * 10) / 10, locale)} MB` : `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`;
}

/** Tenant data exports with status, size, expiry and the download link while it is valid (owner page and console). */
export async function DataExportTable({ rows, locale, timezone, hrefFor, now = new Date() }: { rows: Row[]; locale: string; timezone: string; hrefFor: (id: string) => string; now?: Date }) {
  const t = await getTranslations("data_export");
  if (rows.length === 0) return <EmptyState title={t("empty_title")} description={t("empty_description")} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.requested")}</TableHead>
          <TableHead>{t("columns.status")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("columns.rows")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("columns.expires")}</TableHead>
          <TableHead className="text-right">{t("columns.file")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const expired = r.status === "expired" || (r.status === "done" && r.expiresAt !== null && r.expiresAt <= now);
          const status = expired ? "expired" : r.status;
          return (
            <TableRow key={r.id} data-testid="data-export-row" data-status={status}>
              <TableCell className="text-sm">
                <span className="whitespace-nowrap">{formatDateTime(r.createdAt, locale, timezone)}</span>
                <span className="block text-xs text-muted-foreground">{r.requestedByType === "super_admin" ? t("by_platform") : (r.requestedByEmail ?? "—")}</span>
              </TableCell>
              <TableCell>
                <Badge variant={status === "done" ? "success" : status === "failed" ? "destructive" : status === "expired" ? "muted" : "secondary"}>{t(`statuses.${status}`)}</Badge>
                {r.error && <p className="text-xs text-destructive">{r.error}</p>}
              </TableCell>
              <TableCell className="hidden text-right text-sm tabular sm:table-cell">
                {r.rowCount === null ? "—" : formatNumber(r.rowCount, locale)}
                {r.rowCount !== null && <span className="block text-xs text-muted-foreground">{t("tables_n", { n: Object.keys(r.tables as object).length })} · {size(r.sizeBytes, locale)}</span>}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">{r.expiresAt ? formatDateTime(r.expiresAt, locale, timezone) : "—"}</TableCell>
              <TableCell className="text-right">
                {status === "done" ? <a href={hrefFor(r.id)} className="text-sm text-primary hover:underline" data-testid="data-export-download">{t("download")}</a> : <span className="text-sm text-muted-foreground">—</span>}
                {r.downloadCount > 0 && <span className="block text-xs text-muted-foreground">{t("downloads", { n: r.downloadCount })}</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

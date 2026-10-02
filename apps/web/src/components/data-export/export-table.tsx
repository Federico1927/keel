import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import type { listTenantExports } from "@hullwise/services";
import { Badge, DataList, EmptyState } from "@hullwise/ui";

type Row = Awaited<ReturnType<typeof listTenantExports>>[number];

function size(bytes: number | null, locale: string): string {
  if (!bytes) return "—";
  return bytes >= 1_048_576 ? `${formatNumber(Math.round((bytes / 1_048_576) * 10) / 10, locale)} MB` : `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`;
}

/** Tenant data exports with status, size, expiry and the download link while it is valid (owner page and console). */
export async function DataExportTable({ rows, locale, timezone, hrefFor, now = new Date() }: { rows: Row[]; locale: string; timezone: string; hrefFor: (id: string) => string; now?: Date }) {
  const t = await getTranslations("data_export");
  if (rows.length === 0) return <EmptyState title={t("empty_title")} description={t("empty_description")} />;
  const statusOf = (r: Row) => (r.status === "expired" || (r.status === "done" && r.expiresAt !== null && r.expiresAt <= now) ? "expired" : r.status);
  return (
    <DataList
      rows={rows}
      rowKey={(r) => r.id}
      rowProps={(r) => ({ "data-testid": "data-export-row", "data-status": statusOf(r) })}
      columns={[
        { key: "requested", header: t("columns.requested"), mobile: "title", className: "text-sm", cell: (r) => <><span className="whitespace-nowrap">{formatDateTime(r.createdAt, locale, timezone)}</span><span className="block text-xs font-normal text-muted-foreground">{r.requestedByType === "super_admin" ? t("by_platform") : (r.requestedByEmail ?? "—")}</span></> },
        { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => { const status = statusOf(r); return <><Badge variant={status === "done" ? "success" : status === "failed" ? "destructive" : status === "expired" ? "muted" : "secondary"}>{t(`statuses.${status}`)}</Badge>{r.error && <p className="text-xs text-destructive">{r.error}</p>}</>; } },
        { key: "rows", header: t("columns.rows"), align: "right", className: "text-sm tabular", cell: (r) => <>{r.rowCount === null ? "—" : formatNumber(r.rowCount, locale)}{r.rowCount !== null && <span className="block text-xs text-muted-foreground max-md:ml-1 max-md:inline">{t("tables_n", { n: Object.keys(r.tables as object).length })} · {size(r.sizeBytes, locale)}</span>}</> },
        { key: "expires", header: t("columns.expires"), className: "whitespace-nowrap text-sm text-muted-foreground", cell: (r) => (r.expiresAt ? formatDateTime(r.expiresAt, locale, timezone) : "—") },
        { key: "file", header: t("columns.file"), mobile: "action", align: "right", cell: (r) => <>{statusOf(r) === "done" ? <a href={hrefFor(r.id)} className="text-sm text-primary hover:underline max-md:inline-flex max-md:min-h-9 max-md:items-center" data-testid="data-export-download">{t("download")}</a> : <span className="text-sm text-muted-foreground max-md:hidden">—</span>}{r.downloadCount > 0 && <span className="block text-xs text-muted-foreground max-md:ml-2 max-md:inline">{t("downloads", { n: r.downloadCount })}</span>}</> },
      ]}
    />
  );
}

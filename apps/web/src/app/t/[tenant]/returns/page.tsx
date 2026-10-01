import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { bulkActionsFor, canWritePage } from "@keel/config";
import { formatDate, formatMoney, formatNumber } from "@keel/core";
import { listReturnReasons, listReturns } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ReturnFiltersBar } from "./filters";
import { schema, eq } from "@keel/db";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { BulkBar } from "@/components/lists/bulk-bar";
import { ListSelection, RowCheckbox, SelectAllCheckbox } from "@/components/lists/selection";

export default async function ReturnsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("returns");
  const filters = { q: sp.q?.trim() || undefined, status: sp.status || undefined, reason: sp.reason || undefined, source: sp.source === "portal" || sp.source === "staff" || sp.source === "platform" ? sp.source : undefined, sync: sp.sync === "error" ? "error" : undefined, review: sp.review === "1" ? "1" : undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const bulk = bulkActionsFor(ctx.role, "returns");
  const { rows, total, pageSize, counts, reasons, syncErrors, portalCount, reviewCount, locations } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const list = await listReturns(s, { ...filters, page });
    const reasons = await listReturnReasons(s);
    const locations = bulk.includes("receive") ? await tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)) : [];
    return { ...list, reasons, locations };
  });
  const base = `/t/${tenant}/returns`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) u.set(k, v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  const canWrite = canWritePage(ctx.role, "returns");
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap gap-2 text-sm">
            <ListToolbar ctx={ctx} list="returns" basePath={base} />
            <Link href={`${base}/analytics`} className="rounded-md border px-3 py-1.5 hover:bg-muted">{t("analytics")}</Link>
            {canWrite && <Link href={`${base}/reasons`} className="rounded-md border px-3 py-1.5 hover:bg-muted">{t("reasons")}</Link>}
            {canWrite && <Link href={`${base}/policy`} className="rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="policy-link">{t("policy")}</Link>}
            {canWrite && <Link href={`${base}/portal`} className="rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="portal-settings-link">{t("portal_settings")}</Link>}
          </div>
        }
      />
      <ReturnFiltersBar basePath={base} filters={filters} counts={counts} reasons={reasons.map((r) => ({ code: r.code, label: r.label }))} />
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Link href={filters.source === "portal" ? base : `${base}?source=portal`} className={`rounded-full border px-3 py-1 ${filters.source === "portal" ? "bg-primary text-primary-foreground" : "bg-card"}`} data-testid="filter-portal">{t("from_portal")} <span className="tabular opacity-70">{portalCount}</span></Link>
        {reviewCount > 0 && <Link href={filters.review === "1" ? base : `${base}?review=1`} className={`rounded-full border px-3 py-1 ${filters.review === "1" ? "bg-warning text-warning-foreground" : "border-warning/50 bg-card"}`} data-testid="filter-review">{t("needs_review")} <span className="tabular opacity-70">{reviewCount}</span></Link>}
        {syncErrors > 0 && <Link href={filters.sync === "error" ? base : `${base}?sync=error`} className={`rounded-full border px-3 py-1 ${filters.sync === "error" ? "bg-destructive text-destructive-foreground" : "border-destructive/50 bg-card text-destructive"}`} data-testid="filter-sync-error">{t("sync_errors")} <span className="tabular opacity-70">{syncErrors}</span></Link>}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <ListSelection ids={rows.map((r) => r.id)}>
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {bulk.length > 0 && <TableHead className="w-8"><SelectAllCheckbox /></TableHead>}
                  <TableHead>{t("columns.return")}</TableHead>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.reason")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.resolution")}</TableHead>
                  <TableHead className="text-right">{t("columns.amount")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.requested")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="return-row">
                    {bulk.length > 0 && <TableCell><RowCheckbox id={r.id} label={`R-${r.number}`} /></TableCell>}
                    <TableCell>
                      <Link href={`${base}/${r.id}`} className="font-medium hover:underline">R-{r.number}</Link>
                      {r.outOfWindow && <Badge variant="warning" className="ml-2">{t("out_of_window")}</Badge>}
                      {r.source === "portal" && <Badge variant="info" className="ml-2">{t("source.portal")}</Badge>}
                      {r.platformSyncStatus === "error" && <Badge variant="destructive" className="ml-2">{t("sync_error")}</Badge>}
                      {r.needsReview && <Badge variant="warning" className="ml-2">{t("needs_review")}</Badge>}
                      {r.riskLevel === "high" && <Badge variant="destructive" className="ml-2">{t("risk_high")}</Badge>}
                      <div className="text-xs text-muted-foreground">{t("items_n", { n: formatNumber(r.items, ctx.locale) })}</div>
                    </TableCell>
                    <TableCell>
                      <Link href={`/t/${tenant}/orders/${r.orderId}`} className="hover:underline">{r.orderName}</Link>
                      <div className="truncate text-xs text-muted-foreground">{r.customerName}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{reasons.find((x) => x.code === r.reasonCode)?.label ?? r.reasonCode}</TableCell>
                    <TableCell className="hidden lg:table-cell">{t(`resolution.${r.resolution}`)}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(r.refundedAmountMinor ?? r.proposedAmountMinor, r.currency, ctx.locale)}</TableCell>
                    <TableCell><StatusBadge status={r.status} namespace="return_status" /></TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(r.requestedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="returns" actions={bulk} locations={locations} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

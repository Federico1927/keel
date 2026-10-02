import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { bulkActionsFor, canWritePage } from "@hullwise/config";
import { formatDate, formatMoney, formatNumber } from "@hullwise/core";
import { listReturnReasons, listReturns } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, DataList } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ReturnFiltersBar } from "./filters";
import { schema, eq } from "@hullwise/db";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { BulkBar } from "@/components/lists/bulk-bar";
import { ListSelection, RowCheckbox, SelectAllCheckbox } from "@/components/lists/selection";

import { withIntl } from "@/i18n/intl-scope";
async function ReturnsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("returns");
  const filters = { q: sp.q?.trim() || undefined, status: sp.status || undefined, reason: sp.reason || undefined, source: sp.source === "portal" || sp.source === "staff" || sp.source === "platform" ? sp.source : undefined, sync: sp.sync === "error" ? "error" : undefined, review: sp.review === "1" ? "1" : undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const bulk = bulkActionsFor(ctx.role, "returns");
  const { rows, total, pageSize, counts, reasons, syncErrors, portalCount, platformCount, reviewCount, locations } = await ctx.run(async (tx) => {
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
  type Row = (typeof rows)[number];
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
        <Link href={filters.source === "portal" ? base : `${base}?source=portal`} className={`rounded-full border px-3 py-1 ${filters.source === "portal" ? "bg-primary text-primary-foreground" : "bg-card"}`} data-testid="filter-portal">{t("from_portal")} <span className="tabular font-normal">{portalCount}</span></Link>
        {platformCount > 0 && <Link href={filters.source === "platform" ? base : `${base}?source=platform`} className={`rounded-full border px-3 py-1 ${filters.source === "platform" ? "bg-primary text-primary-foreground" : "bg-card"}`} data-testid="filter-platform">{t("from_store")} <span className="tabular font-normal">{platformCount}</span></Link>}
        {reviewCount > 0 && <Link href={filters.review === "1" ? base : `${base}?review=1`} className={`rounded-full border px-3 py-1 ${filters.review === "1" ? "bg-warning text-warning-foreground" : "border-warning/50 bg-card"}`} data-testid="filter-review">{t("needs_review")} <span className="tabular font-normal">{reviewCount}</span></Link>}
        {syncErrors > 0 && <Link href={filters.sync === "error" ? base : `${base}?sync=error`} className={`rounded-full border px-3 py-1 ${filters.sync === "error" ? "bg-destructive text-destructive-foreground" : "border-destructive/50 bg-card text-destructive"}`} data-testid="filter-sync-error">{t("sync_errors")} <span className="tabular font-normal">{syncErrors}</span></Link>}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <ListSelection ids={rows.map((r) => r.id)}>
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "return-row" })}
              columns={[
                ...(bulk.length > 0 ? [{ key: "select", header: <SelectAllCheckbox />, mobile: "select" as const, headClassName: "w-8", cell: (r: Row) => <RowCheckbox id={r.id} label={`R-${r.number}`} /> }] : []),
                {
                  key: "return",
                  header: t("columns.return"),
                  mobile: "title",
                  cell: (r) => (
                    <>
                      <Link href={`${base}/${r.id}`} className="font-medium hover:underline">R-{r.number}</Link>
                      {r.outOfWindow && <Badge variant="warning" className="ml-2">{t("out_of_window")}</Badge>}
                      {r.source === "portal" && <Badge variant="info" className="ml-2">{t("source.portal")}</Badge>}
                      {r.source === "platform" && <Badge variant="muted" className="ml-2" data-testid="return-source-platform">{t("source.platform")}</Badge>}
                      {r.platformSyncStatus === "error" && <Badge variant="destructive" className="ml-2">{t("sync_error")}</Badge>}
                      {r.needsReview && <Badge variant="warning" className="ml-2">{t("needs_review")}</Badge>}
                      {r.riskLevel === "high" && <Badge variant="destructive" className="ml-2">{t("risk_high")}</Badge>}
                      <div className="text-xs font-normal text-muted-foreground">{t("items_n", { n: formatNumber(r.items, ctx.locale) })}</div>
                    </>
                  ),
                },
                { key: "order", header: t("columns.order"), mobile: "subtitle", cell: (r) => <><Link href={`/t/${tenant}/orders/${r.orderId}`} className="hover:underline max-md:text-foreground">{r.orderName}</Link><div className="truncate text-xs text-muted-foreground max-md:ml-1 max-md:inline">{r.customerName}</div></> },
                { key: "reason", header: t("columns.reason"), cell: (r) => reasons.find((x) => x.code === r.reasonCode)?.label ?? r.reasonCode },
                { key: "resolution", header: t("columns.resolution"), priority: 2, cell: (r) => t(`resolution.${r.resolution}`) },
                { key: "amount", header: t("columns.amount"), align: "right", className: "tabular", cell: (r) => formatMoney(r.refundedAmountMinor ?? r.proposedAmountMinor, r.currency, ctx.locale) },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => <StatusBadge status={r.status} namespace="return_status" /> },
                { key: "requested", header: t("columns.requested"), cell: (r) => formatDate(r.requestedAt, ctx.locale, ctx.tenant.timezone) },
              ]}
            />
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="returns" actions={bulk} locations={locations} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

export default withIntl(ReturnsPage, "app/t/[tenant]/returns/page.tsx");

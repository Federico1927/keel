import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { daysInTransit, formatDateTime } from "@hullwise/core";
import { Button, Card, CardContent, EmptyState, PageHeader, Pagination, Stat, DataList } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { listShipments, parseShipmentFilters } from "@/server/queries/shipments";
import { StatusBadge } from "@/components/status-badge";
import { ShipmentFiltersBar } from "./filters";

import { withIntl } from "@/i18n/intl-scope";
async function ShipmentsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "shipments");
  const t = await getTranslations("shipments");
  const filters = parseShipmentFilters(sp);
  const { rows, total, page, pageSize, summary, carriers } = await listShipments(ctx, filters);
  const base = `/t/${tenant}/shipments`;
  const isStuck = (s: (typeof rows)[number]) => !["delivered", "returned", "failed"].includes(s.status) && (daysInTransit(s.shippedAt, s.deliveredAt) ?? 0) > ctx.settings.shipmentStuckDays;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: ctx.settings.shipmentStuckDays })} actions={<Button asChild variant="outline"><Link href={`/t/${tenant}/fulfilment/exceptions`}>{t("work_queue")}</Link></Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t("kpi.in_transit")} value={summary.inTransit} href={`${base}?status=label_created,in_transit`} />
        <Stat label={t("kpi.out_for_delivery")} value={summary.outForDelivery} href={`${base}?status=out_for_delivery`} />
        <Stat label={t("kpi.exceptions")} value={summary.exceptions} href={`${base}?view=exceptions`} className={summary.exceptions ? "border-destructive/40" : ""} />
        <Stat label={t("kpi.stuck", { days: ctx.settings.shipmentStuckDays })} value={summary.stuck} href={`${base}?view=stuck`} className={summary.stuck ? "border-warning/50" : ""} />
        <Stat label={t("kpi.delivered_7d")} value={summary.delivered7d} href={`${base}?status=delivered`} />
        <Stat label={t("kpi.returned_30d")} value={summary.returned30d} href={`${base}?status=returned`} />
      </div>
      <ShipmentFiltersBar basePath={base} filters={filters} carriers={carriers} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(s) => s.id}
              rowProps={(s) => ({ className: isStuck(s) ? "bg-warning/5" : undefined, "data-testid": "shipment-row" })}
              columns={[
                { key: "order", header: t("columns.order"), mobile: "title", cell: (s) => <><Link href={`/t/${tenant}/orders/${s.orderId}`} className="font-medium text-primary hover:underline">{s.orderName}</Link><p className="text-xs font-normal text-muted-foreground">{s.customerName} · {s.country}</p></> },
                { key: "tracking", header: t("columns.tracking"), mobile: "subtitle", cell: (s) => <><p className="text-sm max-md:inline max-md:text-foreground">{s.carrier}</p>{" "}{s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">{s.trackingNumber}</a> : <span className="text-xs text-muted-foreground">{s.trackingNumber}</span>}</> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (s) => <><StatusBadge status={s.status} namespace="shipment_status" />{s.exceptionReason && <span className="block text-[10px] text-muted-foreground">{s.exceptionReason}</span>}{s.sourceOfTruth && <span className="block text-[10px] text-muted-foreground max-md:hidden">{t("source", { source: s.sourceOfTruth })}</span>}</> },
                { key: "shipped", header: t("columns.shipped"), className: "text-sm text-muted-foreground", cell: (s) => formatDateTime(s.shippedAt, ctx.locale, ctx.tenant.timezone) },
                { key: "days", header: t("columns.days"), align: "right", cell: (s) => <span className={`tabular ${isStuck(s) ? "font-medium text-warning" : ""}`}>{daysInTransit(s.shippedAt, s.deliveredAt) ?? "—"}</span> },
                { key: "last", header: t("columns.last_event"), priority: 2, className: "text-sm text-muted-foreground", cell: (s) => formatDateTime(s.lastEventAt, ctx.locale, ctx.tenant.timezone) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

export default withIntl(ShipmentsPage, "app/t/[tenant]/shipments/page.tsx");

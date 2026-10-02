import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { daysInTransit, formatDateTime } from "@keel/core";
import { Button, Card, CardContent, EmptyState, PageHeader, Pagination, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { listShipments, parseShipmentFilters } from "@/server/queries/shipments";
import { StatusBadge } from "@/components/status-badge";
import { ShipmentFiltersBar } from "./filters";

export default async function ShipmentsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "shipments");
  const t = await getTranslations("shipments");
  const filters = parseShipmentFilters(sp);
  const { rows, total, page, pageSize, summary, carriers } = await listShipments(ctx, filters);
  const base = `/t/${tenant}/shipments`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: ctx.settings.shipmentStuckDays })} actions={<Button asChild variant="outline"><Link href={`/t/${tenant}/fulfilment/exceptions`}>{t("work_queue")}</Link></Button>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead>{t("columns.tracking")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.shipped")}</TableHead>
                  <TableHead className="text-right">{t("columns.days")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.last_event")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => {
                  const days = daysInTransit(s.shippedAt, s.deliveredAt);
                  const stuck = !["delivered", "returned", "failed"].includes(s.status) && (days ?? 0) > ctx.settings.shipmentStuckDays;
                  return (
                    <TableRow key={s.id} className={stuck ? "bg-warning/5" : ""}>
                      <TableCell>
                        <Link href={`/t/${tenant}/orders/${s.orderId}`} className="font-medium text-primary hover:underline">
                          {s.orderName}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {s.customerName} · {s.country}
                        </p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{s.carrier}</p>
                        {s.trackingUrl ? (
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                            {s.trackingNumber}
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">{s.trackingNumber}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={s.status} namespace="shipment_status" />
                        {s.exceptionReason && <span className="block text-[10px] text-muted-foreground">{s.exceptionReason}</span>}
                        {s.sourceOfTruth && <span className="block text-[10px] text-muted-foreground">{t("source", { source: s.sourceOfTruth })}</span>}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{formatDateTime(s.shippedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                      <TableCell className={`text-right tabular ${stuck ? "font-medium text-warning" : ""}`}>{days ?? "—"}</TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{formatDateTime(s.lastEventAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

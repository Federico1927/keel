import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Boxes, Download, Plus, Truck } from "lucide-react";
import { formatDate, formatMoney } from "@hullwise/core";
import { canDo } from "@hullwise/config";
import { Badge, Button, Card, CardContent, DataList, EmptyState, PageHeader, Pagination, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { listPurchaseOrders } from "@/server/queries/purchasing";
import { StatusBadge } from "@/components/status-badge";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { PoFiltersBar } from "./filters";

import { withIntl } from "@/i18n/intl-scope";
async function PurchasingPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("purchasing");
  const tps = await getTranslations("po_status");
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const filters = { status: sp.status, supplier: sp.supplier, destination: sp.destination, q: sp.q, from: sp.from, to: sp.to };
  const { rows, total, pageSize, counts, suppliers, locations } = await listPurchaseOrders(ctx, { ...filters, page });
  const base = `/t/${tenant}/purchasing`;
  const query = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) u.set(k, v);
    return u.size ? `?${u}` : "";
  };
  const link = (patch: Record<string, string | undefined>) => `${base}${query(patch)}`;
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <ListToolbar ctx={ctx} list="purchasing" basePath={base} />
            <Button asChild variant="outline">
              <Link href={`${base}/suppliers`}>
                <Truck /> {t("suppliers")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`${base}/packs`}>
                <Boxes /> {t("packs")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <a href={`${base}/export${query({})}`} data-testid="po-export">
                <Download /> {t("export_csv")}
              </a>
            </Button>
            {canWrite && (
              <Button asChild>
                <Link href={`${base}/new`}>
                  <Plus /> {t("new_po")}
                </Link>
              </Button>
            )}
          </>
        }
      />
      {/* status views: one scrolling row on phones (#49) */}
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0" data-testid="status-chips">
        <Link href={link({ status: undefined })} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9 pointer-coarse:py-2", !sp.status ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("all")} <span className="tabular font-normal">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
        </Link>
        {["draft", "sent", "confirmed", "in_transit", "partially_received", "received", "cancelled"].filter((s) => counts[s]).map((s) => (
          <Link key={s} href={link({ status: sp.status === s ? undefined : s })} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9 pointer-coarse:py-2", sp.status === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {tps(s)} <span className="tabular font-normal">{counts[s]}</span>
          </Link>
        ))}
      </div>
      <PoFiltersBar basePath={base} filters={filters} suppliers={suppliers} locations={locations} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(po) => po.id}
              rowProps={() => ({ "data-testid": "po-row" })}
              columns={[
                { key: "number", header: t("columns.number"), mobile: "title", cell: (po) => <><Link href={`${base}/${po.id}`} className="font-medium text-primary hover:underline">{po.number}</Link><p className="text-xs font-normal text-muted-foreground">{t("lines_count", { n: po.lines })}</p></> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (po) => <StatusBadge status={po.status} namespace="po_status" /> },
                { key: "supplier", header: t("columns.supplier"), mobile: "subtitle", cell: (po) => <span className="max-md:text-foreground">{po.supplierName}</span> },
                { key: "destination", header: t("columns.destination"), priority: 2, className: "text-sm text-muted-foreground", cell: (po) => po.destinationName ?? "—" },
                { key: "expected", header: t("columns.expected"), className: "text-sm text-muted-foreground", cell: (po) => (po.receivedAt ? formatDate(po.receivedAt, ctx.locale, ctx.tenant.timezone) : formatDate(po.expectedAt, ctx.locale, ctx.tenant.timezone)) },
                { key: "units", header: t("columns.units"), align: "right", className: "tabular", cell: (po) => po.units },
                { key: "total", header: t("columns.total"), align: "right", className: "tabular max-md:font-semibold", cell: (po) => formatMoney(po.totalMinor, po.currency, ctx.locale) },
                { key: "covers", header: t("columns.covers"), label: "", priority: 2, cell: (po) => po.backorders > 0 && <Badge variant="info">{t("covers_orders", { n: po.backorders })}</Badge> },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={(p) => link({ page: String(p) })} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

export default withIntl(PurchasingPage, "app/t/[tenant]/purchasing/page.tsx");

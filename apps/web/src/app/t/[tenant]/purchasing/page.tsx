import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus, Truck } from "lucide-react";
import { formatDate, formatMoney } from "@keel/core";
import { canDo } from "@keel/config";
import { Badge, Button, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { listPurchaseOrders } from "@/server/queries/purchasing";
import { StatusBadge } from "@/components/status-badge";
import { ListToolbar } from "@/components/lists/list-toolbar";

export default async function PurchasingPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("purchasing");
  const tps = await getTranslations("po_status");
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const { rows, total, pageSize, counts, suppliers } = await listPurchaseOrders(ctx, { status: sp.status, supplier: sp.supplier, page });
  const base = `/t/${tenant}/purchasing`;
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: sp.status, supplier: sp.supplier, ...patch })) if (v) u.set(k, v);
    return `${base}${u.size ? `?${u}` : ""}`;
  };
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
      <div className="mb-3 flex flex-wrap gap-2">
        <Link href={link({ status: undefined })} className={cn("rounded-full border px-3 py-1 text-xs", !sp.status ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("all")} <span className="tabular opacity-70">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
        </Link>
        {["draft", "sent", "confirmed", "in_transit", "partially_received", "received", "cancelled"].filter((s) => counts[s]).map((s) => (
          <Link key={s} href={link({ status: sp.status === s ? undefined : s })} className={cn("rounded-full border px-3 py-1 text-xs", sp.status === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {tps(s)} <span className="tabular opacity-70">{counts[s]}</span>
          </Link>
        ))}
        <div className="ml-auto flex flex-wrap gap-1">
          {suppliers.map((s) => (
            <Link key={s.id} href={link({ supplier: sp.supplier === s.id ? undefined : s.id })} className={cn("rounded-full border px-3 py-1 text-xs", sp.supplier === s.id ? "bg-secondary" : "bg-card")}>
              {s.name}
            </Link>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.number")}</TableHead>
                  <TableHead>{t("columns.supplier")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.expected")}</TableHead>
                  <TableHead className="text-right">{t("columns.units")}</TableHead>
                  <TableHead className="text-right">{t("columns.total")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.covers")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((po) => (
                  <TableRow key={po.id}>
                    <TableCell>
                      <Link href={`${base}/${po.id}`} className="font-medium text-primary hover:underline">
                        {po.number}
                      </Link>
                      <p className="text-xs text-muted-foreground">{t("lines_count", { n: po.lines })}</p>
                    </TableCell>
                    <TableCell>{po.supplierName}</TableCell>
                    <TableCell>
                      <StatusBadge status={po.status} namespace="po_status" />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{po.receivedAt ? formatDate(po.receivedAt, ctx.locale, ctx.tenant.timezone) : formatDate(po.expectedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    <TableCell className="text-right tabular">{po.units}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(po.totalMinor, po.currency, ctx.locale)}</TableCell>
                    <TableCell className="hidden lg:table-cell">{po.backorders > 0 && <Badge variant="info">{t("covers_orders", { n: po.backorders })}</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={(p) => link({ page: String(p) })} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Boxes, Download, Plus, Truck } from "lucide-react";
import { formatDate, formatMoney } from "@keel/core";
import { canDo } from "@keel/config";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { listPurchaseOrders } from "@/server/queries/purchasing";
import { StatusBadge } from "@/components/status-badge";

export default async function PurchasingPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
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
  const filtered = Boolean(sp.q || sp.from || sp.to || sp.supplier || sp.destination);
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <>
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
      <div className="mb-3 flex flex-wrap gap-2">
        <Link href={link({ status: undefined })} className={cn("rounded-full border px-3 py-1 text-xs", !sp.status ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("all")} <span className="tabular opacity-70">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
        </Link>
        {["draft", "sent", "confirmed", "in_transit", "partially_received", "received", "cancelled"].filter((s) => counts[s]).map((s) => (
          <Link key={s} href={link({ status: sp.status === s ? undefined : s })} className={cn("rounded-full border px-3 py-1 text-xs", sp.status === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {tps(s)} <span className="tabular opacity-70">{counts[s]}</span>
          </Link>
        ))}
      </div>
      <form method="get" className="mb-4 grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-6" data-testid="po-filters">
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="po-q" className="text-xs">{t("filters.search")}</Label>
          <Input id="po-q" name="q" defaultValue={sp.q ?? ""} placeholder={t("filters.search_placeholder")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-supplier-f" className="text-xs">{t("columns.supplier")}</Label>
          <Select id="po-supplier-f" name="supplier" defaultValue={sp.supplier ?? ""}>
            <option value="">{t("filters.all_suppliers")}</option>
            {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-destination-f" className="text-xs">{t("filters.destination")}</Label>
          <Select id="po-destination-f" name="destination" defaultValue={sp.destination ?? ""}>
            <option value="">{t("filters.all_destinations")}</option>
            {locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-from" className="text-xs">{t("filters.from")}</Label>
          <Input id="po-from" name="from" type="date" defaultValue={sp.from ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-to" className="text-xs">{t("filters.to")}</Label>
          <Input id="po-to" name="to" type="date" defaultValue={sp.to ?? ""} />
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6 lg:justify-end">
          {filtered && <Button asChild variant="ghost" size="sm"><Link href={link({ q: undefined, from: undefined, to: undefined, supplier: undefined, destination: undefined })}>{t("filters.clear")}</Link></Button>}
          <Button type="submit" size="sm">{t("filters.apply")}</Button>
        </div>
      </form>
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
                  <TableHead className="hidden lg:table-cell">{t("columns.destination")}</TableHead>
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
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{po.destinationName ?? "—"}</TableCell>
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

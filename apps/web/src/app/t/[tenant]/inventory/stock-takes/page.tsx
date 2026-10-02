import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@keel/config";
import { formatDateTime } from "@keel/core";
import { listStockTakes } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { stockLocations, svcOf } from "@/server/queries/inventory-control";
import { NewStockTakeForm } from "./controls";

export default async function StockTakesPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("inventory_control");
  const canWrite = canWritePage(ctx.role, "inventory");
  const takes = await ctx.run((tx) => listStockTakes(svcOf(ctx, tx)));
  const locations = await stockLocations(ctx);
  return (
    <>
      <Link href={`/t/${tenant}/inventory`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("stock_takes.title")} description={t("stock_takes.description")} actions={canWrite ? <NewStockTakeForm slug={tenant} locations={locations} /> : undefined} />
      {takes.length === 0 ? (
        <EmptyState title={t("stock_takes.empty_title")} description={t("stock_takes.empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("stock_takes.columns.number")}</TableHead>
                  <TableHead>{t("stock_takes.columns.location")}</TableHead>
                  <TableHead>{t("stock_takes.columns.status")}</TableHead>
                  <TableHead className="text-right">{t("stock_takes.columns.lines")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("stock_takes.columns.movements")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("stock_takes.columns.updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {takes.map((r) => (
                  <TableRow key={r.t.id} data-testid="stock-take-row">
                    <TableCell>
                      <Link href={`/t/${tenant}/inventory/stock-takes/${r.t.id}`} className="font-medium text-primary hover:underline">ST-{r.t.number}</Link>
                      {r.t.note && <p className="text-xs text-muted-foreground">{r.t.note}</p>}
                    </TableCell>
                    <TableCell>{r.locationName}</TableCell>
                    <TableCell><Badge variant={r.t.status === "open" ? "info" : r.t.status === "applied" ? "success" : "muted"}>{t(`stock_takes.status.${r.t.status}`)}</Badge></TableCell>
                    <TableCell className="text-right tabular">{r.lines}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.t.appliedMovements ?? "—"}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-xs md:table-cell">{formatDateTime(r.t.appliedAt ?? r.t.updatedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
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

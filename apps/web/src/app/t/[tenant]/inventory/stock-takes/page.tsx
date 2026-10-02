import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { listStockTakes } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, DataList } from "@hullwise/ui";
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
            <DataList
              rows={takes}
              rowKey={(r) => r.t.id}
              rowProps={() => ({ "data-testid": "stock-take-row" })}
              columns={[
                { key: "number", header: t("stock_takes.columns.number"), mobile: "title", cell: (r) => <><Link href={`/t/${tenant}/inventory/stock-takes/${r.t.id}`} className="font-medium text-primary hover:underline">ST-{r.t.number}</Link>{r.t.note && <p className="text-xs font-normal text-muted-foreground">{r.t.note}</p>}</> },
                { key: "location", header: t("stock_takes.columns.location"), mobile: "subtitle", cell: (r) => r.locationName },
                { key: "status", header: t("stock_takes.columns.status"), mobile: "badge", cell: (r) => <Badge variant={r.t.status === "open" ? "info" : r.t.status === "applied" ? "success" : "muted"}>{t(`stock_takes.status.${r.t.status}`)}</Badge> },
                { key: "lines", header: t("stock_takes.columns.lines"), align: "right", className: "tabular", cell: (r) => r.lines },
                { key: "movements", header: t("stock_takes.columns.movements"), align: "right", className: "tabular", cell: (r) => r.t.appliedMovements ?? "—" },
                { key: "updated", header: t("stock_takes.columns.updated"), className: "whitespace-nowrap text-xs", cell: (r) => formatDateTime(r.t.appliedAt ?? r.t.updatedAt, ctx.locale, ctx.tenant.timezone) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

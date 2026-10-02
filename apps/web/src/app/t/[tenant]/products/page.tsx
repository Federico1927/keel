import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { formatDateTime, formatNumber } from "@keel/core";
import { bulkActionsFor, canWritePage } from "@keel/config";
import { catalogQualityReport, catalogSyncStatus } from "@keel/services";
import { ProductThumb } from "@/components/product-thumb";
import { CatalogSyncButton } from "./catalog-sync";
import { requirePage } from "@/server/tenant";
import { listProducts, parseProductFilters } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";
import { ProductFiltersBar } from "./filters";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { BulkBar } from "@/components/lists/bulk-bar";
import { ListSelection, RowCheckbox, SelectAllCheckbox } from "@/components/lists/selection";

export default async function ProductsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "products");
  const t = await getTranslations("products");
  const filters = parseProductFilters(sp);
  const { rows, total, page, pageSize, riskCounts, types } = await listProducts(ctx, filters);
  const { quality, sync } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { quality: await catalogQualityReport(s), sync: await catalogSyncStatus(s) };
  });
  const tm = await getTranslations("product_mirror.sync");
  // a run that has not moved for 15 minutes is not shown as running (an inline run left paused, a crashed worker)
  const syncRunning = sync.latest !== null && (sync.latest.status === "running" || sync.latest.status === "paused") && Date.now() - sync.latest.updatedAt.getTime() < 15 * 60_000;
  const base = `/t/${tenant}/products`;
  const bulk = bulkActionsFor(ctx.role, "products");
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <CatalogSyncButton slug={tenant} canSync={canWritePage(ctx.role, "products")} running={syncRunning} progress={syncRunning ? tm("running", { products: sync.latest!.products, total: sync.totalProducts }) : null} lastSynced={sync.lastSuccessAt ? formatDateTime(sync.lastSuccessAt, ctx.locale, ctx.tenant.timezone) : null} />
            <ListToolbar ctx={ctx} list="products" basePath={base} />
            <Link href={`${base}/quality`} className="underline-offset-4 hover:underline" data-testid="quality-link">
              {t("quality_link")} {quality.affected > 0 && <Badge variant="warning">{formatNumber(quality.affected, ctx.locale)}</Badge>}
            </Link>
            {canWritePage(ctx.role, "products") && <Link href={`${base}/import-costs`} className="underline-offset-4 hover:underline">{t("import_costs_link")}</Link>}
          </div>
        }
      />
      <ProductFiltersBar basePath={base} filters={filters} types={types} riskCounts={riskCounts} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <ListSelection ids={rows.map((p) => p.id)}>
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {bulk.length > 0 && <TableHead className="w-8"><SelectAllCheckbox /></TableHead>}
                  <TableHead>{t("columns.product")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.type")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.variants")}</TableHead>
                  <TableHead className="text-right">{t("columns.available")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.incoming")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.sold", { days: ctx.settings.salesVelocityLookbackDays })}</TableHead>
                  <TableHead>{t("columns.risk")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    {bulk.length > 0 && <TableCell><RowCheckbox id={p.id} label={p.title} /></TableCell>}
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <ProductThumb src={p.imageUrl} alt={p.title} />
                        <div className="min-w-0">
                          <Link href={`${base}/${p.id}`} className="font-medium text-primary hover:underline">
                            {p.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">{p.vendor}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{p.productType}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "active" ? "success" : "muted"}>{t(`status.${p.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular">{p.variants}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(p.stock?.available ?? 0, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular text-muted-foreground lg:table-cell">{p.stock?.incoming ? `+${p.stock.incoming}` : "—"}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(p.stock?.unitsSold ?? 0, ctx.locale)}</TableCell>
                    <TableCell>{p.stock && <RiskBadge risk={p.stock.risk} days={p.stock.worstDaysOfCover} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="products" actions={bulk} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

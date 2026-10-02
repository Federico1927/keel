import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, DataList } from "@hullwise/ui";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { bulkActionsFor, canWritePage } from "@hullwise/config";
import { catalogQualityReport, catalogSyncStatus } from "@hullwise/services";
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
  type Row = (typeof rows)[number];
  // a scanned code that identifies one product opens it (#49)
  if (sp.scan === "1" && total === 1 && rows[0]) redirect(`${base}/${rows[0].id}`);
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
            <DataList
              rows={rows}
              rowKey={(p) => p.id}
              rowProps={() => ({ "data-testid": "product-row" })}
              columns={[
                ...(bulk.length > 0 ? [{ key: "select", header: <SelectAllCheckbox />, mobile: "select" as const, headClassName: "w-8", cell: (p: Row) => <RowCheckbox id={p.id} label={p.title} /> }] : []),
                {
                  key: "product",
                  header: t("columns.product"),
                  mobile: "title",
                  cell: (p) => (
                    <div className="flex items-center gap-3">
                      <ProductThumb src={p.imageUrl} alt={p.title} />
                      <div className="min-w-0">
                        <Link href={`${base}/${p.id}`} className="font-medium text-primary hover:underline max-md:after:absolute max-md:after:inset-0">{p.title}</Link>
                        <p className="text-xs font-normal text-muted-foreground">{p.vendor}</p>
                      </div>
                    </div>
                  ),
                },
                { key: "type", header: t("columns.type"), className: "text-sm text-muted-foreground", cell: (p) => p.productType },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (p) => <Badge variant={p.status === "active" ? "success" : "muted"}>{t(`status.${p.status}`)}</Badge> },
                { key: "variants", header: t("columns.variants"), align: "right", className: "tabular", cell: (p) => p.variants },
                { key: "available", header: t("columns.available"), align: "right", className: "tabular max-md:font-medium", cell: (p) => formatNumber(p.stock?.available ?? 0, ctx.locale) },
                { key: "incoming", header: t("columns.incoming"), priority: 2, align: "right", className: "tabular text-muted-foreground", cell: (p) => (p.stock?.incoming ? `+${p.stock.incoming}` : "—") },
                { key: "sold", header: t("columns.sold", { days: ctx.settings.salesVelocityLookbackDays }), priority: 2, align: "right", className: "tabular", cell: (p) => formatNumber(p.stock?.unitsSold ?? 0, ctx.locale) },
                { key: "risk", header: t("columns.risk"), label: "", cell: (p) => p.stock && <RiskBadge risk={p.stock.risk} days={p.stock.worstDaysOfCover} /> },
              ]}
            />
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="products" actions={bulk} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

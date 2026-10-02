import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { PAGE_SIZE, canWritePage } from "@hullwise/config";
import { CATALOG_ISSUES, formatMoney, formatNumber, type CatalogIssue } from "@hullwise/core";
import { catalogQualityReport } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";

/** Catalog data quality: variants with missing cost, SKU, barcode or image, and duplicate SKUs. */
export default async function CatalogQualityPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ issue?: string; page?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "products");
  const t = await getTranslations("catalog_quality");
  const report = await ctx.run((tx) => catalogQualityReport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const issue = (CATALOG_ISSUES as readonly string[]).includes(sp.issue ?? "") ? (sp.issue as CatalogIssue) : null;
  const filtered = issue ? report.rows.filter((r) => r.issues.includes(issue)) : report.rows;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const base = `/t/${tenant}/products/quality`;
  const hrefFor = (p: number) => `${base}?${new URLSearchParams({ ...(issue ? { issue } : {}), page: String(p) })}`;
  const canImport = canWritePage(ctx.role, "products");
  return (
    <>
      <Link href={`/t/${tenant}/products`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { affected: report.affected, total: report.total })} actions={canImport ? <Link href={`/t/${tenant}/products/import-costs`} className="text-sm text-primary underline-offset-4 hover:underline" data-testid="import-costs-link">{t("import_costs")}</Link> : undefined} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {CATALOG_ISSUES.map((k) => (
          <Stat key={k} label={t(`issue.${k}`)} value={formatNumber(report.counts[k], ctx.locale)} href={issue === k ? base : `${base}?issue=${k}`} className={cn(issue === k && "ring-2 ring-primary", report.counts[k] > 0 && (k === "missing_cost" || k === "duplicate_sku") && "border-warning/60")} />
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.product")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("columns.sku")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.barcode")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.cost")}</TableHead>
                  <TableHead>{t("columns.issues")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="quality-row">
                    <TableCell>
                      <Link href={`/t/${tenant}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.productTitle}</Link>
                      <p className="text-xs text-muted-foreground">{r.title}</p>
                    </TableCell>
                    <TableCell className="hidden text-xs sm:table-cell">{r.sku ?? "—"}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{r.barcode ?? "—"}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{r.costMinor !== null ? formatMoney(r.costMinor, ctx.tenant.currency, ctx.locale) : "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.issues.map((i) => (
                          <Badge key={i} variant={i === "missing_cost" || i === "duplicate_sku" ? "warning" : "muted"}>{t(`issue.${i}`)}</Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={PAGE_SIZE} total={filtered.length} hrefFor={hrefFor} summary={t("pagination", { from: filtered.length ? (page - 1) * PAGE_SIZE + 1 : 0, to: Math.min(page * PAGE_SIZE, filtered.length), total: filtered.length })} />
    </>
  );
}

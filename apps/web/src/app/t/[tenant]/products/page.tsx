import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { formatNumber } from "@keel/core";
import { requirePage } from "@/server/tenant";
import { listProducts, parseProductFilters } from "@/server/queries/catalog";
import { RiskBadge } from "@/components/risk-badge";
import { ProductFiltersBar } from "./filters";

export default async function ProductsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "products");
  const t = await getTranslations("products");
  const filters = parseProductFilters(sp);
  const { rows, total, page, pageSize, riskCounts, types } = await listProducts(ctx, filters);
  const base = `/t/${tenant}/products`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <ProductFiltersBar basePath={base} filters={filters} types={types} riskCounts={riskCounts} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableCell>
                      <Link href={`${base}/${p.id}`} className="font-medium text-primary hover:underline">
                        {p.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">{p.vendor}</p>
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
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}

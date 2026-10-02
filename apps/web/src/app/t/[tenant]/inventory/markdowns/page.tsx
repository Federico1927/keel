import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@keel/config";
import { formatDateTime, formatMoney, formatPercent } from "@keel/core";
import { markdownSuggestions, priceHistory } from "@keel/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { svcOf } from "@/server/queries/inventory-control";
import { MarkdownTable, type MarkdownView } from "./controls";

export default async function MarkdownsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "inventory");
  const t = await getTranslations("inventory_control");
  const canApply = canWritePage(ctx.role, "inventory") && canWritePage(ctx.role, "products");
  const { suggestions, history } = await ctx.run(async (tx) => ({ suggestions: await markdownSuggestions(svcOf(ctx, tx), { country: ctx.tenant.country, settings: ctx.settings }), history: await priceHistory(svcOf(ctx, tx), { source: "markdown", limit: 15 }) }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const pct = (bps: number | null) => (bps === null ? "—" : formatPercent(bps / 10_000, ctx.locale));
  const rows: MarkdownView[] = suggestions.rows.map((r) => ({
    variantId: r.variantId,
    productId: r.productId,
    label: r.productTitle,
    detail: `${r.variantTitle}${r.sku ? ` · ${r.sku}` : ""}`,
    reason: r.suggestion.reason,
    available: r.available,
    cover: r.daysOfCover === null ? null : Math.round(r.daysOfCover),
    price: money(r.priceMinor),
    newPrice: money(r.suggestion.priceMinor),
    compareAt: money(r.suggestion.compareAtMinor),
    discount: pct(r.suggestion.discountBps),
    floor: money(r.suggestion.floorPriceMinor),
    margin: pct(r.suggestion.marginBps),
    clamped: r.suggestion.clampedByFloor,
  }));
  const skipped = Object.entries(suggestions.skipped).filter(([k, n]) => n && k !== "not_excess" && k !== "no_stock");
  return (
    <>
      <Link href={`/t/${tenant}/inventory`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("markdowns.title")} description={t("markdowns.description", { margin: pct(ctx.settings.markdownMinMarginBps), excess: ctx.settings.excessCoverDays, slow: ctx.settings.slowCoverDays, days: ctx.settings.salesVelocityLookbackDays })} />
      {skipped.length > 0 && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="markdown-skipped">
          {skipped.map(([k, n]) => t(`markdowns.skipped.${k}`, { n: n ?? 0 })).join(" · ")}
        </p>
      )}
      {rows.length === 0 ? <EmptyState title={t("markdowns.empty_title")} description={t("markdowns.empty_description")} /> : <MarkdownTable slug={tenant} rows={rows} canApply={canApply} />}
      <Card className="mt-6" data-testid="markdown-history">
        <CardHeader>
          <CardTitle className="text-base">{t("price_history.title")}</CardTitle>
          <CardDescription>{t("price_history.markdown_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("price_history.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("price_history.columns.when")}</TableHead>
                  <TableHead>{t("price_history.columns.variant")}</TableHead>
                  <TableHead className="text-right">{t("price_history.columns.price")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("price_history.columns.compare_at")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("price_history.columns.by")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.c.id} data-testid="price-change-row">
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(h.c.createdAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                    <TableCell>
                      <Link href={`/t/${tenant}/products/${h.productId}`} className="font-medium text-primary hover:underline">{h.productTitle}</Link>
                      <p className="text-xs text-muted-foreground">{h.variantTitle}{h.sku ? ` · ${h.sku}` : ""}</p>
                    </TableCell>
                    <TableCell className="text-right tabular">{money(h.c.priceBeforeMinor)} → <span className="font-medium">{money(h.c.priceAfterMinor)}</span></TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{h.c.compareAtBeforeMinor === null ? "—" : money(h.c.compareAtBeforeMinor)} → {h.c.compareAtAfterMinor === null ? "—" : money(h.c.compareAtAfterMinor)}</TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{h.actorName ?? t("price_history.system")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

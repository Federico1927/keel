import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Boxes } from "lucide-react";
import { canDo, canViewPage, isPageEnabled } from "@keel/config";
import { formatMoney } from "@keel/core";
import { asc, eq, schema } from "@keel/db";
import { listSupplierTerms, packsForProduct } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import type { TenantContext } from "@/server/tenant";
import { BulkSupplierForm, VariantSupplierButton } from "./supplier-forms";

/**
 * "Suppliers & packs" on the product page: the default supplier of each variant with its SKU,
 * cost, MOQ and lead time (editable per variant and for all variants at once), the case packs
 * that fit the product, and the way to the option-mix page.
 */
export async function SupplierPacksSection({ ctx, slug, productId }: { ctx: TenantContext; slug: string; productId: string }) {
  if (!isPageEnabled("purchasing", ctx.activeAddons) || !canViewPage(ctx.role, "purchasing")) return null;
  const t = await getTranslations("supplier_terms");
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  const s = (tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const [terms, packs, suppliers] = await Promise.all([
    ctx.run((tx) => listSupplierTerms(s(tx), { productId })),
    ctx.run((tx) => packsForProduct(s(tx), productId)),
    ctx.run((tx) => tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(asc(schema.suppliers.name))),
  ]);
  const fmt = (m: number | null) => (m === null ? "—" : formatMoney(m, ctx.tenant.currency, ctx.locale));
  const missing = terms.filter((v) => !v.supplierId).length;
  return (
    <Card data-testid="supplier-packs">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <p className="text-xs text-muted-foreground">{missing > 0 ? t("missing", { n: missing }) : t("hint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && suppliers.length > 0 && <BulkSupplierForm slug={slug} productId={productId} suppliers={suppliers} />}
          <Link href={`/t/${slug}/purchasing/mix/${productId}`} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="option-mix-link">
            <Boxes className="h-4 w-4" /> {t("option_mix")}
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.variant")}</TableHead>
              <TableHead>{t("columns.supplier")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("columns.supplier_sku")}</TableHead>
              <TableHead className="text-right">{t("columns.cost")}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t("columns.moq")}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t("columns.lead_time")}</TableHead>
              {canWrite && <TableHead className="w-10"><span className="sr-only">{t("edit")}</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {terms.map((v) => (
              <TableRow key={v.variantId}>
                <TableCell>
                  <p className="font-medium">{v.title}</p>
                  <p className="text-xs text-muted-foreground">{v.sku}</p>
                </TableCell>
                <TableCell>{v.supplierName ?? <Badge variant="warning">{t("none")}</Badge>}</TableCell>
                <TableCell className="hidden font-mono text-xs md:table-cell">{v.supplierSku ?? "—"}</TableCell>
                <TableCell className="text-right tabular">{fmt(v.unitCostMinor ?? v.costMinor)}</TableCell>
                <TableCell className="hidden text-right tabular sm:table-cell">{v.moq ?? "—"}</TableCell>
                <TableCell className="hidden text-right tabular sm:table-cell">{v.leadTimeDays !== null ? t("days", { n: v.leadTimeDays }) : "—"}</TableCell>
                {canWrite && (
                  <TableCell>
                    <VariantSupplierButton slug={slug} suppliers={suppliers} variant={{ id: v.variantId, title: v.title, supplierId: v.supplierId, supplierSku: v.supplierSku, unitCost: v.unitCostMinor !== null ? (v.unitCostMinor / 100).toFixed(2) : "", moq: v.moq, orderMultiple: v.orderMultiple, leadTimeDays: v.leadTimeDays }} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="space-y-2 px-6 pb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("packs")}</p>
          {packs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("no_packs")}{" "}
              <Link href={`/t/${slug}/purchasing/packs`} className="text-primary hover:underline">{t("manage_packs")}</Link>
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {packs.map((p) => (
                <li key={p.id} className="rounded border px-2 py-1 text-xs">
                  <span className="font-medium">{p.name}</span> <span className="text-muted-foreground">· {p.optionName}: {Object.entries(p.units).map(([k, n]) => `${k}×${n}`).join(" ")} · {t("units_per_pack", { n: p.totalUnits })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

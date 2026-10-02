import { and, asc, eq, ilike, or, schema } from "@hullwise/db";
import type { TenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { variantStock } from "../inventory";
import { listSupplierTerms } from "./supplier-terms";

export interface PoVariantOption {
  variantId: string;
  productId: string;
  label: string;
  sku: string | null;
  available: number;
  incoming: number;
  daysOfCover: number | null;
  risk: string;
  suggested: number;
  /** Variant's last purchase cost. */
  costMinor: number | null;
  /** Default supplier and its agreed cost, when set. */
  supplierId: string | null;
  supplierCostMinor: number | null;
}

/** Any variant of the catalogue by SKU, barcode, product or variant title, for a PO line. */
export async function searchPoVariants(ctx: ServiceContext, settings: TenantSettings, q: string, limit = 20): Promise<PoVariantOption[]> {
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const found = await ctx.tx
    .select({ id: schema.productVariants.id })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, ctx.tenantId), or(ilike(schema.productVariants.sku, like), ilike(schema.productVariants.barcode, like), ilike(schema.productVariants.title, like), ilike(schema.products.title, like))))
    .orderBy(asc(schema.products.title), asc(schema.productVariants.sku))
    .limit(Math.min(50, limit));
  return poVariantOptions(ctx, settings, found.map((f) => f.id));
}

/** Stock and supplier facts of the given variants, in the order given. */
export async function poVariantOptions(ctx: ServiceContext, settings: TenantSettings, variantIds: string[]): Promise<PoVariantOption[]> {
  if (!variantIds.length) return [];
  const [stock, terms] = [await variantStock(ctx, settings, { variantIds }), await listSupplierTerms(ctx, { variantIds })];
  const termsBy = new Map(terms.map((t) => [t.variantId, t]));
  return variantIds.flatMap((id) => {
    const s = stock.find((r) => r.variantId === id);
    if (!s) return [];
    const t = termsBy.get(id);
    return [{ variantId: id, productId: s.productId, label: `${s.productTitle} · ${s.variantTitle}`, sku: s.sku, available: s.available, incoming: s.incoming, daysOfCover: s.daysOfCover, risk: s.risk, suggested: s.suggestedReorder, costMinor: s.costMinor, supplierId: t?.supplierId ?? null, supplierCostMinor: t?.unitCostMinor ?? null }];
  });
}

import { and, asc, eq, ilike, inArray, isNull, ne, schema, sql, type SQL } from "@keel/db";
import { diffRecords, type Diff } from "@keel/core";
import type { ServiceContext } from "../context";
import { PurchasingError } from "./index";

/**
 * Default supplier per variant (`supplier_variants` with `is_primary`): the supplier's SKU, cost,
 * MOQ, order multiple and lead time. Replenishment and auto-drafted POs read the primary row.
 * `undefined` keeps a field as it is (bulk edits), `null` clears it.
 */
export interface SupplierTermsInput {
  supplierSku?: string | null;
  unitCostMinor?: number | null;
  moq?: number | null;
  orderMultiple?: number | null;
  leadTimeDays?: number | null;
}

const TERM_KEYS = ["supplierId", "supplierSku", "unitCostMinor", "moq", "orderMultiple", "leadTimeDays"] as const;

export interface VariantSupplierTerms {
  variantId: string;
  productId: string;
  title: string;
  sku: string | null;
  optionValues: Record<string, string>;
  costMinor: number | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string | null;
  unitCostMinor: number | null;
  moq: number | null;
  orderMultiple: number | null;
  leadTimeDays: number | null;
}

/** Variants of a product (or the given ones) with their default supplier terms. */
export async function listSupplierTerms(ctx: ServiceContext, opts: { productId?: string; variantIds?: string[] }): Promise<VariantSupplierTerms[]> {
  const conds: SQL[] = [eq(schema.productVariants.tenantId, ctx.tenantId)];
  if (opts.productId) conds.push(eq(schema.productVariants.productId, opts.productId));
  if (opts.variantIds) conds.push(inArray(schema.productVariants.id, opts.variantIds.length ? opts.variantIds : ["00000000-0000-0000-0000-000000000000"]));
  const variants = await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, title: schema.productVariants.title, sku: schema.productVariants.sku, optionValues: schema.productVariants.optionValues, costMinor: schema.productVariants.costMinor }).from(schema.productVariants).where(and(...conds)).orderBy(asc(schema.productVariants.sku));
  if (!variants.length) return [];
  const links = await ctx.tx
    .select({ sv: schema.supplierVariants, supplierName: schema.suppliers.name })
    .from(schema.supplierVariants)
    .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.supplierVariants.supplierId))
    .where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), inArray(schema.supplierVariants.variantId, variants.map((v) => v.id))));
  return variants.map((v) => {
    // same pick as replenishment: the primary row first
    const l = links.filter((x) => x.sv.variantId === v.id).sort((a, b) => Number(b.sv.isPrimary) - Number(a.sv.isPrimary))[0];
    return { variantId: v.id, productId: v.productId, title: v.title, sku: v.sku, optionValues: v.optionValues as Record<string, string>, costMinor: v.costMinor, supplierId: l?.sv.supplierId ?? null, supplierName: l?.supplierName ?? null, supplierSku: l?.sv.supplierSku ?? null, unitCostMinor: l?.sv.unitCostMinor ?? null, moq: l?.sv.moq ?? null, orderMultiple: l?.sv.orderMultiple ?? null, leadTimeDays: l?.sv.leadTimeDays ?? null };
  });
}

const clean = (n: number | null | undefined, max: number) => (n === undefined ? undefined : n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(max, Math.round(n))));

/**
 * Sets (or with `supplierId: null` removes) the default supplier of variants. The chosen supplier's
 * row becomes primary and the others lose the flag, so planning picks it. Returns one diff per
 * changed variant for the audit.
 */
export async function setDefaultSupplier(ctx: ServiceContext, variantIds: string[], supplierId: string | null, terms: SupplierTermsInput = {}): Promise<{ variantId: string; diff: Diff }[]> {
  const ids = [...new Set(variantIds)];
  if (!ids.length) return [];
  if (supplierId) {
    const [sup] = await ctx.tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(and(eq(schema.suppliers.tenantId, ctx.tenantId), eq(schema.suppliers.id, supplierId))).limit(1);
    if (!sup) throw new PurchasingError("not_found");
  }
  const before = await listSupplierTerms(ctx, { variantIds: ids });
  if (before.length !== ids.length) throw new PurchasingError("not_found");
  const t = { supplierSku: terms.supplierSku === undefined ? undefined : terms.supplierSku?.trim().slice(0, 80) || null, unitCostMinor: clean(terms.unitCostMinor, 100_000_000), moq: clean(terms.moq, 1_000_000), orderMultiple: clean(terms.orderMultiple, 100_000), leadTimeDays: clean(terms.leadTimeDays, 730) };
  const out: { variantId: string; diff: Diff }[] = [];
  for (const prev of before) {
    if (!supplierId) {
      if (!prev.supplierId) continue;
      await ctx.tx.delete(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), eq(schema.supplierVariants.variantId, prev.variantId), eq(schema.supplierVariants.supplierId, prev.supplierId)));
    } else {
      const [existing] = await ctx.tx.select().from(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), eq(schema.supplierVariants.variantId, prev.variantId), eq(schema.supplierVariants.supplierId, supplierId))).limit(1);
      const values = {
        supplierSku: t.supplierSku !== undefined ? t.supplierSku : (existing?.supplierSku ?? null),
        unitCostMinor: t.unitCostMinor !== undefined ? t.unitCostMinor : (existing?.unitCostMinor ?? null),
        moq: t.moq !== undefined ? (t.moq || null) : (existing?.moq ?? null),
        orderMultiple: t.orderMultiple !== undefined ? (t.orderMultiple || null) : (existing?.orderMultiple ?? null),
        leadTimeDays: t.leadTimeDays !== undefined ? t.leadTimeDays : (existing?.leadTimeDays ?? null),
        isPrimary: true,
      };
      if (existing) await ctx.tx.update(schema.supplierVariants).set(values).where(eq(schema.supplierVariants.id, existing.id));
      else await ctx.tx.insert(schema.supplierVariants).values({ tenantId: ctx.tenantId, supplierId, variantId: prev.variantId, ...values });
      await ctx.tx.update(schema.supplierVariants).set({ isPrimary: false }).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), eq(schema.supplierVariants.variantId, prev.variantId), ne(schema.supplierVariants.supplierId, supplierId)));
    }
    const [next] = await listSupplierTerms(ctx, { variantIds: [prev.variantId] });
    const pick = (r: VariantSupplierTerms | undefined) => Object.fromEntries(TERM_KEYS.map((k) => [k, r?.[k] ?? null]));
    const diff = diffRecords(pick(prev), pick(next));
    if (Object.keys(diff).length) out.push({ variantId: prev.variantId, diff });
  }
  return out;
}

/** Variants matched by a bulk filter (product type, vendor, SKU prefix), optionally only those without a supplier. */
export async function variantsForBulkSupplier(ctx: ServiceContext, f: { productIds?: string[]; productType?: string | null; vendor?: string | null; skuPrefix?: string | null; onlyWithoutSupplier?: boolean }): Promise<string[]> {
  const conds: SQL[] = [eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true)];
  if (f.productIds) conds.push(inArray(schema.productVariants.productId, f.productIds.length ? f.productIds : ["00000000-0000-0000-0000-000000000000"]));
  if (f.productType) conds.push(eq(schema.products.productType, f.productType));
  if (f.vendor) conds.push(eq(schema.products.vendor, f.vendor));
  if (f.skuPrefix) conds.push(ilike(schema.productVariants.sku, `${f.skuPrefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  const q = ctx.tx.select({ id: schema.productVariants.id }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId));
  const rows = f.onlyWithoutSupplier
    ? await q.leftJoin(schema.supplierVariants, eq(schema.supplierVariants.variantId, schema.productVariants.id)).where(and(...conds, isNull(schema.supplierVariants.id)))
    : await q.where(and(...conds));
  return [...new Set(rows.map((r) => r.id))];
}

/** Catalogue facets for the bulk form. */
export async function bulkSupplierFacets(ctx: ServiceContext) {
  const rows = await ctx.tx.select({ type: schema.products.productType, vendor: schema.products.vendor }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenantId)).groupBy(schema.products.productType, schema.products.vendor);
  const [{ without }] = (await ctx.tx.select({ without: sql<number>`count(*)::int` }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true), sql`not exists (select 1 from supplier_variants sv where sv.variant_id = ${schema.productVariants.id})`))) as [{ without: number }];
  return { productTypes: [...new Set(rows.map((r) => r.type).filter((x): x is string => Boolean(x)))].sort(), vendors: [...new Set(rows.map((r) => r.vendor).filter((x): x is string => Boolean(x)))].sort(), variantsWithoutSupplier: without };
}

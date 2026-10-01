import { and, asc, eq, gte, inArray, isNull, or, schema, sql } from "@keel/db";
import { SALE_STATUSES, allocateByShare, allocationToPoLines, diffRecords, packAllocation, packFitsProduct, packGroups, packUnits, packsForDemand, type CasePackDef, type Diff } from "@keel/core";
import type { ServiceContext } from "../context";
import { replenishmentPlan, type PlanningTenant } from "../planning";
import { PurchasingError, createPurchaseOrder } from "./index";
import { listSupplierTerms } from "./supplier-terms";

export interface CasePackRow extends CasePackDef {
  id: string;
  productId: string | null;
  productTitle: string | null;
  isActive: boolean;
  totalUnits: number;
}

export async function listCasePacks(ctx: ServiceContext): Promise<CasePackRow[]> {
  const rows = await ctx.tx.select({ p: schema.casePacks, productTitle: schema.products.title }).from(schema.casePacks).leftJoin(schema.products, eq(schema.products.id, schema.casePacks.productId)).where(eq(schema.casePacks.tenantId, ctx.tenantId)).orderBy(asc(schema.casePacks.name));
  return rows.map(({ p, productTitle }) => ({ id: p.id, name: p.name, optionName: p.optionName, units: p.units as Record<string, number>, productId: p.productId, productTitle, isActive: p.isActive, totalUnits: packUnits({ units: p.units as Record<string, number> }) }));
}

export interface SaveCasePackInput {
  id?: string;
  name: string;
  optionName: string;
  units: Record<string, number>;
  productId: string | null;
  isActive?: boolean;
}

/** Creates or updates a pack; values with no units are dropped. Returns the id and the diff for the audit. */
export async function saveCasePack(ctx: ServiceContext, input: SaveCasePackInput): Promise<{ id: string; diff: Diff; created: boolean }> {
  const units = Object.fromEntries(Object.entries(input.units).map(([k, n]) => [k.trim().slice(0, 60), Math.max(0, Math.min(10_000, Math.floor(n || 0)))]).filter(([k, n]) => k && (n as number) > 0));
  const values = { name: input.name.trim().slice(0, 80), optionName: input.optionName.trim().slice(0, 60), units, productId: input.productId, isActive: input.isActive ?? true };
  if (!values.name || !values.optionName || !Object.keys(units).length) throw new PurchasingError("invalid_quantity");
  if (input.productId) {
    const [p] = await ctx.tx.select({ options: schema.products.options }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, input.productId))).limit(1);
    if (!p) throw new PurchasingError("not_found");
    if (!packFitsProduct(values, p.options as { name: string; values: string[] }[])) throw new PurchasingError("invalid_quantity");
  }
  if (input.id) {
    const [prev] = await ctx.tx.select().from(schema.casePacks).where(and(eq(schema.casePacks.tenantId, ctx.tenantId), eq(schema.casePacks.id, input.id))).limit(1);
    if (!prev) throw new PurchasingError("not_found");
    await ctx.tx.update(schema.casePacks).set(values).where(eq(schema.casePacks.id, prev.id));
    return { id: prev.id, diff: diffRecords({ name: prev.name, optionName: prev.optionName, units: prev.units, productId: prev.productId, isActive: prev.isActive }, values), created: false };
  }
  const [row] = await ctx.tx.insert(schema.casePacks).values({ tenantId: ctx.tenantId, ...values }).returning({ id: schema.casePacks.id });
  return { id: row!.id, diff: diffRecords({}, values), created: true };
}

export async function deleteCasePack(ctx: ServiceContext, id: string): Promise<{ name: string } | null> {
  const [row] = await ctx.tx.delete(schema.casePacks).where(and(eq(schema.casePacks.tenantId, ctx.tenantId), eq(schema.casePacks.id, id))).returning({ name: schema.casePacks.name });
  return row ?? null;
}

/** Active packs usable on a product: its own packs and the tenant-wide ones whose option it has. */
export async function packsForProduct(ctx: ServiceContext, productId: string): Promise<CasePackRow[]> {
  const [p] = await ctx.tx.select({ options: schema.products.options }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId))).limit(1);
  if (!p) return [];
  const rows = await ctx.tx.select().from(schema.casePacks).where(and(eq(schema.casePacks.tenantId, ctx.tenantId), eq(schema.casePacks.isActive, true), or(eq(schema.casePacks.productId, productId), isNull(schema.casePacks.productId)))).orderBy(asc(schema.casePacks.name));
  const options = p.options as { name: string; values: string[] }[];
  return rows
    .map((r) => ({ id: r.id, name: r.name, optionName: r.optionName, units: r.units as Record<string, number>, productId: r.productId, productTitle: null, isActive: r.isActive, totalUnits: packUnits({ units: r.units as Record<string, number> }) }))
    .filter((r) => packFitsProduct(r, options));
}

export interface OptionMixVariant {
  variantId: string;
  title: string;
  sku: string | null;
  optionValues: Record<string, string>;
  unitsSold: number;
  /** Share of the product's units sold in the window (equal shares when nothing sold). */
  share: number;
  /** Replenishment suggestion (units) for this variant; 0 when no order is due. */
  suggested: number;
  costMinor: number | null;
  supplierId: string | null;
}

export interface PackSuggestion {
  packId: string;
  packName: string;
  optionName: string;
  groups: { key: string; values: Record<string, string>; need: number; packs: number; units: number; surplusByValue: Record<string, number> }[];
}

export interface OptionMix {
  product: { id: string; title: string; options: { name: string; values: string[] }[] };
  lookbackDays: number;
  variants: OptionMixVariant[];
  packs: CasePackRow[];
  suggestions: PackSuggestion[];
}

/**
 * The option mix of a product: units sold per option combination in the window and their share,
 * the replenishment suggestion per variant, the default supplier cost, the packs that fit and,
 * per pack, the number of cartons per option group that covers the suggested quantities.
 */
export async function optionMix(ctx: ServiceContext, tenant: PlanningTenant, productId: string, lookbackDays = 180): Promise<OptionMix | null> {
  const [p] = await ctx.tx.select({ id: schema.products.id, title: schema.products.title, options: schema.products.options }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId))).limit(1);
  if (!p) return null;
  const terms = await listSupplierTerms(ctx, { productId });
  const active = await ctx.tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.productId, productId), eq(schema.productVariants.isActive, true)));
  const activeIds = new Set(active.map((a) => a.id));
  const variants = terms.filter((v) => activeIds.has(v.variantId));
  const ids = variants.map((v) => v.variantId);
  const since = new Date((ctx.now ?? new Date()).getTime() - lookbackDays * 864e5);
  const sold = ids.length
    ? await ctx.tx
        .select({ variantId: schema.orderLines.variantId, n: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity}), 0)::int` })
        .from(schema.orderLines)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
        .where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orderLines.variantId, ids), gte(schema.orders.placedAt, since), inArray(schema.orders.status, [...SALE_STATUSES])))
        .groupBy(schema.orderLines.variantId)
    : [];
  const soldBy = new Map(sold.map((s) => [s.variantId, Number(s.n)]));
  const total = [...soldBy.values()].reduce((s, n) => s + n, 0);
  const plan = ids.length ? await replenishmentPlan(ctx, tenant, { variantIds: ids }) : [];
  const planBy = new Map(plan.map((r) => [r.variantId, r]));
  const rows: OptionMixVariant[] = variants.map((v) => ({
    variantId: v.variantId,
    title: v.title,
    sku: v.sku,
    optionValues: v.optionValues,
    unitsSold: soldBy.get(v.variantId) ?? 0,
    share: total > 0 ? (soldBy.get(v.variantId) ?? 0) / total : variants.length ? 1 / variants.length : 0,
    suggested: planBy.get(v.variantId)?.shouldOrder ? (planBy.get(v.variantId)?.quantity ?? 0) : 0,
    costMinor: v.unitCostMinor ?? v.costMinor,
    supplierId: v.supplierId,
  }));
  const packs = await packsForProduct(ctx, productId);
  const suggestions: PackSuggestion[] = packs.map((pack) => ({
    packId: pack.id,
    packName: pack.name,
    optionName: pack.optionName,
    groups: packGroups(rows.map((r) => ({ id: r.variantId, optionValues: r.optionValues, suggested: r.suggested })), pack.optionName).map((g) => {
      const need: Record<string, number> = {};
      for (const m of g.members) need[m.value] = (need[m.value] ?? 0) + m.variant.suggested;
      const res = packsForDemand(pack, need);
      return { key: g.key, values: g.values, need: Object.values(need).reduce((s, n) => s + n, 0), packs: res.packs, units: res.packs * pack.totalUnits, surplusByValue: res.surplusByValue };
    }),
  }));
  return { product: { id: p.id, title: p.title, options: p.options as { name: string; values: string[] }[] }, lookbackDays, variants: rows, packs, suggestions };
}

export type MixAllocationInput = { mode: "units"; totalUnits: number; multiple?: number | null } | { mode: "packs"; packId: string; packsByGroup: Record<string, number> };

/** Units per variant for an allocation: a total split by sales share, or N cartons per option group. */
export function mixAllocation(mix: OptionMix, input: MixAllocationInput): Record<string, number> {
  if (input.mode === "units") return allocateByShare(Math.min(1_000_000, Math.max(0, Math.floor(input.totalUnits))), mix.variants.map((v) => ({ key: v.variantId, share: v.share })), { multiple: input.multiple });
  const pack = mix.packs.find((p) => p.id === input.packId);
  if (!pack) throw new PurchasingError("not_found");
  const out: Record<string, number> = {};
  for (const g of packGroups(mix.variants.map((v) => ({ id: v.variantId, optionValues: v.optionValues })), pack.optionName)) Object.assign(out, packAllocation(pack, g, Math.min(10_000, input.packsByGroup[g.key] ?? 0)));
  return out;
}

/**
 * Turns an option-mix allocation into a draft PO for a supplier. Unit cost: the supplier's terms
 * when it is the variant's default supplier, else the variant's last cost.
 */
export async function createPoFromMix(ctx: ServiceContext, tenant: PlanningTenant, input: { productId: string; supplierId: string; destinationLocationId: string | null; expectedAt: Date | null; lookbackDays?: number; allocation: MixAllocationInput }): Promise<{ id: string; lines: number; units: number }> {
  const mix = await optionMix(ctx, tenant, input.productId, input.lookbackDays);
  if (!mix) throw new PurchasingError("not_found");
  const alloc = mixAllocation(mix, input.allocation);
  const terms = await listSupplierTerms(ctx, { productId: input.productId });
  const cost = Object.fromEntries(terms.map((t) => [t.variantId, t.supplierId === input.supplierId && t.unitCostMinor !== null ? t.unitCostMinor : t.costMinor]));
  const lines = allocationToPoLines(alloc, cost);
  if (!lines.length) throw new PurchasingError("invalid_quantity");
  const id = await createPurchaseOrder(ctx, { supplierId: input.supplierId, destinationLocationId: input.destinationLocationId, currency: tenant.currency, expectedAt: input.expectedAt, notes: null, lines });
  return { id, lines: lines.length, units: lines.reduce((s, l) => s + l.quantity, 0) };
}

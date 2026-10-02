import { and, eq, gte, inArray, schema, sql } from "@hullwise/db";
import { reorderSuggestion, stockVelocity, worstRisk, type StockRisk, type TenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";

export interface VariantStockRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  /** Thumbnail: the variant's own image, else the product cover (issue #19). */
  imageUrl: string | null;
  packSize: number | null;
  costMinor: number | null;
  priceMinor: number;
  available: number;
  committed: number;
  incoming: number;
  unitsSold: number;
  velocityPerDay: number;
  daysOfCover: number | null;
  risk: StockRisk;
  suggestedReorder: number;
  byLocation: { locationId: string; available: number }[];
}

/**
 * Stock picture for a set of variants (or all): levels per location, incoming from open
 * purchase orders, units sold in the lookback window, velocity, cover, risk, reorder.
 */
export async function variantStock(ctx: ServiceContext, settings: TenantSettings, opts: { variantIds?: string[]; productIds?: string[]; lookbackDays?: number } = {}): Promise<VariantStockRow[]> {
  const lookback = opts.lookbackDays ?? settings.salesVelocityLookbackDays;
  const since = new Date((ctx.now ?? new Date()).getTime() - lookback * 864e5);
  const where = [eq(schema.productVariants.tenantId, ctx.tenantId)];
  if (opts.variantIds?.length) where.push(inArray(schema.productVariants.id, opts.variantIds));
  if (opts.productIds?.length) where.push(inArray(schema.productVariants.productId, opts.productIds));
  const variants = await ctx.tx
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, productTitle: schema.products.title, title: schema.productVariants.title, sku: schema.productVariants.sku, imageUrl: sql<string | null>`coalesce(${schema.productMedia.url}, ${schema.products.imageUrl})`, packSize: schema.productVariants.packSize, costMinor: schema.productVariants.costMinor, priceMinor: schema.productVariants.priceMinor })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.productMedia, eq(schema.productMedia.id, schema.productVariants.imageMediaId))
    .where(and(...where));
  if (!variants.length) return [];
  const ids = variants.map((v) => v.id);
  const [levels, incoming, sold] = await Promise.all([
    ctx.tx.select({ variantId: schema.inventoryLevels.variantId, locationId: schema.inventoryLevels.locationId, available: schema.inventoryLevels.available, committed: schema.inventoryLevels.committed }).from(schema.inventoryLevels).where(inArray(schema.inventoryLevels.variantId, ids)),
    ctx.tx
      .select({ variantId: schema.purchaseOrderLines.variantId, n: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}), 0)::int` })
      .from(schema.purchaseOrderLines)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
      .where(and(inArray(schema.purchaseOrderLines.variantId, ids), inArray(schema.purchaseOrders.status, ["confirmed", "in_transit", "partially_received"])))
      .groupBy(schema.purchaseOrderLines.variantId),
    ctx.tx
      .select({ variantId: schema.orderLines.variantId, n: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity}), 0)::int` })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(and(inArray(schema.orderLines.variantId, ids), gte(schema.orders.placedAt, since), sql`${schema.orders.status} not in ('cancelled','refunded')`))
      .groupBy(schema.orderLines.variantId),
  ]);
  const incomingBy = new Map(incoming.map((i) => [i.variantId, i.n]));
  const soldBy = new Map(sold.map((s) => [s.variantId, s.n]));
  return variants.map((v) => {
    const lv = levels.filter((l) => l.variantId === v.id);
    const available = lv.reduce((s, l) => s + l.available, 0);
    const committed = lv.reduce((s, l) => s + l.committed, 0);
    const inc = incomingBy.get(v.id) ?? 0;
    const unitsSold = soldBy.get(v.id) ?? 0;
    const vel = stockVelocity({ unitsSold, lookbackDays: lookback, available, incoming: inc, criticalDays: settings.coverageDaysCritical, warningDays: settings.coverageDaysWarning });
    return {
      variantId: v.id, productId: v.productId, productTitle: v.productTitle, variantTitle: v.title, sku: v.sku, imageUrl: v.imageUrl, packSize: v.packSize, costMinor: v.costMinor, priceMinor: v.priceMinor,
      available, committed, incoming: inc, unitsSold, velocityPerDay: vel.velocityPerDay, daysOfCover: vel.daysOfCover, risk: vel.risk,
      suggestedReorder: reorderSuggestion(vel.velocityPerDay, vel.effectiveStock, settings.reorderTargetDays, v.packSize),
      byLocation: lv.map((l) => ({ locationId: l.locationId, available: l.available })),
    };
  });
}

export interface ProductStockSummary {
  productId: string;
  available: number;
  incoming: number;
  unitsSold: number;
  risk: StockRisk;
  criticalVariants: number;
  suggestedReorder: number;
  worstDaysOfCover: number | null;
}

export function summarizeByProduct(rows: VariantStockRow[]): Map<string, ProductStockSummary> {
  const out = new Map<string, ProductStockSummary>();
  for (const r of rows) {
    const s = out.get(r.productId) ?? { productId: r.productId, available: 0, incoming: 0, unitsSold: 0, risk: "no_sales" as StockRisk, criticalVariants: 0, suggestedReorder: 0, worstDaysOfCover: null };
    s.available += r.available;
    s.incoming += r.incoming;
    s.unitsSold += r.unitsSold;
    s.suggestedReorder += r.suggestedReorder;
    if (r.risk === "critical") s.criticalVariants++;
    s.risk = worstRisk([s.risk, r.risk]);
    if (r.daysOfCover !== null) s.worstDaysOfCover = s.worstDaysOfCover === null ? r.daysOfCover : Math.min(s.worstDaysOfCover, r.daysOfCover);
    out.set(r.productId, s);
  }
  return out;
}

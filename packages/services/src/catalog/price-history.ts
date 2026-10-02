import { and, desc, eq, inArray, schema } from "@hullwise/db";
import type { ServiceContext } from "../context";

export type PriceChangeSource = "markdown" | "bulk" | "manual";

export interface PriceChangeInput {
  variantId: string;
  priceBeforeMinor: number;
  priceAfterMinor: number;
  compareAtBeforeMinor: number | null;
  compareAtAfterMinor: number | null;
}

/** Appends price history rows for the price changes Hullwise makes (unchanged rows are skipped). */
export async function recordPriceChanges(ctx: ServiceContext, rows: readonly PriceChangeInput[], opts: { source: PriceChangeSource; batchId?: string | null; note?: string | null }): Promise<number> {
  const changed = rows.filter((r) => r.priceBeforeMinor !== r.priceAfterMinor || r.compareAtBeforeMinor !== r.compareAtAfterMinor);
  if (!changed.length) return 0;
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.priceChanges).values(changed.map((r) => ({ tenantId: ctx.tenantId, ...r, source: opts.source, batchId: opts.batchId ?? null, actorUserId: ctx.actor.userId, note: opts.note ?? null, createdAt: now })));
  return changed.length;
}

/** Latest price changes of some variants (product page) or of a source (markdown page), newest first. */
export async function priceHistory(ctx: ServiceContext, opts: { variantIds?: string[]; source?: PriceChangeSource; limit?: number } = {}) {
  const where = [eq(schema.priceChanges.tenantId, ctx.tenantId)];
  if (opts.variantIds) {
    if (!opts.variantIds.length) return [];
    where.push(inArray(schema.priceChanges.variantId, opts.variantIds));
  }
  if (opts.source) where.push(eq(schema.priceChanges.source, opts.source));
  return ctx.tx
    .select({ c: schema.priceChanges, productId: schema.productVariants.productId, productTitle: schema.products.title, variantTitle: schema.productVariants.title, sku: schema.productVariants.sku, actorName: schema.users.name })
    .from(schema.priceChanges)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.priceChanges.variantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.users, eq(schema.users.id, schema.priceChanges.actorUserId))
    .where(and(...where))
    .orderBy(desc(schema.priceChanges.createdAt))
    .limit(opts.limit ?? 20);
}

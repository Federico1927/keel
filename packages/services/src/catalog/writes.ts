import { and, asc, eq, schema } from "@keel/db";
import { applyBulkCompareAt, applyBulkPrice, planTagChange, type BulkCompareAtChange, type BulkPriceChange } from "@keel/core";
import type { CommercePlatform } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { runPlatformWriteNow } from "../writes";
import { recordPriceChanges, type PriceChangeSource } from "./price-history";

/**
 * Product writes that reach the commerce platform: platform first (through the outbox, so every
 * call is recorded), then the local rows. The returned diff is what the caller writes to the audit log.
 */

export type ProductStatus = "active" | "draft" | "archived";
type Diff = Record<string, { from: unknown; to: unknown }>;
export type ProductWriteOutcome = { kind: "not_found" } | { kind: "unchanged"; title: string } | { kind: "updated"; title: string; diff: Diff };

async function loadProduct(ctx: ServiceContext, productId: string) {
  const [p] = await ctx.tx.select({ id: schema.products.id, title: schema.products.title, externalId: schema.products.externalId, status: schema.products.status, tags: schema.products.tags }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId))).limit(1);
  return p ?? null;
}

export async function setProductStatusWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, productId: string, status: ProductStatus): Promise<ProductWriteOutcome> {
  const p = await loadProduct(ctx, productId);
  if (!p) return { kind: "not_found" };
  if (p.status === status) return { kind: "unchanged", title: p.title };
  if (platform && p.externalId) await runPlatformWriteNow(ctx, platform, { kind: "product.status", entityType: "product", entityId: productId, payload: { productExternalId: p.externalId, status } });
  await ctx.tx.update(schema.products).set({ status }).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId)));
  return { kind: "updated", title: p.title, diff: { status: { from: p.status, to: status } } };
}

export async function updateProductTagsWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, productId: string, add: string[], remove: string[]): Promise<ProductWriteOutcome> {
  const p = await loadProduct(ctx, productId);
  if (!p) return { kind: "not_found" };
  const plan = planTagChange(p.tags, add, remove);
  if (!plan.add.length && !plan.remove.length) return { kind: "unchanged", title: p.title };
  if (platform && p.externalId) await runPlatformWriteNow(ctx, platform, { kind: "product.tags", entityType: "product", entityId: productId, payload: { productExternalId: p.externalId, add: plan.add, remove: plan.remove } });
  await ctx.tx.update(schema.products).set({ tags: plan.next }).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId)));
  return { kind: "updated", title: p.title, diff: { tags: { from: p.tags, to: plan.next } } };
}

/**
 * Price and/or compare-at price of every variant of a product. Variants are written one by one on
 * the platform; a failure stops the product there and is rethrown, so the caller's transaction rolls
 * back the local rows (variants already written on the platform come back with the next catalog sync).
 */
export async function updateProductPricesWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, productId: string, change: { price?: BulkPriceChange; compareAt?: BulkCompareAtChange }, history: { source: PriceChangeSource; batchId?: string | null } = { source: "bulk" }): Promise<ProductWriteOutcome> {
  const p = await loadProduct(ctx, productId);
  if (!p) return { kind: "not_found" };
  const variants = await ctx.tx.select({ id: schema.productVariants.id, externalId: schema.productVariants.externalId, title: schema.productVariants.title, priceMinor: schema.productVariants.priceMinor, compareAtMinor: schema.productVariants.compareAtMinor }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.productId, productId))).orderBy(asc(schema.productVariants.title));
  const diff: Diff = {};
  for (const v of variants) {
    const price = change.price ? applyBulkPrice(v.priceMinor, change.price) : v.priceMinor;
    const compareAt = change.compareAt ? applyBulkCompareAt(change.compareAt) : v.compareAtMinor;
    const patch: { priceMinor?: number; compareAtMinor?: number | null } = {};
    if (price !== v.priceMinor) patch.priceMinor = price;
    if (compareAt !== v.compareAtMinor) patch.compareAtMinor = compareAt;
    if (!Object.keys(patch).length) continue;
    if (platform && v.externalId) await runPlatformWriteNow(ctx, platform, { kind: "variant.prices", entityType: "variant", entityId: v.id, payload: { variantExternalId: v.externalId, patch } });
    await ctx.tx.update(schema.productVariants).set(patch).where(eq(schema.productVariants.id, v.id));
    await recordPriceChanges(ctx, [{ variantId: v.id, priceBeforeMinor: v.priceMinor, priceAfterMinor: price, compareAtBeforeMinor: v.compareAtMinor, compareAtAfterMinor: compareAt }], history);
    if (patch.priceMinor !== undefined) diff[`price:${v.title}`] = { from: v.priceMinor, to: patch.priceMinor };
    if (patch.compareAtMinor !== undefined) diff[`compareAt:${v.title}`] = { from: v.compareAtMinor, to: patch.compareAtMinor };
  }
  if (!Object.keys(diff).length) return { kind: "unchanged", title: p.title };
  return { kind: "updated", title: p.title, diff };
}

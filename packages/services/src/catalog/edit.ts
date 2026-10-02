import { and, asc, desc, eq, inArray, recordAudit, schema, sql } from "@keel/db";
import { diffRecords, isStaleEdit, planProductPatch, planVariantPatch, validateProductEdit, validateVariantEdit, type Diff, type EditableProduct, type EditableVariant, type ProductEditError } from "@keel/core";
import type { CommercePlatform, NormalizedProduct, ProductMediaOperation } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { importProduct } from "../sync";
import { runPlatformWriteNow } from "../writes";
import { recordPriceChanges } from "./price-history";
import type { AuditIdentity } from "./costs";

/**
 * Two-way product fields (issue #19). Keel mirrors every platform field on read and edits a defined
 * subset. A write goes to the platform first, through the outbox (`runPlatformWriteNow`, so every
 * call is recorded); the local rows are then rewritten from the platform's answer, never from the
 * form. An edit opened on a version older than the platform's `updatedAt` is refused ("changed in
 * Shopify, reload") and the local mirror is refreshed with the current version.
 */

export interface ProductEditInput {
  /** The product version the form was opened on (`platformUpdatedAt`, else `syncedAt`), ISO. */
  version: string | null;
  product?: Partial<EditableProduct> & { categoryName?: string | null };
  variants?: ({ variantId: string } & Partial<EditableVariant>)[];
}

export type ProductEditOutcome =
  | { kind: "not_found" }
  | { kind: "invalid"; error: ProductEditError }
  | { kind: "stale"; platformUpdatedAt: Date | null }
  | { kind: "unchanged"; title: string }
  | { kind: "updated"; title: string; diff: Diff };

export type MediaEditInput = { type: "create"; url: string; alt: string | null } | { type: "reorder"; mediaIds: string[] } | { type: "delete"; mediaIds: string[] } | { type: "alt"; mediaId: string; alt: string | null };

type ProductRow = typeof schema.products.$inferSelect;
type VariantRow = typeof schema.productVariants.$inferSelect;

async function loadProduct(ctx: ServiceContext, productId: string): Promise<ProductRow | null> {
  const [p] = await ctx.tx.select().from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId))).limit(1);
  return p ?? null;
}
const loadVariants = (ctx: ServiceContext, productId: string) => ctx.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.productId, productId))).orderBy(asc(schema.productVariants.title));
const loadMedia = (ctx: ServiceContext, productId: string) => ctx.tx.select().from(schema.productMedia).where(and(eq(schema.productMedia.tenantId, ctx.tenantId), eq(schema.productMedia.productId, productId))).orderBy(asc(schema.productMedia.position));

const editable = (p: ProductRow): EditableProduct => ({ title: p.title, descriptionHtml: p.descriptionHtml, vendor: p.vendor, productType: p.productType, tags: p.tags, status: p.status as EditableProduct["status"], seoTitle: p.seoTitle, seoDescription: p.seoDescription, categoryId: p.categoryId });
const editableVariant = (v: VariantRow): EditableVariant => ({ priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, sku: v.sku, barcode: v.barcode, weightGrams: v.weightGrams, inventoryPolicy: (v.inventoryPolicy as EditableVariant["inventoryPolicy"]) ?? null });
/** The version a form shows: the platform's `updatedAt` Keel holds, else when Keel last read the product. */
export const productVersion = (p: Pick<ProductRow, "platformUpdatedAt" | "syncedAt">): Date | null => p.platformUpdatedAt ?? p.syncedAt ?? null;

/** Audit diff of what Keel holds before and after: product fields plus `<field>:<variant title>` per variant. */
function productDiff(before: ProductRow, after: ProductRow, vBefore: VariantRow[], vAfter: VariantRow[]): Diff {
  const pick = (p: ProductRow) => ({ ...editable(p), categoryName: p.categoryName });
  const diff = diffRecords(pick(before), pick(after));
  for (const v of vAfter) {
    const b = vBefore.find((x) => x.id === v.id);
    if (!b) continue;
    for (const [k, d] of Object.entries(diffRecords({ ...editableVariant(b) }, { ...editableVariant(v) }))) diff[`${k}:${v.title}`] = d;
  }
  return diff;
}

/** Price history for the variant prices that changed (the platform's answer decides what changed). */
async function recordVariantPriceChanges(ctx: ServiceContext, vBefore: VariantRow[], vAfter: VariantRow[]): Promise<void> {
  const rows = vAfter.flatMap((v) => {
    const b = vBefore.find((x) => x.id === v.id);
    return b && (b.priceMinor !== v.priceMinor || b.compareAtMinor !== v.compareAtMinor) ? [{ variantId: v.id, priceBeforeMinor: b.priceMinor, priceAfterMinor: v.priceMinor, compareAtBeforeMinor: b.compareAtMinor, compareAtAfterMinor: v.compareAtMinor }] : [];
  });
  await recordPriceChanges(ctx, rows, { source: "manual" });
}

/** Reads the platform's current product and refuses when it changed after the version the user opened (the mirror is refreshed). */
async function currentOrStale(ctx: ServiceContext, platform: CommercePlatform, p: ProductRow, version: string | null): Promise<{ current: NormalizedProduct } | { stale: Date | null } | null> {
  const current = await platform.fetchProduct(p.externalId!);
  if (!current) return null;
  const opened = version ? new Date(version) : productVersion(p);
  if (isStaleEdit(current.platformUpdatedAt ?? null, opened && !Number.isNaN(opened.getTime()) ? opened : null)) {
    await importProduct(ctx, current);
    return { stale: current.platformUpdatedAt ?? null };
  }
  return { current };
}

/**
 * Title, description, vendor, type, tags, status, SEO, category and variant price, compare-at, SKU,
 * barcode, weight, inventory policy. One audit entry with the diff of what the platform accepted.
 */
export async function editProductWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, productId: string, input: ProductEditInput, audit: AuditIdentity): Promise<ProductEditOutcome> {
  const before = await loadProduct(ctx, productId);
  if (!before) return { kind: "not_found" };
  const vBefore = await loadVariants(ctx, productId);
  const requested = input.product ?? {};
  const invalid = validateProductEdit(requested) ?? (input.variants ?? []).map((v) => validateVariantEdit(v)).find(Boolean) ?? null;
  if (invalid) return { kind: "invalid", error: invalid };
  const productPatch = planProductPatch(editable(before), requested);
  const variantPatches: { row: VariantRow; patch: ReturnType<typeof planVariantPatch> }[] = [];
  for (const req of input.variants ?? []) {
    const row = vBefore.find((v) => v.id === req.variantId);
    if (!row) return { kind: "not_found" };
    const patch = planVariantPatch(editableVariant(row), req);
    if (Object.keys(patch).length) variantPatches.push({ row, patch });
  }
  if (!Object.keys(productPatch).length && !variantPatches.length) return { kind: "unchanged", title: before.title };

  if (platform && before.externalId) {
    const check = await currentOrStale(ctx, platform, before, input.version);
    if (!check) return { kind: "not_found" };
    if ("stale" in check) return { kind: "stale", platformUpdatedAt: check.stale };
    let answer: NormalizedProduct | null = null;
    if (Object.keys(productPatch).length) answer = await runPlatformWriteNow(ctx, platform, { kind: "product.update", entityType: "product", entityId: productId, payload: { productExternalId: before.externalId, patch: productPatch } });
    for (const { row, patch } of variantPatches) {
      if (!row.externalId) continue;
      await runPlatformWriteNow(ctx, platform, { kind: "variant.details", entityType: "variant", entityId: row.id, payload: { productExternalId: before.externalId, variantExternalId: row.externalId, patch } });
    }
    // variant writes answer nothing: the product is read back once they are all in
    if (variantPatches.length || !answer) answer = await platform.fetchProduct(before.externalId);
    if (!answer) return { kind: "not_found" };
    await importProduct(ctx, answer);
  } else {
    // a product Keel holds alone (no platform id): the local rows are the source
    const now = ctx.now ?? new Date();
    const local: Partial<ProductRow> = {};
    if (productPatch.title !== undefined) local.title = productPatch.title;
    if (productPatch.descriptionHtml !== undefined) local.descriptionHtml = productPatch.descriptionHtml || null;
    if (productPatch.vendor !== undefined) local.vendor = productPatch.vendor || null;
    if (productPatch.productType !== undefined) local.productType = productPatch.productType || null;
    if (productPatch.tags !== undefined) local.tags = productPatch.tags;
    if (productPatch.status !== undefined) local.status = productPatch.status;
    if (productPatch.seo !== undefined) Object.assign(local, { seoTitle: productPatch.seo.title, seoDescription: productPatch.seo.description });
    if (productPatch.categoryId !== undefined) Object.assign(local, { categoryId: productPatch.categoryId, categoryName: productPatch.categoryId ? (requested.categoryName ?? productPatch.categoryId) : null });
    if (Object.keys(local).length) await ctx.tx.update(schema.products).set({ ...local, updatedAt: now }).where(eq(schema.products.id, productId));
    for (const { row, patch } of variantPatches) await ctx.tx.update(schema.productVariants).set({ ...patch, updatedAt: now }).where(eq(schema.productVariants.id, row.id));
  }

  const after = (await loadProduct(ctx, productId))!;
  const vAfter = await loadVariants(ctx, productId);
  await recordVariantPriceChanges(ctx, vBefore, vAfter);
  const diff = productDiff(before, after, vBefore, vAfter);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...audit, action: "product.updated", entityType: "product", entityId: productId, diff, metadata: { platform: Boolean(platform && before.externalId), fields: [...Object.keys(productPatch), ...variantPatches.flatMap((v) => Object.keys(v.patch))] } });
  return Object.keys(diff).length ? { kind: "updated", title: after.title, diff } : { kind: "unchanged", title: after.title };
}

export type MediaEditOutcome = { kind: "not_found" } | { kind: "invalid" } | { kind: "stale"; platformUpdatedAt: Date | null } | { kind: "updated"; title: string; diff: Diff };

const isHttpUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 2000;

/** Gallery: add an image from a public URL, reorder, delete, alt text. Platform first, local rows from its answer. */
export async function editProductMedia(ctx: ServiceContext, platform: CommercePlatform | undefined, productId: string, input: MediaEditInput & { version: string | null }, audit: AuditIdentity): Promise<MediaEditOutcome> {
  const before = await loadProduct(ctx, productId);
  if (!before) return { kind: "not_found" };
  const media = await loadMedia(ctx, productId);
  const byId = new Map(media.map((m) => [m.id, m]));
  if (input.type === "create" && !isHttpUrl(input.url.trim())) return { kind: "invalid" };
  const ids = input.type === "reorder" || input.type === "delete" ? input.mediaIds : input.type === "alt" ? [input.mediaId] : [];
  if (ids.some((id) => !byId.has(id))) return { kind: "not_found" };
  if (input.type === "reorder" && new Set(ids).size !== ids.length) return { kind: "invalid" };
  if (input.type === "alt" && (input.alt ?? "").length > 512) return { kind: "invalid" };
  const summary = (rows: typeof media) => rows.map((m) => ({ id: m.id, url: m.url, alt: m.alt }));

  if (platform && before.externalId) {
    const check = await currentOrStale(ctx, platform, before, input.version);
    if (!check) return { kind: "not_found" };
    if ("stale" in check) return { kind: "stale", platformUpdatedAt: check.stale };
    const ext = (id: string) => byId.get(id)!.externalId;
    if (ids.some((id) => !ext(id))) return { kind: "invalid" };
    const op: ProductMediaOperation =
      input.type === "create" ? { type: "create", url: input.url.trim(), alt: input.alt?.trim() || null }
      : input.type === "reorder" ? { type: "reorder", mediaExternalIds: ids.map((id) => ext(id)!) }
      : input.type === "delete" ? { type: "delete", mediaExternalIds: ids.map((id) => ext(id)!) }
      : { type: "alt", mediaExternalId: ext(input.mediaId)!, alt: input.alt?.trim() || null };
    const answer = await runPlatformWriteNow(ctx, platform, { kind: "product.media", entityType: "product", entityId: productId, payload: { productExternalId: before.externalId, op } });
    await importProduct(ctx, answer);
  } else {
    const now = ctx.now ?? new Date();
    if (input.type === "create") await ctx.tx.insert(schema.productMedia).values({ tenantId: ctx.tenantId, productId, type: "image", url: input.url.trim(), alt: input.alt?.trim() || null, position: media.length, createdAt: now, updatedAt: now });
    else if (input.type === "delete") await ctx.tx.delete(schema.productMedia).where(and(eq(schema.productMedia.tenantId, ctx.tenantId), inArray(schema.productMedia.id, ids)));
    else if (input.type === "alt") await ctx.tx.update(schema.productMedia).set({ alt: input.alt?.trim() || null, updatedAt: now }).where(eq(schema.productMedia.id, input.mediaId));
    const order = input.type === "reorder" ? [...ids, ...media.map((m) => m.id).filter((id) => !ids.includes(id))] : (await loadMedia(ctx, productId)).map((m) => m.id);
    for (const [position, id] of order.entries()) await ctx.tx.update(schema.productMedia).set({ position, updatedAt: now }).where(eq(schema.productMedia.id, id));
    const [cover] = await loadMedia(ctx, productId);
    await ctx.tx.update(schema.products).set({ imageUrl: cover?.url ?? null, updatedAt: now }).where(eq(schema.products.id, productId));
  }
  const after = await loadMedia(ctx, productId);
  const diff = diffRecords({ media: summary(media) }, { media: summary(after) }, []);
  // media lists compare order-insensitively in diffRecords: a reorder is recorded as the order of ids
  if (input.type === "reorder") diff.order = { from: media.map((m) => m.id), to: after.map((m) => m.id) };
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...audit, action: `product.media_${input.type}`, entityType: "product", entityId: productId, diff, metadata: { platform: Boolean(platform && before.externalId) } });
  return { kind: "updated", title: before.title, diff };
}

/** "Sync from Shopify" on the product page: reads the one product and rewrites the mirror (audited with what changed). */
export async function syncProductFromPlatform(ctx: ServiceContext, platform: CommercePlatform, productId: string, audit: AuditIdentity): Promise<{ kind: "not_found" } | { kind: "synced"; diff: Diff }> {
  const before = await loadProduct(ctx, productId);
  if (!before?.externalId) return { kind: "not_found" };
  const vBefore = await loadVariants(ctx, productId);
  const mBefore = await loadMedia(ctx, productId);
  const current = await platform.fetchProduct(before.externalId);
  if (!current) return { kind: "not_found" };
  await importProduct(ctx, current);
  const after = (await loadProduct(ctx, productId))!;
  const mAfter = await loadMedia(ctx, productId);
  const diff = productDiff(before, after, vBefore, await loadVariants(ctx, productId));
  const gallery = diffRecords({ media: mBefore.map((m) => `${m.url}|${m.alt ?? ""}`).join("\n") }, { media: mAfter.map((m) => `${m.url}|${m.alt ?? ""}`).join("\n") }, []);
  Object.assign(diff, gallery);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...audit, action: "product.synced", entityType: "product", entityId: productId, diff, metadata: { platformUpdatedAt: current.platformUpdatedAt?.toISOString() ?? null } });
  return { kind: "synced", diff };
}

export interface CatalogSyncStatus {
  /** The latest catalog run (any kind): its phase and products imported so far give the progress. */
  latest: { id: string; status: string; kind: string; phase: string | null; products: number; startedAt: Date; updatedAt: Date; finishedAt: Date | null; error: string | null } | null;
  lastSuccessAt: Date | null;
  totalProducts: number;
}

/** Progress of the whole-catalog sync for the Products list (reuses `sync_runs` of `runCatalogSync`). */
export async function catalogSyncStatus(ctx: ServiceContext): Promise<CatalogSyncStatus> {
  const runs = await ctx.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.objectType, "catalog"))).orderBy(desc(schema.syncRuns.startedAt)).limit(10);
  const latest = runs[0];
  const success = runs.find((r) => r.status === "success");
  const [{ n } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenantId));
  const cursor = (latest?.cursor ?? {}) as { phase?: string; counts?: { products?: number } };
  const summary = (latest?.summary ?? {}) as { products?: number };
  return {
    latest: latest ? { id: latest.id, status: latest.status, kind: latest.kind, phase: cursor.phase ?? null, products: cursor.counts?.products ?? summary.products ?? 0, startedAt: latest.startedAt, updatedAt: new Date(latest.startedAt.getTime() + (latest.durationMs ?? 0)), finishedAt: latest.finishedAt, error: latest.error } : null,
    lastSuccessAt: success?.finishedAt ?? null,
    totalProducts: n,
  };
}

/**
 * Thumbnails for lists (orders, purchase orders, campaigns): per variant its own image, else the
 * product cover; per product its cover. Unknown ids are absent from the map.
 */
export async function catalogThumbnails(ctx: ServiceContext, ref: { variantIds?: (string | null)[]; productIds?: (string | null)[] }): Promise<{ variants: Map<string, string | null>; products: Map<string, string | null> }> {
  const variantIds = [...new Set((ref.variantIds ?? []).filter((v): v is string => Boolean(v)))];
  const productIds = [...new Set((ref.productIds ?? []).filter((v): v is string => Boolean(v)))];
  const variants = variantIds.length
    ? await ctx.tx.select({ id: schema.productVariants.id, url: sql<string | null>`coalesce(${schema.productMedia.url}, ${schema.products.imageUrl})` }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).leftJoin(schema.productMedia, eq(schema.productMedia.id, schema.productVariants.imageMediaId)).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, variantIds)))
    : [];
  const products = productIds.length ? await ctx.tx.select({ id: schema.products.id, url: schema.products.imageUrl }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), inArray(schema.products.id, productIds))) : [];
  return { variants: new Map(variants.map((v) => [v.id, v.url])), products: new Map(products.map((p) => [p.id, p.url])) };
}

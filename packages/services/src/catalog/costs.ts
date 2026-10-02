import { and, eq, inArray, isNull, recordAudit, schema, sql, type ActorType } from "@hullwise/db";
import { catalogQuality, matchCostRows, parseCostCsv, type CatalogIssue, type CostCatalogVariant, type CostCsvFileError, type CostImportPreview, type ProductCostSource } from "@hullwise/core";
import type { ServiceContext } from "../context";

/** Who the audit rows name; the web layer passes it to mark super-admin impersonation. */
export interface AuditIdentity {
  actorUserId: string | null;
  actorType: ActorType;
  impersonatedBy: string | null;
}
const identityOf = (ctx: ServiceContext, override?: AuditIdentity): AuditIdentity => override ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", impersonatedBy: null };

/** Which past order lines take a newly set cost: only those without one (default), or all of them (restatement). */
export type CostApplyTo = "missing" | "all";

/**
 * Copies the variants' current cost onto their order lines. Lines keep the cost they were sold
 * with, so by default only lines that had none are filled; `all` restates history (a correction).
 */
export async function applyCostToOrderLines(ctx: ServiceContext, variantIds: readonly string[], applyTo: CostApplyTo = "missing"): Promise<number> {
  if (!variantIds.length) return 0;
  const conds = [eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.variantId, schema.productVariants.id), inArray(schema.productVariants.id, [...variantIds]), sql`${schema.productVariants.costMinor} is not null`];
  if (applyTo === "missing") conds.push(isNull(schema.orderLines.unitCostMinor));
  else conds.push(sql`${schema.orderLines.unitCostMinor} is distinct from ${schema.productVariants.costMinor}`);
  const rows = await ctx.tx.update(schema.orderLines).set({ unitCostMinor: sql`${schema.productVariants.costMinor}` }).from(schema.productVariants).where(and(...conds)).returning({ id: schema.orderLines.id });
  return rows.length;
}

export interface CostChange {
  variantId: string;
  costMinor: number;
}
export interface CostChangeResult {
  changed: { variantId: string; sku: string | null; fromMinor: number | null; toMinor: number; fromSource: string | null }[];
  linesUpdated: number;
}

export class CostError extends Error {
  constructor(readonly code: "invalid_cost" | "not_found") {
    super(code);
  }
}

/** Current cost, source and platform ids of variants of the tenant (for the edit form, the platform write and the diff). */
export async function variantCostRows(ctx: ServiceContext, variantIds: readonly string[]) {
  if (!variantIds.length) return [];
  return ctx.tx
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, sku: schema.productVariants.sku, costMinor: schema.productVariants.costMinor, costSource: schema.productVariants.costSource, externalId: schema.productVariants.externalId, inventoryItemExternalId: schema.productVariants.inventoryItemExternalId })
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, [...variantIds])));
}

/**
 * Sets variant costs typed by a person (`manual`) or read from a file (`import`), records the
 * source and time, fills the order lines that lacked a cost (or restates them) and writes one
 * audit row per variant with the diff. Unchanged costs are skipped. Imports audit once, in
 * `applyCostImport`, so `auditEach` is off there.
 */
export async function setVariantCosts(ctx: ServiceContext, changes: readonly CostChange[], opts: { source: Extract<ProductCostSource, "manual" | "import">; applyTo?: CostApplyTo; audit?: AuditIdentity; auditEach?: boolean }): Promise<CostChangeResult> {
  if (changes.some((c) => !Number.isInteger(c.costMinor) || c.costMinor < 0 || c.costMinor > 1_000_000_000)) throw new CostError("invalid_cost");
  const now = ctx.now ?? new Date();
  const current = new Map((await variantCostRows(ctx, changes.map((c) => c.variantId))).map((v) => [v.id, v]));
  if (changes.some((c) => !current.has(c.variantId))) throw new CostError("not_found");
  const changed: CostChangeResult["changed"] = [];
  for (const c of changes) {
    const v = current.get(c.variantId)!;
    if (v.costMinor === c.costMinor) continue;
    await ctx.tx.update(schema.productVariants).set({ costMinor: c.costMinor, costSource: opts.source, costUpdatedAt: now, updatedAt: now }).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.id, v.id)));
    changed.push({ variantId: v.id, sku: v.sku, fromMinor: v.costMinor, toMinor: c.costMinor, fromSource: v.costSource });
  }
  const applyTo = opts.applyTo ?? "missing";
  const linesUpdated = await applyCostToOrderLines(ctx, changed.map((c) => c.variantId), applyTo);
  if (opts.auditEach !== false) {
    const who = identityOf(ctx, opts.audit);
    for (const c of changed) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...who, action: "variant.cost_updated", entityType: "variant", entityId: c.variantId, diff: { costMinor: { from: c.fromMinor, to: c.toMinor }, costSource: { from: c.fromSource, to: opts.source } }, metadata: { applyTo, sku: c.sku } });
  }
  return { changed, linesUpdated };
}

/* ---------- CSV import ---------- */

/** Every variant of the tenant with its SKU and supplier SKUs, the matching universe of a cost import. */
export async function costImportCatalog(ctx: ServiceContext): Promise<(CostCatalogVariant & { externalId: string | null; inventoryItemExternalId: string | null })[]> {
  const variants = await ctx.tx
    .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, costMinor: schema.productVariants.costMinor, costSource: schema.productVariants.costSource, title: schema.productVariants.title, productTitle: schema.products.title, externalId: schema.productVariants.externalId, inventoryItemExternalId: schema.productVariants.inventoryItemExternalId })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(eq(schema.productVariants.tenantId, ctx.tenantId));
  const supplier = await ctx.tx.select({ variantId: schema.supplierVariants.variantId, supplierSku: schema.supplierVariants.supplierSku }).from(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), sql`${schema.supplierVariants.supplierSku} is not null`));
  const bySupplier = new Map<string, string[]>();
  for (const s of supplier) bySupplier.set(s.variantId, [...(bySupplier.get(s.variantId) ?? []), s.supplierSku!]);
  return variants.map((v) => ({ id: v.id, sku: v.sku, supplierSkus: bySupplier.get(v.id) ?? [], costMinor: v.costMinor, costSource: v.costSource, label: `${v.productTitle} · ${v.title}`, externalId: v.externalId, inventoryItemExternalId: v.inventoryItemExternalId }));
}

/** Step 1: parse and match the file; nothing is written. */
export async function previewCostImport(ctx: ServiceContext, csv: string): Promise<{ error: CostCsvFileError | null; preview: CostImportPreview | null }> {
  const parsed = parseCostCsv(csv);
  if (parsed.error) return { error: parsed.error, preview: null };
  return { error: null, preview: matchCostRows(parsed.rows, await costImportCatalog(ctx)) };
}

/**
 * Step 2: re-parses and re-matches the same file (the catalog may have moved since the preview),
 * writes the matched rows with source `import` and records one audit row for the whole import
 * with a per-SKU diff (capped) and the counts.
 */
export async function applyCostImport(ctx: ServiceContext, csv: string, opts: { applyTo?: CostApplyTo; fileName?: string | null; audit?: AuditIdentity }): Promise<{ error: CostCsvFileError | null; counts: CostImportPreview["counts"] | null; result: CostChangeResult | null }> {
  const { error, preview } = await previewCostImport(ctx, csv);
  if (error || !preview) return { error, counts: null, result: null };
  const changes = preview.rows.filter((r) => r.status === "matched" && r.variantId && r.costMinor !== null).map((r) => ({ variantId: r.variantId!, costMinor: r.costMinor! }));
  const result = await setVariantCosts(ctx, changes, { source: "import", applyTo: opts.applyTo, auditEach: false });
  const AUDIT_CAP = 500;
  const diff = Object.fromEntries(result.changed.slice(0, AUDIT_CAP).map((c) => [c.sku ?? c.variantId, { from: c.fromMinor, to: c.toMinor }]));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "catalog.cost_import", entityType: "catalog", diff, metadata: { fileName: opts.fileName ?? null, counts: preview.counts, written: result.changed.length, linesUpdated: result.linesUpdated, applyTo: opts.applyTo ?? "missing", truncated: result.changed.length > AUDIT_CAP } });
  return { error: null, counts: preview.counts, result };
}

/* ---------- data quality ---------- */

export interface QualityRow {
  id: string;
  productId: string;
  productTitle: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  costMinor: number | null;
  costSource: string | null;
  imageUrl: string | null;
  issues: CatalogIssue[];
}

/** Data-quality report over the active variants of products that are not archived. */
export async function catalogQualityReport(ctx: ServiceContext): Promise<{ rows: QualityRow[]; counts: Record<CatalogIssue, number>; affected: number; total: number }> {
  const variants = await ctx.tx
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, productTitle: schema.products.title, title: schema.productVariants.title, sku: schema.productVariants.sku, barcode: schema.productVariants.barcode, costMinor: schema.productVariants.costMinor, costSource: schema.productVariants.costSource, imageUrl: schema.products.imageUrl })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true), sql`${schema.products.status} <> 'archived'`))
    .orderBy(schema.products.title, schema.productVariants.title);
  return catalogQuality(variants);
}

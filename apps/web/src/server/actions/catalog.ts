"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { diffRecords, parseAmountToMinor, tenantSettingsSchema, type CostCsvFileError, type CostMatchRow, type CostMatchStatus } from "@keel/core";
import { CostError, applyCostImport, enqueuePlatformWrite, recordPriceChanges, previewCostImport, setVariantCosts, variantCostRows, type PlatformWriteRow, type ServiceContext } from "@keel/services";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const priceSchema = z.object({ variantId: z.string().uuid(), priceMinor: z.coerce.number().int().min(0) });
const statusSchema = z.object({ productId: z.string().uuid(), status: z.enum(["active", "draft", "archived"]) });

/** Price change: local change and the outbox write in one transaction, then the write runs (queued or inline). */
export async function updateVariantPrice(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = priceSchema.safeParse({ variantId: formData.get("variantId"), priceMinor: Math.round(Number(formData.get("price")) * 100) });
    if (!parsed.success) return fail("invalid_input");
    const variant = await ctx.run(async (tx) => (await tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.id, parsed.data.variantId))).limit(1))[0]);
    if (!variant) return fail("not_found");
    const write = await ctx.run(async (tx) => {
      await tx.update(schema.productVariants).set({ priceMinor: parsed.data.priceMinor }).where(eq(schema.productVariants.id, variant.id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "variant.price_updated", entityType: "variant", entityId: variant.id, diff: { priceMinor: { from: variant.priceMinor, to: parsed.data.priceMinor } } });
      await recordPriceChanges({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, [{ variantId: variant.id, priceBeforeMinor: variant.priceMinor, priceAfterMinor: parsed.data.priceMinor, compareAtBeforeMinor: variant.compareAtMinor, compareAtAfterMinor: variant.compareAtMinor }], { source: "manual" });
      return variant.externalId ? enqueuePlatformWrite({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { kind: "variant.update", entityType: "variant", entityId: variant.id, payload: { variantExternalId: variant.externalId, priceMinor: parsed.data.priceMinor } }) : null;
    });
    await dispatchPlatformWrites(ctx, [write]);
    revalidatePath(`/t/${slug}/products/${variant.productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function updateProductStatus(slug: string, productId: string, status: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = statusSchema.safeParse({ productId, status });
    if (!parsed.success) return fail("invalid_input");
    const product = await ctx.run(async (tx) => (await tx.select().from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, productId))).limit(1))[0]);
    if (!product) return fail("not_found");
    const write = await ctx.run(async (tx) => {
      await tx.update(schema.products).set({ status: parsed.data.status }).where(eq(schema.products.id, productId));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "product.status_updated", entityType: "product", entityId: productId, diff: { status: { from: product.status, to: parsed.data.status } } });
      return product.externalId ? enqueuePlatformWrite({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { kind: "product.status", entityType: "product", entityId: productId, payload: { productExternalId: product.externalId, status: parsed.data.status } }) : null;
    });
    await dispatchPlatformWrites(ctx, [write]);
    revalidatePath(`/t/${slug}/products/${productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function toggleRepurchasable(slug: string, productId: string, value: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "products");
    await ctx.run(async (tx) => {
      await tx.update(schema.products).set({ isRepurchasable: value }).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, productId)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "product.repurchasable_updated", entityType: "product", entityId: productId, diff: { isRepurchasable: { from: !value, to: value } } });
    });
    revalidatePath(`/t/${slug}/products/${productId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/* ---------- product cost ---------- */

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const applyToSchema = z.enum(["missing", "all"]).default("missing");
const costsSchema = z.object({ productId: z.string().uuid(), applyTo: applyToSchema, costs: z.array(z.object({ variantId: z.string().uuid(), cost: z.string().max(32) })).min(1).max(500) });

/**
 * Cost changes go to the platform (when the tenant opted in) through the outbox, enqueued in the
 * same transaction as the local write; the caller dispatches them after the commit.
 */
async function enqueueCostWrites(ctx: TenantContext, s: ServiceContext, changed: readonly { variantId: string; toMinor: number }[]): Promise<PlatformWriteRow[]> {
  if (!ctx.settings.costWriteBack || !changed.length) return [];
  const refs = await variantCostRows(s, changed.map((c) => c.variantId));
  const writes: PlatformWriteRow[] = [];
  for (const c of changed) {
    const v = refs.find((r) => r.id === c.variantId);
    if (v?.externalId) writes.push(await enqueuePlatformWrite(s, { kind: "variant.cost", entityType: "variant", entityId: v.id, payload: { variantExternalId: v.externalId, inventoryItemExternalId: v.inventoryItemExternalId, costMinor: c.toMinor } }));
  }
  return writes;
}

/** Cost per variant (and in bulk for the product): empty fields are left as they are. */
export async function saveVariantCosts(slug: string, input: unknown): Promise<ActionResult<{ changed: number; lines: number }>> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = costsSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const wanted: { variantId: string; costMinor: number }[] = [];
    for (const c of parsed.data.costs) {
      if (!c.cost.trim()) continue;
      const minor = parseAmountToMinor(c.cost);
      if (minor === null) return fail("invalid_input", { [c.variantId]: "invalid_cost" });
      wanted.push({ variantId: c.variantId, costMinor: minor });
    }
    const current = await ctx.run((tx) => variantCostRows(svc(ctx, tx), wanted.map((w) => w.variantId)));
    if (current.length !== wanted.length || current.some((v) => v.productId !== parsed.data.productId)) return fail("not_found");
    const changes = wanted.filter((w) => current.find((v) => v.id === w.variantId)!.costMinor !== w.costMinor);
    if (!changes.length) return ok({ changed: 0, lines: 0 });
    const { res, writes } = await ctx.run(async (tx) => {
      const res = await setVariantCosts(svc(ctx, tx), changes, { source: "manual", applyTo: parsed.data.applyTo, audit: auditActor(ctx) });
      return { res, writes: await enqueueCostWrites(ctx, svc(ctx, tx), res.changed) };
    });
    await dispatchPlatformWrites(ctx, writes);
    revalidatePath(`/t/${slug}/products/${parsed.data.productId}`);
    revalidatePath(`/t/${slug}/products/quality`);
    return ok({ changed: res.changed.length, lines: res.linesUpdated });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof CostError) return fail(e.code === "not_found" ? "not_found" : "invalid_input");
    throw e;
  }
}

/** At most this many rows travel back to the browser per status; the counts are always complete. */
const PREVIEW_ROWS_PER_STATUS = 100;
const importSchema = z.object({ csv: z.string().min(1).max(2_000_000), fileName: z.string().max(200).nullable().default(null), applyTo: applyToSchema });
export interface CostImportPreviewView {
  fileError: CostCsvFileError | null;
  counts: Record<CostMatchStatus, number> | null;
  rows: Pick<CostMatchRow, "line" | "sku" | "supplierSku" | "rawCost" | "costMinor" | "error" | "status" | "label" | "fromMinor">[];
}

/** Import step 1: parse and match, nothing written. */
export async function previewCostImportAction(slug: string, input: unknown): Promise<ActionResult<CostImportPreviewView>> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const { error, preview } = await ctx.run((tx) => previewCostImport(svc(ctx, tx), parsed.data.csv));
    if (error || !preview) return ok({ fileError: error, counts: null, rows: [] });
    const shown = new Map<string, number>();
    const rows = preview.rows.filter((r) => {
      const n = shown.get(r.status) ?? 0;
      shown.set(r.status, n + 1);
      return n < PREVIEW_ROWS_PER_STATUS;
    });
    return ok({ fileError: null, counts: preview.counts, rows: rows.map(({ line, sku, supplierSku, rawCost, costMinor, error: rowError, status, label, fromMinor }) => ({ line, sku, supplierSku, rawCost, costMinor, error: rowError, status, label, fromMinor })) });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Import step 2: the same file again, re-matched and written; one audit entry for the import. */
export async function confirmCostImportAction(slug: string, input: unknown): Promise<ActionResult<{ written: number; lines: number }>> {
  try {
    const ctx = await requireWrite(slug, "products");
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const { res, writes } = await ctx.run(async (tx) => {
      const res = await applyCostImport(svc(ctx, tx), parsed.data.csv, { applyTo: parsed.data.applyTo, fileName: parsed.data.fileName, audit: auditActor(ctx) });
      return { res, writes: res.result ? await enqueueCostWrites(ctx, svc(ctx, tx), res.result.changed) : [] };
    });
    if (res.error || !res.result) return fail("invalid_input");
    await dispatchPlatformWrites(ctx, writes);
    revalidatePath(`/t/${slug}/products`, "layout");
    return ok({ written: res.result.changed.length, lines: res.result.linesUpdated });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof CostError) return fail("invalid_input");
    throw e;
  }
}

/** Tenant switch: costs edited or imported in Keel are also written to the platform (owner and admin). */
export async function saveCostWriteBackAction(slug: string, enabled: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const next = tenantSettingsSchema.parse({ ...ctx.settings, costWriteBack: Boolean(enabled) });
    await adminDb().update(schema.tenants).set({ settings: next }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.cost_write_back_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: diffRecords({ costWriteBack: ctx.settings.costWriteBack }, { costWriteBack: next.costWriteBack }) }));
    revalidatePath(`/t/${slug}/products`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

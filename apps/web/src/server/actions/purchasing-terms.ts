"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@hullwise/db";
import { PurchasingError, createPoFromMix, deleteCasePack, saveCasePack, setDefaultSupplier, variantsForBulkSupplier, type ServiceContext } from "@hullwise/services";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const planningTenant = (ctx: TenantContext) => ({ id: ctx.tenant.id, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, settings: ctx.settings });

function mapError(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof PurchasingError) return fail(e.code === "not_found" ? "not_found" : "invalid_input", { reason: e.code });
  throw e;
}

/** Blank → keep (undefined) in bulk mode, clear (null) in single mode; otherwise a number. */
const num = (v: FormDataEntryValue | null, blank: null | undefined, scale = 1) => (v === null || String(v).trim() === "" ? blank : Number(String(v).replace(",", ".")) * scale);

async function auditTerms(ctx: TenantContext, tx: ServiceContext["tx"], changes: { variantId: string; diff: Record<string, { from: unknown; to: unknown }> }[], meta: Record<string, unknown>) {
  for (const c of changes) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "variant.supplier_terms_set", entityType: "variant", entityId: c.variantId, diff: c.diff, metadata: meta });
}

const termsSchema = z.object({ supplierId: z.string().uuid().nullable(), supplierSku: z.string().max(80).nullable().optional(), unitCostMinor: z.number().int().min(0).max(100_000_000).nullable().optional(), moq: z.number().int().min(0).max(1_000_000).nullable().optional(), orderMultiple: z.number().int().min(0).max(100_000).nullable().optional(), leadTimeDays: z.number().int().min(0).max(730).nullable().optional() });

function parseTerms(formData: FormData, blank: null | undefined) {
  const cost = num(formData.get("unitCost"), blank, 100);
  return termsSchema.safeParse({
    supplierId: formData.get("supplierId") || null,
    supplierSku: blank === undefined && !String(formData.get("supplierSku") ?? "").trim() ? undefined : String(formData.get("supplierSku") ?? "").trim() || null,
    unitCostMinor: typeof cost === "number" ? Math.round(cost) : cost,
    moq: num(formData.get("moq"), blank),
    orderMultiple: num(formData.get("orderMultiple"), blank),
    leadTimeDays: num(formData.get("leadTimeDays"), blank),
  });
}

/** Default supplier and terms of one variant (product page). Empty fields are cleared. */
export async function saveVariantSupplierAction(slug: string, variantId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const parsed = parseTerms(formData, null);
    if (!parsed.success || !z.string().uuid().safeParse(variantId).success) return fail("invalid_input");
    const { supplierId, ...terms } = parsed.data;
    await ctx.run(async (tx) => auditTerms(ctx, tx, await setDefaultSupplier(svc(ctx, tx), [variantId], supplierId, terms), { scope: "variant" }));
    revalidatePath(`/t/${slug}/products`, "layout");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const bulkScope = z.object({ productId: z.string().uuid().optional(), productType: z.string().max(120).optional(), vendor: z.string().max(120).optional(), skuPrefix: z.string().max(60).optional(), onlyWithoutSupplier: z.boolean() });

/**
 * Default supplier for many variants at once: every variant of a product (product page) or the
 * variants matched by product type, vendor or SKU prefix (suppliers page). Empty fields are kept.
 */
export async function bulkSupplierAction(slug: string, _prev: ActionResult<{ updated: number; matched: number }> | null, formData: FormData): Promise<ActionResult<{ updated: number; matched: number }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const parsed = parseTerms(formData, undefined);
    const scope = bulkScope.safeParse({ productId: formData.get("productId") || undefined, productType: formData.get("productType") || undefined, vendor: formData.get("vendor") || undefined, skuPrefix: String(formData.get("skuPrefix") ?? "").trim() || undefined, onlyWithoutSupplier: formData.get("onlyWithoutSupplier") === "on" });
    if (!parsed.success || !scope.success || !parsed.data.supplierId) return fail("invalid_input");
    const s = scope.data;
    // a filter is required: never every variant of the catalogue by accident
    if (!s.productId && !s.productType && !s.vendor && !s.skuPrefix && !s.onlyWithoutSupplier) return fail("invalid_input");
    const { supplierId, ...terms } = parsed.data;
    const r = await ctx.run(async (tx) => {
      const ids = await variantsForBulkSupplier(svc(ctx, tx), { productIds: s.productId ? [s.productId] : undefined, productType: s.productType, vendor: s.vendor, skuPrefix: s.skuPrefix, onlyWithoutSupplier: s.onlyWithoutSupplier });
      const changes = await setDefaultSupplier(svc(ctx, tx), ids, supplierId, terms);
      await auditTerms(ctx, tx, changes, { scope: "bulk", filter: s, supplierId });
      return { updated: changes.length, matched: ids.length };
    });
    revalidatePath(`/t/${slug}/products`, "layout");
    revalidatePath(`/t/${slug}/purchasing/suppliers`);
    return ok(r);
  } catch (e) {
    return mapError(e) as ActionResult<{ updated: number; matched: number }>;
  }
}

const packSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80), optionName: z.string().trim().min(1).max(60), productId: z.string().uuid().nullable(), isActive: z.boolean(), units: z.record(z.string(), z.number().int().min(0).max(10_000)) });

/** Case pack: name, option, units per option value (`unit_<value>` fields), optional product. */
export async function saveCasePackAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const units: Record<string, number> = {};
    for (const [k, v] of formData.entries()) if (k.startsWith("unit_") && String(v).trim() !== "") units[k.slice(5)] = Number(v);
    const parsed = packSchema.safeParse({ id: formData.get("id") || undefined, name: formData.get("name"), optionName: formData.get("optionName"), productId: formData.get("productId") || null, isActive: formData.get("hasActive") ? formData.get("isActive") === "on" : true, units });
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const r = await saveCasePack(svc(ctx, tx), parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: r.created ? "case_pack.created" : "case_pack.updated", entityType: "case_pack", entityId: r.id, diff: r.diff });
    });
    revalidatePath(`/t/${slug}/purchasing/packs`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deleteCasePackAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    await ctx.run(async (tx) => {
      const r = await deleteCasePack(svc(ctx, tx), id);
      if (!r) throw new PurchasingError("not_found");
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "case_pack.deleted", entityType: "case_pack", entityId: id, metadata: r });
    });
    revalidatePath(`/t/${slug}/purchasing/packs`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const mixSchema = z.object({
  supplierId: z.string().uuid(),
  destinationLocationId: z.string().uuid().nullable(),
  lookbackDays: z.coerce.number().int().min(30).max(730),
  allocation: z.discriminatedUnion("mode", [z.object({ mode: z.literal("units"), totalUnits: z.number().int().min(1).max(1_000_000), multiple: z.number().int().min(1).max(10_000).nullable().optional() }), z.object({ mode: z.literal("packs"), packId: z.string().uuid(), packsByGroup: z.record(z.string(), z.number().int().min(0).max(10_000)) })]),
});

/** Option mix → draft PO: the allocation is recomputed on the server from the same inputs as the preview. */
export async function createPoFromMixAction(slug: string, productId: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    let allocation: unknown = null;
    try {
      allocation = JSON.parse(String(formData.get("allocation") ?? "null"));
    } catch {
      return fail("invalid_input");
    }
    const parsed = mixSchema.safeParse({ supplierId: formData.get("supplierId"), destinationLocationId: formData.get("destinationLocationId") || null, lookbackDays: formData.get("lookbackDays") ?? 180, allocation });
    if (!parsed.success || !z.string().uuid().safeParse(productId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const res = await createPoFromMix(svc(ctx, tx), planningTenant(ctx), { productId, ...parsed.data, expectedAt: null });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.created", entityType: "purchase_order", entityId: res.id, metadata: { from: "option_mix", productId, allocation: parsed.data.allocation, lines: res.lines, units: res.units } });
      return res;
    });
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ id: r.id });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
  }
}

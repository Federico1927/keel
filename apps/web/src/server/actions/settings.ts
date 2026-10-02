"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { diffRecords, tenantSettingsSchema } from "@keel/core";
import { SUPPORTED_LOCALES } from "@keel/config";
import { requireAction, ForbiddenError } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const generalSchema = z.object({
  name: z.string().trim().min(2).max(80),
  country: z.string().trim().length(2).toUpperCase(),
  currency: z.string().trim().length(3).toUpperCase(),
  timezone: z.string().trim().min(3),
  defaultLocale: z.enum(SUPPORTED_LOCALES),
  orderNumberPrefix: z.string().trim().max(10),
});

function num(v: FormDataEntryValue | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function updateGeneralSettings(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = generalSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
    try {
      Intl.DateTimeFormat(undefined, { timeZone: parsed.data.timezone });
    } catch {
      return fail("invalid_input", { timezone: "invalid" });
    }
    const prev = ctx.tenant;
    const next = parsed.data;
    const diff = diffRecords(
      { name: prev.name, country: prev.country, currency: prev.currency, timezone: prev.timezone, defaultLocale: prev.defaultLocale, orderNumberPrefix: prev.orderNumberPrefix },
      next,
    );
    // tenants is a platform table: written through the admin connection, audited in the tenant.
    await adminDb().update(schema.tenants).set(next).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.general_updated", entityType: "tenant", entityId: ctx.tenant.id, diff }));
    revalidatePath(`/t/${slug}`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function updateOperationalSettings(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const current = ctx.settings;
    const candidate = {
      ...current,
      lowStockThreshold: num(formData.get("lowStockThreshold")) ?? current.lowStockThreshold,
      coverageDaysWarning: num(formData.get("coverageDaysWarning")) ?? current.coverageDaysWarning,
      coverageDaysCritical: num(formData.get("coverageDaysCritical")) ?? current.coverageDaysCritical,
      salesVelocityLookbackDays: num(formData.get("salesVelocityLookbackDays")) ?? current.salesVelocityLookbackDays,
      reorderTargetDays: num(formData.get("reorderTargetDays")) ?? current.reorderTargetDays,
      roiGood: num(formData.get("roiGood")) ?? current.roiGood,
      roiMedium: num(formData.get("roiMedium")) ?? current.roiMedium,
      campaignStockThreshold: num(formData.get("campaignStockThreshold")) ?? current.campaignStockThreshold,
      duplicateOrderWindowDays: num(formData.get("duplicateOrderWindowDays")) ?? current.duplicateOrderWindowDays,
      shipmentStuckDays: num(formData.get("shipmentStuckDays")) ?? current.shipmentStuckDays,
      returnWindowDays: num(formData.get("returnWindowDays")) ?? current.returnWindowDays,
      returnShippingFallbackDays: num(formData.get("returnShippingFallbackDays")) ?? current.returnShippingFallbackDays,
      returnExcludedProductTypes: formData.has("returnExcludedProductTypes") ? String(formData.get("returnExcludedProductTypes")).split(",").map((x) => x.trim()).filter(Boolean) : current.returnExcludedProductTypes,
      shippingCostMinor: num(formData.get("shippingCostMinor")) ?? current.shippingCostMinor,
      churnLowPct: num(formData.get("churnLowPct")) ?? current.churnLowPct,
      churnMediumPct: num(formData.get("churnMediumPct")) ?? current.churnMediumPct,
      // checkboxes: only read when the backorder card was part of the submitted form
      backorderHold: formData.has("backorderSettings") ? formData.get("backorderHold") === "on" : current.backorderHold,
      backorderPlatformHold: formData.has("backorderSettings") ? formData.get("backorderPlatformHold") === "on" : current.backorderPlatformHold,
      paymentFeeBps: { ...current.paymentFeeBps },
      paymentFeeFixedMinor: { ...current.paymentFeeFixedMinor },
    };
    for (const m of Object.keys(candidate.paymentFeeBps) as (keyof typeof candidate.paymentFeeBps)[]) {
      const bps = num(formData.get(`fee_bps_${m}`));
      const fixed = num(formData.get(`fee_fixed_${m}`));
      if (bps !== undefined) candidate.paymentFeeBps[m] = Math.round(bps);
      if (fixed !== undefined) candidate.paymentFeeFixedMinor[m] = Math.round(fixed);
    }
    const parsed = tenantSettingsSchema.safeParse(candidate);
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const diff = diffRecords(current as unknown as Record<string, unknown>, parsed.data as unknown as Record<string, unknown>);
    await adminDb().update(schema.tenants).set({ settings: parsed.data }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.operational_updated", entityType: "tenant", entityId: ctx.tenant.id, diff }));
    revalidatePath(`/t/${slug}/settings`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const taxSchema = z.object({ country: z.string().trim().length(2).toUpperCase(), rateBps: z.coerce.number().int().min(0).max(10000), pricesIncludeTax: z.coerce.boolean() });

export async function upsertTaxRate(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = taxSchema.safeParse({ country: formData.get("country"), rateBps: Math.round(Number(formData.get("ratePercent")) * 100), pricesIncludeTax: formData.get("pricesIncludeTax") === "on" });
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await tx
        .insert(schema.tenantTaxRates)
        .values({ tenantId: ctx.tenant.id, ...parsed.data })
        .onConflictDoUpdate({ target: [schema.tenantTaxRates.tenantId, schema.tenantTaxRates.country], set: { rateBps: parsed.data.rateBps, pricesIncludeTax: parsed.data.pricesIncludeTax } });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.tax_rate.upserted", entityType: "tax_rate", entityId: parsed.data.country, diff: { rateBps: { from: null, to: parsed.data.rateBps } } });
    });
    revalidatePath(`/t/${slug}/settings`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function deleteTaxRate(slug: string, country: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    await ctx.run(async (tx) => {
      await tx.delete(schema.tenantTaxRates).where(and(eq(schema.tenantTaxRates.tenantId, ctx.tenant.id), eq(schema.tenantTaxRates.country, country)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.tax_rate.deleted", entityType: "tax_rate", entityId: country });
    });
    revalidatePath(`/t/${slug}/settings`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

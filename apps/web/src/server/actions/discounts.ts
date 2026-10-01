"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@keel/db";
import { createDiscountCode, createDiscountPool, DiscountError, setDiscountActive } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const date = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : new Date(String(v))), z.date().nullable());
const codeSchema = z.object({ code: z.string().trim().min(2).max(40), title: z.string().trim().min(1).max(120), type: z.enum(["percentage", "fixed_amount", "free_shipping"]), value: z.coerce.number().min(0), startsAt: date, endsAt: date, usageLimit: z.preprocess((v) => (v === "" || v === null ? null : Number(v)), z.number().int().min(1).nullable()), minimumAmount: z.preprocess((v) => (v === "" || v === null ? null : Number(v)), z.number().min(0).nullable()) });
const poolSchema = z.object({ title: z.string().trim().min(1).max(120), prefix: z.string().trim().min(1).max(12), type: z.enum(["percentage", "fixed_amount"]), value: z.coerce.number().min(0), size: z.coerce.number().int().min(1).max(10000), startsAt: date, endsAt: date });

export async function createDiscountCodeAction(slug: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    const parsed = codeSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    const value = d.type === "percentage" ? Math.round(d.value * 100) : d.type === "fixed_amount" ? Math.round(d.value * 100) : 0;
    const platform = await getCommercePlatform(ctx);
    const id = await ctx.run(async (tx) => {
      const id = await createDiscountCode({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { code: d.code, title: d.title, type: d.type, value, startsAt: d.startsAt, endsAt: d.endsAt, usageLimit: d.usageLimit, minimumAmountMinor: d.minimumAmount === null ? null : Math.round(d.minimumAmount * 100) }, (i) => platform.createDiscountCode({ code: i.code, title: i.title, type: i.type, value: i.value, startsAt: i.startsAt, endsAt: i.endsAt, usageLimit: i.usageLimit, minimumAmountMinor: i.minimumAmountMinor }));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount.created", entityType: "discount", entityId: id, diff: { code: { from: null, to: d.code.toUpperCase() }, type: { from: null, to: d.type }, value: { from: null, to: value } } });
      return id;
    });
    revalidatePath(`/t/${slug}/discounts`);
    return ok({ id });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof DiscountError) return fail(`discount_${e.code}`);
    throw e;
  }
}

export async function createDiscountPoolAction(slug: string, _prev: ActionResult<{ poolId: string; imported: number; failed: number }> | null, formData: FormData): Promise<ActionResult<{ poolId: string; imported: number; failed: number }>> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    const parsed = poolSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    const platform = await getCommercePlatform(ctx);
    const result = await ctx.run(async (tx) => {
      const r = await createDiscountPool({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { title: d.title, prefix: d.prefix, type: d.type, value: Math.round(d.value * 100), size: d.size, startsAt: d.startsAt, endsAt: d.endsAt }, (i) => platform.createDiscountPool(i));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount_pool.created", entityType: "discount_pool", entityId: r.poolId, diff: { title: { from: null, to: d.title }, size: { from: null, to: d.size }, imported: { from: null, to: r.imported } } });
      return r;
    });
    revalidatePath(`/t/${slug}/discounts`);
    return ok(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof DiscountError) return fail(`discount_${e.code}`);
    throw e;
  }
}

export async function setDiscountActiveAction(slug: string, discountId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    if (!z.string().uuid().safeParse(discountId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await setDiscountActive({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, discountId, isActive);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: isActive ? "discount.enabled" : "discount.disabled", entityType: "discount", entityId: discountId, diff: { isActive: { from: !isActive, to: isActive } } });
    });
    revalidatePath(`/t/${slug}/discounts`);
    revalidatePath(`/t/${slug}/discounts/${discountId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

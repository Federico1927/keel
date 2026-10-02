"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { normalizeEmail } from "@hullwise/core";
import { assignPoolCodes, createDiscountCode, createDiscountPool, DiscountError, PoolError, releasePoolCode, runPlatformWriteNow, setDiscountActive, setDiscountPoolActive, topUpDiscountPool } from "@hullwise/services";
import { getCommercePlatform } from "@/server/integrations";
import { dispatchPendingWritesFor, dispatchPlatformWrites } from "@/server/platform-writes";
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
    // created locally with its platform write enqueued (outbox); the external id arrives when the write succeeds
    const id = await ctx.run(async (tx) => {
      const id = await createDiscountCode({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { code: d.code, title: d.title, type: d.type, value, startsAt: d.startsAt, endsAt: d.endsAt, usageLimit: d.usageLimit, minimumAmountMinor: d.minimumAmount === null ? null : Math.round(d.minimumAmount * 100) });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount.created", entityType: "discount", entityId: id, diff: { code: { from: null, to: d.code.toUpperCase() }, type: { from: null, to: d.type }, value: { from: null, to: value } } });
      return id;
    });
    await dispatchPendingWritesFor(ctx, "discount", [id]);
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
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      // synchronous (recorded in the outbox): the form shows how many codes the platform accepted
      const r = await createDiscountPool(s, { title: d.title, prefix: d.prefix, type: d.type, value: Math.round(d.value * 100), size: d.size, startsAt: d.startsAt, endsAt: d.endsAt }, (i) => runPlatformWriteNow(s, platform, { kind: "discount.pool", entityType: "discount_pool", payload: { title: i.title, codes: i.codes, type: i.type, value: i.value, startsAt: i.startsAt?.toISOString() ?? null, endsAt: i.endsAt?.toISOString() ?? null } }));
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

/** One code on or off: local at once, the platform through the outbox (badge shows the sync state). */
export async function setDiscountActiveAction(slug: string, discountId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    if (!z.string().uuid().safeParse(discountId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const r = await setDiscountActive({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, discountId, isActive);
      if (r.changed) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: isActive ? "discount.enabled" : "discount.disabled", entityType: "discount", entityId: discountId, diff: { isActive: { from: !isActive, to: isActive } }, metadata: { platformWriteId: r.write?.id ?? null } });
      return r;
    });
    await dispatchPlatformWrites(ctx, [r.write]);
    revalidatePath(`/t/${slug}/discounts`);
    revalidatePath(`/t/${slug}/discounts/${discountId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof DiscountError) return fail(`discount_${e.code}`);
    throw e;
  }
}

const uuid = z.string().uuid();
const poolPaths = (slug: string, poolId: string) => {
  revalidatePath(`/t/${slug}/discounts`);
  revalidatePath(`/t/${slug}/discounts/pools/${poolId}`);
};
const poolFail = (e: unknown): ActionResult<never> => {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof PoolError) return fail(`pool_${e.code}`);
  throw e;
};

/** A whole pool on or off (issue #35): every code locally, the pool's discount on the platform through the outbox. */
export async function setDiscountPoolActiveAction(slug: string, poolId: string, isActive: boolean): Promise<ActionResult<{ codes: number }>> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    if (!uuid.safeParse(poolId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const r = await setDiscountPoolActive({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, poolId, isActive);
      if (r.changed) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: isActive ? "discount_pool.enabled" : "discount_pool.disabled", entityType: "discount_pool", entityId: poolId, diff: { isActive: { from: !isActive, to: isActive } }, metadata: { codes: r.codes, platformWriteId: r.write?.id ?? null } });
      return r;
    });
    await dispatchPlatformWrites(ctx, [r.write]);
    poolPaths(slug, poolId);
    return ok({ codes: r.codes });
  } catch (e) {
    return poolFail(e);
  }
}

const topUpSchema = z.object({ target: z.coerce.number().int().min(1).max(10000) });

/** Generates codes until the pool has `target` codes ready, pushed to the pool's discount (synchronous: the form shows what the platform accepted). */
export async function topUpDiscountPoolAction(slug: string, poolId: string, _prev: ActionResult<{ added: number; imported: number; failed: number }> | null, formData: FormData): Promise<ActionResult<{ added: number; imported: number; failed: number }>> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    const parsed = topUpSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!uuid.safeParse(poolId).success || !parsed.success) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await topUpDiscountPool(s, poolId, parsed.data.target, (i) => runPlatformWriteNow(s, platform, { kind: "discount.pool", entityType: "discount_pool", entityId: poolId, payload: { title: i.title, codes: i.codes, type: i.type, value: i.value, startsAt: i.startsAt?.toISOString() ?? null, endsAt: i.endsAt?.toISOString() ?? null, poolExternalId: i.poolExternalId } }));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount_pool.topped_up", entityType: "discount_pool", entityId: poolId, diff: { targetSize: { from: null, to: r.target } }, metadata: { added: r.added, imported: r.imported, failed: r.failed } });
      return r;
    });
    poolPaths(slug, poolId);
    return ok({ added: r.added, imported: r.imported, failed: r.failed });
  } catch (e) {
    return poolFail(e);
  }
}

const assignSchema = z.object({ target: z.enum(["customer", "campaign"]), customerEmail: z.string().trim().max(200).optional(), campaignId: z.string().optional(), count: z.coerce.number().int().min(1).max(1000) });

/** Hands the next available codes to a customer (by email) or a campaign. */
export async function assignPoolCodesAction(slug: string, poolId: string, _prev: ActionResult<{ codes: string[] }> | null, formData: FormData): Promise<ActionResult<{ codes: string[] }>> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    const parsed = assignSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!uuid.safeParse(poolId).success || !parsed.success) return fail("invalid_input");
    const d = parsed.data;
    const r = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      let customerId: string | null = null;
      let campaignId: string | null = null;
      if (d.target === "customer") {
        const email = normalizeEmail(d.customerEmail ?? "");
        const [c] = email ? await tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenant.id), eq(schema.customers.emailNormalized, email))).limit(1) : [];
        if (!c) return null;
        customerId = c.id;
      } else {
        if (!uuid.safeParse(d.campaignId).success) return null;
        campaignId = d.campaignId!;
      }
      const r = await assignPoolCodes(s, poolId, { customerId, campaignId, count: d.count });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount_pool.codes_assigned", entityType: "discount_pool", entityId: poolId, diff: { assignedTo: { from: null, to: customerId ? `customer:${customerId}` : `campaign:${campaignId}` } }, metadata: { codes: r.codes } });
      return r;
    });
    if (!r) return fail("pool_recipient_not_found");
    poolPaths(slug, poolId);
    return ok({ codes: r.codes });
  } catch (e) {
    return poolFail(e);
  }
}

/** Takes an assigned code back into the pool. */
export async function releasePoolCodeAction(slug: string, poolId: string, discountId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "create_discount", "discounts");
    if (!uuid.safeParse(poolId).success || !uuid.safeParse(discountId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const r = await releasePoolCode({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, discountId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "discount_pool.code_released", entityType: "discount", entityId: discountId, diff: { assignedCustomerId: { from: r.from.customerId, to: null }, assignedCampaignId: { from: r.from.campaignId, to: null } }, metadata: { code: r.code, poolId } });
    });
    poolPaths(slug, poolId);
    return ok();
  } catch (e) {
    return poolFail(e);
  }
}

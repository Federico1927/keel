"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SUPPORTED_LOCALES, canWritePage } from "@keel/config";
import { SHOPIFY_RETURN_REASONS } from "@keel/integrations";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { RETURN_STATUSES, diffRecords, tenantSettingsSchema } from "@keel/core";
import { decryptJson } from "@keel/integrations";
import { createReturn, getPortalConfig, ReturnError, savePortalConfig, saveReturnReason, setReturnReasonActive, syncReturnToPlatform, transitionReturn } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireAction, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const createSchema = z.object({
  orderId: z.string().uuid(),
  reasonCode: z.string().min(1),
  resolution: z.enum(["refund", "exchange", "voucher"]),
  lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.coerce.number().int().min(0) })).min(1),
  customerNote: z.string().max(1000).optional().nullable(),
  staffNote: z.string().max(1000).optional().nullable(),
  overrideWindow: z.boolean().optional(),
});

async function requireReturnsWrite(slug: string) {
  const ctx = await requirePage(slug, "returns");
  if (!canWritePage(ctx.role, "returns")) throw new ForbiddenError("edit");
  return ctx;
}

export async function createReturnAction(slug: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const created = await ctx.run(async (tx) => {
      const r = await createReturn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.settings, parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "return.created", entityType: "return", entityId: r.id, diff: { number: { from: null, to: r.number }, orderId: { from: null, to: parsed.data.orderId } } });
      return r;
    });
    await syncAfter(ctx, created.id);
    revalidatePath(`/t/${slug}/returns`);
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    return ok({ id: created.id });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail(`return_${e.code}`);
    throw e;
  }
}

const transitionSchema = z.object({
  to: z.enum(["approved", "received", "inspected", "refunded", "exchanged", "voucher_issued", "rejected"]),
  note: z.string().max(1000).optional().nullable(),
  restock: z.object({ locationId: z.string().uuid(), lineIds: z.array(z.string().uuid()) }).optional().nullable(),
  inspection: z.array(z.object({ lineId: z.string().uuid(), outcome: z.enum(["intact", "damaged", "missing"]), amountMinor: z.coerce.number().int().min(0) })).optional(),
  refundAmountMinor: z.coerce.number().int().min(0).optional().nullable(),
  voucherCode: z.string().max(60).optional().nullable(),
  fault: z.enum(["merchant", "customer", "undetermined"]).optional(),
});

/** Writes the return to the commerce platform after the change is committed; never fails the user action. */
async function syncAfter(ctx: TenantContext, returnId: string): Promise<string> {
  if (!ctx.settings.returnsWriteBack) return "not_required";
  const platform = await getCommercePlatform(ctx);
  const r = await ctx.run((tx) => syncReturnToPlatform({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, ctx.settings, returnId));
  return r.status;
}

export async function transitionReturnAction(slug: string, returnId: string, input: unknown): Promise<ActionResult<{ next: string; sync: string }>> {
  try {
    const ctx = await requireAction(slug, "approve_return", "returns");
    const parsed = transitionSchema.safeParse(input);
    if (!parsed.success || !z.string().uuid().safeParse(returnId).success) return fail("invalid_input");
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await transitionReturn(s, { returnId, ...parsed.data });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: `return.${parsed.data.to}`, entityType: "return", entityId: returnId, diff: { status: { from: r.previous, to: r.next } } });
      return r;
    });
    const sync = await syncAfter(ctx, returnId);
    revalidatePath(`/t/${slug}/returns`);
    revalidatePath(`/t/${slug}/returns/${returnId}`);
    return ok({ next: result.next, sync });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail(`return_${e.code}`);
    throw e;
  }
}

export async function retryReturnSyncAction(slug: string, returnId: string): Promise<ActionResult<{ sync: string; error?: string }>> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await syncReturnToPlatform({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, ctx.settings, z.string().uuid().parse(returnId));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "return.platform_sync", entityType: "return", entityId: returnId, metadata: { status: res.status, steps: res.steps, error: res.error ?? null } });
      return res;
    });
    revalidatePath(`/t/${slug}/returns/${returnId}`);
    return ok({ sync: r.status, error: r.error });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Shows the refund bank details of a return; every reveal is audited. */
export async function revealBankDetailsAction(slug: string, returnId: string): Promise<ActionResult<{ holder: string; iban: string }>> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const details = await ctx.run(async (tx) => {
      const [r] = await tx.select({ enc: schema.returnRequests.bankDetailsEnc }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenant.id), eq(schema.returnRequests.id, returnId))).limit(1);
      if (!r?.enc) return null;
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "return.bank_details_viewed", entityType: "return", entityId: returnId });
      return decryptJson<{ holder: string; iban: string }>(r.enc);
    });
    return details ? ok(details) : fail("not_found");
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Saves the customer portal configuration (validated by the core schema). */
export async function savePortalConfigAction(slug: string, config: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireReturnsWrite(slug);
    await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const before = await getPortalConfig(s);
      const after = await savePortalConfig(s, config);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "return_portal.updated", entityType: "tenant", entityId: ctx.tenant.id, diff: diffRecords(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    });
    revalidatePath(`/t/${slug}/returns/portal`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail("invalid_input");
    throw e;
  }
}

const behaviourSchema = z.object({ returnShippingCostMinor: z.number().int().min(0).max(100_000), returnsWriteBack: z.boolean(), returnPlatformTags: z.record(z.string(), z.array(z.string().trim().min(1).max(40)).max(5)) });

/** Return shipping deduction, write-back switch and order tags per status (owner and admin). */
export async function saveReturnBehaviourAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = behaviourSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const tags = Object.fromEntries(Object.entries(parsed.data.returnPlatformTags).filter(([k, v]) => (RETURN_STATUSES as readonly string[]).includes(k) && v.length));
    const next = tenantSettingsSchema.parse({ ...ctx.settings, ...parsed.data, returnPlatformTags: tags });
    await adminDb().update(schema.tenants).set({ settings: next }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.returns_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: diffRecords(ctx.settings as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>) }));
    revalidatePath(`/t/${slug}/returns/portal`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

const reasonSchema = z.object({ code: z.string().min(1).max(40), label: z.string().min(1).max(120), defaultFault: z.enum(["merchant", "customer", "undetermined"]), sortOrder: z.coerce.number().int().min(0).optional(), platformReason: z.enum(SHOPIFY_RETURN_REASONS).nullable(), labels: z.record(z.string(), z.string().max(120)) });

export async function saveReturnReasonAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireReturnsWrite(slug);
    const labels = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, String(formData.get(`label_${l}`) ?? "").trim()]).filter(([, v]) => v));
    const parsed = reasonSchema.safeParse({ code: formData.get("code"), label: formData.get("label"), defaultFault: formData.get("defaultFault"), sortOrder: formData.get("sortOrder") || 0, platformReason: formData.get("platformReason") || null, labels });
    if (!parsed.success) return fail("invalid_input");
    const reasonId = String(formData.get("reasonId") || "") || undefined;
    await ctx.run(async (tx) => {
      const id = await saveReturnReason({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, parsed.data, reasonId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: reasonId ? "return_reason.updated" : "return_reason.created", entityType: "return_reason", entityId: id, diff: { code: { from: null, to: parsed.data.code }, label: { from: null, to: parsed.data.label } } });
    });
    revalidatePath(`/t/${slug}/returns/reasons`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof ReturnError) return fail("invalid_input");
    throw e;
  }
}

export async function toggleReturnReasonAction(slug: string, reasonId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireReturnsWrite(slug);
    await ctx.run(async (tx) => {
      await setReturnReasonActive({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, reasonId, isActive);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "return_reason.toggled", entityType: "return_reason", entityId: reasonId, diff: { isActive: { from: !isActive, to: isActive } } });
    });
    revalidatePath(`/t/${slug}/returns/reasons`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

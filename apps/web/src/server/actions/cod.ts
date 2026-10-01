"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@keel/config";
import { recordAudit } from "@keel/db";
import { CodError, assignQueueItem, deleteCapacityException, distributeUnassigned, recomputeRecipientProfiles, recordAttempt, releaseQueueItem, saveCapacity, saveCapacityException, saveCodSettings, scorePendingItems, scoreQueueItem, setRecipientOverride, syncQueue } from "@keel/addon-cod";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();
const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });

async function requireQueueWrite(slug: string) {
  const ctx = await requirePage(slug, "cod_queue");
  if (!canWritePage(ctx.role, "cod_queue")) throw new ForbiddenError("edit");
  return ctx;
}
async function requireCodSettings(slug: string) {
  const ctx = await requirePage(slug, "cod_settings");
  if (!canWritePage(ctx.role, "cod_settings")) throw new ForbiddenError("edit");
  return ctx;
}
const handle = (e: unknown): ActionResult => {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof CodError) return fail(`cod_${e.code}`);
  throw e;
};

const attemptSchema = z.object({ orderId: uuid, outcome: z.enum(["confirmed", "no_answer", "call_back", "cancelled", "modified"]), note: z.string().max(500).optional().nullable(), callBackAt: z.string().optional().nullable() });

export async function recordAttemptAction(slug: string, input: unknown): Promise<ActionResult<{ status: string; attemptNumber: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    const parsed = attemptSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const callBackAt = parsed.data.callBackAt ? new Date(parsed.data.callBackAt) : null;
    if (parsed.data.outcome === "call_back" && (!callBackAt || Number.isNaN(callBackAt.getTime()))) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const res = await recordAttempt(svc(ctx, tx), { orderId: parsed.data.orderId, outcome: parsed.data.outcome, note: parsed.data.note ?? null, callBackAt });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: `cod.attempt_${parsed.data.outcome}`, entityType: "order", entityId: parsed.data.orderId, diff: { attempt: { from: res.attemptNumber - 1, to: res.attemptNumber } }, metadata: { queueStatus: res.status } });
      return res;
    });
    revalidatePath(`/t/${slug}/cod`);
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<{ status: string; attemptNumber: number }>;
  }
}

export async function claimQueueItemAction(slug: string, orderId: string, userId?: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    const target = userId === undefined ? ctx.user.id : userId;
    if (target !== ctx.user.id && !canWritePage(ctx.role, "cod_settings") && ctx.role !== "operations") return fail("forbidden");
    await ctx.run(async (tx) => {
      await assignQueueItem(svc(ctx, tx), orderId, { source: "manual", timezone: ctx.tenant.timezone, userId: target });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.assigned", entityType: "order", entityId: orderId, diff: { assignedTo: { from: null, to: target } } });
    });
    revalidatePath(`/t/${slug}/cod`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function releaseQueueItemAction(slug: string, orderId: string): Promise<ActionResult> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    await ctx.run((tx) => releaseQueueItem(svc(ctx, tx), orderId, { isAdmin: ctx.role === "owner" || ctx.role === "admin" }));
    revalidatePath(`/t/${slug}/cod`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function distributeAction(slug: string): Promise<ActionResult<{ assigned: number; skipped: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      await syncQueue(s);
      const res = await distributeUnassigned(s, { source: "backfill", timezone: ctx.tenant.timezone });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.distributed", metadata: res });
      return res;
    });
    revalidatePath(`/t/${slug}/cod`);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<{ assigned: number; skipped: number }>;
  }
}

export async function rescoreAction(slug: string, orderId?: string): Promise<ActionResult<{ scored: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    const scored = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      if (orderId && uuid.safeParse(orderId).success) {
        await scoreQueueItem(s, orderId, { timezone: ctx.tenant.timezone });
        return 1;
      }
      await syncQueue(s);
      return scorePendingItems(s, { limit: 150, force: true, timezone: ctx.tenant.timezone });
    });
    revalidatePath(`/t/${slug}/cod`);
    if (orderId) revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok({ scored });
  } catch (e) {
    return handle(e) as ActionResult<{ scored: number }>;
  }
}

export async function saveCodSettingsAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    const num = (k: string) => (formData.has(k) && formData.get(k) !== "" ? Number(formData.get(k)) : undefined);
    const weights: Record<string, number> = {};
    for (const [k, v] of formData.entries()) if (k.startsWith("w_") && v !== "") weights[k.slice(2)] = Number(v);
    const patch = { weights, unreachableAfterAttempts: num("unreachableAfterAttempts"), queueCutoffDays: num("queueCutoffDays"), timeElapsedWarnHours: num("timeElapsedWarnHours"), customerHistoryHalfLifeDays: num("customerHistoryHalfLifeDays"), customerHistoryMinOrders: num("customerHistoryMinOrders"), similarOrdersLookbackDays: num("similarOrdersLookbackDays"), similarOrdersMinSample: num("similarOrdersMinSample"), orderValueMultiple: num("orderValueMultiple"), risk: { watchMinReturns: num("risk_watchMinReturns"), highRiskMinReturns: num("risk_highRiskMinReturns"), blacklistMinReturns: num("risk_blacklistMinReturns"), recentMonths: num("risk_recentMonths"), redemptionConsecutiveDeliveries: num("risk_redemptionConsecutiveDeliveries") } };
    const clean = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
    await ctx.run(async (tx) => {
      await saveCodSettings(svc(ctx, tx), clean);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.settings_updated", entityType: "cod_settings", diff: Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, { from: null, to: v }])) });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function saveCapacityAction(slug: string, userId: string, dailyHours: number[], isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    if (!uuid.safeParse(userId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await saveCapacity(svc(ctx, tx), { userId, dailyHours, isActive });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.capacity_updated", entityType: "user", entityId: userId, diff: { dailyHours: { from: null, to: dailyHours }, isActive: { from: null, to: isActive } } });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function saveExceptionAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    const parsed = z.object({ userId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(["off", "extra"]), hours: z.coerce.number().int().min(0).max(24).optional(), note: z.string().max(200).optional() }).safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    await ctx.run((tx) => saveCapacityException(svc(ctx, tx), { ...parsed.data, hours: parsed.data.kind === "extra" ? (parsed.data.hours ?? null) : null, note: parsed.data.note || null }));
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function deleteExceptionAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    if (!uuid.safeParse(id).success) return fail("invalid_input");
    await ctx.run((tx) => deleteCapacityException(svc(ctx, tx), id));
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function recomputeRiskAction(slug: string): Promise<ActionResult<{ profiles: number; flagged: number }>> {
  try {
    const ctx = await requireCodSettings(slug);
    const r = await ctx.run(async (tx) => {
      const res = await recomputeRecipientProfiles(svc(ctx, tx), undefined, ctx.tenant.country);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.risk_recomputed", metadata: res });
      return res;
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<{ profiles: number; flagged: number }>;
  }
}

export async function setOverrideAction(slug: string, recipientKey: string, override: "force_clean" | "force_blacklist" | null, reason: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    await ctx.run(async (tx) => {
      await setRecipientOverride(svc(ctx, tx), recipientKey, override, reason);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.risk_override", entityType: "recipient", entityId: recipientKey.replace(/\d(?=\d{3})/g, "•"), diff: { override: { from: null, to: override } }, metadata: { reason } });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

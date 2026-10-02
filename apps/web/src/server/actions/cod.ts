"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canWritePage } from "@keel/config";
import { recordAudit } from "@keel/db";
import { CodError, TAG_WRITE_EVENTS, assignQueueItem, bulkAssign, bulkOutcome, distributeEqually, escalateQueueItem, getCodSettings, importCarrierOutcomes, messageTemplateSchema, modifyCodOrder, deleteCapacityException, distributeUnassigned, parseCarrierCsv, parseTagList, recomputeRecipientProfiles, recordAttempt, releaseQueueItem, resolveEscalation, saveCapacity, saveCapacityException, saveCodSettings, scorePendingItems, scoreQueueItem, sendCodMessage, setRecipientOverride, syncQueue, transferQueueItem, warehouseLines, type ScoreFactor } from "@keel/addon-cod";
import { and, eq, schema, sql } from "@keel/db";
import { displayName } from "@keel/core";
import { getMessagingChannelFor, resolveAddressProvider } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
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
/** Error details with their own message (`cod_<detail>`): the rest fall back to the code's message. */
const DETAIL_CODES = new Set(["daily_limit", "already_called", "not_yours", "same_operator", "target", "template", "phone", "reason"]);
const handle = (e: unknown): ActionResult => {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof CodError) return fail(e.detail && DETAIL_CODES.has(e.detail) ? `cod_${e.detail}` : `cod_${e.code}`);
  throw e;
};
const isAdminRole = (ctx: TenantContext) => ctx.role === "owner" || ctx.role === "admin";
/** Supervisors of the queue: bulk actions, assigning to others. */
const isSupervisor = (ctx: TenantContext) => isAdminRole(ctx) || ctx.role === "operations";

const attemptSchema = z.object({ orderId: uuid, outcome: z.enum(["confirmed", "no_answer", "call_back", "cancelled", "modified", "confirm_scheduled"]), note: z.string().max(500).optional().nullable(), callBackAt: z.string().optional().nullable(), confirmOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable() });

export async function recordAttemptAction(slug: string, input: unknown): Promise<ActionResult<{ status: string; attemptNumber: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    const parsed = attemptSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const callBackAt = parsed.data.callBackAt ? new Date(parsed.data.callBackAt) : null;
    if (parsed.data.outcome === "call_back" && (!callBackAt || Number.isNaN(callBackAt.getTime()))) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await recordAttempt(svc(ctx, tx), { orderId: parsed.data.orderId, outcome: parsed.data.outcome, note: parsed.data.note ?? null, callBackAt, confirmOn: parsed.data.confirmOn ?? null }, undefined, { platform });
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
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      await syncQueue(s, undefined, { platform });
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
    const platform = await getCommercePlatform(ctx);
    const scored = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      if (orderId && uuid.safeParse(orderId).success) {
        await scoreQueueItem(s, orderId, { timezone: ctx.tenant.timezone });
        return 1;
      }
      await syncQueue(s, undefined, { platform });
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

export async function saveCapacityAction(slug: string, userId: string, dailyHours: number[], isActive: boolean, allowedTags?: string[]): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    if (!uuid.safeParse(userId).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await saveCapacity(svc(ctx, tx), { userId, dailyHours, isActive, allowedTags });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.capacity_updated", entityType: "user", entityId: userId, diff: { dailyHours: { from: null, to: dailyHours }, isActive: { from: null, to: isActive }, ...(allowedTags ? { allowedTags: { from: null, to: allowedTags } } : {}) } });
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

/** Tag vocabulary: which platform tags the queue reads and which it writes per event. */
export async function saveCodTagSettingsAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    const list = (k: string) => parseTagList(String(formData.get(k) ?? ""));
    const write = Object.fromEntries(TAG_WRITE_EVENTS.map((e) => [e, { add: list(`w_add_${e}`), remove: list(`w_remove_${e}`) }]));
    const patch = { tags: { queue: list("tags_queue"), confirmed: list("tags_confirmed"), cancelled: list("tags_cancelled"), clearQueueTagsOnClose: formData.get("clearQueueTagsOnClose") === "on", write }, cancelRestock: formData.get("cancelRestock") === "on" };
    await ctx.run(async (tx) => {
      await saveCodSettings(svc(ctx, tx), patch);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.tags_updated", entityType: "cod_settings", diff: { tags: { from: null, to: patch.tags }, cancelRestock: { from: null, to: patch.cancelRestock } } });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    revalidatePath(`/t/${slug}/cod`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

const addressSchema = z.object({ name: z.string().max(120).nullish(), address1: z.string().max(200).nullish(), address2: z.string().max(200).nullish(), city: z.string().max(120).nullish(), province: z.string().max(120).nullish(), zip: z.string().max(20).nullish(), country: z.string().max(2).nullish(), phone: z.string().max(40).nullish() });
const modifySchema = z.object({
  orderId: uuid,
  contact: z.object({ customerName: z.string().max(120).nullish(), phone: z.string().max(40).nullish(), email: z.string().max(200).nullish(), shippingAddress: addressSchema.nullish(), note: z.string().max(2000).nullish(), noteMode: z.enum(["replace", "append"]).optional() }).optional(),
  lines: z.array(z.object({ lineId: uuid.optional(), variantId: uuid.optional(), quantity: z.number().int().min(0).max(999) })).max(50).optional(),
  mergeOrderIds: z.array(uuid).max(10).optional(),
  paymentMethod: z.enum(["card", "bank_transfer", "other"]).nullish(),
  attemptNote: z.string().max(500).nullish(),
  registerAttempt: z.boolean().optional(),
});

/** Pre-confirmation change agreed on the phone: in-place contact edit, or replacement when lines change / orders merge. */
export async function modifyCodOrderAction(slug: string, input: unknown): Promise<ActionResult<{ kind: "updated" | "replaced"; newOrderId?: string; newOrderName?: string; warning?: string | null }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    const parsed = modifySchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await modifyCodOrder(svc(ctx, tx), platform, { ...parsed.data, contact: parsed.data.contact ? { ...parsed.data.contact, shippingAddress: parsed.data.contact.shippingAddress ?? undefined } : undefined }, { country: ctx.tenant.country });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: res.kind === "replaced" ? "cod.order_replaced" : "cod.order_modified", entityType: "order", entityId: parsed.data.orderId, metadata: res });
      return res;
    });
    revalidatePath(`/t/${slug}/cod`);
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    if (r.kind === "replaced") revalidatePath(`/t/${slug}/orders/${r.newOrderId}`);
    return ok(r.kind === "replaced" ? { kind: "replaced", newOrderId: r.newOrderId, newOrderName: r.newOrderName, warning: r.warning } : { kind: "updated" });
  } catch (e) {
    return handle(e) as ActionResult<{ kind: "updated" | "replaced" }>;
  }
}

/* ---------- depth of the Control Room scan (issue #8) ---------- */

/** Warehouse list for the confirm dialog: `SKU × qty` per line (C.6). */
export async function orderLinesAction(slug: string, orderId: string): Promise<ActionResult<{ text: string }>> {
  try {
    const ctx = await requirePage(slug, "cod_queue");
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    const lines = await ctx.run((tx) => tx.select({ sku: schema.orderLines.sku, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, quantity: schema.orderLines.currentQuantity, isAncillary: schema.orderLines.isAncillary }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenant.id), eq(schema.orderLines.orderId, orderId))));
    return ok({ text: warehouseLines(lines) });
  } catch (e) {
    return handle(e) as ActionResult<{ text: string }>;
  }
}

/** Pass to a colleague (C.9): operators within the rules, admins freely. */
export async function transferAction(slug: string, orderId: string, toUserId: string, note?: string | null): Promise<ActionResult<{ transfersToday: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!uuid.safeParse(orderId).success || !uuid.safeParse(toUserId).success) return fail("invalid_input");
    const r = await ctx.run((tx) => transferQueueItem(svc(ctx, tx), orderId, toUserId, { isAdmin: isAdminRole(ctx), timezone: ctx.tenant.timezone, note: note?.slice(0, 300) ?? null }));
    revalidatePath(`/t/${slug}/cod`);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<{ transfersToday: number }>;
  }
}

export async function escalateAction(slug: string, orderId: string, reason: string): Promise<ActionResult> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    await ctx.run((tx) => escalateQueueItem(svc(ctx, tx), orderId, String(reason ?? "")));
    revalidatePath(`/t/${slug}/cod`);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function resolveEscalationAction(slug: string, orderId: string, assignTo?: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!isAdminRole(ctx)) return fail("forbidden");
    if (!uuid.safeParse(orderId).success || (assignTo && !uuid.safeParse(assignTo).success)) return fail("invalid_input");
    await ctx.run((tx) => resolveEscalation(svc(ctx, tx), orderId, { assignTo: assignTo ?? null, timezone: ctx.tenant.timezone }));
    revalidatePath(`/t/${slug}/cod`);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

const bulkSchema = z.object({ kind: z.enum(["assign", "unassign", "distribute", "confirm", "cancel"]), orderIds: z.array(uuid).min(1).max(200), userId: uuid.nullish() });

/** Selection bar of the queue (C.4): supervisors only. */
export async function bulkQueueAction(slug: string, input: unknown): Promise<ActionResult<{ done: number; failed: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!isSupervisor(ctx)) return fail("forbidden");
    const parsed = bulkSchema.safeParse(input);
    if (!parsed.success || (parsed.data.kind === "assign" && !parsed.data.userId)) return fail("invalid_input");
    const { kind, orderIds, userId } = parsed.data;
    const platform = kind === "confirm" || kind === "cancel" ? await getCommercePlatform(ctx) : undefined;
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      if (kind === "assign" || kind === "unassign") return bulkAssign(s, orderIds, kind === "assign" ? userId! : null, { timezone: ctx.tenant.timezone });
      if (kind === "distribute") return distributeEqually(s, orderIds, { timezone: ctx.tenant.timezone });
      return bulkOutcome(s, orderIds, kind === "confirm" ? "confirmed" : "cancelled", { platform });
    });
    revalidatePath(`/t/${slug}/cod`);
    return ok({ done: r.done, failed: r.failed.length });
  } catch (e) {
    return handle(e) as ActionResult<{ done: number; failed: number }>;
  }
}

/** Sends a confirmation template through the tenant's messaging channel (C.17). */
export async function sendCodMessageAction(slug: string, orderId: string, templateKey: string): Promise<ActionResult<{ attemptNumber: number }>> {
  try {
    const ctx = await requireQueueWrite(slug);
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const res = await sendCodMessage(svc(ctx, tx), getMessagingChannelFor(ctx.tenant.id), { orderId, templateKey: String(templateKey) }, { shopName: ctx.tenant.name, locale: ctx.locale, operatorName: displayName(ctx.user) });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.message_sent", entityType: "order", entityId: orderId, metadata: { template: templateKey, attemptNumber: res.attemptNumber } });
      return res;
    });
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    revalidatePath(`/t/${slug}/cod`);
    return ok({ attemptNumber: r.attemptNumber });
  } catch (e) {
    return handle(e) as ActionResult<{ attemptNumber: number }>;
  }
}

/** Queue behaviour: aging, scheduled confirmations, transfers, return-to-sender automation, fee lines, refusal cost. */
export async function saveCodOperationsAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    const num = (k: string) => (formData.has(k) && formData.get(k) !== "" ? Number(formData.get(k)) : undefined);
    const patch = JSON.parse(JSON.stringify({ agingWarnHours: num("agingWarnHours"), agingAlertHours: num("agingAlertHours"), scheduledConfirmHour: num("scheduledConfirmHour"), transferDailyLimit: num("transferDailyLimit"), bottleneckFactor: num("bottleneckFactor"), refusalCostMinor: num("refusalCostMinor"), rtsAutoCancel: formData.get("rtsAutoCancel") === "on", feeLineMatch: parseTagList(String(formData.get("feeLineMatch") ?? "")) })) as Record<string, unknown>;
    const before = await ctx.run((tx) => getCodSettings(svc(ctx, tx)));
    await ctx.run(async (tx) => {
      const after = await saveCodSettings(svc(ctx, tx), patch);
      const diff = Object.fromEntries(Object.keys(patch).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k])).map((k) => [k, { from: (before as Record<string, unknown>)[k], to: (after as Record<string, unknown>)[k] }]));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.settings_updated", entityType: "cod_settings", diff });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Message templates: the whole list is replaced (key, name, body per template). */
export async function saveCodTemplatesAction(slug: string, templates: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireCodSettings(slug);
    const parsed = z.array(messageTemplateSchema).max(20).safeParse(templates);
    if (!parsed.success || new Set(parsed.data.map((t) => t.key)).size !== parsed.data.length) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await saveCodSettings(svc(ctx, tx), { messageTemplates: parsed.data });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.templates_updated", entityType: "cod_settings", diff: { messageTemplates: { from: null, to: parsed.data.map((t) => t.key) } } });
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Score of any order by its number, without storing it (C.15). */
export async function previewScoreAction(slug: string, orderName: string): Promise<ActionResult<{ orderId: string; name: string; score: number; base: number; riskTier: string | null; factors: ScoreFactor[] }>> {
  try {
    const ctx = await requireCodSettings(slug);
    const q = String(orderName ?? "").trim().replace(/^#/, "");
    if (!q) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const [o] = await tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), sql`lower(${schema.orders.name}) in (${q.toLowerCase()}, ${`#${q.toLowerCase()}`})`)).limit(1);
      if (!o) return null;
      const s = await scoreQueueItem(svc(ctx, tx), o.id, { timezone: ctx.tenant.timezone, addressProvider: await resolveAddressProvider(svc(ctx, tx)), preview: true });
      return { orderId: o.id, name: o.name, score: s.score, base: s.base, riskTier: s.riskTier, factors: s.factors };
    });
    return r ? ok(r) : fail("cod_not_found");
  } catch (e) {
    return handle(e) as ActionResult<never>;
  }
}

/** Carrier billing / remittance file (C.19): parse, match, store; recipient risk recomputed right after. */
export async function importCarrierAction(slug: string, _prev: ActionResult<{ imported: number; matched: number; unmatched: number; errors: number }> | null, formData: FormData): Promise<ActionResult<{ imported: number; matched: number; unmatched: number; errors: number }>> {
  try {
    const ctx = await requireCodSettings(slug);
    const file = formData.get("file");
    const text = file && typeof file === "object" && "text" in file && (file as File).size > 0 ? await (file as File).text() : String(formData.get("csv") ?? "");
    if (!text.trim() || text.length > 2_000_000) return fail("invalid_input");
    const parsed = parseCarrierCsv(text, { decimals: new Intl.NumberFormat("en", { style: "currency", currency: ctx.tenant.currency }).resolvedOptions().maximumFractionDigits ?? 2 });
    if (parsed.missingColumns.length) return fail("cod_carrier_columns");
    const batch = `${new Date().toISOString().slice(0, 16)}-${ctx.user.id.slice(0, 6)}`;
    const r = await ctx.run(async (tx) => {
      const res = await importCarrierOutcomes(svc(ctx, tx), parsed.rows, { batch });
      await recomputeRecipientProfiles(svc(ctx, tx), undefined, ctx.tenant.country);
      return res;
    });
    revalidatePath(`/t/${slug}/cod/settings`);
    return ok({ imported: r.imported, matched: r.matched, unmatched: r.unmatched.length, errors: parsed.errors.length });
  } catch (e) {
    return handle(e) as ActionResult<never>;
  }
}

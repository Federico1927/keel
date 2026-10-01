"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, desc, eq, recordAudit, schema } from "@keel/db";
import { ORDER_STATUSES, deriveOrderStatus, previewRules, stateRuleConditionsSchema, type OrderStatus, type PaymentMethod, type PaymentStatus, type ShipmentStatus, type StateRule } from "@keel/core";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ruleInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(80),
  priority: z.coerce.number().int().min(0).max(10000),
  resultStatus: z.enum(ORDER_STATUSES),
  isActive: z.boolean(),
  conditions: stateRuleConditionsSchema,
});

function parseForm(formData: FormData) {
  const conditions: Record<string, unknown> = {};
  const tagsAny = list(formData.get("tagsAny"));
  const tagsAll = list(formData.get("tagsAll"));
  const tagsNone = list(formData.get("tagsNone"));
  const paymentMethods = list(formData.get("paymentMethods"));
  const paymentStatuses = list(formData.get("paymentStatuses"));
  const financialStatusRaw = list(formData.get("financialStatusRaw"));
  const fulfillmentStatusRaw = list(formData.get("fulfillmentStatusRaw"));
  const minAgeHours = formData.get("minAgeHours");
  if (tagsAny.length) conditions.tagsAny = tagsAny;
  if (tagsAll.length) conditions.tagsAll = tagsAll;
  if (tagsNone.length) conditions.tagsNone = tagsNone;
  if (paymentMethods.length) conditions.paymentMethods = paymentMethods;
  if (paymentStatuses.length) conditions.paymentStatuses = paymentStatuses;
  if (financialStatusRaw.length) conditions.financialStatusRaw = financialStatusRaw;
  if (fulfillmentStatusRaw.length) conditions.fulfillmentStatusRaw = fulfillmentStatusRaw;
  if (minAgeHours && String(minAgeHours) !== "") conditions.minAgeHours = Number(minAgeHours);
  return ruleInput.safeParse({
    id: formData.get("id") || undefined,
    name: formData.get("name"),
    priority: formData.get("priority"),
    resultStatus: formData.get("resultStatus"),
    isActive: formData.get("isActive") === "on",
    conditions,
  });
}

export async function saveStateRule(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = parseForm(formData);
    if (!parsed.success) return fail("invalid_input", Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    const d = parsed.data;
    await ctx.run(async (tx) => {
      if (d.id) {
        const [prev] = await tx.select().from(schema.stateRules).where(and(eq(schema.stateRules.id, d.id), eq(schema.stateRules.tenantId, ctx.tenant.id)));
        if (!prev) throw new ForbiddenError("not_found");
        await tx.update(schema.stateRules).set({ name: d.name, priority: d.priority, resultStatus: d.resultStatus, isActive: d.isActive, conditions: d.conditions }).where(eq(schema.stateRules.id, d.id));
        await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "state_rule.updated", entityType: "state_rule", entityId: d.id, diff: { name: { from: prev.name, to: d.name }, priority: { from: prev.priority, to: d.priority }, resultStatus: { from: prev.resultStatus, to: d.resultStatus }, conditions: { from: prev.conditions, to: d.conditions } } });
      } else {
        const [row] = await tx.insert(schema.stateRules).values({ tenantId: ctx.tenant.id, name: d.name, priority: d.priority, resultStatus: d.resultStatus, isActive: d.isActive, conditions: d.conditions }).returning({ id: schema.stateRules.id });
        await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "state_rule.created", entityType: "state_rule", entityId: row!.id, diff: { conditions: { from: null, to: d.conditions }, resultStatus: { from: null, to: d.resultStatus } } });
      }
    });
    revalidatePath(`/t/${slug}/settings/order-states`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(e.message === "not_found" ? "not_found" : "forbidden");
    throw e;
  }
}

export async function deleteStateRule(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    await ctx.run(async (tx) => {
      await tx.delete(schema.stateRules).where(and(eq(schema.stateRules.id, id), eq(schema.stateRules.tenantId, ctx.tenant.id)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "state_rule.deleted", entityType: "state_rule", entityId: id });
    });
    revalidatePath(`/t/${slug}/settings/order-states`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export interface PreviewRow {
  id: string;
  name: string;
  current: OrderStatus;
  next: OrderStatus;
  reason: string;
  changed: boolean;
}

/** "On these 50 recent orders the rules would give this" — never writes. */
export async function previewStateRules(slug: string, candidate?: { rule: StateRule; replaceId?: string }): Promise<{ rows: PreviewRow[]; changed: number }> {
  const ctx = await requireAction(slug, "manage_settings", "settings");
  return ctx.run(async (tx) => {
    const stored = await tx.select().from(schema.stateRules).where(eq(schema.stateRules.tenantId, ctx.tenant.id));
    let rules: StateRule[] = stored.map((r) => ({ id: r.id, name: r.name, priority: r.priority, conditions: r.conditions as StateRule["conditions"], resultStatus: r.resultStatus as OrderStatus, isActive: r.isActive }));
    if (candidate) rules = [...rules.filter((r) => r.id !== candidate.replaceId), candidate.rule];
    const recent = await tx.select().from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenant.id)).orderBy(desc(schema.orders.placedAt)).limit(50);
    const shipmentRows = recent.length ? await tx.select({ orderId: schema.shipments.orderId, status: schema.shipments.status }).from(schema.shipments).where(eq(schema.shipments.tenantId, ctx.tenant.id)) : [];
    const shipmentByOrder = new Map(shipmentRows.map((s) => [s.orderId, s.status as ShipmentStatus]));
    const samples = recent.map((o) => ({
      id: o.id,
      name: o.name,
      currentStatus: o.status as OrderStatus,
      input: {
        platformTags: o.platformTags,
        paymentMethod: o.paymentMethod as PaymentMethod,
        paymentStatus: o.paymentStatus as PaymentStatus,
        financialStatusRaw: o.financialStatusRaw,
        fulfillmentStatusRaw: o.fulfillmentStatusRaw,
        cancelledAt: o.cancelledAt,
        placedAt: o.placedAt,
        sourceChannel: o.sourceChannel,
        shipmentStatus: shipmentByOrder.get(o.id) ?? null,
        returnedFraction: o.returnedFraction / 10000,
        manualStatus: null,
      },
    }));
    const out = previewRules(samples, rules);
    const rows = out.map((r, i) => ({ ...r, name: samples[i]!.name }));
    void deriveOrderStatus;
    return { rows, changed: rows.filter((r) => r.changed).length };
  });
}

"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_CONCURRENCY, BULK_MAX_ITEMS } from "@keel/config";
import { EXCEPTION_RESOLUTIONS, INSTRUCTION_CHANNELS, RTS_FOLLOW_UPS, SHIPMENT_STATUSES, diffRecords, tenantSettingsSchema } from "@keel/core";
import { adminDb, eq, recordAudit, schema } from "@keel/db";
import { CaseError, FulfilmentError, MappingError, bulkSetPacked, claimCase, closeCase, deleteStatusMapping, getCarrierProviderFor, recordFollowUp, releaseCase, saveStatusMapping, sendCaseInstruction, setOrderPacked, shipOrder, type BatchSummary, type ServiceContext } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();
const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const refresh = (slug: string) => revalidatePath(`/t/${slug}/fulfilment`, "layout");

function failFrom(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof FulfilmentError) return fail(e.code, e.issues?.length ? Object.fromEntries(e.issues.map((i) => [i.field, i.code])) : e.code === "platform_error" ? { platform: e.message.slice(0, 200) } : undefined);
  if (e instanceof CaseError) return fail(e.code, e.issues?.length ? Object.fromEntries(e.issues.map((i) => [i.field, i.code])) : e.code === "send_failed" ? { platform: e.message.slice(0, 200) } : undefined);
  if (e instanceof MappingError) return fail(e.code);
  throw e;
}

/* ---------- pick/pack board ---------- */

export async function setPackedAction(slug: string, orderId: string, packed: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    if (!uuid.safeParse(orderId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const out = await setOrderPacked(svc(ctx, tx), orderId, packed);
      if (out.kind === "done") await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: packed ? "order.packed" : "order.unpacked", entityType: "order", entityId: orderId, diff: { packed: { from: !packed, to: packed } } });
      return out;
    });
    if (r.kind === "not_found") return fail("not_found");
    if (r.kind === "not_to_ship") return fail("not_to_ship");
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function bulkPackAction(slug: string, orderIds: unknown, packed: boolean): Promise<ActionResult<BatchSummary>> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    const list = z.array(uuid).min(1).max(BULK_MAX_ITEMS).safeParse(orderIds);
    if (!list.success) return fail("invalid_input");
    const summary = await bulkSetPacked({ tenantId: ctx.tenant.id, actor: { type: "user", userId: ctx.user.id }, audit: auditActor(ctx), run: (fn) => ctx.run((tx) => fn(svc(ctx, tx))) }, list.data, packed, { concurrency: BULK_CONCURRENCY });
    refresh(slug);
    return ok(summary);
  } catch (e) {
    return failFrom(e);
  }
}

const shipSchema = z.object({ carrier: z.string().max(60), trackingNumber: z.string().max(80), trackingUrl: z.string().max(500).nullish(), notifyCustomer: z.boolean() });

/** Ship from Keel: the store creates the fulfilment first (outbox, synchronous); Keel changes only once it answered. */
export async function shipOrderAction(slug: string, orderId: string, input: unknown): Promise<ActionResult<{ name: string; orderStatus: string }>> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    const parsed = shipSchema.safeParse(input);
    if (!uuid.safeParse(orderId).success || !parsed.success) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run((tx) => shipOrder(svc(ctx, tx), platform, orderId, parsed.data));
    refresh(slug);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok({ name: r.name, orderStatus: r.orderStatus });
  } catch (e) {
    return failFrom(e);
  }
}

/* ---------- exception and return-to-sender cases ---------- */

export async function claimCaseAction(slug: string, caseId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    if (!uuid.safeParse(caseId).success) return fail("invalid_input");
    await ctx.run((tx) => claimCase(svc(ctx, tx), caseId));
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function releaseCaseAction(slug: string, caseId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    if (!uuid.safeParse(caseId).success) return fail("invalid_input");
    // owners and admins can take a case back from a colleague who is away
    await ctx.run((tx) => releaseCase(svc(ctx, tx), caseId, { force: ctx.role === "owner" || ctx.role === "admin" }));
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

const addressSchema = z.object({ name: z.string().max(120), address1: z.string().max(200), address2: z.string().max(200).nullish(), city: z.string().max(120), province: z.string().max(60).nullish(), zip: z.string().max(20), country: z.string().max(2), phone: z.string().max(40).nullish() });
const instructionSchema = z.object({ resolution: z.enum(EXCEPTION_RESOLUTIONS), channel: z.enum(INSTRUCTION_CHANNELS), emailTo: z.string().max(200).nullish(), pickupPoint: z.string().max(200).nullish(), note: z.string().max(1000).nullish(), address: addressSchema.nullish() });

export async function sendInstructionAction(slug: string, caseId: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    const parsed = instructionSchema.safeParse(input);
    if (!uuid.safeParse(caseId).success || !parsed.success) return fail("invalid_input");
    const v = parsed.data;
    const address = v.address ? { name: v.address.name, address1: v.address.address1, address2: v.address.address2 ?? null, city: v.address.city, province: v.address.province ?? null, zip: v.address.zip.trim().toUpperCase(), country: v.address.country.trim().toUpperCase(), phone: v.address.phone ?? null } : null;
    await ctx.run((tx) => sendCaseInstruction(svc(ctx, tx), caseId, { resolution: v.resolution, channel: v.channel, emailTo: v.emailTo ?? ctx.settings.carrierInstructionEmail, pickupPoint: v.pickupPoint ?? null, note: v.note ?? null, address }, { carrier: getCarrierProviderFor(ctx.tenant.id), companyName: ctx.tenant.name, locale: ctx.locale }));
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function followUpAction(slug: string, caseId: string, kind: string, outcome: "done" | "skipped" | null): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    const k = z.enum(RTS_FOLLOW_UPS).safeParse(kind);
    if (!uuid.safeParse(caseId).success || !k.success || ![null, "done", "skipped"].includes(outcome)) return fail("invalid_input");
    await ctx.run((tx) => recordFollowUp(svc(ctx, tx), caseId, k.data, outcome));
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function closeCaseAction(slug: string, caseId: string, reason: "resolved" | "dismissed", note?: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "shipments");
    if (!uuid.safeParse(caseId).success || !["resolved", "dismissed"].includes(reason)) return fail("invalid_input");
    await ctx.run((tx) => closeCase(svc(ctx, tx), caseId, { reason, note: note ?? null }));
    refresh(slug);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

/* ---------- settings: shipping clock, carrier email, status mappings ---------- */

const settingsSchema = z.object({ lateToShipBusinessDays: z.number().int().min(0).max(30), workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), carrierInstructionEmail: z.string().trim().max(200).nullable() });

export async function saveFulfilmentSettingsAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const candidate = { ...ctx.settings, lateToShipBusinessDays: parsed.data.lateToShipBusinessDays, workdays: [...new Set(parsed.data.workdays)].sort(), carrierInstructionEmail: parsed.data.carrierInstructionEmail || null };
    const next = tenantSettingsSchema.safeParse(candidate);
    if (!next.success) return fail("invalid_input", Object.fromEntries(next.error.issues.map((i) => [i.path.join("."), i.message])));
    const diff = diffRecords({ lateToShipBusinessDays: ctx.settings.lateToShipBusinessDays, workdays: ctx.settings.workdays, carrierInstructionEmail: ctx.settings.carrierInstructionEmail }, { lateToShipBusinessDays: next.data.lateToShipBusinessDays, workdays: next.data.workdays, carrierInstructionEmail: next.data.carrierInstructionEmail });
    // tenants is a platform table: written through the admin connection, audited in the tenant
    await adminDb().update(schema.tenants).set({ settings: next.data }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.fulfilment_updated", entityType: "tenant", entityId: ctx.tenant.id, diff }));
    revalidatePath(`/t/${slug}`, "layout");
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

const mappingSchema = z.object({ id: uuid.nullish(), source: z.string().max(40), externalStatus: z.string().max(80), canonicalStatus: z.enum(SHIPMENT_STATUSES), isException: z.boolean(), isFinal: z.boolean() });

export async function saveMappingAction(slug: string, input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = mappingSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    await ctx.run((tx) => saveStatusMapping(svc(ctx, tx), parsed.data));
    revalidatePath(`/t/${slug}/settings/fulfilment`);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function deleteMappingAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    if (!uuid.safeParse(id).success) return fail("invalid_input");
    const done = await ctx.run((tx) => deleteStatusMapping(svc(ctx, tx), id));
    if (!done) return fail("not_found");
    revalidatePath(`/t/${slug}/settings/fulfilment`);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

"use server";
import { auditActor } from "@/server/audit-actor";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema, withTenant } from "@keel/db";
import { addPoCharge, applyTransfer, deleteBundleComponent, deleteDemandEvent, deletePoCharge, generateDraftPurchaseOrders, issueSupplierLink, recordSupplierLinkAccess, saveBundleComponent, saveDemandEvent, sendSupplierPoEmail, setForecastOverride, SupplierAckError, supplierAcknowledge, tenantForSupplierToken, type ServiceContext } from "@keel/services";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const planningTenant = (ctx: TenantContext) => ({ id: ctx.tenant.id, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, settings: ctx.settings });

function mapError(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof Error && ["not_found", "invalid_input", "insufficient_stock"].includes(e.message)) return fail(e.message === "not_found" ? "not_found" : "invalid_input", { reason: e.message });
  throw e;
}

/** Turns the reorder suggestions into one draft PO per supplier. */
export async function generateDraftsAction(slug: string, variantIds?: string[]): Promise<ActionResult<{ created: { id: string; number: string }[] }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const ids = variantIds ? z.array(z.string().uuid()).max(500).parse(variantIds) : undefined;
    const created = await ctx.run(async (tx) => {
      const r = await generateDraftPurchaseOrders(svc(ctx, tx), planningTenant(ctx), { variantIds: ids });
      for (const po of r) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.auto_draft", entityType: "purchase_order", entityId: po.id, metadata: { lines: po.lines, totalMinor: po.totalMinor } });
      return r;
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ created: created.map((c) => ({ id: c.id, number: c.number })) });
  } catch (e) {
    return mapError(e);
  }
}

const eventSchema = z.object({ name: z.string().trim().min(2).max(80), month: z.string().regex(/^\d{4}-\d{2}$/), upliftPct: z.coerce.number().min(-90).max(500), scope: z.enum(["all", "product_type", "product"]), scopeValue: z.string().trim().max(200).optional() });

export async function saveDemandEventAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = eventSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success || (parsed.data.scope !== "all" && !parsed.data.scopeValue)) return fail("invalid_input");
    const d = parsed.data;
    await ctx.run(async (tx) => {
      await saveDemandEvent(svc(ctx, tx), { name: d.name, month: d.month, upliftBps: Math.round(d.upliftPct * 100), scope: d.scope, scopeValue: d.scope === "all" ? null : d.scopeValue });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "demand_event.saved", entityType: "demand_event", metadata: d });
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deleteDemandEventAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    await ctx.run(async (tx) => {
      await deleteDemandEvent(svc(ctx, tx), z.string().uuid().parse(id));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "demand_event.deleted", entityType: "demand_event", entityId: id });
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const overrideSchema = z.object({ variantId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}$/), units: z.union([z.literal(""), z.coerce.number().int().min(0).max(1_000_000)]), note: z.string().max(200).optional() });

export async function setForecastOverrideAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = overrideSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    const units = parsed.data.units === "" ? null : parsed.data.units;
    await ctx.run(async (tx) => {
      const [v] = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.id, parsed.data.variantId))).limit(1);
      if (!v) throw new Error("not_found");
      await setForecastOverride(svc(ctx, tx), { variantId: parsed.data.variantId, month: parsed.data.month, units, note: parsed.data.note ?? null });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "forecast.override", entityType: "variant", entityId: parsed.data.variantId, diff: { [parsed.data.month]: { from: null, to: units } } });
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const chargeSchema = z.object({ kind: z.enum(["duty", "freight", "fee", "other"]), amount: z.coerce.number().positive().max(10_000_000), basis: z.enum(["value", "quantity", "weight"]), note: z.string().max(200).optional() });

export async function addPoChargeAction(slug: string, poId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const parsed = chargeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await addPoCharge(svc(ctx, tx), poId, { kind: parsed.data.kind, amountMinor: Math.round(parsed.data.amount * 100), basis: parsed.data.basis, note: parsed.data.note || null });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.charge_added", entityType: "purchase_order", entityId: poId, metadata: parsed.data });
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deletePoChargeAction(slug: string, poId: string, chargeId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    await ctx.run(async (tx) => {
      await deletePoCharge(svc(ctx, tx), poId, chargeId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.charge_deleted", entityType: "purchase_order", entityId: poId, metadata: { chargeId } });
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

/**
 * Sends the PO to the supplier: issues a confirmation link and marks a draft as sent. The email
 * with the PDF goes through the tenant's mail sink when one is configured; in mock mode the link
 * is shown to the user to forward it.
 */
export async function sendPoToSupplierAction(slug: string, poId: string, _prev: ActionResult<{ url: string; expiresAt: string }> | null, formData: FormData): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const email = z.string().email().or(z.literal("")).safeParse(formData.get("email") ?? "");
    if (!email.success) return fail("invalid_input");
    const h = await headers();
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
    const token = await ctx.run(async (tx) => {
      const [po] = await tx.select({ status: schema.purchaseOrders.status }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenant.id), eq(schema.purchaseOrders.id, poId))).limit(1);
      if (!po) throw new Error("not_found");
      if (!["draft", "sent", "confirmed"].includes(po.status)) throw new Error("invalid_input");
      const link = await issueSupplierLink(svc(ctx, tx), poId, email.data || null);
      // the PO email (template supplier_po, tenant language) is queued when an address is given; the platform sender delivers it after the commit
      const delivery = email.data ? await sendSupplierPoEmail(svc(ctx, tx), { poId, to: email.data, url: `${origin}/supplier/po/${link.token}` }) : "none";
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.sent_to_supplier", entityType: "purchase_order", entityId: poId, diff: { status: { from: po.status, to: po.status === "draft" ? "sent" : po.status } }, metadata: { email: email.data || null, delivery, linkId: link.linkId, expiresAt: link.expiresAt.toISOString(), revokedLinks: link.revoked } });
      return link;
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    return ok({ url: `${origin}/supplier/po/${token.token}`, expiresAt: token.expiresAt.toISOString() });
  } catch (e) {
    return mapError(e) as ActionResult<{ url: string; expiresAt: string }>;
  }
}

const transferSchema = z.object({ variantId: z.string().uuid(), fromLocationId: z.string().uuid(), toLocationId: z.string().uuid(), units: z.coerce.number().int().min(1).max(100_000) });

export async function applyTransferAction(slug: string, input: { variantId: string; fromLocationId: string; toLocationId: string; units: number }): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = transferSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const moved = await applyTransfer(svc(ctx, tx), parsed.data, { pushToPlatform: true });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "inventory.transfer", entityType: "variant", entityId: parsed.data.variantId, metadata: parsed.data });
      return moved;
    });
    await dispatchPlatformWrites(ctx, r.writes);
    revalidatePath(`/t/${slug}/inventory/planning`);
    revalidatePath(`/t/${slug}/inventory`);
    return ok();
  } catch (e) {
    if (e instanceof Error && !(e instanceof ForbiddenError) && /platform|Integration/i.test(e.name + e.message) && !["not_found", "invalid_input", "insufficient_stock"].includes(e.message)) return fail("platform_error", { platform: e.message });
    return mapError(e);
  }
}

const bundleSchema = z.object({ parentVariantId: z.string().uuid(), componentVariantId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(1000), kind: z.enum(["bundle", "bom"]) });

export async function saveBundleComponentAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    const parsed = bundleSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success || parsed.data.parentVariantId === parsed.data.componentVariantId) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const found = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id)));
      const ids = new Set(found.map((f) => f.id));
      if (!ids.has(parsed.data.parentVariantId) || !ids.has(parsed.data.componentVariantId)) throw new Error("not_found");
      await saveBundleComponent(svc(ctx, tx), parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "bundle.component_saved", entityType: "variant", entityId: parsed.data.parentVariantId, metadata: parsed.data });
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deleteBundleComponentAction(slug: string, parentVariantId: string, componentVariantId: string): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "inventory");
    await ctx.run(async (tx) => {
      await deleteBundleComponent(svc(ctx, tx), parentVariantId, componentVariantId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "bundle.component_deleted", entityType: "variant", entityId: parentVariantId, metadata: { componentVariantId } });
    });
    revalidatePath(`/t/${slug}/inventory/planning`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const ackSchema = z.object({ decision: z.enum(["confirm", "problem"]), expectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")), note: z.string().max(2000).optional() });

/** Public: the supplier answers through the link. The token is the only credential. */
export async function supplierAckAction(token: string, _prev: ActionResult<{ status: string }> | null, formData: FormData): Promise<ActionResult<{ status: string }>> {
  const parsed = ackSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail("invalid_input");
  const found = await tenantForSupplierToken(token);
  if (!found) return fail("not_found");
  const h = await headers();
  // every answer attempt is logged; an expired or revoked link cannot answer
  await withTenant(found.tenantId, (tx) => recordSupplierLinkAccess({ tenantId: found.tenantId, tx, actor: { type: "system", userId: null } }, found, { token, kind: "answer", ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") }));
  if (found.state !== "active") return fail("link_expired");
  try {
    const r = await withTenant(found.tenantId, (tx) => supplierAcknowledge({ tenantId: found.tenantId, tx, actor: { type: "system", userId: null } }, found.poId, { decision: parsed.data.decision, expectedAt: parsed.data.expectedAt ? new Date(`${parsed.data.expectedAt}T12:00:00Z`) : null, note: parsed.data.note ?? null }));
    return ok(r);
  } catch (e) {
    if (e instanceof SupplierAckError) return fail(e.message === "note_required" ? "invalid_input" : e.message, { reason: e.message });
    throw e;
  }
}

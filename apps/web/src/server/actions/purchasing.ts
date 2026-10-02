"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from "@hullwise/core";
import { PurchasingError, createPurchaseOrder, deletePurchaseOrder, duplicatePurchaseOrder, enqueuePlatformWrite, poVariantOptions, receivePurchaseOrder, recordSupplierPayment, revokeSupplierLinks, searchPoVariants, transitionPurchaseOrder, updatePurchaseOrder, type PlatformWriteRow, type PoVariantOption, type ServiceContext } from "@hullwise/services";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

function mapError(e: unknown): ActionResult {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof PurchasingError) return fail(e.code === "not_found" ? "not_found" : "invalid_input", { reason: e.code });
  throw e;
}

export async function transitionPo(slug: string, poId: string, to: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    if (!(PURCHASE_ORDER_STATUSES as readonly string[]).includes(to)) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const r = await transitionPurchaseOrder({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, poId, to as PurchaseOrderStatus);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.transition", entityType: "purchase_order", entityId: poId, diff: { status: { from: r.from, to: r.to } } });
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    revalidatePath(`/t/${slug}/purchasing`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const receiveSchema = z.object({ locationId: z.string().uuid().nullable(), pushToPlatform: z.boolean(), lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.coerce.number().int().min(0), damaged: z.coerce.number().int().min(0), rejected: z.coerce.number().int().min(0) })) });

export async function receivePo(slug: string, poId: string, _prev: ActionResult<{ status: string; released: number }> | null, formData: FormData): Promise<ActionResult<{ status: string; released: number }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    // received now per line, of which damaged and rejected (inspection); only good units go to stock
    const lines: { lineId: string; quantity: number; damaged: number; rejected: number }[] = [];
    for (const [k, v] of formData.entries()) if (k.startsWith("qty_")) lines.push({ lineId: k.slice(4), quantity: Number(v), damaged: Number(formData.get(`dmg_${k.slice(4)}`) || 0), rejected: Number(formData.get(`rej_${k.slice(4)}`) || 0) });
    const parsed = receiveSchema.safeParse({ locationId: formData.get("locationId") || null, pushToPlatform: formData.get("pushToPlatform") === "on", lines });
    if (!parsed.success || parsed.data.lines.every((l) => l.quantity === 0)) return fail("invalid_input");
    const push = parsed.data.pushToPlatform;
    const writes: PlatformWriteRow[] = [];
    const result = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await receivePurchaseOrder(s, {
        poId,
        locationId: parsed.data.locationId,
        lines: parsed.data.lines,
        // the new stock level goes to the platform through the outbox, committed with the receipt
        pushToPlatform: push
          ? async (variantId, locationId, available) => {
              const [v] = await tx.select({ inv: schema.productVariants.inventoryItemExternalId }).from(schema.productVariants).where(eq(schema.productVariants.id, variantId)).limit(1);
              const [l] = await tx.select({ ext: schema.locations.externalId }).from(schema.locations).where(eq(schema.locations.id, locationId)).limit(1);
              if (v?.inv && l?.ext) writes.push(await enqueuePlatformWrite(s, { kind: "inventory.set", entityType: "variant", entityId: variantId, payload: { inventoryItemExternalId: v.inv, locationExternalId: l.ext, available } }));
            }
          : undefined,
      });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.received", entityType: "purchase_order", entityId: poId, metadata: { status: r.status, received: r.received.map((x) => ({ variantId: x.variantId, quantity: x.quantity, cost: x.newCostMinor })), inspection: r.inspected.map((x) => ({ lineId: x.lineId, variantId: x.variantId, description: x.description, received: x.received, good: x.good, damaged: x.damaged, rejected: x.rejected })), releasedOrders: r.releasedOrders, pushToPlatform: push } });
      return r;
    });
    // stock pushes, then the platform holds lifted for the orders the receipt released
    await dispatchPlatformWrites(ctx, [...writes, ...result.platformWrites]);
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    revalidatePath(`/t/${slug}/inventory`);
    if (result.releasedOrders.length) revalidatePath(`/t/${slug}/orders`);
    return ok({ status: result.status, released: result.releasedOrders.length });
  } catch (e) {
    return mapError(e) as ActionResult<{ status: string; released: number }>;
  }
}

const lineSchema = z.object({ variantId: z.string().uuid().nullable(), description: z.string().trim().max(300).nullable().optional(), quantity: z.coerce.number().int().min(1).max(1_000_000), unitCost: z.coerce.number().min(0).max(10_000_000) });
const poFormSchema = z.object({ supplierId: z.string().uuid(), destinationLocationId: z.string().uuid().nullable(), expectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(2000).optional(), lines: z.array(lineSchema).min(1).max(500) });

/** The PO editor posts its lines as JSON (catalogue lines with a variant, free-text lines with a description). */
function parsePoForm(formData: FormData) {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    return null;
  }
  const parsed = poFormSchema.safeParse({ supplierId: formData.get("supplierId"), destinationLocationId: formData.get("destinationLocationId") || null, expectedAt: formData.get("expectedAt") || undefined, notes: formData.get("notes") || undefined, lines });
  if (!parsed.success || parsed.data.lines.some((l) => !l.variantId && !l.description)) return null;
  const d = parsed.data;
  return { supplierId: d.supplierId, destinationLocationId: d.destinationLocationId, expectedAt: d.expectedAt ? new Date(`${d.expectedAt}T12:00:00Z`) : null, notes: d.notes?.trim() || null, lines: d.lines.map((l) => ({ variantId: l.variantId, description: l.variantId ? null : (l.description ?? null), quantity: l.quantity, unitCostMinor: Math.round(l.unitCost * 100) })) };
}

export async function createPo(slug: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const input = parsePoForm(formData);
    if (!input) return fail("invalid_input");
    const id = await ctx.run(async (tx) => {
      const poId = await createPurchaseOrder(svc(ctx, tx), { ...input, currency: ctx.tenant.currency });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.created", entityType: "purchase_order", entityId: poId, metadata: { lines: input.lines.length, freeTextLines: input.lines.filter((l) => !l.variantId).length } });
      return poId;
    });
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ id });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
  }
}

/** Edits a draft or sent PO: header and lines replaced, audited with the field and line diff. */
export async function updatePo(slug: string, poId: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const input = parsePoForm(formData);
    if (!input) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const r = await updatePurchaseOrder(svc(ctx, tx), poId, input);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.updated", entityType: "purchase_order", entityId: poId, diff: r.diff, metadata: { lines: r.lines } });
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ id: poId });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
  }
}

export async function duplicatePo(slug: string, poId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const copy = await ctx.run(async (tx) => {
      const r = await duplicatePurchaseOrder(svc(ctx, tx), poId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.duplicated", entityType: "purchase_order", entityId: r.id, metadata: { from: poId, number: r.number } });
      return r;
    });
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ id: copy.id });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
  }
}

export async function deletePo(slug: string, poId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    await ctx.run(async (tx) => {
      const r = await deletePurchaseOrder(svc(ctx, tx), poId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.deleted", entityType: "purchase_order", entityId: poId, diff: { status: { from: r.status, to: null } }, metadata: r });
    });
    revalidatePath(`/t/${slug}/purchasing`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

/** Variant search for the PO editor (any variant by SKU, barcode or title), with stock and supplier cost. */
export async function searchPoVariantsAction(slug: string, q: string): Promise<PoVariantOption[]> {
  const ctx = await requirePage(slug, "purchasing");
  return ctx.run((tx) => searchPoVariants(svc(ctx, tx), ctx.settings, String(q ?? "")));
}

/** Facts of known variants (pre-filled lines of an existing PO). */
export async function poVariantOptionsAction(slug: string, variantIds: string[]): Promise<PoVariantOption[]> {
  const ctx = await requirePage(slug, "purchasing");
  const ids = z.array(z.string().uuid()).max(500).safeParse(variantIds);
  if (!ids.success) return [];
  return ctx.run((tx) => poVariantOptions(svc(ctx, tx), ctx.settings, ids.data));
}

/** Revokes the supplier links of a PO (the supplier then sees the neutral page). */
export async function revokeSupplierLinksAction(slug: string, poId: string): Promise<ActionResult<{ revoked: number }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const n = await ctx.run(async (tx) => {
      const [po] = await tx.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenant.id), eq(schema.purchaseOrders.id, poId))).limit(1);
      if (!po) throw new PurchasingError("not_found");
      const revoked = await revokeSupplierLinks(svc(ctx, tx), poId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "purchase_order.supplier_link_revoked", entityType: "purchase_order", entityId: poId, metadata: { revoked } });
      return revoked;
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    return ok({ revoked: n });
  } catch (e) {
    return mapError(e) as ActionResult<{ revoked: number }>;
  }
}

const paymentSchema = z.object({ supplierId: z.string().uuid(), purchaseOrderId: z.string().uuid().nullable(), amountMinor: z.number().int().min(1), paidAt: z.string(), method: z.string().max(40).optional(), note: z.string().max(200).optional() });

export async function addSupplierPayment(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const parsed = paymentSchema.safeParse({ supplierId: formData.get("supplierId"), purchaseOrderId: formData.get("purchaseOrderId") || null, amountMinor: Math.round(Number(formData.get("amount")) * 100), paidAt: formData.get("paidAt") || new Date().toISOString().slice(0, 10), method: formData.get("method") || undefined, note: formData.get("note") || undefined });
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const [sup] = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(and(eq(schema.suppliers.tenantId, ctx.tenant.id), eq(schema.suppliers.id, parsed.data.supplierId))).limit(1);
      if (!sup) throw new PurchasingError("not_found");
      const id = await recordSupplierPayment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { ...parsed.data, paidAt: new Date(parsed.data.paidAt) });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "supplier_payment.recorded", entityType: "supplier_payment", entityId: id, metadata: { amountMinor: parsed.data.amountMinor, supplierId: parsed.data.supplierId } });
    });
    revalidatePath(`/t/${slug}/purchasing`, "layout");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const supplierSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(2).max(80), payeeName: z.string().trim().max(120).optional(), email: z.string().email().optional().or(z.literal("")), phone: z.string().max(40).optional(), country: z.string().trim().max(2).optional(), leadTimeDays: z.coerce.number().int().min(0).max(365).optional(), notes: z.string().max(1000).optional(), contactName: z.string().trim().max(80).optional(), leadTimeSdDays: z.coerce.number().int().min(0).max(120).optional(), depositPct: z.coerce.number().min(0).max(100).optional(), balanceDays: z.coerce.number().int().min(0).max(365).optional(), moqDefault: z.coerce.number().int().min(1).max(1_000_000).optional(), orderMultipleDefault: z.coerce.number().int().min(1).max(10_000).optional() });

export async function saveSupplier(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const raw = Object.fromEntries(formData) as Record<string, string>;
    const blank = (k: string) => raw[k] === "" || raw[k] === undefined ? undefined : raw[k];
    const parsed = supplierSchema.safeParse({ ...raw, id: raw.id || undefined, leadTimeDays: blank("leadTimeDays"), leadTimeSdDays: blank("leadTimeSdDays"), depositPct: blank("depositPct"), balanceDays: blank("balanceDays"), moqDefault: blank("moqDefault"), orderMultipleDefault: blank("orderMultipleDefault") });
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    const values = { name: d.name, payeeName: d.payeeName || null, email: d.email || null, phone: d.phone || null, country: d.country?.toUpperCase() || null, leadTimeDays: d.leadTimeDays ?? null, notes: d.notes || null, contactName: d.contactName || null, leadTimeSdDays: d.leadTimeSdDays ?? null, depositBps: d.depositPct !== undefined ? Math.round(d.depositPct * 100) : 0, balanceDays: d.balanceDays ?? 30, moqDefault: d.moqDefault ?? null, orderMultipleDefault: d.orderMultipleDefault ?? null };
    await ctx.run(async (tx) => {
      if (d.id) {
        const [prev] = await tx.select().from(schema.suppliers).where(and(eq(schema.suppliers.tenantId, ctx.tenant.id), eq(schema.suppliers.id, d.id))).limit(1);
        if (!prev) throw new PurchasingError("not_found");
        await tx.update(schema.suppliers).set(values).where(eq(schema.suppliers.id, d.id));
        const diff = Object.fromEntries(Object.entries(values).filter(([k, v]) => prev[k as keyof typeof prev] !== v).map(([k, v]) => [k, { from: prev[k as keyof typeof prev], to: v }]));
        await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "supplier.updated", entityType: "supplier", entityId: d.id, diff });
      } else {
        const [row] = await tx.insert(schema.suppliers).values({ tenantId: ctx.tenant.id, currency: ctx.tenant.currency, ...values }).returning({ id: schema.suppliers.id });
        await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "supplier.created", entityType: "supplier", entityId: row!.id });
      }
    });
    revalidatePath(`/t/${slug}/purchasing/suppliers`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

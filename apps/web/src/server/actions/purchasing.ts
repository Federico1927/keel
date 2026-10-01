"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@keel/db";
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from "@keel/core";
import { PurchasingError, createPurchaseOrder, receivePurchaseOrder, recordSupplierPayment, transitionPurchaseOrder } from "@keel/services";
import { getCommercePlatform } from "@/server/integrations";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

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
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "purchase_order.transition", entityType: "purchase_order", entityId: poId, diff: { status: { from: r.from, to: r.to } } });
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    revalidatePath(`/t/${slug}/purchasing`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const receiveSchema = z.object({ locationId: z.string().uuid().nullable(), pushToPlatform: z.boolean(), lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.coerce.number().int().min(0) })) });

export async function receivePo(slug: string, poId: string, _prev: ActionResult<{ status: string; released: number }> | null, formData: FormData): Promise<ActionResult<{ status: string; released: number }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const lines: { lineId: string; quantity: number }[] = [];
    for (const [k, v] of formData.entries()) if (k.startsWith("qty_")) lines.push({ lineId: k.slice(4), quantity: Number(v) });
    const parsed = receiveSchema.safeParse({ locationId: formData.get("locationId") || null, pushToPlatform: formData.get("pushToPlatform") === "on", lines });
    if (!parsed.success || parsed.data.lines.every((l) => l.quantity === 0)) return fail("invalid_input");
    const platform = parsed.data.pushToPlatform ? await getCommercePlatform(ctx) : null;
    const result = await ctx.run(async (tx) => {
      const r = await receivePurchaseOrder({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, {
        poId,
        locationId: parsed.data.locationId,
        lines: parsed.data.lines,
        pushToPlatform: platform
          ? async (variantId, locationId, available) => {
              const [v] = await tx.select({ inv: schema.productVariants.inventoryItemExternalId }).from(schema.productVariants).where(eq(schema.productVariants.id, variantId)).limit(1);
              const [l] = await tx.select({ ext: schema.locations.externalId }).from(schema.locations).where(eq(schema.locations.id, locationId)).limit(1);
              if (v?.inv && l?.ext) await platform.setInventory(v.inv, l.ext, available);
            }
          : undefined,
      });
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "purchase_order.received", entityType: "purchase_order", entityId: poId, metadata: { status: r.status, received: r.received.map((x) => ({ variantId: x.variantId, quantity: x.quantity, cost: x.newCostMinor })), releasedOrders: r.releasedOrders, pushToPlatform: Boolean(platform) } });
      return r;
    });
    revalidatePath(`/t/${slug}/purchasing/${poId}`);
    revalidatePath(`/t/${slug}/inventory`);
    return ok({ status: result.status, released: result.releasedOrders.length });
  } catch (e) {
    return mapError(e) as ActionResult<{ status: string; released: number }>;
  }
}

const createSchema = z.object({ supplierId: z.string().uuid(), destinationLocationId: z.string().uuid().nullable(), expectedAt: z.string().optional(), notes: z.string().max(2000).optional(), lines: z.array(z.object({ variantId: z.string().uuid(), quantity: z.coerce.number().int().min(1), unitCostMinor: z.coerce.number().int().min(0) })).min(1) });

export async function createPo(slug: string, _prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const lines: { variantId: string; quantity: unknown; unitCostMinor: unknown }[] = [];
    for (const [k, v] of formData.entries()) {
      if (!k.startsWith("qty_")) continue;
      const variantId = k.slice(4);
      const qty = Number(v);
      if (!qty) continue;
      lines.push({ variantId, quantity: qty, unitCostMinor: Math.round(Number(formData.get(`cost_${variantId}`) ?? 0) * 100) });
    }
    const parsed = createSchema.safeParse({ supplierId: formData.get("supplierId"), destinationLocationId: formData.get("destinationLocationId") || null, expectedAt: formData.get("expectedAt") || undefined, notes: formData.get("notes") || undefined, lines });
    if (!parsed.success) return fail("invalid_input");
    const id = await ctx.run(async (tx) => {
      const poId = await createPurchaseOrder({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { supplierId: parsed.data.supplierId, destinationLocationId: parsed.data.destinationLocationId, currency: ctx.tenant.currency, expectedAt: parsed.data.expectedAt ? new Date(parsed.data.expectedAt) : null, notes: parsed.data.notes ?? null, lines: parsed.data.lines });
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "purchase_order.created", entityType: "purchase_order", entityId: poId, metadata: { lines: parsed.data.lines.length } });
      return poId;
    });
    revalidatePath(`/t/${slug}/purchasing`);
    return ok({ id });
  } catch (e) {
    return mapError(e) as ActionResult<{ id: string }>;
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
      await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "supplier_payment.recorded", entityType: "supplier_payment", entityId: id, metadata: { amountMinor: parsed.data.amountMinor, supplierId: parsed.data.supplierId } });
    });
    revalidatePath(`/t/${slug}/purchasing`, "layout");
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

const supplierSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(2).max(80), payeeName: z.string().trim().max(120).optional(), email: z.string().email().optional().or(z.literal("")), phone: z.string().max(40).optional(), country: z.string().trim().max(2).optional(), leadTimeDays: z.coerce.number().int().min(0).max(365).optional(), notes: z.string().max(1000).optional() });

export async function saveSupplier(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "receive_purchase_order", "purchasing");
    const raw = Object.fromEntries(formData) as Record<string, string>;
    const parsed = supplierSchema.safeParse({ ...raw, id: raw.id || undefined, leadTimeDays: raw.leadTimeDays || undefined });
    if (!parsed.success) return fail("invalid_input");
    const d = parsed.data;
    const values = { name: d.name, payeeName: d.payeeName || null, email: d.email || null, phone: d.phone || null, country: d.country?.toUpperCase() || null, leadTimeDays: d.leadTimeDays ?? null, notes: d.notes || null };
    await ctx.run(async (tx) => {
      if (d.id) {
        await tx.update(schema.suppliers).set(values).where(and(eq(schema.suppliers.tenantId, ctx.tenant.id), eq(schema.suppliers.id, d.id)));
        await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "supplier.updated", entityType: "supplier", entityId: d.id, diff: { name: { from: null, to: d.name } } });
      } else {
        const [row] = await tx.insert(schema.suppliers).values({ tenantId: ctx.tenant.id, currency: ctx.tenant.currency, ...values }).returning({ id: schema.suppliers.id });
        await recordAudit(tx, { tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action: "supplier.created", entityType: "supplier", entityId: row!.id });
      }
    });
    revalidatePath(`/t/${slug}/purchasing/suppliers`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

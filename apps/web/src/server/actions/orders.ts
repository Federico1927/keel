"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { ORDER_STATUSES, type OrderStatus, displayName } from "@keel/core";
import { OrderEditError, addOrderNote, applyCancellation, cancelBackorderWait, applyOrderDiscount, clearManualStatus, deleteOrderNote, editOrder, enqueuePlatformWrite, getAddressProviderFor, setManualStatus } from "@keel/services";
import type { AddressSuggestion, AddressValidation } from "@keel/integrations";
import { getCommercePlatform } from "@/server/integrations";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const idSchema = z.string().uuid();

export async function changeOrderStatus(slug: string, orderId: string, status: string, note?: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "change_order_state", "orders");
    if (!idSchema.safeParse(orderId).success || !(ORDER_STATUSES as readonly string[]).includes(status)) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      const r = await setManualStatus(s, orderId, status as OrderStatus, note);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), actorType: ctx.impersonation ? "impersonation" : "user", impersonatedBy: ctx.impersonation?.adminUserId ?? null, action: "order.status_changed", entityType: "order", entityId: orderId, diff: { status: { from: r.previous, to: r.next } }, metadata: { note: note ?? null } });
    });
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function resetOrderStatus(slug: string, orderId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "change_order_state", "orders");
    await ctx.run(async (tx) => {
      const r = await clearManualStatus({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, orderId);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.status_reset", entityType: "order", entityId: orderId, diff: { status: { from: r.previous, to: r.next } } });
    });
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** Cancels locally and enqueues the platform cancellation in the same transaction; the write then runs (queued or inline) and its status shows on the order. */
export async function cancelOrder(slug: string, orderId: string, input: { reason: string; restock: boolean; refund: boolean }): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "cancel_order", "orders");
    const order = await ctx.run(async (tx) => (await tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, orderId))).limit(1))[0]);
    if (!order) return fail("not_found");
    if (order.cancelledAt) return fail("already_cancelled");
    const write = await ctx.run(async (tx) => {
      const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
      await applyCancellation(s, orderId, input);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.cancelled", entityType: "order", entityId: orderId, metadata: input });
      return order.externalId ? enqueuePlatformWrite(s, { kind: "order.cancel", entityType: "order", entityId: orderId, payload: { orderExternalId: order.externalId, reason: input.reason, restock: input.restock, refund: input.refund } }) : null;
    });
    await dispatchPlatformWrites(ctx, [write]);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/** "Cancel wait": the order stops waiting for stock (backorders cancelled, hold released here and on the platform). */
export async function cancelBackorderWaitAction(slug: string, orderId: string, note?: string): Promise<ActionResult<{ cancelled: number }>> {
  try {
    const ctx = await requireAction(slug, "change_order_state", "orders");
    if (!idSchema.safeParse(orderId).success) return fail("invalid_input");
    const r = await ctx.run(async (tx) => {
      const res = await cancelBackorderWait({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, orderId, note?.slice(0, 500));
      if (res.cancelled) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.backorder_wait_cancelled", entityType: "order", entityId: orderId, diff: { awaitingStock: { from: true, to: false } }, metadata: { backorders: res.cancelled, note: note ?? null } });
      return res;
    });
    if (!r.cancelled) return fail("not_found");
    await dispatchPlatformWrites(ctx, [r.write]);
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok({ cancelled: r.cancelled });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function assignOrder(slug: string, orderId: string, userId: string | null): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "assign", "orders");
    if (userId) {
      const [m] = await adminDb().select({ id: schema.tenantMemberships.id }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
      if (!m) return fail("invalid_input");
    }
    await ctx.run(async (tx) => {
      const [prev] = await tx.select({ assignedTo: schema.orders.assignedTo }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, orderId))).limit(1);
      await tx.update(schema.orders).set({ assignedTo: userId }).where(eq(schema.orders.id, orderId));
      await tx.insert(schema.orderEvents).values({ tenantId: ctx.tenant.id, orderId, type: "assigned", actorType: "user", actorUserId: ctx.user.id, diff: { assignedTo: { from: prev?.assignedTo ?? null, to: userId } }, metadata: {} });
    });
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

export async function addNote(slug: string, orderId: string, body: string): Promise<ActionResult<{ mentions: number }>> {
  try {
    const ctx = await requireAction(slug, "add_note", "orders");
    const members = await adminDb().select({ id: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true)));
    const result = await ctx.run(async (tx) => {
      const [o] = await tx.select({ name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, orderId))).limit(1);
      if (!o) throw new ForbiddenError("not_found");
      return addOrderNote({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { orderId, body, allowedMentionIds: members.map((m) => m.id), link: `/t/${slug}/orders/${orderId}`, orderName: o.name, authorName: displayName(ctx.user) });
    });
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok({ mentions: result.mentions.length });
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(e.message === "not_found" ? "not_found" : "forbidden");
    if (e instanceof Error && e.message === "invalid_note") return fail("invalid_input");
    throw e;
  }
}

export async function removeNote(slug: string, orderId: string, noteId: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "add_note", "orders");
    const done = await ctx.run((tx) => deleteOrderNote({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, noteId, ctx.role === "owner" || ctx.role === "admin"));
    if (!done) return fail("forbidden");
    revalidatePath(`/t/${slug}/orders/${orderId}`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/* ---------- order editing (core, any payment method) ---------- */

const addressSchema = z.object({ name: z.string().max(120).nullish(), address1: z.string().max(200).nullish(), address2: z.string().max(200).nullish(), city: z.string().max(120).nullish(), province: z.string().max(120).nullish(), zip: z.string().max(20).nullish(), country: z.string().max(2).nullish(), phone: z.string().max(40).nullish() });
const editSchema = z.object({
  orderId: idSchema,
  contact: z.object({ customerName: z.string().max(120).nullish(), phone: z.string().max(40).nullish(), email: z.string().max(200).nullish(), shippingAddress: addressSchema.nullish(), billingAddress: addressSchema.nullish(), note: z.string().max(2000).nullish(), noteMode: z.enum(["replace", "append"]).optional() }).optional(),
  lines: z.array(z.object({ lineId: idSchema.optional(), variantId: idSchema.optional(), quantity: z.number().int().min(0).max(999) })).max(50).optional(),
  mergeOrderIds: z.array(idSchema).max(10).optional(),
});

/** Maps a core edit error to the action result; address issues come back per field (`zip: invalid_zip`). */
function editFailure(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof OrderEditError) {
    if (e.code === "invalid_address") return fail("invalid_address", Object.fromEntries((e.detail?.issues ?? []).map((i) => [i.field, i.code])));
    if (e.code === "not_editable") return fail("not_editable", e.detail?.block ? { block: e.detail.block } : undefined);
    if (e.code === "merge_invalid") return fail("merge_invalid", e.detail?.block ? { block: e.detail.block } : undefined);
    if (e.code === "platform_error") return fail("platform_error", { platform: e.message });
    if (e.code === "invalid_input") return fail("invalid_input", e.detail?.field ? { [e.detail.field]: "invalid" } : undefined);
    return fail(e.code);
  }
  throw e;
}

/**
 * Edits an open, unfulfilled order: contact and address in place on the platform, or a linked
 * replacement when lines change or orders are merged. Works the same for every payment method.
 */
export async function editOrderAction(slug: string, input: unknown): Promise<ActionResult<{ kind: "updated" | "replaced"; changed?: string[]; newOrderId?: string; newOrderName?: string; warning?: string | null; balanceMinor?: number }>> {
  try {
    const ctx = await requireAction(slug, "edit_order", "orders");
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await editOrder({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, parsed.data, { country: ctx.tenant.country, source: "core" });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: res.kind === "replaced" ? "order.replaced" : "order.edited", entityType: "order", entityId: parsed.data.orderId, diff: res.kind === "replaced" ? { replacedByOrderId: { from: null, to: res.newOrderId } } : {}, metadata: res.kind === "replaced" ? { newOrderName: res.newOrderName, merged: res.merged, balanceMinor: res.balanceMinor } : { changed: res.changed } });
      return res;
    });
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    if (r.kind === "replaced") await dispatchPlatformWrites(ctx, [r.holdWrite]);
    if (r.kind === "replaced") {
      revalidatePath(`/t/${slug}/orders/${r.newOrderId}`);
      return ok({ kind: "replaced", newOrderId: r.newOrderId, newOrderName: r.newOrderName, warning: r.warning, balanceMinor: r.balanceMinor });
    }
    return ok({ kind: "updated", changed: r.changed });
  } catch (e) {
    return editFailure(e);
  }
}

const discountSchema = z.object({ orderId: idSchema, type: z.enum(["percentage", "fixed_amount"]), value: z.number().int().positive().max(100_000_000), code: z.string().max(60).nullish(), reason: z.string().max(200).nullish() });

/** Adds a preset or custom discount (% in basis points, or an amount in minor units) to an open order. */
export async function applyOrderDiscountAction(slug: string, input: unknown): Promise<ActionResult<{ code: string; amountMinor: number; refundDueMinor: number }>> {
  try {
    const ctx = await requireAction(slug, "edit_order", "orders");
    const parsed = discountSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const platform = await getCommercePlatform(ctx);
    const r = await ctx.run(async (tx) => {
      const res = await applyOrderDiscount({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, platform, parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "order.discount_applied", entityType: "order", entityId: parsed.data.orderId, diff: { totalMinor: { from: res.totalMinor + res.amountMinor, to: res.totalMinor } }, metadata: { code: res.code, amountMinor: res.amountMinor } });
      return res;
    });
    revalidatePath(`/t/${slug}/orders/${parsed.data.orderId}`);
    return ok({ code: r.code, amountMinor: r.amountMinor, refundDueMinor: r.refundDueMinor });
  } catch (e) {
    return editFailure(e);
  }
}

/** Address autocomplete for the edit dialog, through the tenant's address provider (mock until #7). */
export async function suggestAddressesAction(slug: string, query: string, country: string | null): Promise<ActionResult<AddressSuggestion[]>> {
  try {
    const ctx = await requireAction(slug, "edit_order", "orders");
    const q = String(query ?? "").slice(0, 120);
    const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : ctx.tenant.country;
    return ok(await getAddressProviderFor(ctx.tenant.id).autocomplete(q, { country: c, limit: 3 }));
  } catch (e) {
    return editFailure(e);
  }
}

export async function validateAddressAction(slug: string, address: unknown): Promise<ActionResult<AddressValidation>> {
  try {
    const ctx = await requireAction(slug, "edit_order", "orders");
    const parsed = addressSchema.safeParse(address);
    if (!parsed.success) return fail("invalid_input");
    return ok(await getAddressProviderFor(ctx.tenant.id).validate(parsed.data));
  } catch (e) {
    return editFailure(e);
  }
}

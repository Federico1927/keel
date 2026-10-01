"use server";
import { auditActor } from "@/server/audit-actor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, and, eq, recordAudit, schema } from "@keel/db";
import { ORDER_STATUSES, type OrderStatus } from "@keel/core";
import { addOrderNote, applyCancellation, clearManualStatus, deleteOrderNote, enqueuePlatformWrite, setManualStatus } from "@keel/services";
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
      return addOrderNote({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { orderId, body, allowedMentionIds: members.map((m) => m.id), link: `/t/${slug}/orders/${orderId}`, orderName: o.name, authorName: ctx.user.name ?? ctx.user.email });
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

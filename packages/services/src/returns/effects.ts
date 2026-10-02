import { and, eq, inArray, schema, sql } from "@hullwise/db";
import { RETURN_GOODS_BACK_STATUSES, returnedFractionBps } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { recomputeOrderStatus } from "../orders/state";
import { queueConversionAdjustments } from "../tracking/conversions";
import { emitReturnWebhook } from "../webhooks/payloads";

/**
 * Carries a return's status change to its order: the returned fraction from goods that came back, the
 * refund total (returns refunded in Hullwise plus money refunds from the order page, never below what the
 * platform already reported), the payment status and the canonical status, with a `return_updated`
 * timeline event. Used by Hullwise's own transitions and by returns imported from the platform.
 */
export async function applyReturnToOrder(ctx: ServiceContext, orderId: string, change: { returnId: string; number: number; from: string | null; to: string }, metadata: Record<string, unknown> = {}): Promise<void> {
  const now = ctx.now ?? new Date();
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return;
  const orderLines = await ctx.tx.select({ id: schema.orderLines.id, quantity: schema.orderLines.quantity }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, order.id), eq(schema.orderLines.isAncillary, false)));
  const back = await ctx.tx.select({ orderLineId: schema.returnLines.orderLineId, qty: sql<number>`sum(${schema.returnLines.quantity})::int` }).from(schema.returnLines).innerJoin(schema.returnRequests, eq(schema.returnRequests.id, schema.returnLines.returnId)).where(and(eq(schema.returnRequests.orderId, order.id), inArray(schema.returnRequests.status, [...RETURN_GOODS_BACK_STATUSES]))).groupBy(schema.returnLines.orderLineId);
  const fraction = returnedFractionBps(orderLines, Object.fromEntries(back.map((b) => [b.orderLineId, b.qty])));
  const [refunds] = await ctx.tx.select({ total: sql<number>`coalesce(sum(${schema.returnRequests.refundedAmountMinor}), 0)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.orderId, order.id), eq(schema.returnRequests.status, "refunded")));
  // money refunds issued from the order page add to the return refunds
  const [manualRow] = await ctx.tx.select({ total: sql<number>`coalesce(sum(${schema.orderTransactions.amountMinor}), 0)::int` }).from(schema.orderTransactions).where(and(eq(schema.orderTransactions.orderId, order.id), eq(schema.orderTransactions.kind, "refund")));
  const manual = manualRow?.total ?? 0;
  const refundedMinor = Math.max(order.refundedMinor, (refunds?.total ?? 0) + manual);
  const paymentStatus = refundedMinor <= 0 ? order.paymentStatus : refundedMinor >= order.totalMinor ? "refunded" : order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded" ? "partially_refunded" : order.paymentStatus;
  const changed = fraction !== order.returnedFraction || refundedMinor !== order.refundedMinor || paymentStatus !== order.paymentStatus;
  if (changed) await ctx.tx.update(schema.orders).set({ returnedFraction: fraction, refundedMinor, paymentStatus, updatedAt: now }).where(eq(schema.orders.id, order.id));
  if (refundedMinor !== order.refundedMinor) await queueConversionAdjustments(ctx, [order.id]);
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "return_updated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { returnStatus: { from: change.from, to: change.to }, ...(changed ? { returnedFraction: { from: order.returnedFraction, to: fraction }, refundedMinor: { from: order.refundedMinor, to: refundedMinor } } : {}) }, metadata: { returnId: change.returnId, number: change.number, ...metadata }, createdAt: now });
  if (changed) await recomputeOrderStatus(ctx, order.id, { eventMetadata: { source: "return", returnId: change.returnId } });
  if (change.from !== change.to) await emitReturnWebhook(ctx, change.returnId, change.from);
}

import { and, eq, inArray, schema } from "@hullwise/db";
import { OPEN_BACKORDER_STATUSES, ORDER_STATUSES, deriveOrderStatus, diffRecords, type OrderStatus, type PaymentMethod, type PaymentStatus, type ShipmentStatus, type StateInput, type StateRule } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { emitOrderStatusWebhook } from "../webhooks/payloads";

export async function loadStateRules(ctx: ServiceContext): Promise<StateRule[]> {
  const rows = await ctx.tx.select().from(schema.stateRules).where(eq(schema.stateRules.tenantId, ctx.tenantId));
  return rows.map((r) => ({ id: r.id, name: r.name, priority: r.priority, conditions: r.conditions as StateRule["conditions"], resultStatus: r.resultStatus as OrderStatus, isActive: r.isActive }));
}

export function stateInputFromOrder(o: typeof schema.orders.$inferSelect, shipmentStatus: ShipmentStatus | null, now?: Date, awaitingStock = false): StateInput {
  return {
    platformTags: o.platformTags,
    paymentMethod: o.paymentMethod as PaymentMethod,
    paymentStatus: o.paymentStatus as PaymentStatus,
    financialStatusRaw: o.financialStatusRaw,
    fulfillmentStatusRaw: o.fulfillmentStatusRaw,
    cancelledAt: o.cancelledAt,
    placedAt: o.placedAt,
    sourceChannel: o.sourceChannel,
    shipmentStatus,
    returnedFraction: o.returnedFraction / 10000,
    manualStatus: (o.manualStatus as OrderStatus | null) ?? null,
    replacedByOrderId: o.replacedByOrderId,
    awaitingStock,
    now,
  };
}

async function currentShipmentStatus(ctx: ServiceContext, orderId: string): Promise<ShipmentStatus | null> {
  const [s] = await ctx.tx.select({ status: schema.shipments.status }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(schema.shipments.createdAt).limit(1);
  return (s?.status as ShipmentStatus | undefined) ?? null;
}

/** True while some line of the order waits for stock (an open backorder): a fact for the state engine. */
export async function isAwaitingStock(ctx: ServiceContext, orderId: string): Promise<boolean> {
  const [b] = await ctx.tx.select({ id: schema.backorders.id }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, [...OPEN_BACKORDER_STATUSES]))).limit(1);
  return Boolean(b);
}

/**
 * Closes the open backorders of an order that no longer waits (cancelled, replaced, fulfilled on the
 * platform), with a timeline event. Returns how many were closed; the caller recomputes the status.
 */
export async function closeOrderBackorders(ctx: ServiceContext, orderId: string, to: "cancelled" | "fulfilled", reason: string): Promise<number> {
  const now = ctx.now ?? new Date();
  const closed = await ctx.tx.update(schema.backorders).set({ status: to, resolvedAt: now }).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, [...OPEN_BACKORDER_STATUSES]))).returning({ id: schema.backorders.id, quantity: schema.backorders.quantity });
  if (closed.length) await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "backorder_closed", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { awaitingUnits: { from: closed.reduce((s, b) => s + b.quantity, 0), to: 0 } }, metadata: { reason, status: to, backorders: closed.map((b) => b.id) }, createdAt: now });
  return closed.length;
}

export interface RecomputeResult {
  previous: OrderStatus;
  next: OrderStatus;
  reason: string;
  changed: boolean;
}

/**
 * Recomputes the canonical status of one order from its current facts and writes it,
 * with an `order_events` row carrying the diff. The only writer of `orders.status`.
 */
export async function recomputeOrderStatus(ctx: ServiceContext, orderId: string, opts: { rules?: StateRule[]; eventMetadata?: Record<string, unknown> } = {}): Promise<RecomputeResult> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new Error("order_not_found");
  const rules = opts.rules ?? (await loadStateRules(ctx));
  const shipmentStatus = await currentShipmentStatus(ctx, orderId);
  const derived = deriveOrderStatus(stateInputFromOrder(order, shipmentStatus, ctx.now, await isAwaitingStock(ctx, orderId)), rules);
  const previous = order.status as OrderStatus;
  const changed = derived.status !== previous;
  const source = derived.reason === "manual" ? "manual" : "rules";
  if (changed || order.statusReason !== derived.reason || order.statusSource !== source) {
    await ctx.tx
      .update(schema.orders)
      .set({ status: derived.status, statusReason: derived.reason, statusSource: source, statusChangedAt: changed ? (ctx.now ?? new Date()) : order.statusChangedAt, manualStatus: derived.reason === "manual" ? order.manualStatus : null })
      .where(eq(schema.orders.id, orderId));
  }
  if (changed) {
    await ctx.tx.insert(schema.orderEvents).values({
      tenantId: ctx.tenantId,
      orderId,
      type: "status_changed",
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId,
      diff: diffRecords({ status: previous }, { status: derived.status }),
      metadata: { reason: derived.reason, ...(opts.eventMetadata ?? {}) },
      createdAt: ctx.now ?? new Date(),
    });
    await emitOrderStatusWebhook(ctx, order, { previous, status: derived.status, reason: derived.reason });
  }
  return { previous, next: derived.status, reason: derived.reason, changed };
}

/** Operator decision: sets a manual status, then lets the engine apply precedence. */
export async function setManualStatus(ctx: ServiceContext, orderId: string, status: OrderStatus, note?: string, opts: { eventMetadata?: Record<string, unknown> } = {}): Promise<RecomputeResult> {
  if (!ORDER_STATUSES.includes(status)) throw new Error("invalid_status");
  await ctx.tx.update(schema.orders).set({ manualStatus: status, holdReason: status === "on_hold" ? (note ?? "manual") : null }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  return recomputeOrderStatus(ctx, orderId, { eventMetadata: { note: note ?? null, manual: true, ...(opts.eventMetadata ?? {}) } });
}

/** Removes the operator override so platform facts and rules decide again. */
export async function clearManualStatus(ctx: ServiceContext, orderId: string): Promise<RecomputeResult> {
  await ctx.tx.update(schema.orders).set({ manualStatus: null, holdReason: null }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  return recomputeOrderStatus(ctx, orderId, { eventMetadata: { manual: false } });
}

/**
 * Local side of a cancellation, after the platform accepted it (or when the order has no
 * external id): stamps the order, writes the timeline event and recomputes the status.
 */
export async function applyCancellation(ctx: ServiceContext, orderId: string, input: { reason: string; restock: boolean; refund: boolean; source?: string; eventMetadata?: Record<string, unknown> }): Promise<RecomputeResult | null> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order || order.cancelledAt) return null;
  const now = ctx.now ?? new Date();
  const paymentStatus = input.refund && order.paymentStatus === "paid" ? "refunded" : order.paymentStatus === "pending" ? "voided" : order.paymentStatus;
  await ctx.tx.update(schema.orders).set({ cancelledAt: now, cancelReason: input.reason, paymentStatus, financialStatusRaw: paymentStatus }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cancelled", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: diffRecords<Record<string, unknown>>({ cancelledAt: null, paymentStatus: order.paymentStatus }, { cancelledAt: now, paymentStatus }), metadata: { reason: input.reason, restock: input.restock, refund: input.refund, source: input.source ?? null, ...(input.eventMetadata ?? {}) }, createdAt: now });
  // a cancelled order no longer waits for stock: its units go back to the queue
  await closeOrderBackorders(ctx, orderId, "cancelled", "order_cancelled");
  return recomputeOrderStatus(ctx, orderId);
}

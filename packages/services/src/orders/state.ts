import { and, eq, schema } from "@keel/db";
import { ORDER_STATUSES, deriveOrderStatus, diffRecords, type OrderStatus, type PaymentMethod, type PaymentStatus, type ShipmentStatus, type StateInput, type StateRule } from "@keel/core";
import type { ServiceContext } from "../context";

export async function loadStateRules(ctx: ServiceContext): Promise<StateRule[]> {
  const rows = await ctx.tx.select().from(schema.stateRules).where(eq(schema.stateRules.tenantId, ctx.tenantId));
  return rows.map((r) => ({ id: r.id, name: r.name, priority: r.priority, conditions: r.conditions as StateRule["conditions"], resultStatus: r.resultStatus as OrderStatus, isActive: r.isActive }));
}

export function stateInputFromOrder(o: typeof schema.orders.$inferSelect, shipmentStatus: ShipmentStatus | null, now?: Date): StateInput {
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
    now,
  };
}

async function currentShipmentStatus(ctx: ServiceContext, orderId: string): Promise<ShipmentStatus | null> {
  const [s] = await ctx.tx.select({ status: schema.shipments.status }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(schema.shipments.createdAt).limit(1);
  return (s?.status as ShipmentStatus | undefined) ?? null;
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
  const derived = deriveOrderStatus(stateInputFromOrder(order, shipmentStatus, ctx.now), rules);
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
  }
  return { previous, next: derived.status, reason: derived.reason, changed };
}

/** Operator decision: sets a manual status, then lets the engine apply precedence. */
export async function setManualStatus(ctx: ServiceContext, orderId: string, status: OrderStatus, note?: string): Promise<RecomputeResult> {
  if (!ORDER_STATUSES.includes(status)) throw new Error("invalid_status");
  await ctx.tx.update(schema.orders).set({ manualStatus: status, holdReason: status === "on_hold" ? (note ?? "manual") : null }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  return recomputeOrderStatus(ctx, orderId, { eventMetadata: { note: note ?? null, manual: true } });
}

/** Removes the operator override so platform facts and rules decide again. */
export async function clearManualStatus(ctx: ServiceContext, orderId: string): Promise<RecomputeResult> {
  await ctx.tx.update(schema.orders).set({ manualStatus: null, holdReason: null }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  return recomputeOrderStatus(ctx, orderId, { eventMetadata: { manual: false } });
}

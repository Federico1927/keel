import { and, eq, inArray, schema, sql } from "@keel/db";
import { backorderStatus, canTransitionPo, movingAverageCost, type PurchaseOrderStatus } from "@keel/core";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";

export class PurchasingError extends Error {
  constructor(public readonly code: "not_found" | "invalid_transition" | "invalid_quantity" | "no_location") {
    super(code);
  }
}

async function recomputePoTotal(ctx: ServiceContext, poId: string) {
  const [row] = await ctx.tx.select({ total: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity} * ${schema.purchaseOrderLines.unitCostMinor}), 0)::int` }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
  await ctx.tx.update(schema.purchaseOrders).set({ totalMinor: row?.total ?? 0 }).where(eq(schema.purchaseOrders.id, poId));
}

export async function nextPoNumber(ctx: ServiceContext, now = ctx.now ?? new Date()): Promise<string> {
  const prefix = `PO-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
  const [row] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), sql`${schema.purchaseOrders.number} like ${prefix + "%"}`));
  return `${prefix}${String((row?.n ?? 0) + 1).padStart(3, "0")}`;
}

export interface CreatePoInput {
  supplierId: string;
  destinationLocationId: string | null;
  currency: string;
  expectedAt: Date | null;
  notes?: string | null;
  lines: { variantId: string; quantity: number; unitCostMinor: number }[];
}

export async function createPurchaseOrder(ctx: ServiceContext, input: CreatePoInput): Promise<string> {
  if (!input.lines.length || input.lines.some((l) => l.quantity <= 0 || l.unitCostMinor < 0)) throw new PurchasingError("invalid_quantity");
  const number = await nextPoNumber(ctx);
  const [po] = await ctx.tx.insert(schema.purchaseOrders).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, number, status: "draft", currency: input.currency, destinationLocationId: input.destinationLocationId, expectedAt: input.expectedAt, notes: input.notes ?? null, createdBy: ctx.actor.userId }).returning({ id: schema.purchaseOrders.id });
  await ctx.tx.insert(schema.purchaseOrderLines).values(input.lines.map((l) => ({ tenantId: ctx.tenantId, purchaseOrderId: po!.id, variantId: l.variantId, quantity: l.quantity, unitCostMinor: l.unitCostMinor })));
  await recomputePoTotal(ctx, po!.id);
  return po!.id;
}

export async function transitionPurchaseOrder(ctx: ServiceContext, poId: string, to: PurchaseOrderStatus): Promise<{ from: string; to: string }> {
  const [po] = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId))).limit(1);
  if (!po) throw new PurchasingError("not_found");
  if (!canTransitionPo(po.status, to)) throw new PurchasingError("invalid_transition");
  const now = ctx.now ?? new Date();
  const stamps: Partial<typeof schema.purchaseOrders.$inferInsert> = { status: to };
  if (to === "sent") { stamps.sentAt = now; stamps.orderedAt = po.orderedAt ?? now; }
  if (to === "confirmed") stamps.confirmedAt = now;
  if (to === "cancelled") stamps.cancelledAt = now;
  await ctx.tx.update(schema.purchaseOrders).set(stamps).where(eq(schema.purchaseOrders.id, poId));
  // Incoming stock changed: refresh backorder coverage for the variants of this PO.
  if (to === "confirmed" || to === "cancelled") await refreshBackorders(ctx, (await ctx.tx.select({ v: schema.purchaseOrderLines.variantId }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId))).map((r) => r.v).filter((v): v is string => Boolean(v)));
  return { from: po.status, to };
}

export interface ReceiveInput {
  poId: string;
  locationId?: string | null;
  /** Quantities received now per line (not cumulative). */
  lines: { lineId: string; quantity: number }[];
  /** Also push the new available quantity to the commerce platform. */
  pushToPlatform?: (variantId: string, locationId: string, available: number) => Promise<void>;
}

export interface ReceiveResult {
  status: PurchaseOrderStatus;
  received: { variantId: string; quantity: number; newAvailable: number; newCostMinor: number; newAverageMinor: number }[];
  releasedOrders: string[];
}

/**
 * Receiving goods: inventory movement + level increment at the destination location,
 * variant cost (last and moving average) update, PO status (partial/complete), and
 * backorder release with a notification. The P/L reads the cost written here.
 */
export async function receivePurchaseOrder(ctx: ServiceContext, input: ReceiveInput): Promise<ReceiveResult> {
  const [po] = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, input.poId))).limit(1);
  if (!po) throw new PurchasingError("not_found");
  if (!["confirmed", "in_transit", "partially_received"].includes(po.status)) throw new PurchasingError("invalid_transition");
  const locationId = input.locationId ?? po.destinationLocationId ?? (await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isDefault, true))).limit(1))[0]?.id;
  if (!locationId) throw new PurchasingError("no_location");
  const lines = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
  const now = ctx.now ?? new Date();
  const received: ReceiveResult["received"] = [];
  for (const r of input.lines) {
    const line = lines.find((l) => l.id === r.lineId);
    if (!line || !line.variantId) continue;
    const remaining = line.quantity - line.receivedQuantity;
    const qty = Math.min(Math.max(0, Math.floor(r.quantity)), remaining);
    if (qty <= 0) continue;
    await ctx.tx.update(schema.purchaseOrderLines).set({ receivedQuantity: line.receivedQuantity + qty }).where(eq(schema.purchaseOrderLines.id, line.id));
    // stock
    const [level] = await ctx.tx.select().from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, line.variantId), eq(schema.inventoryLevels.locationId, locationId))).limit(1);
    const newAvailable = (level?.available ?? 0) + qty;
    if (level) await ctx.tx.update(schema.inventoryLevels).set({ available: newAvailable, onHand: (level.onHand ?? 0) + qty }).where(eq(schema.inventoryLevels.id, level.id));
    else await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId, available: qty, onHand: qty, committed: 0 });
    await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId, delta: qty, reason: "receipt", referenceType: "purchase_order", referenceId: po.id, actorUserId: ctx.actor.userId, note: po.number, createdAt: now });
    // cost
    const [variant] = await ctx.tx.select({ costMinor: schema.productVariants.costMinor, averageCostMinor: schema.productVariants.averageCostMinor }).from(schema.productVariants).where(eq(schema.productVariants.id, line.variantId)).limit(1);
    const [{ onHandTotal }] = (await ctx.tx.select({ onHandTotal: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, line.variantId))) as [{ onHandTotal: number }];
    const newAverage = movingAverageCost(variant?.averageCostMinor ?? variant?.costMinor ?? null, Math.max(0, onHandTotal - qty), qty, line.unitCostMinor);
    await ctx.tx.update(schema.productVariants).set({ costMinor: line.unitCostMinor, averageCostMinor: newAverage }).where(eq(schema.productVariants.id, line.variantId));
    received.push({ variantId: line.variantId, quantity: qty, newAvailable, newCostMinor: line.unitCostMinor, newAverageMinor: newAverage });
    if (input.pushToPlatform) await input.pushToPlatform(line.variantId, locationId, newAvailable);
  }
  // status
  const refreshed = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
  const complete = refreshed.every((l) => l.receivedQuantity >= l.quantity);
  const status: PurchaseOrderStatus = complete ? "received" : "partially_received";
  await ctx.tx.update(schema.purchaseOrders).set({ status, receivedAt: complete ? now : po.receivedAt }).where(eq(schema.purchaseOrders.id, po.id));
  const releasedOrders = await refreshBackorders(ctx, received.map((r) => r.variantId));
  return { status, received, releasedOrders };
}

/** Recomputes backorder statuses for the given variants; returns ids of orders fully covered by stock. */
export async function refreshBackorders(ctx: ServiceContext, variantIds: string[]): Promise<string[]> {
  if (!variantIds.length) return [];
  const open = await ctx.tx.select().from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.variantId, variantIds), inArray(schema.backorders.status, ["pending", "covered"])));
  if (!open.length) return [];
  const released = new Set<string>();
  for (const b of open) {
    const [stock] = await ctx.tx.select({ available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, b.variantId));
    const [incoming] = await ctx.tx
      .select({ n: sql<number>`coalesce(sum(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}), 0)::int` })
      .from(schema.purchaseOrderLines)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
      .where(and(eq(schema.purchaseOrderLines.variantId, b.variantId), inArray(schema.purchaseOrders.status, ["confirmed", "in_transit", "partially_received"])));
    const next = backorderStatus(b.quantity, stock?.available ?? 0, incoming?.n ?? 0);
    if (next !== b.status) await ctx.tx.update(schema.backorders).set({ status: next, resolvedAt: next === "fulfilled" ? (ctx.now ?? new Date()) : null }).where(eq(schema.backorders.id, b.id));
    if (next === "fulfilled") released.add(b.orderId);
  }
  for (const orderId of released) {
    const stillOpen = await ctx.tx.select({ id: schema.backorders.id }).from(schema.backorders).where(and(eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, ["pending", "covered"]))).limit(1);
    if (stillOpen.length) {
      released.delete(orderId);
      continue;
    }
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "hold_released", actorType: "system", actorUserId: null, diff: {}, metadata: { reason: "stock_available" }, createdAt: ctx.now ?? new Date() });
    const [o] = await ctx.tx.select({ name: schema.orders.name, assignedTo: schema.orders.assignedTo }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    if (o?.assignedTo) await notifyUsers(ctx, { userIds: [o.assignedTo], type: "stock_available", title: o.name, body: "stock_available", link: `/orders/${orderId}`, antiSpamMinutes: 60 });
  }
  return [...released];
}

export async function recordSupplierPayment(ctx: ServiceContext, input: { supplierId: string; purchaseOrderId?: string | null; amountMinor: number; paidAt: Date; method?: string | null; note?: string | null }): Promise<string> {
  if (input.amountMinor <= 0) throw new PurchasingError("invalid_quantity");
  const [row] = await ctx.tx.insert(schema.supplierPayments).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, purchaseOrderId: input.purchaseOrderId ?? null, amountMinor: input.amountMinor, paidAt: input.paidAt, method: input.method ?? null, note: input.note ?? null }).returning({ id: schema.supplierPayments.id });
  return row!.id;
}

/** Balance = Σ totals of non-draft, non-cancelled POs − Σ payments. */
export async function supplierBalances(ctx: ServiceContext) {
  const owed = await ctx.tx
    .select({ supplierId: schema.purchaseOrders.supplierId, total: sql<number>`coalesce(sum(${schema.purchaseOrders.totalMinor}), 0)::int`, open: sql<number>`count(*) filter (where ${schema.purchaseOrders.status} not in ('received'))::int` })
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), sql`${schema.purchaseOrders.status} not in ('draft','cancelled')`))
    .groupBy(schema.purchaseOrders.supplierId);
  const paid = await ctx.tx.select({ supplierId: schema.supplierPayments.supplierId, total: sql<number>`coalesce(sum(${schema.supplierPayments.amountMinor}), 0)::int` }).from(schema.supplierPayments).where(eq(schema.supplierPayments.tenantId, ctx.tenantId)).groupBy(schema.supplierPayments.supplierId);
  const paidBy = new Map(paid.map((p) => [p.supplierId, p.total]));
  return new Map(owed.map((o) => [o.supplierId, { owedMinor: o.total, paidMinor: paidBy.get(o.supplierId) ?? 0, balanceMinor: o.total - (paidBy.get(o.supplierId) ?? 0), openPos: o.open }]));
}

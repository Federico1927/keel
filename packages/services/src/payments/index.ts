import { and, desc, eq, inArray, schema, sql } from "@hullwise/db";
import { PAYMENT_METHODS, diffRecords, outstandingMinor, paymentStatusAfterRefund, refundableMinor, validateManualPayment, validateRefund, type ManualPaymentError, type PaymentMethod, type RefundError, type RefundableLine } from "@hullwise/core";
import type { CommercePlatform } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { recomputeOrderStatus } from "../orders/state";
import { queueConversionAdjustments } from "../tracking/conversions";
import { enqueuePlatformWrite, runPlatformWriteNow, type PlatformWriteRow } from "../writes";

export * from "./payouts";
export * from "./reports";

/**
 * Money on an order after checkout (issue #27), for every payment method alike:
 * - a manual payment (bank transfer received, cash, cheque) on an order whose payment is pending,
 *   pushed to the platform through the outbox;
 * - a money refund (goodwill, price adjustment, optionally on lines with restock) through
 *   `CommercePlatform.refundOrder`, synchronously: Hullwise records the amount the platform accepted.
 * Both write an `order_transactions` row (the ledger), an order event with author and diff, and
 * recompute the canonical status. The caller audits.
 */

export type PaymentErrorCode = ManualPaymentError | RefundError | "not_found" | "location_required" | "platform_error";
export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PaymentError";
  }
}

export type OrderTransactionRow = typeof schema.orderTransactions.$inferSelect;
interface RefundLineRecord {
  orderLineId: string;
  quantity: number;
  restock: boolean;
}

async function lockedOrder(ctx: ServiceContext, orderId: string) {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1).for("update");
  if (!order) throw new PaymentError("not_found");
  return order;
}

async function transactionsOf(ctx: ServiceContext, orderId: string): Promise<OrderTransactionRow[]> {
  return ctx.tx.select().from(schema.orderTransactions).where(and(eq(schema.orderTransactions.tenantId, ctx.tenantId), eq(schema.orderTransactions.orderId, orderId))).orderBy(desc(schema.orderTransactions.occurredAt), desc(schema.orderTransactions.createdAt));
}

const paidSoFar = (txns: readonly OrderTransactionRow[]) => txns.filter((t) => t.kind === "manual_payment").reduce((s, t) => s + t.amountMinor, 0);

/** Units of each line refunded by Hullwise without restock (restocked units already left the line's current quantity). */
function refundedQuantities(txns: readonly OrderTransactionRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of txns) if (t.kind === "refund") for (const l of (t.lines as RefundLineRecord[]) ?? []) if (!l.restock) out.set(l.orderLineId, (out.get(l.orderLineId) ?? 0) + l.quantity);
  return out;
}

async function refundableLines(ctx: ServiceContext, orderId: string, txns: readonly OrderTransactionRow[]) {
  const lines = await ctx.tx.select({ id: schema.orderLines.id, externalId: schema.orderLines.externalId, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, sku: schema.orderLines.sku, variantId: schema.orderLines.variantId, currentQuantity: schema.orderLines.currentQuantity, unitPriceMinor: schema.orderLines.unitPriceMinor }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId))).orderBy(schema.orderLines.createdAt);
  const refunded = refundedQuantities(txns);
  return lines.map((l) => ({ ...l, refundedQuantity: Math.min(l.currentQuantity, refunded.get(l.id) ?? 0) }));
}

export interface OrderMoney {
  transactions: OrderTransactionRow[];
  paidSoFarMinor: number;
  outstandingMinor: number;
  refundableMinor: number;
  lines: (RefundableLine & { title: string; variantTitle: string | null; sku: string | null })[];
  canRecordPayment: boolean;
  canRefund: boolean;
}

/** What the order page needs for the payment and refund dialogs and the payments card. */
export async function orderMoney(ctx: ServiceContext, orderId: string): Promise<OrderMoney | null> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return null;
  const txns = await transactionsOf(ctx, orderId);
  const lines = await refundableLines(ctx, orderId, txns);
  const paid = paidSoFar(txns);
  return {
    transactions: txns,
    paidSoFarMinor: paid,
    outstandingMinor: order.paymentStatus === "pending" ? outstandingMinor(order, paid) : 0,
    refundableMinor: ["paid", "partially_refunded"].includes(order.paymentStatus) ? refundableMinor(order) : 0,
    lines: lines.map((l) => ({ id: l.id, currentQuantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, refundedQuantity: l.refundedQuantity, title: l.title, variantTitle: l.variantTitle, sku: l.sku })),
    canRecordPayment: order.paymentStatus === "pending" && !order.cancelledAt && !order.replacedByOrderId,
    canRefund: ["paid", "partially_refunded"].includes(order.paymentStatus) && !order.replacedByOrderId && refundableMinor(order) > 0,
  };
}

/* ---------- manual payment ---------- */

export interface ManualPaymentResult {
  orderId: string;
  transactionId: string;
  amountMinor: number;
  fullyPaid: boolean;
  outstandingMinor: number;
  paymentStatus: string;
  previousPaymentStatus: string;
  /** Outbox row to dispatch after the commit (null for an order that is not on a platform). */
  write: PlatformWriteRow | null;
}

/**
 * Records a payment received outside checkout. The order becomes `paid` when the payments cover the
 * total (a partial payment leaves it pending with the rest outstanding); the platform is updated
 * through the outbox (`order.mark_paid`), so an outage never blocks the team.
 */
export async function recordManualPayment(ctx: ServiceContext, input: { orderId: string; amountMinor?: number | null; occurredAt?: Date | null; method?: PaymentMethod | null; note?: string | null }): Promise<ManualPaymentResult> {
  const now = ctx.now ?? new Date();
  const order = await lockedOrder(ctx, input.orderId);
  const txns = await transactionsOf(ctx, order.id);
  const paid = paidSoFar(txns);
  const amountMinor = input.amountMinor ?? outstandingMinor(order, paid);
  const occurredAt = input.occurredAt ?? now;
  const v = validateManualPayment(order, paid, { amountMinor, occurredAt }, now);
  if (!v.ok) throw new PaymentError(v.error);
  const method = input.method && (PAYMENT_METHODS as readonly string[]).includes(input.method) ? input.method : (order.paymentMethod as PaymentMethod);
  const note = input.note?.trim() || null;
  const [txn] = await ctx.tx.insert(schema.orderTransactions).values({ tenantId: ctx.tenantId, orderId: order.id, kind: "manual_payment", amountMinor, currency: order.currency, method, occurredAt, note, writtenToPlatform: Boolean(order.externalId), actorUserId: ctx.actor.userId, actorType: ctx.actor.type, createdAt: now }).returning({ id: schema.orderTransactions.id });
  const next = v.fullyPaid ? { paymentStatus: "paid", financialStatusRaw: "paid" } : null;
  if (next) await ctx.tx.update(schema.orders).set({ ...next, updatedAt: now }).where(eq(schema.orders.id, order.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "payment_recorded", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: next ? diffRecords({ paymentStatus: order.paymentStatus }, { paymentStatus: next.paymentStatus }) : {}, metadata: { amountMinor, method, occurredAt: occurredAt.toISOString(), outstandingMinor: v.outstandingMinor, note, transactionId: txn!.id, platform: order.externalId ? "outbox" : null }, createdAt: now });
  if (next) await recomputeOrderStatus(ctx, order.id, { eventMetadata: { source: "payment", transactionId: txn!.id } });
  const write = order.externalId ? await enqueuePlatformWrite(ctx, { kind: "order.mark_paid", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId, amountMinor, currency: order.currency, method, fullBalance: v.fullyPaid, note }, idempotencyKey: `order:payment:${txn!.id}` }) : null;
  return { orderId: order.id, transactionId: txn!.id, amountMinor, fullyPaid: v.fullyPaid, outstandingMinor: v.outstandingMinor, paymentStatus: next?.paymentStatus ?? order.paymentStatus, previousPaymentStatus: order.paymentStatus, write };
}

/* ---------- partial refund ---------- */

export interface RefundInput {
  orderId: string;
  amountMinor: number;
  lines?: { orderLineId: string; quantity: number }[];
  /** Put the refunded units back in stock (Hullwise and the platform) at `locationId` (default location when omitted). */
  restock?: boolean;
  locationId?: string | null;
  note?: string | null;
  notify?: boolean;
  /** Per dialog: the same request sent twice (double click, retry) refunds once. */
  requestId?: string | null;
}
export interface RefundResult {
  orderId: string;
  transactionId: string;
  requestedMinor: number;
  amountMinor: number;
  refundedMinor: number;
  paymentStatus: string;
  previousRefundedMinor: number;
  previousPaymentStatus: string;
  restocked: number;
  duplicate: boolean;
}

/**
 * Refunds money on a paid order: never more than what remains refundable, optionally on lines, with
 * optional restock. Platform first (`order.refund`, synchronous): Hullwise records the amount the
 * platform accepted, which feeds `refunded_minor` and so the P/L net revenue.
 */
export async function refundOrder(ctx: ServiceContext, platform: CommercePlatform | undefined, input: RefundInput): Promise<RefundResult> {
  const now = ctx.now ?? new Date();
  const order = await lockedOrder(ctx, input.orderId);
  const key = input.requestId ? `order:refund:${order.id}:${input.requestId}` : undefined;
  if (key) {
    // the same request again (double click, retry after a timeout): answer with what was recorded
    const [done] = await ctx.tx.select({ result: schema.platformWrites.result }).from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.idempotencyKey, key), eq(schema.platformWrites.status, "succeeded"))).limit(1);
    const ext = (done?.result as { externalId?: string } | null)?.externalId;
    const [dup] = ext ? await ctx.tx.select().from(schema.orderTransactions).where(and(eq(schema.orderTransactions.tenantId, ctx.tenantId), eq(schema.orderTransactions.orderId, order.id), eq(schema.orderTransactions.kind, "refund"), eq(schema.orderTransactions.externalId, ext))).limit(1) : [];
    if (dup) return { orderId: order.id, transactionId: dup.id, requestedMinor: dup.requestedMinor ?? dup.amountMinor, amountMinor: dup.amountMinor, refundedMinor: order.refundedMinor, paymentStatus: order.paymentStatus, previousRefundedMinor: order.refundedMinor, previousPaymentStatus: order.paymentStatus, restocked: 0, duplicate: true };
  }
  const txns = await transactionsOf(ctx, order.id);
  const lines = await refundableLines(ctx, order.id, txns);
  const requests = (input.lines ?? []).filter((l) => l.quantity > 0);
  const v = validateRefund(order, lines, { amountMinor: input.amountMinor, lines: requests });
  if (!v.ok) throw new PaymentError(v.error);
  const restock = Boolean(input.restock) && requests.length > 0;
  let location: { id: string; externalId: string | null } | null = null;
  if (restock) {
    const [loc] = await ctx.tx.select({ id: schema.locations.id, externalId: schema.locations.externalId }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), input.locationId ? eq(schema.locations.id, input.locationId) : eq(schema.locations.isDefault, true))).limit(1);
    if (!loc) throw new PaymentError("location_required");
    location = loc;
  }
  const records: RefundLineRecord[] = requests.map((r) => ({ orderLineId: r.orderLineId, quantity: r.quantity, restock }));
  const note = input.note?.trim() || null;
  let accepted = input.amountMinor;
  let externalId: string | null = null;
  const writes = Boolean(platform && order.externalId);
  if (writes) {
    const missing = requests.find((r) => !lines.find((l) => l.id === r.orderLineId)?.externalId);
    if (missing) throw new PaymentError("line_invalid");
    try {
      const r = await runPlatformWriteNow(ctx, platform!, { kind: "order.refund", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId!, lines: requests.map((q) => ({ orderLineExternalId: lines.find((l) => l.id === q.orderLineId)!.externalId!, quantity: q.quantity, restock })), locationExternalId: location?.externalId ?? null, amountMinor: input.amountMinor, currency: order.currency, note, notify: input.notify ?? false }, idempotencyKey: key });
      accepted = Math.max(0, Math.min(input.amountMinor, r.amountMinor));
      externalId = r.externalId;
    } catch (e) {
      throw new PaymentError("platform_error", e instanceof Error ? e.message : String(e));
    }
    // the same request answered from the outbox: it was already recorded
    const [dup] = await ctx.tx.select().from(schema.orderTransactions).where(and(eq(schema.orderTransactions.tenantId, ctx.tenantId), eq(schema.orderTransactions.orderId, order.id), eq(schema.orderTransactions.kind, "refund"), eq(schema.orderTransactions.externalId, externalId))).limit(1);
    if (dup) return { orderId: order.id, transactionId: dup.id, requestedMinor: dup.requestedMinor ?? dup.amountMinor, amountMinor: dup.amountMinor, refundedMinor: order.refundedMinor, paymentStatus: order.paymentStatus, previousRefundedMinor: order.refundedMinor, previousPaymentStatus: order.paymentStatus, restocked: 0, duplicate: true };
  }
  const nextRefunded = order.refundedMinor + accepted;
  const paymentStatus = paymentStatusAfterRefund(order, nextRefunded);
  const [txn] = await ctx.tx.insert(schema.orderTransactions).values({ tenantId: ctx.tenantId, orderId: order.id, kind: "refund", amountMinor: accepted, currency: order.currency, method: order.paymentMethod, occurredAt: now, note, lines: records, restockLocationId: location?.id ?? null, externalId, requestedMinor: accepted !== input.amountMinor ? input.amountMinor : null, writtenToPlatform: writes, actorUserId: ctx.actor.userId, actorType: ctx.actor.type, createdAt: now }).returning({ id: schema.orderTransactions.id });
  // restocked units come back to the location and leave the order (its cost of goods follows them)
  let restocked = 0;
  if (restock && location) {
    for (const r of requests) {
      const line = lines.find((l) => l.id === r.orderLineId)!;
      await ctx.tx.update(schema.orderLines).set({ currentQuantity: sql`greatest(0, ${schema.orderLines.currentQuantity} - ${r.quantity})` }).where(eq(schema.orderLines.id, line.id));
      if (!line.variantId) continue;
      await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId: location.id, delta: r.quantity, reason: "refund_restock", referenceType: "order", referenceId: order.id, actorUserId: ctx.actor.userId, note: order.name, createdAt: now });
      await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId: location.id, available: r.quantity, updatedAt: now }).onConflictDoUpdate({ target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId], set: { available: sql`${schema.inventoryLevels.available} + ${r.quantity}`, updatedAt: now } });
      restocked += r.quantity;
    }
  }
  await ctx.tx.update(schema.orders).set({ refundedMinor: nextRefunded, paymentStatus, financialStatusRaw: paymentStatus, updatedAt: now }).where(eq(schema.orders.id, order.id));
  await ctx.tx.insert(schema.orderEvents).values({
    tenantId: ctx.tenantId,
    orderId: order.id,
    type: "refund_issued",
    actorType: ctx.actor.type,
    actorUserId: ctx.actor.userId,
    diff: diffRecords({ refundedMinor: order.refundedMinor, paymentStatus: order.paymentStatus }, { refundedMinor: nextRefunded, paymentStatus }),
    metadata: { amountMinor: accepted, requestedMinor: input.amountMinor, lines: requests.map((r) => { const l = lines.find((x) => x.id === r.orderLineId)!; return { title: l.title, sku: l.sku, quantity: r.quantity }; }), restocked, note, transactionId: txn!.id, platform: writes ? platform!.provider : null },
    createdAt: now,
  });
  if (paymentStatus !== order.paymentStatus) await recomputeOrderStatus(ctx, order.id, { eventMetadata: { source: "refund", transactionId: txn!.id } });
  // a refund withdraws or restates the purchase the ad platforms received (#82)
  await queueConversionAdjustments(ctx, [order.id]);
  return { orderId: order.id, transactionId: txn!.id, requestedMinor: input.amountMinor, amountMinor: accepted, refundedMinor: nextRefunded, paymentStatus, previousRefundedMinor: order.refundedMinor, previousPaymentStatus: order.paymentStatus, restocked, duplicate: false };
}

/** Refunds Hullwise issued from the order page, per order: the returns module adds them to its own refunds. */
export async function manualRefundTotals(ctx: ServiceContext, orderIds: string[]): Promise<Map<string, number>> {
  if (!orderIds.length) return new Map();
  const rows = await ctx.tx.select({ orderId: schema.orderTransactions.orderId, total: sql<number>`coalesce(sum(${schema.orderTransactions.amountMinor}), 0)::int` }).from(schema.orderTransactions).where(and(eq(schema.orderTransactions.tenantId, ctx.tenantId), eq(schema.orderTransactions.kind, "refund"), inArray(schema.orderTransactions.orderId, orderIds))).groupBy(schema.orderTransactions.orderId);
  return new Map(rows.map((r) => [r.orderId, r.total]));
}

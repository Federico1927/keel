import { and, asc, desc, eq, gt, inArray, isNull, lt, not, schema, sql, type SQL } from "@hullwise/db";
import { INCOMING_PO_STATUSES, OPEN_BACKORDER_STATUSES, allocateRelease, diffRecords, lineShortage, openBackorderStatus, parseTenantSettings, pickIncomingLine } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { notifyUsers, membersWithRoles } from "../notifications";
import { recomputeOrderStatus } from "../orders/state";
import { enqueuePlatformWrite, type PlatformWriteRow } from "../writes";

/**
 * Backorders end to end (issue #26). An order line that stock cannot serve gets a `backorders` row
 * linked to the earliest incoming purchase order line that covers it; the state engine then holds
 * the order (`on_hold`, reason `hold:awaiting_stock`) and, when the tenant wants it, a fulfillment
 * hold goes to the platform through the outbox. Receiving a PO, the 10-minute safety tick and any
 * stock change re-check open backorders: what stock now covers is released (event, notification,
 * platform hold lifted). The rules are pure functions in `@hullwise/core/backorders`.
 */

const OPEN = [...OPEN_BACKORDER_STATUSES];
/** Orders whose lines can still wait for stock: nothing shipped, not cancelled. */
const STOCK_CHECK_STATUSES = ["new", "pending_review", "confirmed", "on_hold"];

export interface BackorderSettings {
  hold: boolean;
  platformHold: boolean;
}

export async function loadBackorderSettings(ctx: ServiceContext): Promise<BackorderSettings> {
  const [t] = await ctx.tx.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const s = parseTenantSettings(t?.settings ?? {});
  return { hold: s.backorderHold, platformHold: s.backorderPlatformHold };
}

interface Supply {
  available: number;
  onHand: number;
  committed: number;
  /** When Hullwise last read the level (latest location); null = never read from the platform. */
  syncedAt: Date | null;
}

async function variantSupply(ctx: ServiceContext, variantIds: string[]): Promise<Map<string, Supply>> {
  if (!variantIds.length) return new Map();
  const rows = await ctx.tx
    .select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int`, onHand: sql<number>`coalesce(sum(${schema.inventoryLevels.onHand}), 0)::int`, committed: sql<number>`coalesce(sum(${schema.inventoryLevels.committed}), 0)::int`, syncedAt: sql<Date | null>`max(${schema.inventoryLevels.syncedAt})` })
    .from(schema.inventoryLevels)
    .where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, variantIds)))
    .groupBy(schema.inventoryLevels.variantId);
  return new Map(rows.map((r) => [r.variantId, { available: r.available, onHand: r.onHand, committed: r.committed, syncedAt: r.syncedAt ? new Date(r.syncedAt) : null }]));
}

/**
 * Units of open orders placed after the level was read (so the level does not reflect them yet),
 * net of the units those orders already wait for: what the read level still owes them.
 */
async function unreflectedUnits(ctx: ServiceContext, variantId: string, since: Date, before: Date | null, excludeOrderIds: string[]): Promise<number> {
  const where: SQL[] = [eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.variantId, variantId), gt(schema.orders.placedAt, since), isNull(schema.orders.cancelledAt), isNull(schema.orders.replacedByOrderId), inArray(schema.orders.status, STOCK_CHECK_STATUSES), sql`coalesce(${schema.orders.fulfillmentStatusRaw}, 'unfulfilled') not in ('fulfilled', 'partial')`];
  if (before) where.push(lt(schema.orders.placedAt, before));
  if (excludeOrderIds.length) where.push(not(inArray(schema.orders.id, excludeOrderIds)));
  const [r] = await ctx.tx
    .select({ n: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity} - coalesce((select sum(b.quantity) from backorders b where b.order_line_id = ${schema.orderLines.id} and b.status in ('pending', 'covered')), 0)), 0)::int` })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .where(and(...where));
  return Math.max(0, r?.n ?? 0);
}

async function openBackorderUnits(ctx: ServiceContext, variantId: string, excludeOrderId: string): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`coalesce(sum(${schema.backorders.quantity}), 0)::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.variantId, variantId), inArray(schema.backorders.status, OPEN), not(eq(schema.backorders.orderId, excludeOrderId))));
  return r?.n ?? 0;
}

/** Incoming PO lines of a variant with the units other open backorders already wait for. */
async function incomingLines(ctx: ServiceContext, variantId: string, excludeBackorderId?: string) {
  const claimed = excludeBackorderId
    ? sql<number>`(select coalesce(sum(b.quantity), 0) from backorders b where b.purchase_order_line_id = ${schema.purchaseOrderLines.id} and b.status in ('pending', 'covered') and b.id <> ${excludeBackorderId})::int`
    : sql<number>`(select coalesce(sum(b.quantity), 0) from backorders b where b.purchase_order_line_id = ${schema.purchaseOrderLines.id} and b.status in ('pending', 'covered'))::int`;
  return ctx.tx
    .select({ id: schema.purchaseOrderLines.id, remaining: sql<number>`(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity})::int`, claimed, expectedAt: schema.purchaseOrders.expectedAt, poNumber: schema.purchaseOrders.number })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
    .where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), eq(schema.purchaseOrderLines.variantId, variantId), inArray(schema.purchaseOrders.status, [...INCOMING_PO_STATUSES]), sql`${schema.purchaseOrderLines.quantity} > ${schema.purchaseOrderLines.receivedQuantity}`))
    .orderBy(asc(schema.purchaseOrders.createdAt));
}

export interface StockCheckOptions {
  settings?: BackorderSettings;
  /** Units given back per variant before checking (a replaced order cancelled with restock). */
  credit?: Map<string, number>;
  /** The order was just created on the platform: Hullwise's level cannot reflect it yet. */
  assumeUnreflected?: boolean;
  /** Skip the status recompute (the caller recomputes right after, e.g. the import). */
  skipRecompute?: boolean;
  source?: string;
}

export interface StockCheckResult {
  created: { id: string; orderLineId: string; variantId: string; quantity: number; purchaseOrderLineId: string | null }[];
  /** Outbox row of the platform fulfillment hold, when one was enqueued (dispatch it after the commit). */
  write: PlatformWriteRow | null;
}

/**
 * Stock check of one order (on import, and on the replacement order of an edit): per line, the
 * units stock cannot serve become a backorder linked to the earliest incoming PO line that covers
 * them. Lines already waiting are skipped, so the check can run twice. Any new backorder writes a
 * timeline event, holds the order through the state engine and, if the tenant wants it, enqueues a
 * fulfillment hold on the platform.
 */
export async function checkOrderStock(ctx: ServiceContext, orderId: string, opts: StockCheckOptions = {}): Promise<StockCheckResult> {
  const none: StockCheckResult = { created: [], write: null };
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order || order.cancelledAt || order.replacedByOrderId || order.paymentStatus === "voided" || !STOCK_CHECK_STATUSES.includes(order.status) || ["fulfilled", "partial"].includes(order.fulfillmentStatusRaw ?? "")) return none;
  const settings = opts.settings ?? (await loadBackorderSettings(ctx));
  if (!settings.hold) return none;
  const lines = (await ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)))).filter((l) => l.variantId && l.currentQuantity > 0 && !l.isAncillary);
  if (!lines.length) return none;
  const waiting = new Set((await ctx.tx.select({ lineId: schema.backorders.orderLineId }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, OPEN)))).map((r) => r.lineId));
  const todo = lines.filter((l) => !waiting.has(l.id));
  if (!todo.length) return none;
  const supply = await variantSupply(ctx, [...new Set(todo.map((l) => l.variantId!))]);
  const taken = new Map<string, number>();
  const ahead = new Map<string, number>();
  const now = ctx.now ?? new Date();
  const created: StockCheckResult["created"] = [];
  const described: { sku: string | null; title: string; quantity: number; poNumber: string | null; expectedAt: string | null }[] = [];
  for (const l of todo) {
    const v = l.variantId!;
    const s = supply.get(v) ?? { available: 0, onHand: 0, committed: 0, syncedAt: null };
    const reflected = !opts.assumeUnreflected && s.syncedAt !== null && order.placedAt.getTime() <= s.syncedAt.getTime();
    let shortage: number;
    if (reflected) {
      shortage = lineShortage({ quantity: l.currentQuantity, available: 0, reflected: true, overcommitted: s.committed - s.onHand - (await openBackorderUnits(ctx, v, orderId)) - (taken.get(v) ?? 0) });
    } else {
      if (!ahead.has(v)) ahead.set(v, s.syncedAt ? await unreflectedUnits(ctx, v, s.syncedAt, order.placedAt, [orderId]) : 0);
      shortage = lineShortage({ quantity: l.currentQuantity, available: s.available + (opts.credit?.get(v) ?? 0) - (taken.get(v) ?? 0), aheadUnits: ahead.get(v) });
    }
    taken.set(v, (taken.get(v) ?? 0) + (reflected ? shortage : l.currentQuantity - shortage));
    if (shortage <= 0) continue;
    const line = pickIncomingLine(await incomingLines(ctx, v), shortage);
    const [row] = await ctx.tx.insert(schema.backorders).values({ tenantId: ctx.tenantId, orderLineId: l.id, orderId, variantId: v, quantity: shortage, purchaseOrderLineId: line?.id ?? null, status: openBackorderStatus(Boolean(line)), createdAt: now }).returning({ id: schema.backorders.id });
    created.push({ id: row!.id, orderLineId: l.id, variantId: v, quantity: shortage, purchaseOrderLineId: line?.id ?? null });
    described.push({ sku: l.sku, title: `${l.title}${l.variantTitle ? ` ${l.variantTitle}` : ""}`, quantity: shortage, poNumber: line?.poNumber ?? null, expectedAt: line?.expectedAt ? line.expectedAt.toISOString().slice(0, 10) : null });
  }
  if (!created.length) return none;
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "backorder_created", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { awaitingUnits: { from: 0, to: created.reduce((s, b) => s + b.quantity, 0) } }, metadata: { lines: described, source: opts.source ?? null }, createdAt: now });
  if (!opts.skipRecompute) await recomputeOrderStatus(ctx, orderId, { eventMetadata: { source: opts.source ?? null } });
  let write: PlatformWriteRow | null = null;
  if (settings.platformHold && order.externalId) {
    const note = described.map((d) => `${d.quantity}× ${d.sku ?? d.title}${d.poNumber ? ` (${d.poNumber}${d.expectedAt ? ` ${d.expectedAt}` : ""})` : ""}`).join(", ").slice(0, 250);
    write = await enqueuePlatformWrite(ctx, { kind: "order.fulfillment_hold", entityType: "order", entityId: orderId, payload: { orderExternalId: order.externalId, hold: { reason: "awaiting_stock", note } }, idempotencyKey: `order.fulfillment_hold:${orderId}:${created[0]!.id}` });
  }
  return { created, write };
}

/** The last platform fulfillment hold Hullwise enqueued for the order, if any. */
async function lastHoldWrite(ctx: ServiceContext, orderId: string) {
  const [w] = await ctx.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.entityType, "order"), eq(schema.platformWrites.entityId, orderId), eq(schema.platformWrites.kind, "order.fulfillment_hold"))).orderBy(desc(schema.platformWrites.createdAt)).limit(1);
  return w ?? null;
}

/**
 * An order no longer waits for stock: timeline event, status recomputed by the engine (the hold
 * goes), and the platform hold lifted when Hullwise placed one (keyed by that hold, so it is lifted once).
 */
export async function releaseOrderHold(ctx: ServiceContext, orderId: string, reason: "stock_available" | "wait_cancelled", metadata: Record<string, unknown> = {}): Promise<PlatformWriteRow | null> {
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "hold_released", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { reason, ...metadata }, createdAt: now });
  await recomputeOrderStatus(ctx, orderId, { eventMetadata: { reason } });
  const hold = await lastHoldWrite(ctx, orderId);
  const [order] = await ctx.tx.select({ externalId: schema.orders.externalId }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!hold || !order?.externalId || hold.status === "superseded") return null;
  return enqueuePlatformWrite(ctx, { kind: "order.fulfillment_release", entityType: "order", entityId: orderId, payload: { orderExternalId: order.externalId }, idempotencyKey: `order.fulfillment_release:${hold.id}` });
}

export interface RefreshResult {
  /** Orders whose every backorder is now covered by stock: released. */
  releasedOrders: string[];
  released: number;
  relinked: number;
  writes: PlatformWriteRow[];
}

/**
 * Re-checks the open backorders of these variants against current stock (first fit in age order
 * over the free units) and against incoming POs (a backorder without a covering PO line gets the
 * earliest one that covers it; one whose line went away is re-linked). Orders left with no open
 * backorder are released, with a notification to the assignee (or the operations team).
 */
export async function refreshBackorderCoverage(ctx: ServiceContext, variantIds: string[]): Promise<RefreshResult> {
  const out: RefreshResult = { releasedOrders: [], released: 0, relinked: 0, writes: [] };
  const ids = [...new Set(variantIds)];
  if (!ids.length) return out;
  const open = await ctx.tx.select().from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.variantId, ids), inArray(schema.backorders.status, OPEN))).orderBy(asc(schema.backorders.createdAt));
  if (!open.length) return out;
  const now = ctx.now ?? new Date();
  const supply = await variantSupply(ctx, [...new Set(open.map((b) => b.variantId))]);
  const touched = new Set<string>();
  for (const variantId of new Set(open.map((b) => b.variantId))) {
    const mine = open.filter((b) => b.variantId === variantId);
    const s = supply.get(variantId) ?? { available: 0, onHand: 0, committed: 0, syncedAt: null };
    // units the level still owes to orders it does not reflect yet (their waiting units excluded) are not free
    const free = s.available - (s.syncedAt ? await unreflectedUnits(ctx, variantId, s.syncedAt, null, []) : 0);
    const releasedIds = allocateRelease(mine, free);
    for (const b of mine) {
      if (releasedIds.has(b.id)) {
        await ctx.tx.update(schema.backorders).set({ status: "fulfilled", resolvedAt: now }).where(eq(schema.backorders.id, b.id));
        out.released++;
        touched.add(b.orderId);
        continue;
      }
      const lines = await incomingLines(ctx, variantId, b.id);
      const current = b.purchaseOrderLineId ? lines.find((l) => l.id === b.purchaseOrderLineId && l.remaining - l.claimed >= b.quantity) : undefined;
      const link = current ?? pickIncomingLine(lines, b.quantity);
      const status = openBackorderStatus(Boolean(link));
      if ((link?.id ?? null) !== b.purchaseOrderLineId || status !== b.status) {
        await ctx.tx.update(schema.backorders).set({ purchaseOrderLineId: link?.id ?? null, status }).where(eq(schema.backorders.id, b.id));
        if ((link?.id ?? null) !== b.purchaseOrderLineId) out.relinked++;
      }
    }
  }
  for (const orderId of touched) {
    const [still] = await ctx.tx.select({ id: schema.backorders.id }).from(schema.backorders).where(and(eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, OPEN))).limit(1);
    if (still) continue;
    const w = await releaseOrderHold(ctx, orderId, "stock_available");
    if (w) out.writes.push(w);
    out.releasedOrders.push(orderId);
    const [o] = await ctx.tx.select({ name: schema.orders.name, assignedTo: schema.orders.assignedTo }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    const users = o?.assignedTo ? [o.assignedTo] : await membersWithRoles(ctx, ["owner", "admin", "operations"]);
    if (o) await notifyUsers(ctx, { userIds: users, type: "stock_available", severity: "success", title: o.name, body: "stock_available", link: `/orders/${orderId}`, metadata: { orderId }, antiSpamMinutes: 60 });
  }
  return out;
}

/** Safety net (tick every 10 minutes): every variant with an open backorder is re-checked. */
export async function recheckOpenBackorders(ctx: ServiceContext): Promise<RefreshResult> {
  const rows = await ctx.tx.selectDistinct({ v: schema.backorders.variantId }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.status, OPEN)));
  return refreshBackorderCoverage(ctx, rows.map((r) => r.v));
}

/** "Cancel wait": staff decide the order should not wait for stock any more; it is released at once. */
export async function cancelBackorderWait(ctx: ServiceContext, orderId: string, note?: string | null): Promise<{ cancelled: number; write: PlatformWriteRow | null }> {
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.update(schema.backorders).set({ status: "cancelled", resolvedAt: now }).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, OPEN))).returning({ id: schema.backorders.id, quantity: schema.backorders.quantity });
  if (!rows.length) return { cancelled: 0, write: null };
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "backorder_closed", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: diffRecords({ awaitingUnits: rows.reduce((s, b) => s + b.quantity, 0) }, { awaitingUnits: 0 }), metadata: { reason: "wait_cancelled", status: "cancelled", backorders: rows.map((b) => b.id), note: note?.trim() || null }, createdAt: now });
  const write = await releaseOrderHold(ctx, orderId, "wait_cancelled");
  return { cancelled: rows.length, write };
}

/* ---------- read models: order card, stock check, views, dashboard ---------- */

export interface OrderBackorder {
  id: string;
  orderLineId: string;
  variantId: string;
  quantity: number;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  po: { id: string; number: string; status: string; expectedAt: Date | null; supplierName: string } | null;
}

/** Backorders of an order (open first), with the PO, supplier and ETA they wait for. */
export async function orderBackorders(ctx: ServiceContext, orderId: string): Promise<OrderBackorder[]> {
  const rows = await ctx.tx
    .select({ b: schema.backorders, poId: schema.purchaseOrders.id, number: schema.purchaseOrders.number, poStatus: schema.purchaseOrders.status, expectedAt: schema.purchaseOrders.expectedAt, supplierName: schema.suppliers.name })
    .from(schema.backorders)
    .leftJoin(schema.purchaseOrderLines, eq(schema.purchaseOrderLines.id, schema.backorders.purchaseOrderLineId))
    .leftJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
    .leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId)))
    .orderBy(desc(schema.backorders.createdAt));
  return rows
    .map((r) => ({ id: r.b.id, orderLineId: r.b.orderLineId, variantId: r.b.variantId, quantity: r.b.quantity, status: r.b.status, createdAt: r.b.createdAt, resolvedAt: r.b.resolvedAt, po: r.poId ? { id: r.poId, number: r.number!, status: r.poStatus!, expectedAt: r.expectedAt, supplierName: r.supplierName ?? "" } : null }))
    .sort((a, b) => Number(OPEN.includes(b.status as never)) - Number(OPEN.includes(a.status as never)));
}

export interface LineStock {
  lineId: string;
  variantId: string;
  available: number;
  committed: number;
  incoming: number;
  backordered: number;
  pos: { id: string; number: string; status: string; expectedAt: Date | null; remaining: number }[];
}

/** Stock check card: per order line, available and committed (Σ locations), incoming POs with status and ETA, units waiting. */
export async function orderLineStock(ctx: ServiceContext, orderId: string): Promise<LineStock[]> {
  const lines = (await ctx.tx.select({ id: schema.orderLines.id, variantId: schema.orderLines.variantId, qty: schema.orderLines.currentQuantity }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)))).filter((l) => l.variantId);
  if (!lines.length) return [];
  const ids = [...new Set(lines.map((l) => l.variantId!))];
  const supply = await variantSupply(ctx, ids);
  const pos = await ctx.tx
    .select({ variantId: schema.purchaseOrderLines.variantId, id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, expectedAt: schema.purchaseOrders.expectedAt, remaining: sql<number>`(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity})::int` })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
    .where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), inArray(schema.purchaseOrderLines.variantId, ids), inArray(schema.purchaseOrders.status, [...INCOMING_PO_STATUSES]), sql`${schema.purchaseOrderLines.quantity} > ${schema.purchaseOrderLines.receivedQuantity}`))
    .orderBy(sql`${schema.purchaseOrders.expectedAt} asc nulls last`);
  const waiting = await ctx.tx.select({ lineId: schema.backorders.orderLineId, n: sql<number>`sum(${schema.backorders.quantity})::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), eq(schema.backorders.orderId, orderId), inArray(schema.backorders.status, OPEN))).groupBy(schema.backorders.orderLineId);
  return lines.map((l) => {
    const s = supply.get(l.variantId!);
    const mine = pos.filter((p) => p.variantId === l.variantId).map(({ variantId: _v, ...p }) => p);
    return { lineId: l.id, variantId: l.variantId!, available: s?.available ?? 0, committed: s?.committed ?? 0, incoming: mine.reduce((sum, p) => sum + p.remaining, 0), backordered: waiting.find((w) => w.lineId === l.id)?.n ?? 0, pos: mine };
  });
}

/** SQL for the order list views (one source for page, export and saved views). */
export const awaitingStockSql = (orderId: SQL | unknown) => sql`exists (select 1 from backorders b where b.order_id = ${orderId} and b.status in ('pending', 'covered'))`;
/**
 * "Ready to release": orders still waiting whose backorders current stock covers (the next re-check
 * releases them), and orders released from a wait that have not shipped yet (the warehouse can go).
 */
export const readyToReleaseSql = (orderId: SQL | unknown, status: SQL | unknown) => sql`(
  (exists (select 1 from backorders b where b.order_id = ${orderId} and b.status in ('pending', 'covered'))
    and not exists (select 1 from backorders b where b.order_id = ${orderId} and b.status in ('pending', 'covered')
      and b.quantity > (select coalesce(sum(il.available), 0) from inventory_levels il where il.variant_id = b.variant_id)))
  or (${status} in ('new', 'pending_review', 'confirmed')
    and exists (select 1 from backorders b where b.order_id = ${orderId} and b.status = 'fulfilled')
    and not exists (select 1 from backorders b where b.order_id = ${orderId} and b.status in ('pending', 'covered'))))`;

export interface BackorderSummary {
  /** Orders currently waiting for stock and the units they wait for. */
  holdingOrders: number;
  holdingUnits: number;
  /** Best sellers (units in the window) whose cover is critical or low, with what waits for them. */
  lowStockBestSellers: { variantId: string; productId: string; label: string; sku: string | null; unitsSold: number; available: number; incoming: number; backordered: number }[];
}

/** Dashboard tile: orders holding stock and the best sellers running out. */
export async function backorderSummary(ctx: ServiceContext, opts: { lowStockThreshold: number; days?: number; limit?: number }): Promise<BackorderSummary> {
  const since = new Date((ctx.now ?? new Date()).getTime() - (opts.days ?? 30) * 864e5);
  const [h] = await ctx.tx.select({ orders: sql<number>`count(distinct ${schema.backorders.orderId})::int`, units: sql<number>`coalesce(sum(${schema.backorders.quantity}), 0)::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.status, OPEN)));
  const sellers = await ctx.tx
    .select({ variantId: schema.orderLines.variantId, units: sql<number>`sum(${schema.orderLines.currentQuantity})::int` })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .where(and(eq(schema.orderLines.tenantId, ctx.tenantId), gt(schema.orders.placedAt, since), isNull(schema.orders.replacedByOrderId), sql`${schema.orders.status} not in ('cancelled', 'refunded')`, sql`${schema.orderLines.variantId} is not null`))
    .groupBy(schema.orderLines.variantId)
    .orderBy(sql`2 desc`)
    .limit(50);
  const ids = sellers.map((s) => s.variantId!);
  const supply = await variantSupply(ctx, ids);
  const low = sellers.filter((s) => (supply.get(s.variantId!)?.available ?? 0) <= opts.lowStockThreshold).slice(0, opts.limit ?? 5);
  if (!low.length) return { holdingOrders: h?.orders ?? 0, holdingUnits: h?.units ?? 0, lowStockBestSellers: [] };
  const lowIds = low.map((s) => s.variantId!);
  const meta = await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, title: schema.productVariants.title, sku: schema.productVariants.sku, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(inArray(schema.productVariants.id, lowIds));
  const inc = await ctx.tx.select({ variantId: schema.purchaseOrderLines.variantId, n: sql<number>`sum(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity})::int` }).from(schema.purchaseOrderLines).innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId)).where(and(inArray(schema.purchaseOrderLines.variantId, lowIds), inArray(schema.purchaseOrders.status, [...INCOMING_PO_STATUSES]))).groupBy(schema.purchaseOrderLines.variantId);
  const bo = await ctx.tx.select({ variantId: schema.backorders.variantId, n: sql<number>`sum(${schema.backorders.quantity})::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.variantId, lowIds), inArray(schema.backorders.status, OPEN))).groupBy(schema.backorders.variantId);
  return {
    holdingOrders: h?.orders ?? 0,
    holdingUnits: h?.units ?? 0,
    lowStockBestSellers: low.map((s) => {
      const m = meta.find((x) => x.id === s.variantId);
      return { variantId: s.variantId!, productId: m?.productId ?? "", label: m ? `${m.product}${m.title ? ` · ${m.title}` : ""}` : "—", sku: m?.sku ?? null, unitsSold: s.units, available: supply.get(s.variantId!)?.available ?? 0, incoming: inc.find((x) => x.variantId === s.variantId)?.n ?? 0, backordered: bo.find((x) => x.variantId === s.variantId)?.n ?? 0 };
    }),
  };
}


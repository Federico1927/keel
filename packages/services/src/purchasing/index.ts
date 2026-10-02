import { and, eq, inArray, schema, sql } from "@keel/db";
import { canTransitionPo, inspectReceipt, movingAverageCost, type PurchaseOrderStatus } from "@keel/core";
import type { ServiceContext } from "../context";
import { refreshBackorderCoverage, type RefreshResult } from "../backorders";
import { applyCostToOrderLines } from "../catalog/costs";
import { syncRecordTasks } from "../tasks";

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
  // highest suffix + 1, not count + 1: numbers can be sparse (imports, deleted drafts) and count would collide
  const [row] = await ctx.tx.select({ n: sql<number>`coalesce(max(nullif(regexp_replace(substr(${schema.purchaseOrders.number}, ${prefix.length + 1}), '[^0-9]', '', 'g'), '')::int), 0)::int` }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), sql`${schema.purchaseOrders.number} like ${prefix + "%"}`));
  return `${prefix}${String((row?.n ?? 0) + 1).padStart(3, "0")}`;
}

/** A catalogue line has a variant; a free-text line (packaging, samples, services) has a description only. */
export interface PoLineInput {
  variantId: string | null;
  description?: string | null;
  quantity: number;
  unitCostMinor: number;
}

export interface CreatePoInput {
  supplierId: string;
  destinationLocationId: string | null;
  currency: string;
  expectedAt: Date | null;
  notes?: string | null;
  lines: PoLineInput[];
}

/**
 * Validates lines and references against the tenant: foreign keys are checked by Postgres without
 * RLS, so ids coming from a form must be proven to belong to this tenant here.
 */
export async function normalizePoInput(ctx: ServiceContext, input: { supplierId: string; destinationLocationId: string | null; lines: PoLineInput[] }): Promise<PoLineInput[]> {
  const lines = input.lines.map((l) => ({ variantId: l.variantId || null, description: l.description?.trim().slice(0, 300) || null, quantity: Math.floor(l.quantity), unitCostMinor: Math.round(l.unitCostMinor) }));
  if (!lines.length || lines.some((l) => !(l.quantity > 0) || !(l.unitCostMinor >= 0) || (!l.variantId && !l.description))) throw new PurchasingError("invalid_quantity");
  const [sup] = await ctx.tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(and(eq(schema.suppliers.tenantId, ctx.tenantId), eq(schema.suppliers.id, input.supplierId))).limit(1);
  if (!sup) throw new PurchasingError("not_found");
  if (input.destinationLocationId) {
    const [loc] = await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.id, input.destinationLocationId))).limit(1);
    if (!loc) throw new PurchasingError("not_found");
  }
  const ids = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)))];
  if (ids.length) {
    const found = await ctx.tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, ids)));
    if (found.length !== ids.length) throw new PurchasingError("not_found");
  }
  return lines;
}

export async function insertPoLines(ctx: ServiceContext, poId: string, lines: PoLineInput[]) {
  return ctx.tx.insert(schema.purchaseOrderLines).values(lines.map((l) => ({ tenantId: ctx.tenantId, purchaseOrderId: poId, variantId: l.variantId, description: l.variantId ? (l.description ?? null) : l.description!, quantity: l.quantity, unitCostMinor: l.unitCostMinor }))).returning({ id: schema.purchaseOrderLines.id, variantId: schema.purchaseOrderLines.variantId });
}

export async function createPurchaseOrder(ctx: ServiceContext, input: CreatePoInput): Promise<string> {
  const lines = await normalizePoInput(ctx, input);
  const number = await nextPoNumber(ctx);
  const [po] = await ctx.tx.insert(schema.purchaseOrders).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, number, status: "draft", currency: input.currency, destinationLocationId: input.destinationLocationId, expectedAt: input.expectedAt, notes: input.notes ?? null, createdBy: ctx.actor.userId }).returning({ id: schema.purchaseOrders.id });
  await insertPoLines(ctx, po!.id, lines);
  await recomputePoTotal(ctx, po!.id);
  return po!.id;
}

export { recomputePoTotal };

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
  await syncRecordTasks(ctx, "purchase_order", [poId]);
  return { from: po.status, to };
}

export interface ReceiveInput {
  poId: string;
  locationId?: string | null;
  /** Units that arrived now per line (not cumulative), with the inspection outcome. */
  lines: { lineId: string; quantity: number; damaged?: number; rejected?: number }[];
  /** Also push the new available quantity to the commerce platform. */
  pushToPlatform?: (variantId: string, locationId: string, available: number) => Promise<void>;
}

export interface ReceiveResult {
  status: PurchaseOrderStatus;
  /** Catalogue lines that put good units in stock. */
  received: { variantId: string; quantity: number; newAvailable: number; newCostMinor: number; newAverageMinor: number }[];
  /** Every inspected line, free-text ones included. */
  inspected: { lineId: string; variantId: string | null; description: string | null; received: number; damaged: number; rejected: number; good: number }[];
  releasedOrders: string[];
  /** Platform holds lifted for the released orders (outbox rows to dispatch after the commit). */
  platformWrites: RefreshResult["writes"];
}

/**
 * Receiving goods with inspection: per line the units that arrived, of which damaged and rejected.
 * Only good units move stock (movement + level at the destination) and update the variant cost
 * (last and moving average); damaged and rejected units are recorded on the line. Free-text lines
 * are counted as arrived but never touch stock. Then PO status (partial/complete) and backorder
 * release with a notification. The P/L reads the cost written here.
 */
export async function receivePurchaseOrder(ctx: ServiceContext, input: ReceiveInput): Promise<ReceiveResult> {
  const [po] = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, input.poId))).limit(1);
  if (!po) throw new PurchasingError("not_found");
  if (!["confirmed", "in_transit", "partially_received"].includes(po.status)) throw new PurchasingError("invalid_transition");
  const locationId = input.locationId ?? po.destinationLocationId ?? (await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isDefault, true))).limit(1))[0]?.id;
  if (!locationId) throw new PurchasingError("no_location");
  if (input.locationId) {
    const [loc] = await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.id, input.locationId))).limit(1);
    if (!loc) throw new PurchasingError("no_location");
  }
  const lines = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
  const now = ctx.now ?? new Date();
  const received: ReceiveResult["received"] = [];
  const inspected: ReceiveResult["inspected"] = [];
  for (const r of input.lines) {
    const line = lines.find((l) => l.id === r.lineId);
    if (!line) continue;
    const check = inspectReceipt({ remaining: line.quantity - line.receivedQuantity, received: r.quantity, damaged: r.damaged, rejected: r.rejected });
    if (check.received <= 0) continue;
    await ctx.tx.update(schema.purchaseOrderLines).set({ receivedQuantity: line.receivedQuantity + check.received, damagedQuantity: line.damagedQuantity + check.damaged, rejectedQuantity: line.rejectedQuantity + check.rejected }).where(eq(schema.purchaseOrderLines.id, line.id));
    inspected.push({ lineId: line.id, variantId: line.variantId, description: line.description, ...check });
    const qty = check.good;
    if (!line.variantId || qty <= 0) continue;
    // stock
    const [level] = await ctx.tx.select().from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, line.variantId), eq(schema.inventoryLevels.locationId, locationId))).limit(1);
    const newAvailable = (level?.available ?? 0) + qty;
    if (level) await ctx.tx.update(schema.inventoryLevels).set({ available: newAvailable, onHand: (level.onHand ?? 0) + qty }).where(eq(schema.inventoryLevels.id, level.id));
    else await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId, available: qty, onHand: qty, committed: 0 });
    await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: line.variantId, locationId, delta: qty, reason: "receipt", referenceType: "purchase_order", referenceId: po.id, actorUserId: ctx.actor.userId, note: check.damaged + check.rejected > 0 ? `${po.number} (−${check.damaged + check.rejected})` : po.number, createdAt: now });
    // cost
    const [variant] = await ctx.tx.select({ costMinor: schema.productVariants.costMinor, averageCostMinor: schema.productVariants.averageCostMinor }).from(schema.productVariants).where(eq(schema.productVariants.id, line.variantId)).limit(1);
    const [{ onHandTotal }] = (await ctx.tx.select({ onHandTotal: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int` }).from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, line.variantId))) as [{ onHandTotal: number }];
    // landed cost (unit cost + allocated duties/freight/fees) when the PO carries charges
    const unitCost = line.landedUnitCostMinor ?? line.unitCostMinor;
    const newAverage = movingAverageCost(variant?.averageCostMinor ?? variant?.costMinor ?? null, Math.max(0, onHandTotal - qty), qty, unitCost);
    await ctx.tx.update(schema.productVariants).set({ costMinor: unitCost, averageCostMinor: newAverage, costSource: "po_receipt", costUpdatedAt: now }).where(eq(schema.productVariants.id, line.variantId));
    // orders sold while the variant had no cost take the received one; costs already on lines stay as sold
    await applyCostToOrderLines(ctx, [line.variantId], "missing");
    received.push({ variantId: line.variantId, quantity: qty, newAvailable, newCostMinor: unitCost, newAverageMinor: newAverage });
    if (input.pushToPlatform) await input.pushToPlatform(line.variantId, locationId, newAvailable);
  }
  // status
  const refreshed = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
  const complete = refreshed.every((l) => l.receivedQuantity >= l.quantity);
  const status: PurchaseOrderStatus = complete ? "received" : "partially_received";
  await ctx.tx.update(schema.purchaseOrders).set({ status, receivedAt: complete ? now : po.receivedAt }).where(eq(schema.purchaseOrders.id, po.id));
  // backorders: stock arrived for these variants; covered orders are released (event, notification, platform hold lifted)
  const coverage = await refreshBackorderCoverage(ctx, received.map((r) => r.variantId));
  await syncRecordTasks(ctx, "purchase_order", [po.id]);
  return { status, received, inspected, releasedOrders: coverage.releasedOrders, platformWrites: coverage.writes };
}

/**
 * Recomputes backorder coverage for the given variants (stock, incoming POs) and releases the orders
 * stock now covers; returns their ids. The platform holds lifted are dispatched by the tick or the action.
 */
export async function refreshBackorders(ctx: ServiceContext, variantIds: string[]): Promise<string[]> {
  return (await refreshBackorderCoverage(ctx, variantIds)).releasedOrders;
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

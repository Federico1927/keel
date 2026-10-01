import { and, desc, eq, gte, inArray, lt, schema, sql, type SQL } from "@keel/db";
import { RETURN_GOODS_BACK_STATUSES, SALE_STATUSES, canTransitionReturn, isReturnStatus, proposedReturnAmount, returnEligibility, returnableLines, returnedFractionBps, type Eligibility, type Period, type ReturnStatus, type ReturnableLine, type TenantSettings } from "@keel/core";
import type { ServiceContext } from "../context";
import { recomputeOrderStatus } from "../orders/state";

export class ReturnError extends Error {
  constructor(public readonly code: "order_not_found" | "return_not_found" | "not_eligible" | "no_lines" | "quantity_exceeds" | "bad_transition" | "bad_reason" | "location_required" | "invalid_input") {
    super(code);
  }
}

/* ---------- reasons ---------- */

export async function listReturnReasons(ctx: ServiceContext, onlyActive = false) {
  const conds = [eq(schema.returnReasons.tenantId, ctx.tenantId)];
  if (onlyActive) conds.push(eq(schema.returnReasons.isActive, true));
  return ctx.tx.select().from(schema.returnReasons).where(and(...conds)).orderBy(schema.returnReasons.sortOrder, schema.returnReasons.label);
}

export async function saveReturnReason(ctx: ServiceContext, input: { code: string; label: string; defaultFault: "merchant" | "customer" | "undetermined"; sortOrder?: number; platformReason?: string | null; labels?: Record<string, string> }, reasonId?: string): Promise<string> {
  const code = input.code.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40);
  if (!code || !input.label.trim()) throw new ReturnError("invalid_input");
  if (reasonId) {
    await ctx.tx.update(schema.returnReasons).set({ label: input.label.trim(), defaultFault: input.defaultFault, sortOrder: input.sortOrder ?? 0, ...(input.platformReason !== undefined ? { platformReason: input.platformReason } : {}), ...(input.labels ? { labels: input.labels } : {}) }).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.id, reasonId)));
    return reasonId;
  }
  const [row] = await ctx.tx.insert(schema.returnReasons).values({ tenantId: ctx.tenantId, code, label: input.label.trim(), defaultFault: input.defaultFault, sortOrder: input.sortOrder ?? 0, platformReason: input.platformReason ?? null, labels: input.labels ?? {} }).onConflictDoUpdate({ target: [schema.returnReasons.tenantId, schema.returnReasons.code], set: { label: input.label.trim(), defaultFault: input.defaultFault, isActive: true, platformReason: input.platformReason ?? null, labels: input.labels ?? {} } }).returning({ id: schema.returnReasons.id });
  return row!.id;
}

export async function setReturnReasonActive(ctx: ServiceContext, reasonId: string, isActive: boolean): Promise<void> {
  await ctx.tx.update(schema.returnReasons).set({ isActive }).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.id, reasonId)));
}

/* ---------- eligibility and creation ---------- */

export interface OrderReturnContext {
  order: typeof schema.orders.$inferSelect;
  eligibility: Eligibility;
  lines: (ReturnableLine & { title: string; variantTitle: string | null; sku: string | null; variantId: string | null })[];
  openReturns: number;
}

/** What a staff member sees before opening a return: eligibility, returnable lines, previous returns. */
export async function orderReturnContext(ctx: ServiceContext, settings: TenantSettings, orderId: string): Promise<OrderReturnContext> {
  const now = ctx.now ?? new Date();
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new ReturnError("order_not_found");
  const [shipment] = await ctx.tx.select({ deliveredAt: schema.shipments.deliveredAt, shippedAt: schema.shipments.shippedAt }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(desc(schema.shipments.createdAt)).limit(1);
  const eligibility = returnEligibility({ orderStatus: order.status, deliveredAt: shipment?.deliveredAt ?? null, shippedAt: shipment?.shippedAt ?? null, now, windowDays: settings.returnWindowDays, shippingFallbackDays: settings.returnShippingFallbackDays });
  const lines = await ctx.tx.select({ id: schema.orderLines.id, quantity: schema.orderLines.quantity, unitPriceMinor: schema.orderLines.unitPriceMinor, totalMinor: schema.orderLines.totalMinor, isAncillary: schema.orderLines.isAncillary, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, sku: schema.orderLines.sku, variantId: schema.orderLines.variantId, productType: schema.products.productType }).from(schema.orderLines).leftJoin(schema.products, eq(schema.products.id, schema.orderLines.productId)).where(eq(schema.orderLines.orderId, orderId));
  const previous = await ctx.tx.select({ orderLineId: schema.returnLines.orderLineId, qty: sql<number>`sum(${schema.returnLines.quantity})::int` }).from(schema.returnLines).innerJoin(schema.returnRequests, eq(schema.returnRequests.id, schema.returnLines.returnId)).where(and(eq(schema.returnRequests.orderId, orderId), sql`${schema.returnRequests.status} <> 'rejected'`)).groupBy(schema.returnLines.orderLineId);
  const previouslyReturned = Object.fromEntries(previous.map((p) => [p.orderLineId, p.qty]));
  const computed = returnableLines(lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.totalMinor, productType: l.productType, isAncillary: l.isAncillary })), order.discountMinor, previouslyReturned, settings.returnExcludedProductTypes);
  const [open] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.orderId, orderId), sql`${schema.returnRequests.status} not in ('refunded','exchanged','voucher_issued','rejected')`));
  return { order, eligibility, lines: computed.map((c, i) => ({ ...c, title: lines[i]!.title, variantTitle: lines[i]!.variantTitle, sku: lines[i]!.sku, variantId: lines[i]!.variantId })), openReturns: open?.n ?? 0 };
}

export interface CreateReturnInput {
  orderId: string;
  reasonCode: string;
  resolution: "refund" | "exchange" | "voucher";
  lines: { orderLineId: string; quantity: number }[];
  customerNote?: string | null;
  staffNote?: string | null;
  /** Staff can open a return outside the window; a note is then mandatory. */
  overrideWindow?: boolean;
  source?: "staff" | "portal" | "platform";
  trackingCode?: string | null;
  trackingCarrier?: string | null;
  exchangeNote?: string | null;
  customFields?: Record<string, string | boolean>;
  bankDetailsEnc?: string | null;
  customerLocale?: string | null;
  idempotencyKey?: string | null;
}

export async function createReturn(ctx: ServiceContext, settings: TenantSettings, input: CreateReturnInput): Promise<{ id: string; number: number }> {
  const now = ctx.now ?? new Date();
  const context = await orderReturnContext(ctx, settings, input.orderId);
  const reason = (await listReturnReasons(ctx, true)).find((r) => r.code === input.reasonCode);
  if (!reason) throw new ReturnError("bad_reason");
  if (!context.eligibility.eligible) {
    if (!input.overrideWindow || !input.staffNote?.trim()) throw new ReturnError("not_eligible");
    if (context.eligibility.reason !== "expired") throw new ReturnError("not_eligible");
  }
  const wanted = input.lines.filter((l) => l.quantity > 0);
  if (!wanted.length) throw new ReturnError("no_lines");
  for (const w of wanted) {
    const line = context.lines.find((l) => l.id === w.orderLineId);
    if (!line || w.quantity > line.returnable) throw new ReturnError("quantity_exceeds");
  }
  const [maxRow] = await ctx.tx.select({ n: sql<number>`coalesce(max(${schema.returnRequests.number}), 0)::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId));
  const number = (maxRow?.n ?? 0) + 1;
  const amounts = proposedReturnAmount(wanted.map((w) => ({ quantity: w.quantity, unitNetMinor: context.lines.find((l) => l.id === w.orderLineId)!.unitNetMinor })), reason.defaultFault, settings.returnShippingCostMinor);
  const [row] = await ctx.tx
    .insert(schema.returnRequests)
    .values({
      tenantId: ctx.tenantId,
      orderId: input.orderId,
      number,
      status: "requested",
      reasonCode: reason.code,
      resolution: input.resolution,
      fault: reason.defaultFault,
      customerNote: input.customerNote ?? null,
      staffNote: input.staffNote ?? null,
      proposedAmountMinor: amounts.proposedMinor,
      deductionMinor: amounts.deductionMinor,
      outOfWindow: !context.eligibility.eligible,
      requestedAt: now,
      createdBy: ctx.actor.userId,
      source: input.source ?? "staff",
      trackingCode: input.trackingCode ?? null,
      trackingCarrier: input.trackingCarrier ?? null,
      exchangeNote: input.exchangeNote ?? null,
      customFields: input.customFields ?? {},
      bankDetailsEnc: input.bankDetailsEnc ?? null,
      customerLocale: input.customerLocale ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      platformSyncStatus: input.source === "platform" ? "synced" : "pending",
    })
    .returning({ id: schema.returnRequests.id });
  await ctx.tx.insert(schema.returnLines).values(wanted.map((w) => ({ tenantId: ctx.tenantId, returnId: row!.id, orderLineId: w.orderLineId, quantity: w.quantity, unitAmountMinor: context.lines.find((l) => l.id === w.orderLineId)!.unitNetMinor })));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "return_requested", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { returnId: row!.id, number, reason: reason.code, resolution: input.resolution, outOfWindow: !context.eligibility.eligible, source: input.source ?? "staff" }, createdAt: now });
  return { id: row!.id, number };
}

/* ---------- workflow ---------- */

export interface TransitionInput {
  returnId: string;
  to: ReturnStatus;
  note?: string | null;
  /** On `received`: which lines to put back to stock, and where. */
  restock?: { locationId: string; lineIds: string[] } | null;
  /** On `inspected`: per-line outcome and accepted amount. */
  inspection?: { lineId: string; outcome: "intact" | "damaged" | "missing"; amountMinor: number }[];
  /** On `refunded`: amount actually refunded (defaults to the inspected/proposed amount). */
  refundAmountMinor?: number | null;
  voucherCode?: string | null;
  fault?: "merchant" | "customer" | "undetermined";
}

export async function transitionReturn(ctx: ServiceContext, input: TransitionInput): Promise<{ previous: string; next: string }> {
  const now = ctx.now ?? new Date();
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, input.returnId))).limit(1);
  if (!req) throw new ReturnError("return_not_found");
  if (!isReturnStatus(input.to) || !canTransitionReturn(req.status, input.to)) throw new ReturnError("bad_transition");
  const lines = await ctx.tx.select({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, restocked: schema.returnLines.restocked, inspectionAmountMinor: schema.returnLines.inspectionAmountMinor, variantId: schema.orderLines.variantId }).from(schema.returnLines).innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId)).where(eq(schema.returnLines.returnId, req.id));
  // every change is written to the commerce platform afterwards (`syncReturnToPlatform`), never inside this transaction
  const patch: Partial<typeof schema.returnRequests.$inferInsert> = { status: input.to, updatedAt: now, platformSyncStatus: "pending" };
  if (input.note?.trim()) patch.staffNote = [req.staffNote, input.note.trim()].filter(Boolean).join("\n");
  if (input.fault) patch.fault = input.fault;
  if (input.to === "approved") patch.approvedAt = now;
  if (input.to === "received") {
    patch.receivedAt = now;
    if (input.restock && input.restock.lineIds.length) {
      if (!input.restock.locationId) throw new ReturnError("location_required");
      patch.restockLocationId = input.restock.locationId;
      const toRestock = lines.filter((l) => input.restock!.lineIds.includes(l.id) && !l.restocked && l.variantId);
      for (const l of toRestock) {
        await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: l.variantId!, locationId: input.restock.locationId, delta: l.quantity, reason: "return_restock", referenceType: "return", referenceId: req.id, actorUserId: ctx.actor.userId, note: `R-${req.number}`, createdAt: now });
        await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: l.variantId!, locationId: input.restock.locationId, available: l.quantity, updatedAt: now }).onConflictDoUpdate({ target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId], set: { available: sql`${schema.inventoryLevels.available} + ${l.quantity}`, updatedAt: now } });
        await ctx.tx.update(schema.returnLines).set({ restocked: true }).where(eq(schema.returnLines.id, l.id));
      }
    }
  }
  if (input.to === "inspected" && input.inspection) {
    for (const i of input.inspection) {
      if (!lines.some((l) => l.id === i.lineId)) throw new ReturnError("invalid_input");
      await ctx.tx.update(schema.returnLines).set({ inspectionOutcome: i.outcome, inspectionAmountMinor: Math.max(0, Math.round(i.amountMinor)) }).where(eq(schema.returnLines.id, i.lineId));
    }
  }
  const acceptedAmount = lines.reduce((s, l) => s + (l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor), 0);
  const inspectedAmount = input.inspection ? input.inspection.reduce((s, i) => s + Math.max(0, Math.round(i.amountMinor)), 0) : acceptedAmount;
  if (input.to === "refunded") {
    patch.refundedAmountMinor = Math.max(0, Math.round(input.refundAmountMinor ?? inspectedAmount));
    patch.closedAt = now;
  }
  if (input.to === "voucher_issued") {
    patch.voucherCode = input.voucherCode?.trim() || `V-${req.number}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    patch.refundedAmountMinor = Math.max(0, Math.round(input.refundAmountMinor ?? inspectedAmount));
    patch.closedAt = now;
  }
  if (input.to === "exchanged" || input.to === "rejected") patch.closedAt = now;
  await ctx.tx.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, req.id));

  // Propagate to the order: returned fraction from goods that came back, refund totals, payment status, canonical status.
  const [order] = await ctx.tx.select().from(schema.orders).where(eq(schema.orders.id, req.orderId)).limit(1);
  if (order) {
    const orderLines = await ctx.tx.select({ id: schema.orderLines.id, quantity: schema.orderLines.quantity }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, order.id), eq(schema.orderLines.isAncillary, false)));
    const back = await ctx.tx.select({ orderLineId: schema.returnLines.orderLineId, qty: sql<number>`sum(${schema.returnLines.quantity})::int` }).from(schema.returnLines).innerJoin(schema.returnRequests, eq(schema.returnRequests.id, schema.returnLines.returnId)).where(and(eq(schema.returnRequests.orderId, order.id), inArray(schema.returnRequests.status, [...RETURN_GOODS_BACK_STATUSES]))).groupBy(schema.returnLines.orderLineId);
    const fraction = returnedFractionBps(orderLines, Object.fromEntries(back.map((b) => [b.orderLineId, b.qty])));
    const [refunds] = await ctx.tx.select({ total: sql<number>`coalesce(sum(${schema.returnRequests.refundedAmountMinor}), 0)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.orderId, order.id), eq(schema.returnRequests.status, "refunded")));
    const refundedMinor = Math.max(order.refundedMinor, refunds?.total ?? 0);
    const paymentStatus = refundedMinor <= 0 ? order.paymentStatus : refundedMinor >= order.totalMinor ? "refunded" : order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded" ? "partially_refunded" : order.paymentStatus;
    const changed = fraction !== order.returnedFraction || refundedMinor !== order.refundedMinor || paymentStatus !== order.paymentStatus;
    if (changed) await ctx.tx.update(schema.orders).set({ returnedFraction: fraction, refundedMinor, paymentStatus, updatedAt: now }).where(eq(schema.orders.id, order.id));
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "return_updated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { returnStatus: { from: req.status, to: input.to }, ...(changed ? { returnedFraction: { from: order.returnedFraction, to: fraction }, refundedMinor: { from: order.refundedMinor, to: refundedMinor } } : {}) }, metadata: { returnId: req.id, number: req.number }, createdAt: now });
    if (changed) await recomputeOrderStatus(ctx, order.id, { eventMetadata: { source: "return", returnId: req.id } });
  }
  return { previous: req.status, next: input.to };
}

/* ---------- lists and analytics ---------- */

export interface ReturnFilters {
  status?: string;
  source?: string;
  /** "error": write to the platform failed. */
  sync?: string;
  reason?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listReturns(ctx: ServiceContext, f: ReturnFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, f.pageSize ?? 50);
  const conds: SQL[] = [eq(schema.returnRequests.tenantId, ctx.tenantId)];
  if (f.status === "open") conds.push(sql`${schema.returnRequests.status} not in ('refunded','exchanged','voucher_issued','rejected')`);
  else if (f.status) conds.push(eq(schema.returnRequests.status, f.status));
  if (f.reason) conds.push(eq(schema.returnRequests.reasonCode, f.reason));
  if (f.source) conds.push(eq(schema.returnRequests.source, f.source));
  if (f.sync === "error") conds.push(eq(schema.returnRequests.platformSyncStatus, "error"));
  if (f.q) conds.push(sql`(${schema.orders.name} ilike ${"%" + f.q + "%"} or ${schema.orders.customerName} ilike ${"%" + f.q + "%"} or ${schema.orders.email} ilike ${"%" + f.q + "%"} or cast(${schema.returnRequests.number} as text) = ${f.q.replace(/^R-/i, "")})`);
  const where = and(...conds);
  const rows = await ctx.tx.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, status: schema.returnRequests.status, reasonCode: schema.returnRequests.reasonCode, resolution: schema.returnRequests.resolution, fault: schema.returnRequests.fault, proposedAmountMinor: schema.returnRequests.proposedAmountMinor, refundedAmountMinor: schema.returnRequests.refundedAmountMinor, requestedAt: schema.returnRequests.requestedAt, closedAt: schema.returnRequests.closedAt, outOfWindow: schema.returnRequests.outOfWindow, source: schema.returnRequests.source, platformSyncStatus: schema.returnRequests.platformSyncStatus, orderId: schema.orders.id, orderName: schema.orders.name, customerName: schema.orders.customerName, currency: schema.orders.currency, items: sql<number>`(select coalesce(sum(l.quantity),0) from return_lines l where l.return_id = ${schema.returnRequests.id})::int` }).from(schema.returnRequests).innerJoin(schema.orders, eq(schema.orders.id, schema.returnRequests.orderId)).where(where).orderBy(desc(schema.returnRequests.requestedAt)).limit(pageSize).offset((page - 1) * pageSize);
  const [count] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).innerJoin(schema.orders, eq(schema.orders.id, schema.returnRequests.orderId)).where(where);
  const counts = await ctx.tx.select({ status: schema.returnRequests.status, n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId)).groupBy(schema.returnRequests.status);
  const [extra] = await ctx.tx.select({ syncErrors: sql<number>`count(*) filter (where ${schema.returnRequests.platformSyncStatus} = 'error')::int`, portal: sql<number>`count(*) filter (where ${schema.returnRequests.source} = 'portal')::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId));
  return { rows, total: count?.n ?? 0, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, syncErrors: extra?.syncErrors ?? 0, portalCount: extra?.portal ?? 0 };
}

export async function returnDetail(ctx: ServiceContext, returnId: string) {
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!req) return null;
  const [order] = await ctx.tx.select().from(schema.orders).where(eq(schema.orders.id, req.orderId)).limit(1);
  const lines = await ctx.tx.select({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, inspectionOutcome: schema.returnLines.inspectionOutcome, inspectionAmountMinor: schema.returnLines.inspectionAmountMinor, restocked: schema.returnLines.restocked, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, sku: schema.orderLines.sku, variantId: schema.orderLines.variantId, productId: schema.orderLines.productId }).from(schema.returnLines).innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId)).where(eq(schema.returnLines.returnId, req.id));
  const [reason] = await ctx.tx.select().from(schema.returnReasons).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.code, req.reasonCode))).limit(1);
  const events = await ctx.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, req.orderId), sql`${schema.orderEvents.metadata}->>'returnId' = ${req.id}`)).orderBy(desc(schema.orderEvents.createdAt));
  const locations = await ctx.tx.select({ id: schema.locations.id, name: schema.locations.name, isDefault: schema.locations.isDefault }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isActive, true))).orderBy(desc(schema.locations.isDefault), schema.locations.name);
  return { request: req, order: order!, lines, reason: reason ?? null, events, locations };
}

export interface ReturnsAnalytics {
  total: number;
  closed: number;
  refundedMinor: number;
  soldOrders: number;
  returnRate: number | null;
  byReason: { reasonCode: string; label: string; count: number; amountMinor: number; share: number }[];
  byFault: { fault: string; count: number; amountMinor: number }[];
  byProduct: { productId: string | null; title: string; returnedQty: number; soldQty: number; rate: number | null; amountMinor: number }[];
  byResolution: { resolution: string; count: number }[];
}

export async function returnsAnalytics(ctx: ServiceContext, period: Period): Promise<ReturnsAnalytics> {
  const t = ctx.tenantId;
  const inPeriod = and(eq(schema.returnRequests.tenantId, t), gte(schema.returnRequests.requestedAt, period.from), lt(schema.returnRequests.requestedAt, period.to), sql`${schema.returnRequests.status} <> 'rejected'`);
  const [totals] = await ctx.tx.select({ total: sql<number>`count(*)::int`, closed: sql<number>`count(*) filter (where ${schema.returnRequests.closedAt} is not null)::int`, refunded: sql<number>`coalesce(sum(${schema.returnRequests.refundedAmountMinor}), 0)::int` }).from(schema.returnRequests).where(inPeriod);
  const [sold] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, t), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), inArray(schema.orders.status, [...SALE_STATUSES, "returned", "refunded"])));
  const byReason = await ctx.tx.select({ reasonCode: schema.returnRequests.reasonCode, label: sql<string>`coalesce(max(${schema.returnReasons.label}), ${schema.returnRequests.reasonCode})`, count: sql<number>`count(*)::int`, amountMinor: sql<number>`coalesce(sum(coalesce(${schema.returnRequests.refundedAmountMinor}, ${schema.returnRequests.proposedAmountMinor})), 0)::int` }).from(schema.returnRequests).leftJoin(schema.returnReasons, and(eq(schema.returnReasons.tenantId, schema.returnRequests.tenantId), eq(schema.returnReasons.code, schema.returnRequests.reasonCode))).where(inPeriod).groupBy(schema.returnRequests.reasonCode).orderBy(sql`count(*) desc`);
  const byFault = await ctx.tx.select({ fault: schema.returnRequests.fault, count: sql<number>`count(*)::int`, amountMinor: sql<number>`coalesce(sum(coalesce(${schema.returnRequests.refundedAmountMinor}, ${schema.returnRequests.proposedAmountMinor})), 0)::int` }).from(schema.returnRequests).where(inPeriod).groupBy(schema.returnRequests.fault);
  const byResolution = await ctx.tx.select({ resolution: schema.returnRequests.resolution, count: sql<number>`count(*)::int` }).from(schema.returnRequests).where(inPeriod).groupBy(schema.returnRequests.resolution);
  const byProduct = await ctx.tx.execute<{ product_id: string | null; title: string; returned_qty: number; sold_qty: number; amount_minor: number }>(sql`
    with ret as (
      select ol.product_id, max(ol.title) as title, sum(rl.quantity)::int as returned_qty, sum(rl.quantity * rl.unit_amount_minor)::int as amount_minor
      from return_lines rl join return_requests rr on rr.id = rl.return_id join order_lines ol on ol.id = rl.order_line_id
      where rr.tenant_id = ${t} and rr.requested_at >= ${period.from} and rr.requested_at < ${period.to} and rr.status <> 'rejected'
      group by ol.product_id
    ), sold as (
      select ol.product_id, sum(ol.quantity)::int as sold_qty
      from order_lines ol join orders o on o.id = ol.order_id
      where o.tenant_id = ${t} and o.placed_at >= ${period.from} and o.placed_at < ${period.to} and o.status <> 'cancelled' and ol.is_ancillary = false
      group by ol.product_id
    )
    select r.product_id, r.title, r.returned_qty, coalesce(s.sold_qty, 0) as sold_qty, r.amount_minor
    from ret r left join sold s on s.product_id is not distinct from r.product_id
    order by r.returned_qty desc limit 50`);
  const total = totals?.total ?? 0;
  return {
    total,
    closed: totals?.closed ?? 0,
    refundedMinor: totals?.refunded ?? 0,
    soldOrders: sold?.n ?? 0,
    returnRate: sold?.n ? total / sold.n : null,
    byReason: byReason.map((r) => ({ ...r, share: total ? r.count / total : 0 })),
    byFault,
    byResolution,
    byProduct: byProduct.rows.map((r) => ({ productId: r.product_id, title: r.title, returnedQty: r.returned_qty, soldQty: r.sold_qty, rate: r.sold_qty ? r.returned_qty / r.sold_qty : null, amountMinor: r.amount_minor })),
  };
}

export * from "./platform";
export * from "./portal";

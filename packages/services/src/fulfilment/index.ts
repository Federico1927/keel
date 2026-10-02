import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, recordAudit, schema, sql, type SQL } from "@hullwise/db";
import { OPEN_STATUSES, TO_SHIP_STATUSES, businessDaysElapsed, diffRecords, isToShip, lateToShipCutoff, localDateKey, tablesPdf, validateShipInput, zonedDayStart, type ShipInput, type ShipInputIssue, type TableDocument, type TenantSettings } from "@hullwise/core";
import { IntegrationError, type CommercePlatform } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { recomputeOrderStatus } from "../orders/state";
import { importFulfillment } from "../sync";
import { runPlatformWriteNow } from "../writes";
import { SkipItem, newBatchId, runBatch, type BatchSummary } from "../lists/batch";
import type { BulkRunner } from "../lists/bulk";

export * from "./cases";
export * from "./mappings";

/**
 * Fulfilment from Hullwise (issue #28): the late-to-ship queue, the pick/pack board (pending → packed →
 * shipped) and packing slips. "Ship" goes through the platform-writes outbox synchronously: the
 * fulfilment is created on the commerce platform first and Hullwise changes only once it is acknowledged.
 */

export interface FulfilmentClock {
  timezone: string;
  settings: Pick<TenantSettings, "lateToShipBusinessDays" | "workdays">;
  now?: Date;
}

export class FulfilmentError extends Error {
  constructor(public readonly code: "not_found" | "not_to_ship" | "invalid_input" | "no_platform_order" | "platform_error", message?: string, public readonly issues?: ShipInputIssue[]) {
    super(message ?? code);
    this.name = "FulfilmentError";
  }
}

// qualified by hand: drizzle renders a column of a single-table select unqualified, which a correlated subquery would bind to its own table
const ORDER_ID = sql.raw(`"orders"."id"`);
const hasShipment = sql<boolean>`exists (select 1 from ${schema.shipments} s where s.order_id = ${ORDER_ID})`;

/** Orders ready to ship with nothing shipped: the base of the queue, the board and the alert. */
export function toShipWhere(tenantId: string): SQL {
  return and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.status, [...TO_SHIP_STATUSES]), isNull(schema.orders.replacedByOrderId), sql`coalesce(lower(${schema.orders.fulfillmentStatusRaw}), '') <> 'fulfilled'`, sql`not ${hasShipment}`)!;
}

export function lateCutoffFor(clock: FulfilmentClock): Date {
  return lateToShipCutoff(clock.now ?? new Date(), clock.settings.lateToShipBusinessDays, clock.timezone, clock.settings.workdays);
}

export async function countToShip(ctx: ServiceContext): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(toShipWhere(ctx.tenantId));
  return r?.n ?? 0;
}

export async function countLateToShip(ctx: ServiceContext, clock: FulfilmentClock): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(toShipWhere(ctx.tenantId), lt(schema.orders.placedAt, lateCutoffFor(clock))));
  return r?.n ?? 0;
}

export type BoardView = "late" | "all";
export interface BoardFilters {
  view: BoardView;
  q?: string;
}

export function parseBoardFilters(sp: Record<string, string | string[] | undefined>): BoardFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
  return { view: one(sp.view) === "late" ? "late" : "all", q: one(sp.q)?.trim().slice(0, 100) || undefined };
}

export interface BoardCard {
  id: string;
  name: string;
  customerName: string | null;
  country: string | null;
  city: string | null;
  placedAt: Date;
  status: string;
  paymentMethod: string;
  totalMinor: number;
  currency: string;
  packedAt: Date | null;
  units: number;
  lines: number;
  businessDays: number;
  late: boolean;
  note: string | null;
}
export interface ShippedCard {
  orderId: string;
  name: string;
  customerName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  shippedAt: Date | null;
}

/**
 * The pick/pack board: oldest first, `perColumn` cards per column (pending, packed) and the
 * shipments created today in the tenant's time zone; counts are exact.
 */
export async function fulfilmentBoard(ctx: ServiceContext, clock: FulfilmentClock, f: BoardFilters, perColumn = 40) {
  const now = clock.now ?? new Date();
  const cutoff = lateCutoffFor(clock);
  const conds: SQL[] = [toShipWhere(ctx.tenantId)];
  if (f.view === "late") conds.push(lt(schema.orders.placedAt, cutoff));
  if (f.q) conds.push(sql`${schema.orders.searchBlob} like ${`%${f.q.toLowerCase()}%`}`);
  const where = and(...conds)!;
  const units = sql<number>`(select coalesce(sum(l.current_quantity), 0)::int from ${schema.orderLines} l where l.order_id = ${ORDER_ID} and not l.is_ancillary)`;
  const lineCount = sql<number>`(select count(*)::int from ${schema.orderLines} l where l.order_id = ${ORDER_ID} and not l.is_ancillary and l.current_quantity > 0)`;
  const cols = { id: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, country: schema.orders.shippingCountry, city: schema.orders.shippingCity, placedAt: schema.orders.placedAt, status: schema.orders.status, paymentMethod: schema.orders.paymentMethod, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, packedAt: schema.orders.packedAt, units, lines: lineCount, note: schema.orders.note };
  const column = (packed: boolean) => ctx.tx.select(cols).from(schema.orders).where(and(where, packed ? isNotNull(schema.orders.packedAt) : isNull(schema.orders.packedAt))).orderBy(asc(schema.orders.placedAt)).limit(perColumn);
  const toCard = (r: Awaited<ReturnType<typeof column>>[number]): BoardCard => ({ ...r, businessDays: businessDaysElapsed(r.placedAt, now, clock.timezone, clock.settings.workdays), late: r.placedAt < cutoff });
  const [pending, packed] = [(await column(false)).map(toCard), (await column(true)).map(toCard)];
  const [counts] = await ctx.tx
    .select({ all: sql<number>`count(*)::int`, late: sql<number>`count(*) filter (where ${schema.orders.placedAt} < ${cutoff})::int`, pending: sql<number>`count(*) filter (where ${schema.orders.packedAt} is null)::int`, packed: sql<number>`count(*) filter (where ${schema.orders.packedAt} is not null)::int` })
    .from(schema.orders)
    .where(f.q ? and(toShipWhere(ctx.tenantId), sql`${schema.orders.searchBlob} like ${`%${f.q.toLowerCase()}%`}`) : toShipWhere(ctx.tenantId));
  const [filtered] = await ctx.tx.select({ pending: sql<number>`count(*) filter (where ${schema.orders.packedAt} is null)::int`, packed: sql<number>`count(*) filter (where ${schema.orders.packedAt} is not null)::int` }).from(schema.orders).where(where);
  const todayStart = zonedDayStart(localDateKey(now, clock.timezone), clock.timezone);
  const shipped: ShippedCard[] = await ctx.tx
    .select({ orderId: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, carrier: schema.shipments.carrier, trackingNumber: schema.shipments.trackingNumber, trackingUrl: schema.shipments.trackingUrl, status: schema.shipments.status, shippedAt: schema.shipments.shippedAt })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(and(eq(schema.shipments.tenantId, ctx.tenantId), gte(schema.shipments.shippedAt, todayStart)))
    .orderBy(desc(schema.shipments.shippedAt))
    .limit(perColumn);
  const [shippedToday] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), gte(schema.shipments.shippedAt, todayStart)));
  return { pending, packed, shipped, counts: { ...(counts ?? { all: 0, late: 0, pending: 0, packed: 0 }), shippedToday: shippedToday?.n ?? 0 }, filtered: filtered ?? { pending: 0, packed: 0 }, cutoff, thresholdDays: clock.settings.lateToShipBusinessDays };
}

/* ---------- pick/pack ---------- */

async function orderFacts(ctx: ServiceContext, orderId: string) {
  const [o] = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, externalId: schema.orders.externalId, status: schema.orders.status, fulfillmentStatusRaw: schema.orders.fulfillmentStatusRaw, manualStatus: schema.orders.manualStatus, packedAt: schema.orders.packedAt, replacedByOrderId: schema.orders.replacedByOrderId, hasShipment }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  return o ?? null;
}

export type PackOutcome = { kind: "not_found" } | { kind: "not_to_ship"; name: string } | { kind: "unchanged"; name: string } | { kind: "done"; name: string };

/** Marks an order packed (or back to pending). Local to Hullwise; timeline event with author and diff. */
export async function setOrderPacked(ctx: ServiceContext, orderId: string, packed: boolean, opts: { eventMetadata?: Record<string, unknown> } = {}): Promise<PackOutcome> {
  const o = await orderFacts(ctx, orderId);
  if (!o) return { kind: "not_found" };
  if (o.replacedByOrderId || !isToShip({ status: o.status, fulfillmentStatusRaw: o.fulfillmentStatusRaw, hasShipment: o.hasShipment })) return { kind: "not_to_ship", name: o.name };
  if (Boolean(o.packedAt) === packed) return { kind: "unchanged", name: o.name };
  const now = ctx.now ?? new Date();
  const next = packed ? now : null;
  await ctx.tx.update(schema.orders).set({ packedAt: next, packedBy: packed ? ctx.actor.userId : null }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: packed ? "packed" : "unpacked", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: diffRecords({ packedAt: o.packedAt?.toISOString() ?? null }, { packedAt: next?.toISOString() ?? null }), metadata: { ...(opts.eventMetadata ?? {}) }, createdAt: now });
  return { kind: "done", name: o.name };
}

/** Bulk "mark packed" / "back to pending" from the board: one transaction per order through `runBatch`, outcome per order, `batch_id` on events and audit. */
export async function bulkSetPacked(runner: BulkRunner, orderIds: string[], packed: boolean, opts: { concurrency: number }): Promise<BatchSummary> {
  const batchId = newBatchId();
  const names = await runner.run((s) => s.tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, s.tenantId), inArray(schema.orders.id, orderIds))));
  const items = [...new Set(orderIds)].map((id) => ({ id, label: names.find((n) => n.id === id)?.name ?? null }));
  return runBatch(
    items,
    (item) =>
      runner.run(async (s) => {
        const r = await setOrderPacked(s, item.id, packed, { eventMetadata: { batchId, source: "bulk" } });
        if (r.kind !== "done") throw new SkipItem(r.kind);
        await recordAudit(s.tx, { tenantId: runner.tenantId, ...runner.audit, action: packed ? "order.packed" : "order.unpacked", entityType: "order", entityId: item.id, diff: { packed: { from: !packed, to: packed } }, metadata: { batchId } });
      }),
    { concurrency: opts.concurrency, batchId },
  );
}

/* ---------- ship ---------- */

export interface ShipOrderInput extends ShipInput {
  notifyCustomer: boolean;
}

/**
 * Ships an order from Hullwise: `fulfillment.create` on the commerce platform through the outbox
 * (synchronous, recorded), then — only once the platform answered — the shipment, the order's
 * fulfilment state, a `fulfilled` timeline event with author and diff, and the status recompute.
 * A refused or failed platform call changes nothing locally (the caller's transaction rolls back).
 */
export async function shipOrder(ctx: ServiceContext, platform: CommercePlatform, orderId: string, input: ShipOrderInput): Promise<{ name: string; shipmentId: string; orderStatus: string; externalId: string }> {
  const o = await orderFacts(ctx, orderId);
  if (!o) throw new FulfilmentError("not_found");
  if (o.replacedByOrderId || !isToShip({ status: o.status, fulfillmentStatusRaw: o.fulfillmentStatusRaw, hasShipment: o.hasShipment })) throw new FulfilmentError("not_to_ship");
  const issues = validateShipInput(input);
  if (issues.length) throw new FulfilmentError("invalid_input", undefined, issues);
  if (!o.externalId) throw new FulfilmentError("no_platform_order");
  const carrier = input.carrier.trim();
  const trackingNumber = input.trackingNumber.trim();
  const trackingUrl = input.trackingUrl?.trim() || null;
  let f;
  try {
    f = await runPlatformWriteNow(ctx, platform, { kind: "fulfillment.create", entityType: "order", entityId: orderId, payload: { input: { orderExternalId: o.externalId, carrier, trackingNumber, trackingUrl, notifyCustomer: input.notifyCustomer } }, idempotencyKey: `order:${orderId}:fulfil:${trackingNumber}` });
  } catch (e) {
    throw new FulfilmentError("platform_error", e instanceof IntegrationError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e));
  }
  const now = ctx.now ?? new Date();
  const imported = await importFulfillment(ctx, orderId, f, now);
  // shipping is a fact that moves past a status staff set before it (confirmed, on review…)
  const clearManual = o.manualStatus && (OPEN_STATUSES as readonly string[]).includes(o.manualStatus) && o.manualStatus !== "on_hold";
  await ctx.tx.update(schema.orders).set({ fulfillmentStatusRaw: "fulfilled", ...(clearManual ? { manualStatus: null } : {}), packedAt: o.packedAt ?? now, packedBy: o.packedAt ? undefined : ctx.actor.userId, platformUpdatedAt: now }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.orderEvents).values({
    tenantId: ctx.tenantId,
    orderId,
    type: "fulfilled",
    actorType: ctx.actor.type,
    actorUserId: ctx.actor.userId,
    diff: diffRecords<Record<string, unknown>>({ fulfillmentStatusRaw: o.fulfillmentStatusRaw, carrier: null, trackingNumber: null, ...(clearManual ? { manualStatus: o.manualStatus } : {}) }, { fulfillmentStatusRaw: "fulfilled", carrier: f.carrier ?? carrier, trackingNumber: f.trackingNumber ?? trackingNumber, ...(clearManual ? { manualStatus: null } : {}) }),
    metadata: { platform: platform.provider, fulfillmentExternalId: f.externalId, shipmentId: imported.shipmentId, notifyCustomer: input.notifyCustomer, source: "hullwise" },
    createdAt: now,
  });
  const r = await recomputeOrderStatus(ctx, orderId, { eventMetadata: { source: "fulfilment" } });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? "user" : "system", action: "order.fulfilled", entityType: "order", entityId: orderId, diff: { status: { from: r.previous, to: r.next } }, metadata: { carrier, trackingNumber, externalId: f.externalId } });
  return { name: o.name, shipmentId: imported.shipmentId, orderStatus: r.next, externalId: f.externalId };
}

/* ---------- packing slips ---------- */

export interface PackingSlipLabels {
  title: string;
  order: string;
  placed: string;
  shipTo: string;
  sku: string;
  item: string;
  variant: string;
  quantity: string;
  units: string;
  note: string;
}

/** Packing slips (one or many orders, one per page group) with the existing PDF writer; order of `orderIds` is kept. */
export async function packingSlipsPdf(ctx: ServiceContext, orderIds: string[], labels: PackingSlipLabels, fmt: { date: (d: Date) => string; companyName: string }): Promise<{ filename: string; bytes: Uint8Array; count: number } | null> {
  const ids = [...new Set(orderIds)].slice(0, 200);
  if (!ids.length) return null;
  const orders = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, customerName: schema.orders.customerName, shippingAddress: schema.orders.shippingAddress, note: schema.orders.note }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, ids)));
  if (!orders.length) return null;
  const lines = await ctx.tx.select({ orderId: schema.orderLines.orderId, sku: schema.orderLines.sku, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, quantity: schema.orderLines.currentQuantity }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), inArray(schema.orderLines.orderId, orders.map((o) => o.id)), eq(schema.orderLines.isAncillary, false))).orderBy(asc(schema.orderLines.title));
  const docs: TableDocument[] = ids
    .map((id) => orders.find((o) => o.id === id))
    .filter((o): o is (typeof orders)[number] => Boolean(o))
    .map((o) => {
      const a = (o.shippingAddress ?? {}) as Record<string, string | null | undefined>;
      const mine = lines.filter((l) => l.orderId === o.id && l.quantity > 0);
      const shipTo = [a.name ?? o.customerName, a.address1, a.address2, [a.zip, a.city, a.province].filter(Boolean).join(" "), a.country].filter((x): x is string => Boolean(x && String(x).trim()));
      return {
        title: `${labels.title} ${o.name}`,
        header: [fmt.companyName, `${labels.placed}: ${fmt.date(o.placedAt)}`, `${labels.shipTo}: ${shipTo.join(", ")}`],
        columns: [
          { label: labels.sku, width: 110 },
          { label: labels.item, width: 220 },
          { label: labels.variant, width: 120 },
          { label: labels.quantity, width: 49, align: "right" as const },
        ],
        rows: mine.map((l) => [l.sku ?? "", l.title, l.variantTitle ?? "", String(l.quantity)]),
        totals: [[labels.units, String(mine.reduce((s, l) => s + l.quantity, 0))]],
        footer: o.note ? [`${labels.note}: ${o.note}`] : [],
      };
    });
  const bytes = tablesPdf(docs, { title: labels.title });
  const filename = docs.length === 1 ? `${labels.title}-${orders[0]!.name.replace(/[^\w-]+/g, "")}.pdf` : `${labels.title}-${docs.length}.pdf`;
  return { filename: filename.replace(/\s+/g, "-").toLowerCase(), bytes, count: docs.length };
}

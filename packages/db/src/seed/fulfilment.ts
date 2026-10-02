import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { deriveOrderStatus, type OrderStatus, type PaymentMethod, type PaymentStatus, type ShipmentStatus, type StateRule } from "@keel/core";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
/** Same window as the service sweep (`DELIVERY_CASE_WINDOW_DAYS`). */
const CASE_WINDOW_DAYS = 30;

/**
 * Fulfilment demo (issue #28), on top of the generated orders, deterministic (ordered by order
 * number, no random draws): a backlog of paid orders that should have shipped days ago (the
 * late-to-ship queue), a few packed parcels on the board, enough recent delivery exceptions and
 * returns to sender to fill both work queues at any scale, their cases (one claimed, one already
 * instructed, one review half done), and an alert rule on the late-to-ship count.
 */
export async function seedFulfilment(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  const it = key === "northwind";
  const ops = userIds[it ? "ops@northwind.demo" : "ops@harborhome.demo"] ?? null;
  const owner = userIds[it ? "owner@northwind.demo" : "owner@harborhome.demo"] ?? null;
  const care = userIds[it ? "care@northwind.demo" : "owner@harborhome.demo"] ?? owner;
  const ruleRows = await db.select().from(schema.stateRules).where(eq(schema.stateRules.tenantId, tenantId));
  const rules: StateRule[] = ruleRows.map((r) => ({ id: r.id, name: r.name, priority: r.priority, conditions: r.conditions as StateRule["conditions"], resultStatus: r.resultStatus as OrderStatus, isActive: r.isActive }));
  const derive = (o: typeof schema.orders.$inferSelect, shipmentStatus: ShipmentStatus | null, fulfillmentStatusRaw: string | null) =>
    deriveOrderStatus({ platformTags: o.platformTags, paymentMethod: o.paymentMethod as PaymentMethod, paymentStatus: o.paymentStatus as PaymentStatus, financialStatusRaw: o.financialStatusRaw, fulfillmentStatusRaw, cancelledAt: o.cancelledAt, placedAt: o.placedAt, sourceChannel: o.sourceChannel, shipmentStatus, returnedFraction: o.returnedFraction / 10000, manualStatus: null, replacedByOrderId: o.replacedByOrderId, now }, rules);
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  // the newest delivered orders stay as generated: other features (returns, reviews) demo on them
  const keep = (await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "delivered"))).orderBy(sql`${schema.orders.placedAt} desc`).limit(8)).map((r) => r.id);
  const notKept = keep.length ? sql`${schema.orders.id} not in (${sql.join(keep.map((k) => sql`${k}::uuid`), sql`, `)})` : sql`true`;

  /* ---------- backlog: delivered prepaid orders of 5–12 days ago become paid, unshipped ---------- */
  const backlogWanted = it ? 7 : 4;
  let backlog: (typeof schema.orders.$inferSelect)[] = [];
  for (const [from, to] of [[12, 5], [30, 5]] as const) {
    backlog = await db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "delivered"), eq(schema.orders.paymentStatus, "paid"), sql`${schema.orders.paymentMethod} <> 'cod'`, sql`${schema.orders.replacedByOrderId} is null`, sql`${schema.orders.placedAt} between ${ago(from)} and ${ago(to)}`, sql`not exists (select 1 from return_requests r where r.order_id = ${schema.orders.id})`, notKept))
      .orderBy(asc(schema.orders.orderNumber))
      .limit(backlogWanted);
    if (backlog.length >= Math.min(2, backlogWanted)) break;
  }
  const backlogIds = backlog.map((o) => o.id);
  if (backlogIds.length) {
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, backlogIds));
    await db.delete(schema.orderEvents).where(and(inArray(schema.orderEvents.orderId, backlogIds), inArray(schema.orderEvents.type, ["fulfillment_updated", "shipment_updated"])));
    for (const o of backlog) {
      const d = derive(o, null, null);
      await db.update(schema.orders).set({ status: d.status, statusReason: d.reason, statusSource: "rules", manualStatus: null, fulfillmentStatusRaw: null, closedAt: null, statusChangedAt: o.placedAt, platformUpdatedAt: o.placedAt, packedAt: null, packedBy: null }).where(eq(schema.orders.id, o.id));
    }
  }

  /* ---------- the board: some parcels already packed (two late ones and a few recent) ---------- */
  const toShip = await db
    .select({ id: schema.orders.id, placedAt: schema.orders.placedAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, tenantId), inArray(schema.orders.status, ["confirmed", "fulfilling"]), sql`${schema.orders.replacedByOrderId} is null`, sql`coalesce(${schema.orders.fulfillmentStatusRaw}, '') <> 'fulfilled'`, sql`not exists (select 1 from shipments s where s.order_id = ${schema.orders.id})`))
    .orderBy(asc(schema.orders.orderNumber));
  const packed = [...toShip.filter((o) => backlogIds.includes(o.id)).slice(-2), ...toShip.filter((o) => !backlogIds.includes(o.id)).filter((_, i) => i % 4 === 1)].slice(0, it ? 14 : 6);
  for (const o of packed) await db.update(schema.orders).set({ packedAt: new Date(Math.min(now.getTime() - 36e5, o.placedAt.getTime() + 20 * 36e5)), packedBy: ops }).where(eq(schema.orders.id, o.id));

  /* ---------- enough recent exceptions and returns to sender ---------- */
  const recentExceptions = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, tenantId), inArray(schema.shipments.status, ["exception", "attempted"]), sql`coalesce(${schema.shipments.exceptionSince}, ${schema.shipments.lastEventAt}) >= ${ago(CASE_WINDOW_DAYS - 2)}`));
  const exceptionsWanted = Math.max(0, (it ? 5 : 3) - recentExceptions.length);
  const moving = (fromDays: number, toDays: number, limit: number, statuses: string[]) =>
    db
      .select({ shipment: schema.shipments, order: schema.orders })
      .from(schema.shipments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
      .where(and(eq(schema.shipments.tenantId, tenantId), inArray(schema.shipments.status, statuses), sql`${schema.shipments.shippedAt} between ${ago(fromDays)} and ${ago(toDays)}`, sql`${schema.orders.cancelledAt} is null`, sql`${schema.orders.paymentMethod} <> 'cod'`, sql`not exists (select 1 from return_requests r where r.order_id = ${schema.orders.id})`, notKept))
      .orderBy(asc(schema.orders.orderNumber))
      .limit(limit);
  let toException = exceptionsWanted ? await moving(12, 1, exceptionsWanted, ["in_transit", "out_for_delivery", "label_created"]) : [];
  if (toException.length < exceptionsWanted) toException = [...toException, ...(await moving(25, 2, exceptionsWanted - toException.length, ["delivered"]))];
  for (const [i, { shipment, order }] of toException.entries()) {
    const status: ShipmentStatus = i % 2 === 0 ? "attempted" : "exception";
    const at = new Date(now.getTime() - (6 + i * 9) * 36e5);
    await db.update(schema.shipments).set({ status, exceptionReason: "delivery_error", exceptionSince: at, lastEventAt: at, deliveredAt: null }).where(eq(schema.shipments.id, shipment.id));
    await db.update(schema.shipmentSourceStates).set({ status, externalStatus: status === "attempted" ? "attempted_delivery" : "exception", lastEventAt: at }).where(eq(schema.shipmentSourceStates.shipmentId, shipment.id));
    await db.insert(schema.shipmentEvents).values({ tenantId, shipmentId: shipment.id, source: "shopify", status, description: status === "attempted" ? (it ? "Destinatario assente, avviso lasciato" : "Recipient not home, notice left") : it ? "Indirizzo incompleto" : "Address incomplete", location: order.shippingCity, occurredAt: at });
    const d = derive(order, status, "fulfilled");
    await db.update(schema.orders).set({ status: d.status, statusReason: d.reason, closedAt: null }).where(eq(schema.orders.id, order.id));
  }
  const recentRts = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, tenantId), inArray(schema.shipments.status, ["returned", "failed"]), sql`${schema.shipments.lastEventAt} >= ${ago(CASE_WINDOW_DAYS - 2)}`));
  const rtsWanted = Math.max(0, (it ? 3 : 2) - recentRts.length);
  const taken = new Set(toException.map((x) => x.shipment.id));
  let toRts = rtsWanted ? (await moving(26, 6, rtsWanted + taken.size, ["in_transit", "out_for_delivery"])).filter((x) => !taken.has(x.shipment.id)).slice(0, rtsWanted) : [];
  if (toRts.length < rtsWanted) toRts = [...toRts, ...(await moving(28, 4, rtsWanted + taken.size + toRts.length, ["delivered"])).filter((x) => !taken.has(x.shipment.id) && !toRts.some((y) => y.shipment.id === x.shipment.id)).slice(0, rtsWanted - toRts.length)];
  for (const [i, { shipment, order }] of toRts.entries()) {
    const at = new Date(now.getTime() - (20 + i * 30) * 36e5);
    await db.update(schema.shipments).set({ status: "returned", exceptionReason: null, exceptionSince: null, lastEventAt: at, deliveredAt: null }).where(eq(schema.shipments.id, shipment.id));
    await db.update(schema.shipmentSourceStates).set({ status: "returned", externalStatus: "returned", lastEventAt: at }).where(eq(schema.shipmentSourceStates.shipmentId, shipment.id));
    await db.insert(schema.shipmentEvents).values({ tenantId, shipmentId: shipment.id, source: "shopify", status: "returned", description: it ? "Reso al mittente: giacenza scaduta" : "Returned to sender: not collected", location: null, occurredAt: at });
    const d = derive(order, "returned", "fulfilled");
    await db.update(schema.orders).set({ status: d.status, statusReason: d.reason, closedAt: null }).where(eq(schema.orders.id, order.id));
  }

  /* ---------- cases for everything in the window ---------- */
  const caseShipments = await db
    .select({ id: schema.shipments.id, orderId: schema.shipments.orderId, status: schema.shipments.status, reason: schema.shipments.exceptionReason, since: sql<Date>`coalesce(${schema.shipments.exceptionSince}, ${schema.shipments.lastEventAt}, ${schema.shipments.shippedAt})`.mapWith((v: string | Date) => new Date(v)), trackingNumber: schema.shipments.trackingNumber })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(and(eq(schema.shipments.tenantId, tenantId), inArray(schema.shipments.status, ["exception", "attempted", "returned", "failed"]), sql`coalesce(${schema.shipments.exceptionSince}, ${schema.shipments.lastEventAt}, ${schema.shipments.shippedAt}) >= ${ago(CASE_WINDOW_DAYS)}`))
    .orderBy(asc(schema.orders.orderNumber));
  const exceptions = caseShipments.filter((s) => s.status === "exception" || s.status === "attempted");
  const returns = caseShipments.filter((s) => s.status === "returned" || s.status === "failed");
  const rows: (typeof schema.shipmentCases.$inferInsert)[] = [];
  exceptions.forEach((s, i) => {
    const openedAt = new Date(Math.min(now.getTime(), s.since.getTime() + 30 * 60e3));
    const base = { tenantId, kind: "exception", shipmentId: s.id, orderId: s.orderId, shipmentStatus: s.status, reason: s.reason ?? "source_exception", openedAt, createdAt: openedAt, updatedAt: openedAt };
    // the last one is claimed by a colleague, the one before already instructed by email; the oldest stay unclaimed for the queue
    if (i === exceptions.length - 1 && exceptions.length >= 3) rows.push({ ...base, status: "claimed", claimedBy: care, claimedAt: new Date(openedAt.getTime() + 36e5) });
    else if (i === exceptions.length - 2 && exceptions.length >= 3) rows.push({ ...base, status: "instructed", claimedBy: ops, claimedAt: new Date(openedAt.getTime() + 36e5), resolution: "redeliver", resolutionDetail: { address: null, pickupPoint: null, note: it ? "Il cliente è a casa dopo le 18" : "Customer is home after 6pm" }, instructionChannel: "email", instructionTo: it ? "assistenza@corriere.example" : "support@carrier.example", instructionRef: "email:mock", instructionSentAt: new Date(openedAt.getTime() + 2 * 36e5), instructionSentBy: ops });
    else rows.push({ ...base, status: "open" });
  });
  returns.forEach((s, i) => {
    const openedAt = new Date(Math.min(now.getTime(), s.since.getTime() + 30 * 60e3));
    const base = { tenantId, kind: "return_to_sender", shipmentId: s.id, orderId: s.orderId, shipmentStatus: s.status, reason: null, openedAt, createdAt: openedAt, updatedAt: openedAt };
    if (i === 0 && returns.length >= 2) rows.push({ ...base, status: "claimed", claimedBy: ops, claimedAt: new Date(openedAt.getTime() + 36e5), followUps: { contact: { outcome: "done", at: new Date(openedAt.getTime() + 2 * 36e5).toISOString(), by: ops } } });
    else rows.push({ ...base, status: "open" });
  });
  if (rows.length) await db.insert(schema.shipmentCases).values(rows);

  /* ---------- alert rule on the late-to-ship count ---------- */
  const recipients = [owner, ops].filter((x): x is string => Boolean(x));
  await db.insert(schema.alertRules).values({ tenantId, name: it ? "Ordini in ritardo di spedizione" : "Orders late to ship", metric: "late_to_ship", condition: { kind: "threshold", op: "gt", value: it ? 5 : 3, days: 1 }, channels: ["in_app"], recipients, cooldownHours: 24, createdBy: owner });
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, isNull, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { MockCarrierProvider, MockCommercePlatform } from "@keel/integrations";
import { parseTenantSettings } from "@keel/core";
import {
  CaseError, FulfilmentError, MappingError, bulkSetPacked, drainEmailJobs, mockEmailOutbox, checkLateToShip, claimCase, closeCase, countLateToShip, fulfilmentBoard, importFulfillment, listShipmentCases, packingSlipsPdf, recomputeOrderStatus, recordFollowUp, releaseCase, saveStatusMapping, sendCaseInstruction, setOrderPacked, shipmentCaseDetail, shipOrder, syncShipmentCases,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let harbor = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  harbor = ctx.tenantIds.harbor;
});
afterAll(() => pools.close());

const as = (email: string) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(harbor, (tx) => fn({ tenantId: harbor, tx, actor: { type: "user", userId: ctx.userIds[email]! } }), pools.app);
const ops = as("ops@harborhome.demo");
const owner = as("owner@harborhome.demo");
const platform = () => new MockCommercePlatform({ currency: "USD", country: "US", orderNumberPrefix: "HH-", variants: [], locations: [], customers: [], startOrderNumber: 990000 });
const NY = "America/New_York";

/** n Harbor Home orders put back into "paid, ready to ship, nothing shipped". */
async function readyToShip(n: number, placedAt: Date): Promise<string[]> {
  const rows = await ops((s) => s.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, harbor), isNull(schema.orders.replacedByOrderId), isNull(schema.orders.cancelledAt))).orderBy(desc(schema.orders.orderNumber)).limit(n + 20));
  const picked = rows.slice(10, 10 + n).map((r) => r.id);
  await ops(async (s) => {
    await s.tx.update(schema.orders).set({ status: "confirmed", manualStatus: null, placedAt, paymentStatus: "paid", financialStatusRaw: "paid", fulfillmentStatusRaw: null, returnedFraction: 0, refundedMinor: 0, holdReason: null, packedAt: null, packedBy: null }).where(inArray(schema.orders.id, picked));
    await s.tx.delete(schema.shipments).where(inArray(schema.shipments.orderId, picked));
    for (const id of picked) await recomputeOrderStatus(s, id);
  });
  return picked;
}

describe("late-to-ship queue (working days, tenant time zone)", () => {
  it("counts working days in the tenant zone: a Friday order is not late on Monday with a 1-day threshold, is with 0", async () => {
    // Friday 2026-09-25 10:00 in New York; "now" = Monday 2026-09-28 10:00 in New York
    const [id] = await readyToShip(1, new Date("2026-09-25T14:00:00Z"));
    const now = new Date("2026-09-28T14:00:00Z");
    const name = (await ops((s) => s.tx.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.id, id!))))[0]!.name;
    const lateIds = async (days: number) => (await ops((s) => fulfilmentBoard(s, { timezone: NY, settings: { lateToShipBusinessDays: days, workdays: [1, 2, 3, 4, 5] }, now }, { view: "late", q: name }))).pending.map((c) => c.id);
    expect(await lateIds(1)).not.toContain(id);
    expect(await lateIds(0)).toContain(id);
    // a Sunday-to-Thursday week: Sunday and Monday count, so 1 is over the threshold
    const board = await ops((s) => fulfilmentBoard(s, { timezone: NY, settings: { lateToShipBusinessDays: 1, workdays: [7, 1, 2, 3, 4] }, now }, { view: "late", q: name }));
    expect(board.pending.find((c) => c.id === id)).toMatchObject({ late: true, businessDays: 2 });
  });

  it("the late count, the board and the notification agree; shipped orders leave the queue", async () => {
    const ids = await readyToShip(3, new Date(Date.now() - 12 * 864e5));
    const settings = parseTenantSettings({ lateToShipBusinessDays: 2 });
    const clock = { timezone: NY, settings };
    const count = await ops((s) => countLateToShip(s, clock));
    expect(count).toBeGreaterThanOrEqual(3);
    const board = await ops((s) => fulfilmentBoard(s, clock, { view: "late" }, 500));
    expect(board.counts.late).toBe(count);
    for (const id of ids) expect(board.pending.some((c) => c.id === id)).toBe(true);
    const notified = await ops((s) => checkLateToShip({ ...s, actor: { type: "system", userId: null } }, settings, NY));
    expect(notified).toBe(count);
  });
});

describe("pick/pack and ship from Keel", () => {
  it("cards show units and lines; an order with a shipment is not to ship whatever its status says", async () => {
    const [a, b] = await readyToShip(2, new Date(Date.now() - 4 * 864e5));
    const clock = { timezone: NY, settings: { lateToShipBusinessDays: 2, workdays: [1, 2, 3, 4, 5] } };
    const board = await ops((s) => fulfilmentBoard(s, clock, { view: "all" }, 1000));
    const card = board.pending.find((c) => c.id === a)!;
    expect(card.units).toBeGreaterThan(0);
    expect(card.lines).toBeGreaterThan(0);
    // a staff-set "confirmed" with a parcel already out (e.g. fulfilled outside Keel) leaves the queue
    await ops(async (s) => {
      await s.tx.update(schema.orders).set({ manualStatus: "confirmed" }).where(eq(schema.orders.id, b!));
      await recomputeOrderStatus(s, b!);
      await s.tx.insert(schema.shipments).values({ tenantId: harbor, orderId: b!, externalId: `manual-${b}`, status: "in_transit", shippedAt: new Date() });
    });
    const after = await ops((s) => fulfilmentBoard(s, clock, { view: "all" }, 1000));
    expect(after.pending.some((c) => c.id === b)).toBe(false);
    expect(await ops((s) => setOrderPacked(s, b!, true))).toMatchObject({ kind: "not_to_ship" });
  });

  it("packs, then ships through the platform: fulfilment on the store first, then shipment, timeline and status", async () => {
    const [id] = await readyToShip(1, new Date(Date.now() - 6 * 864e5));
    expect(await ops((s) => setOrderPacked(s, id!, true))).toMatchObject({ kind: "done" });
    expect(await ops((s) => setOrderPacked(s, id!, true))).toMatchObject({ kind: "unchanged" });
    const p = platform();
    const r = await ops((s) => shipOrder(s, p, id!, { carrier: "UPS", trackingNumber: "1Z999AA10123456784", trackingUrl: "https://track.example/1Z999AA10123456784", notifyCustomer: true }));
    expect(r.orderStatus).toBe("shipped");
    expect(p.writeLog.filter((w) => w.op === "createFulfillment")).toHaveLength(1);
    const shipment = (await ops((s) => s.tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, id!))))[0]!;
    expect(shipment).toMatchObject({ carrier: "UPS", trackingNumber: "1Z999AA10123456784", status: "label_created" });
    const ev = (await ops((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, id!), eq(schema.orderEvents.type, "fulfilled")))))[0]!;
    expect(ev.actorUserId).toBe(ctx.userIds["ops@harborhome.demo"]);
    expect(ev.diff).toMatchObject({ trackingNumber: { from: null, to: "1Z999AA10123456784" }, fulfillmentStatusRaw: { to: "fulfilled" } });
    const write = (await ops((s) => s.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.entityId, id!), eq(schema.platformWrites.kind, "fulfillment.create")))))[0]!;
    expect(write.status).toBe("succeeded");
    // it left the queue: shipping again is refused, packing too
    await expect(ops((s) => shipOrder(s, p, id!, { carrier: "UPS", trackingNumber: "1Z2", notifyCustomer: false }))).rejects.toMatchObject({ code: "not_to_ship" });
    expect(await ops((s) => setOrderPacked(s, id!, false))).toMatchObject({ kind: "not_to_ship" });
  });

  it("a refused fulfilment changes nothing in Keel", async () => {
    const [id] = await readyToShip(1, new Date(Date.now() - 6 * 864e5));
    const p = platform();
    p.failures.failNext("permission");
    await expect(ops((s) => shipOrder(s, p, id!, { carrier: "DHL", trackingNumber: "JD0001", notifyCustomer: false }))).rejects.toBeInstanceOf(FulfilmentError);
    const o = (await ops((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.id, id!))))[0]!;
    expect(o.status).toBe("confirmed");
    expect(o.fulfillmentStatusRaw).toBeNull();
    expect(await ops((s) => s.tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, id!)))).toHaveLength(0);
    await expect(ops((s) => shipOrder(s, p, id!, { carrier: "", trackingNumber: "", notifyCustomer: false }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("bulk pack runs per order with an outcome each, and packing slips render every order", async () => {
    const ids = await readyToShip(2, new Date(Date.now() - 3 * 864e5));
    const runner = { tenantId: harbor, actor: { type: "user" as const, userId: ctx.userIds["ops@harborhome.demo"]! }, audit: { actorUserId: ctx.userIds["ops@harborhome.demo"]!, actorType: "user" as const, impersonatedBy: null }, run: <T>(fn: (s: ServiceContext) => Promise<T>) => ops(fn) };
    const summary = await bulkSetPacked(runner, [...ids, "00000000-0000-4000-8000-000000000000"], true, { concurrency: 2 });
    expect(summary).toMatchObject({ total: 3, done: 2, skipped: 1 });
    const pdf = await ops((s) => packingSlipsPdf(s, ids, { title: "Packing slip", order: "Order", placed: "Placed", shipTo: "Ship to", sku: "SKU", item: "Item", variant: "Variant", quantity: "Qty", units: "Units", note: "Note" }, { date: (d) => d.toISOString().slice(0, 10), companyName: "Harbor Home" }));
    expect(pdf!.count).toBe(2);
    const text = Buffer.from(pdf!.bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    const names = await ops((s) => s.tx.select({ name: schema.orders.name }).from(schema.orders).where(inArray(schema.orders.id, ids)));
    for (const n of names) expect(text).toContain(n.name);
  });
});

describe("delivery-exception work queue", () => {
  async function exceptionCase(): Promise<{ caseId: string; shipmentId: string; orderId: string }> {
    const [id] = await readyToShip(1, new Date(Date.now() - 6 * 864e5));
    const r = await ops((s) => shipOrder(s, platform(), id!, { carrier: "UPS", trackingNumber: `EX${Date.now()}`, notifyCustomer: false }));
    // the store reports a failed attempt: the case opens by itself
    await ops((s) => importFulfillment(s, id!, { externalId: (r.externalId), status: "attempted", externalStatus: "attempted_delivery", trackingNumber: null, trackingUrl: null, carrier: null, createdAt: new Date(Date.now() - 36e5), updatedAt: new Date(), deliveredAt: null }, new Date()));
    const c = (await ops((s) => s.tx.select().from(schema.shipmentCases).where(and(eq(schema.shipmentCases.shipmentId, r.shipmentId), isNull(schema.shipmentCases.closedAt)))))[0]!;
    expect(c.kind).toBe("exception");
    return { caseId: c.id, shipmentId: r.shipmentId, orderId: id! };
  }

  it("a case can be claimed by one user only, even when two claim at the same time", async () => {
    const { caseId } = await exceptionCase();
    const results = await Promise.allSettled([ops((s) => claimCase(s, caseId)), owner((s) => claimCase(s, caseId))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "claimed_by_other" });
    const c = (await ops((s) => s.tx.select().from(schema.shipmentCases).where(eq(schema.shipmentCases.id, caseId))))[0]!;
    const loser = c.claimedBy === ctx.userIds["ops@harborhome.demo"] ? owner : ops;
    await expect(loser((s) => claimCase(s, caseId))).rejects.toMatchObject({ code: "claimed_by_other" });
    await expect(loser((s) => sendCaseInstruction(s, caseId, { resolution: "redeliver", channel: "carrier" }, { carrier: new MockCarrierProvider(), companyName: "Harbor Home", locale: "en" }))).rejects.toMatchObject({ code: "claimed_by_other" });
    // the claimer releases, the other can take it
    const winner = loser === ops ? owner : ops;
    await winner((s) => releaseCase(s, caseId));
    await loser((s) => claimCase(s, caseId));
  });

  it("the instruction is sent once: a concurrent or later second send is blocked", async () => {
    const { caseId, orderId } = await exceptionCase();
    await ops((s) => claimCase(s, caseId));
    const carrier = new MockCarrierProvider();
    const send = () => ops((s) => sendCaseInstruction(s, caseId, { resolution: "pickup_point", pickupPoint: "Locker 12, 5th Ave", note: "Customer away", channel: "carrier" }, { carrier, companyName: "Harbor Home", locale: "en" }));
    const results = await Promise.allSettled([send(), send()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "already_sent" });
    expect(carrier.instructions).toHaveLength(1);
    expect(carrier.instructions[0]).toMatchObject({ resolution: "pickup_point", pickupPoint: "Locker 12, 5th Ave", reference: `case:${caseId}` });
    await expect(send()).rejects.toMatchObject({ code: "already_sent" });
    expect(carrier.instructions).toHaveLength(1);
    const ev = (await ops((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, orderId), eq(schema.orderEvents.type, "delivery_instruction_sent")))));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.diff).toEqual({ deliveryResolution: { from: null, to: "pickup_point" } });
  });

  it("a failed send leaves the case sendable; email goes through the template; validation refuses a bad address", async () => {
    const { caseId } = await exceptionCase();
    await ops((s) => claimCase(s, caseId));
    const carrier = new MockCarrierProvider();
    carrier.failures.failNext("network");
    await expect(ops((s) => sendCaseInstruction(s, caseId, { resolution: "redeliver", channel: "carrier" }, { carrier, companyName: "Harbor Home", locale: "en" }))).rejects.toMatchObject({ code: "send_failed" });
    await expect(ops((s) => sendCaseInstruction(s, caseId, { resolution: "new_address", address: { name: "A", address1: "1 Main", city: "Austin", province: "TX", zip: "12", country: "US" }, channel: "email", emailTo: "support@carrier.example" }, { carrier: null, companyName: "Harbor Home", locale: "en" }))).rejects.toBeInstanceOf(CaseError);
    await ops((s) => sendCaseInstruction(s, caseId, { resolution: "new_address", address: { name: "Ann Lee", address1: "500 Congress Ave", city: "Austin", province: "TX", zip: "78701", country: "US" }, channel: "email", emailTo: "support@carrier.example" }, { carrier: null, companyName: "Harbor Home", locale: "en" }));
    await drainEmailJobs(pools.admin);
    const mail = mockEmailOutbox().sent.filter((m) => m.message.to === "support@carrier.example").at(-1)!;
    expect(mail.message.subject).toContain("Delivery instruction");
    expect(mail.message.text).toContain("500 Congress Ave");
  });

  it("closes by itself when the shipment moves on; a return to sender opens a review with follow-ups", async () => {
    const { caseId, shipmentId, orderId } = await exceptionCase();
    const ship = (await ops((s) => s.tx.select().from(schema.shipments).where(eq(schema.shipments.id, shipmentId))))[0]!;
    // back "in transit" right after an attempt is not moving on: exceptions are sticky against that regression
    await ops((s) => importFulfillment(s, orderId, { externalId: ship.externalId!, status: "in_transit", externalStatus: "in_transit", trackingNumber: null, trackingUrl: null, carrier: null, createdAt: ship.shippedAt!, updatedAt: new Date(Date.now() + 500), deliveredAt: null }, new Date()));
    expect((await ops((s) => s.tx.select().from(schema.shipmentCases).where(eq(schema.shipmentCases.id, caseId))))[0]!.status).toBe("open");
    await ops((s) => importFulfillment(s, orderId, { externalId: ship.externalId!, status: "out_for_delivery", externalStatus: "out_for_delivery", trackingNumber: null, trackingUrl: null, carrier: null, createdAt: ship.shippedAt!, updatedAt: new Date(Date.now() + 1000), deliveredAt: null }, new Date()));
    const closed = (await ops((s) => s.tx.select().from(schema.shipmentCases).where(eq(schema.shipmentCases.id, caseId))))[0]!;
    expect(closed).toMatchObject({ status: "closed", closeReason: "moved_on" });
    await ops((s) => importFulfillment(s, orderId, { externalId: ship.externalId!, status: "returned", externalStatus: "returned", trackingNumber: null, trackingUrl: null, carrier: null, createdAt: ship.shippedAt!, updatedAt: new Date(Date.now() + 2000), deliveredAt: null }, new Date()));
    const review = (await ops((s) => listShipmentCases(s, { kind: "return_to_sender", scope: "open" }))).rows.find((r) => r.shipmentId === shipmentId)!;
    expect(review).toBeTruthy();
    const detail = await ops((s) => shipmentCaseDetail(s, review.id));
    expect(detail!.suggestions.map((x) => [x.kind, x.suggested])).toEqual([["restock", true], ["refund", true], ["contact", true]]);
    await ops((s) => recordFollowUp(s, review.id, "refund", "done"));
    await expect(owner((s) => recordFollowUp(s, review.id, "contact", "done"))).rejects.toMatchObject({ code: "claimed_by_other" });
    await ops((s) => closeCase(s, review.id, { reason: "resolved", note: "Refunded, customer reordered" }));
    // the sweep does not reopen a reviewed return
    await ops((s) => syncShipmentCases({ ...s, actor: { type: "system", userId: null } }));
    expect((await ops((s) => s.tx.select().from(schema.shipmentCases).where(and(eq(schema.shipmentCases.shipmentId, shipmentId), isNull(schema.shipmentCases.closedAt)))))).toHaveLength(0);
  });
});

describe("status mapping editor feeds the resolver", () => {
  it("a tenant row turns an unknown carrier status into an exception that opens a case; duplicates are refused", async () => {
    await owner((s) => saveStatusMapping(s, { source: "shopify", externalStatus: "Held_At_Customs", canonicalStatus: "in_transit", isException: true, isFinal: false }));
    await expect(owner((s) => saveStatusMapping(s, { source: "shopify", externalStatus: "held_at_customs", canonicalStatus: "exception", isException: true, isFinal: false }))).rejects.toBeInstanceOf(MappingError);
    const [id] = await readyToShip(1, new Date(Date.now() - 6 * 864e5));
    const r = await ops((s) => shipOrder(s, platform(), id!, { carrier: "FedEx", trackingNumber: `CU${Date.now()}`, notifyCustomer: false }));
    const res = await ops((s) => importFulfillment(s, id!, { externalId: r.externalId, status: "in_transit", externalStatus: "held_at_customs", trackingNumber: null, trackingUrl: null, carrier: null, createdAt: new Date(Date.now() - 36e5), updatedAt: new Date(), deliveredAt: null }, new Date()));
    expect(res.status).toBe("exception");
    const open = await ops((s) => s.tx.select().from(schema.shipmentCases).where(and(eq(schema.shipmentCases.shipmentId, r.shipmentId), isNull(schema.shipmentCases.closedAt))));
    expect(open.map((c) => c.kind)).toEqual(["exception"]);
    const audit = await owner((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, harbor), eq(schema.auditLogs.action, "shipment_mapping.created"))));
    expect(audit.length).toBeGreaterThan(0);
  });
});

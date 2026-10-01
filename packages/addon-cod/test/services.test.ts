import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { MockCommercePlatform } from "@keel/integrations";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import type { ServiceContext } from "@keel/services";
import { assignQueueItem, distributeUnassigned, getCodSettings, listRiskyRecipients, mergeCandidates, modifyCodOrder, queueItems, recomputeRecipientProfiles, recordAttempt, saveCapacity, saveCodSettings, scoreQueueItem, syncQueue } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const as = (email: string) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! } }), pools.app);
const ops = as("ops@northwind.demo");

describe("queue", () => {
  it("syncs eligible COD orders in and closed ones out, scores them with an explained breakdown", async () => {
    // make sure there is at least one fresh open COD order
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"))).limit(1), pools.app);
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, placedAt: new Date(), manualStatus: null, platformTags: [], returnedFraction: 0, refundedMinor: 0, fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending" }).where(eq(schema.orders.id, order!.id)), pools.app);
    await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, order!.id)), pools.app);
    const r = await ops((s) => syncQueue(s));
    expect(r.entered).toBeGreaterThanOrEqual(1);
    const q = await ops((s) => queueItems(s, { view: "all" }));
    expect(q.rows.some((x) => x.order.id === order!.id)).toBe(true);
    const score = await ops((s) => scoreQueueItem(s, order!.id, { timezone: "Europe/Rome" }));
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.factors.length).toBeGreaterThan(5);
    expect(score.factors.find((f) => f.key === "duplicate_orders")).toBeTruthy();
    const [item] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order!.id)), pools.app);
    expect(item!.score).toBe(score.score);
    // cancel the order → next sync closes the item
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(schema.orders.id, order!.id)), pools.app);
    const r2 = await ops((s) => syncQueue(s));
    expect(r2.closed).toBeGreaterThanOrEqual(1);
    const [closed] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order!.id)), pools.app);
    expect(closed!.status).toBe("cancelled");
  });

  it("applies the outcome machine: no answers → unreachable + on hold, confirmed → confirmed order", async () => {
    await ops((s) => saveCodSettings(s, { unreachableAfterAttempts: 2 }));
    const settings = await ops((s) => getCodSettings(s));
    expect(settings.unreachableAfterAttempts).toBe(2);
    const open = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"), sql`${schema.orders.status} <> 'cancelled'`)).limit(2), pools.app);
    for (const o of open) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "new", cancelledAt: null, placedAt: new Date(), manualStatus: null, platformTags: [], returnedFraction: 0, refundedMinor: 0, fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending" }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await ops((s) => syncQueue(s));
    const a = open[0]!.id;
    const b = open[1]!.id;
    const first = await ops((s) => recordAttempt(s, { orderId: a, outcome: "no_answer" }));
    expect(first).toMatchObject({ status: "pending", attemptNumber: 1 });
    const second = await ops((s) => recordAttempt(s, { orderId: a, outcome: "no_answer" }));
    expect(second.status).toBe("unreachable");
    const [held] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, a)), pools.app);
    expect(held!.status).toBe("on_hold");
    expect(held!.assignedTo).toBe(ctx.userIds["ops@northwind.demo"]);
    const cb = await ops((s) => recordAttempt(s, { orderId: b, outcome: "call_back", callBackAt: new Date(Date.now() + 3600e3) }));
    expect(cb.status).toBe("scheduled");
    const done = await ops((s) => recordAttempt(s, { orderId: b, outcome: "confirmed" }));
    expect(done.status).toBe("confirmed");
    const [confirmed] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, b)), pools.app);
    expect(confirmed!.status).toBe("confirmed");
    expect(confirmed!.manualStatus).toBe("confirmed");
    const events = await withTenant(tenantId, (tx) => tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, b), eq(schema.orderEvents.type, "cod_attempt"))), pools.app);
    expect(events).toHaveLength(2);
    await expect(ops((s) => recordAttempt(s, { orderId: b, outcome: "no_answer" }))).rejects.toMatchObject({ code: "not_in_queue" });
  });
});

describe("assignment", () => {
  it("distributes unassigned items in proportion to today's hours and logs every decision", async () => {
    const u1 = ctx.userIds["ops@northwind.demo"]!;
    const u2 = ctx.userIds["care@northwind.demo"]!;
    const u3 = ctx.userIds["care2@northwind.demo"]!;
    await ops((s) => saveCapacity(s, { userId: u1, dailyHours: [8, 8, 8, 8, 8, 8, 8], isActive: true }));
    await ops((s) => saveCapacity(s, { userId: u2, dailyHours: [4, 4, 4, 4, 4, 4, 4], isActive: true }));
    await ops((s) => saveCapacity(s, { userId: u3, dailyHours: [0, 0, 0, 0, 0, 0, 0], isActive: true }));
    // 12 fresh unassigned COD items
    const orders = await withTenant(tenantId, (tx) => tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"))).limit(14), pools.app);
    for (const o of orders) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "new", cancelledAt: null, placedAt: new Date(), manualStatus: null, assignedTo: null, platformTags: [], returnedFraction: 0, refundedMinor: 0, fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending" }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await withTenant(tenantId, (tx) => tx.delete(schema.codAssignmentLog).where(eq(schema.codAssignmentLog.tenantId, tenantId)), pools.app);
    await withTenant(tenantId, (tx) => tx.update(schema.codQueueItems).set({ assignedTo: null, status: "pending", closedAt: null, attemptsCount: 0, noAnswerCount: 0 }).where(eq(schema.codQueueItems.tenantId, tenantId)), pools.app);
    await ops((s) => syncQueue(s));
    const r = await ops((s) => distributeUnassigned(s, { source: "backfill", timezone: "Europe/Rome" }));
    expect(r.assigned).toBeGreaterThanOrEqual(12);
    const counts = await withTenant(tenantId, (tx) => tx.select({ u: schema.codAssignmentLog.assignedTo, n: sql<number>`count(*)::int` }).from(schema.codAssignmentLog).where(eq(schema.codAssignmentLog.tenantId, tenantId)).groupBy(schema.codAssignmentLog.assignedTo), pools.app);
    const n = (u: string) => counts.find((c) => c.u === u)?.n ?? 0;
    expect(n(u3)).toBe(0);
    expect(n(u1)).toBeGreaterThan(n(u2));
    expect(Math.abs(n(u1) / Math.max(1, n(u2)) - 2)).toBeLessThan(0.6);
    // manual reassignment is idempotent for the same target and audited in the log
    const some = (await ops((s) => queueItems(s, { view: "all" }))).rows[0]!;
    const target = await ops((s) => assignQueueItem(s, some.order.id, { source: "manual", timezone: "Europe/Rome", userId: u2 }));
    expect(target).toBe(u2);
  });
});

describe("recipient risk", () => {
  it("builds profiles from delivered/returned COD history and never acts automatically", async () => {
    const r = await ops((s) => recomputeRecipientProfiles(s));
    expect(r.profiles).toBeGreaterThan(0);
    const risky = await ops((s) => listRiskyRecipients(s, { tiers: ["watch", "high_risk", "blacklisted"] }));
    for (const p of risky) {
      expect(p.recipientKey).not.toMatch(/\s/);
      expect(["watch", "high_risk", "blacklisted"]).toContain(p.tier);
    }
    const orders = await withTenant(tenantId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.holdReason} = 'risk'`)), pools.app);
    expect(orders[0]!.n).toBe(0);
  });
});

describe("platform tags", () => {
  const mockPlatform = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 1 });
  const freshCodOrders = async (n: number) => {
    const rows = await withTenant(tenantId, (tx) => tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"))).orderBy(schema.orders.orderNumber).limit(n), pools.app);
    for (const o of rows) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, placedAt: new Date(), manualStatus: null, assignedTo: null, platformTags: ["cod"], fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending", returnedFraction: 0, refundedMinor: 0 }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await withTenant(tenantId, (tx) => tx.delete(schema.codQueueItems).where(inArray(schema.codQueueItems.orderId, rows.map((r) => r.id))), pools.app);
    return rows.map((r) => r.id);
  };

  it("writes the configured tags on entry and on outcomes, platform first, and reads confirmed/cancelled tags back", async () => {
    await ops((s) => saveCodSettings(s, { unreachableAfterAttempts: 3, tags: { queue: ["Da confermare", "Da chiamare"], confirmed: ["Confermato"], cancelled: ["Annullato*"], clearQueueTagsOnClose: true, write: { entered: { add: ["Da confermare"] }, confirmed: { add: ["Confermato"] }, call_back: { add: ["Da chiamare"], remove: ["Da confermare"] }, cancelled: { add: ["Annullato"] } } } }));
    const platform = mockPlatform();
    const [a, b, c] = await freshCodOrders(3);
    await ops((s) => syncQueue(s, undefined, { platform }));
    const tagsOf = async (id: string) => (await withTenant(tenantId, (tx) => tx.select({ t: schema.orders.platformTags, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, id)), pools.app))[0]!;
    expect((await tagsOf(a!)).t).toEqual(["cod", "da confermare"]);
    expect(platform.writeLog.filter((w) => w.op === "updateOrderTags").length).toBeGreaterThanOrEqual(3);
    // call back swaps the queue tag; confirmed adds the confirmation tag and clears queue tags
    await ops((s) => recordAttempt(s, { orderId: a!, outcome: "call_back", callBackAt: new Date(Date.now() + 3600e3) }, undefined, { platform }));
    expect((await tagsOf(a!)).t).toEqual(["cod", "da chiamare"]);
    const done = await ops((s) => recordAttempt(s, { orderId: a!, outcome: "confirmed" }, undefined, { platform }));
    expect(done.tags).toEqual({ added: ["Confermato"], removed: ["da chiamare"] });
    expect((await tagsOf(a!)).t).toEqual(["cod", "confermato"]);
    // a refused platform write records nothing
    platform.failures.failNext("network", 1);
    await expect(ops((s) => recordAttempt(s, { orderId: b!, outcome: "call_back", callBackAt: new Date(Date.now() + 3600e3) }, undefined, { platform }))).rejects.toMatchObject({ code: "platform_error" });
    expect((await tagsOf(b!)).t).toEqual(["cod", "da confermare"]);
    // the cancelled outcome cancels the order on the platform and locally, with its tag
    const cancelled = await ops((s) => recordAttempt(s, { orderId: b!, outcome: "cancelled" }, undefined, { platform }));
    expect(cancelled.status).toBe("cancelled");
    expect(platform.writeLog.some((w) => w.op === "cancelOrder")).toBe(true);
    const bRow = await tagsOf(b!);
    expect(bRow.status).toBe("cancelled");
    expect(bRow.t).toEqual(["cod", "annullato"]);
    // a confirmed tag arriving from the platform closes the item and confirms the order
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ platformTags: ["cod", "Confermato"] }).where(eq(schema.orders.id, c!)), pools.app);
    const r = await ops((s) => syncQueue(s, undefined, { platform }));
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const [item] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, c!)), pools.app);
    expect(item!.status).toBe("confirmed");
    expect((await tagsOf(c!)).status).toBe("confirmed");
    // a queue tag on a confirmed order pulls it back in
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ platformTags: ["cod", "da chiamare"] }).where(eq(schema.orders.id, c!)), pools.app);
    await ops((s) => syncQueue(s, undefined, { platform }));
    const [back] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, c!)), pools.app);
    expect(back!.status).toBe("pending");
    expect(back!.entryTag).toBe("da chiamare");
    expect((await tagsOf(c!)).status).toBe("pending_review");
  });

  it("routes items by entry tag to operators with allowed tags", async () => {
    const u1 = ctx.userIds["ops@northwind.demo"]!;
    const u2 = ctx.userIds["care@northwind.demo"]!;
    const u3 = ctx.userIds["care2@northwind.demo"]!;
    await ops((s) => saveCapacity(s, { userId: u1, dailyHours: [8, 8, 8, 8, 8, 8, 8], isActive: true, allowedTags: ["Da confermare"] }));
    await ops((s) => saveCapacity(s, { userId: u2, dailyHours: [8, 8, 8, 8, 8, 8, 8], isActive: true, allowedTags: ["Richiesta modifica"] }));
    await ops((s) => saveCapacity(s, { userId: u3, dailyHours: [0, 0, 0, 0, 0, 0, 0], isActive: false }));
    const [a] = await freshCodOrders(1);
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ platformTags: ["cod", "richiesta modifica"] }).where(eq(schema.orders.id, a!)), pools.app);
    await ops((s) => saveCodSettings(s, { tags: { queue: ["Da confermare", "Richiesta modifica"], write: { entered: { add: [] } } } }));
    await ops((s) => syncQueue(s));
    const assigned = await ops((s) => assignQueueItem(s, a!, { source: "manual", timezone: "Europe/Rome" }));
    expect(assigned).toBe(u2);
  });
});

describe("pre-confirmation changes", () => {
  const platform = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 777000 });
  const prepare = async (n: number) => {
    const rows = await withTenant(tenantId, (tx) => tx.select({ id: schema.orders.id, customerId: schema.orders.customerId }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"), sql`${schema.orders.customerId} is not null`)).orderBy(schema.orders.orderNumber).limit(n), pools.app);
    for (const o of rows) {
      await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, cancelReason: null, placedAt: new Date(), manualStatus: null, assignedTo: null, platformTags: ["cod"], fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending", replacedByOrderId: null, returnedFraction: 0, refundedMinor: 0 }).where(eq(schema.orders.id, o.id)), pools.app);
      await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)), pools.app);
    }
    await withTenant(tenantId, (tx) => tx.delete(schema.codQueueItems).where(inArray(schema.codQueueItems.orderId, rows.map((r) => r.id))), pools.app);
    await ops((s) => syncQueue(s));
    return rows;
  };

  it("edits contact and address in place, platform first, with a diffed timeline event and a modified attempt", async () => {
    await ops((s) => saveCodSettings(s, { tags: { queue: [], confirmed: [], cancelled: [], write: { modified: { add: ["Richiesta modifica"] } } } }));
    const p = platform();
    const [o] = await prepare(1);
    const r = await ops((s) => modifyCodOrder(s, p, { orderId: o!.id, contact: { phone: "+39 333 123 4567", shippingAddress: { name: "Mario Rossi", address1: "Via Roma 1", city: "Milano", zip: "20100", country: "IT" }, note: "citofono Rossi", noteMode: "append" } }, { country: "IT" }));
    expect(r.kind).toBe("updated");
    expect(r.kind === "updated" && r.changed.sort()).toEqual(["note", "phone", "shippingAddress"]);
    expect(p.writeLog.some((w) => w.op === "updateOrderDetails")).toBe(true);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, o!.id)), pools.app);
    expect(row!.phoneE164).toBe("+393331234567");
    expect(row!.shippingCity).toBe("Milano");
    expect(row!.platformTags).toContain("richiesta modifica");
    const events = await withTenant(tenantId, (tx) => tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, o!.id), inArray(schema.orderEvents.type, ["modified", "cod_attempt"]))), pools.app);
    expect(events.map((e) => e.type)).toContain("modified");
    expect(events.map((e) => e.type)).toContain("cod_attempt");
    const modified = events.find((e) => e.type === "modified")!;
    expect(Object.keys(modified.diff as Record<string, unknown>).sort()).toEqual(["note", "phone", "shippingAddress"]);
    const [item] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, o!.id)), pools.app);
    expect(item!.status).toBe("pending");
    expect(item!.attemptsCount).toBe(1);
  });

  it("replaces the order when lines change or orders merge: new order imported and queued, old ones cancelled as replaced and linked", async () => {
    await ops((s) => saveCodSettings(s, { tags: { queue: ["Da confermare"], confirmed: [], cancelled: ["Annullato*"], write: { entered: { add: ["Da confermare"] }, replaced: { add: ["Annullato per variazione"] } } } }));
    const p = platform();
    const rows = await prepare(3);
    const [a, b] = rows;
    // make b the same customer as a so it can be merged
    const [aRow] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, a!.id)), pools.app);
    await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ customerId: aRow!.customerId, emailNormalized: aRow!.emailNormalized, phoneE164: aRow!.phoneE164 }).where(eq(schema.orders.id, b!.id)), pools.app);
    await ops((s) => assignQueueItem(s, a!.id, { source: "manual", timezone: "Europe/Rome", userId: ctx.userIds["ops@northwind.demo"]! }));
    const candidates = await ops((s) => mergeCandidates(s, a!.id));
    expect(candidates.map((c) => c.id)).toContain(b!.id);
    const lines = await withTenant(tenantId, (tx) => tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, a!.id)), pools.app);
    const first = lines.find((l) => l.currentQuantity > 0)!;
    // keep every current line, one more unit of the first
    const keep = lines.filter((l) => l.currentQuantity > 0).map((l) => ({ lineId: l.id, quantity: l.id === first.id ? l.currentQuantity + 1 : l.currentQuantity }));
    const r = await ops((s) => modifyCodOrder(s, p, { orderId: a!.id, lines: keep, mergeOrderIds: [b!.id] }, { country: "IT" }));
    expect(r.kind).toBe("replaced");
    if (r.kind !== "replaced") return;
    expect(r.merged).toBe(1);
    expect(r.warning).toBeNull();
    expect(p.writeLog.filter((w) => w.op === "createOrder")).toHaveLength(1);
    expect(p.writeLog.filter((w) => w.op === "cancelOrder")).toHaveLength(2);
    const [created] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, r.newOrderId)), pools.app);
    expect(created!.replacesOrderId).toBe(a!.id);
    expect(created!.paymentMethod).toBe("cod");
    expect(created!.assignedTo).toBe(ctx.userIds["ops@northwind.demo"]);
    const newLines = await withTenant(tenantId, (tx) => tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, r.newOrderId)), pools.app);
    const bLines = await withTenant(tenantId, (tx) => tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, b!.id)), pools.app);
    const expectedUnits = lines.filter((l) => l.currentQuantity > 0).reduce((s, l) => s + l.currentQuantity, 0) + 1 + bLines.filter((l) => l.currentQuantity > 0).reduce((s, l) => s + l.currentQuantity, 0);
    expect(newLines.reduce((s, l) => s + l.currentQuantity, 0)).toBe(expectedUnits);
    for (const old of [a!.id, b!.id]) {
      const [row] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, old)), pools.app);
      expect(row!.cancelReason).toBe("replaced");
      expect(row!.replacedByOrderId).toBe(r.newOrderId);
      expect(row!.status).toBe("cancelled");
      expect(row!.platformTags).toContain("annullato per variazione");
      const [item] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, old)), pools.app);
      expect(item!.status).toBe("left");
    }
    const [newItem] = await withTenant(tenantId, (tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, r.newOrderId)), pools.app);
    expect(newItem!.status).toBe("pending");
    expect(newItem!.assignedTo).toBe(ctx.userIds["ops@northwind.demo"]);
    expect(created!.platformTags).toContain("da confermare");
  });
});

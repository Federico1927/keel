import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { MockCommercePlatform, MockMessagingChannel } from "@keel/integrations";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { loadWidgetData, type ServiceContext } from "@keel/services";
import { dashboardPeriod } from "@keel/core";
import { COD_WIDGET_LOADERS, CodError, applyMessageStatus, autoCancelReturnedToSender, bulkOutcome, distributeEqually, escalateQueueItem, importCarrierOutcomes, listOrderMessages, modifyCodOrder, operatorAttribution, operatorEfficiency, orderPrecheck, parseCarrierCsv, queueCounts, queueItems, queueNeighbours, queueTiles, recomputeRecipientProfiles, recordAttempt, renderOrderTemplates, resolveEscalation, riskPanel, runScheduledConfirmations, saveCapacity, saveCodSettings, scoreQueueItem, sendCodMessage, supervisorView, syncQueue, transferQueueItem } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let harborId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
  harborId = ctx.tenantIds.harbor;
});
afterAll(() => pools.close());

const TZ = "Europe/Rome";
const as = (email: string, now?: Date) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! }, now }), pools.app);
const system = (now?: Date) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null }, now }), pools.app);
const ops = as("ops@northwind.demo");
const care = as("care@northwind.demo");
const owner = as("owner@northwind.demo");
const uid = (email: string) => ctx.userIds[email]!;
const mockPlatform = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 880000 });
const db = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) => withTenant(tenantId, fn, pools.app);

let offset = 0;
/** Fresh open COD orders, out of every queue, never reused across tests. */
async function freshCodOrders(n: number, extra: Partial<typeof schema.orders.$inferInsert> = {}): Promise<string[]> {
  const rows = await db((tx) => tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"), sql`${schema.orders.replacedByOrderId} is null`, sql`${schema.orders.replacesOrderId} is null`)).orderBy(sql`${schema.orders.orderNumber} desc`).limit(n).offset(offset));
  offset += n;
  for (const o of rows) {
    await db((tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, cancelReason: null, placedAt: new Date(), manualStatus: null, assignedTo: null, platformTags: ["cod"], fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending", returnedFraction: 0, refundedMinor: 0, ...extra }).where(eq(schema.orders.id, o.id)));
    await db((tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, o.id)));
  }
  await db((tx) => tx.delete(schema.codQueueItems).where(inArray(schema.codQueueItems.orderId, rows.map((r) => r.id))));
  await ops((s) => syncQueue(s));
  return rows.map((r) => r.id);
}
const itemOf = async (orderId: string) => (await db((tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, orderId))))[0]!;
const orderOf = async (orderId: string) => (await db((tx) => tx.select().from(schema.orders).where(eq(schema.orders.id, orderId))))[0]!;

describe("scheduled confirmation (C.5)", () => {
  it("confirms on the agreed day from the configured hour; a refused platform call keeps the date for the next day", async () => {
    await ops((s) => saveCodSettings(s, { scheduledConfirmHour: 8, tags: { queue: [], confirmed: [], cancelled: [], write: { confirmed: { add: ["Confermato"] }, confirm_scheduled: { add: ["Conferma programmata"] } } } }));
    const [a, b] = await freshCodOrders(2);
    const platform = mockPlatform();
    await expect(ops((s) => recordAttempt(s, { orderId: a!, outcome: "confirm_scheduled" }))).rejects.toMatchObject({ code: "invalid_input" });
    const r = await ops((s) => recordAttempt(s, { orderId: a!, outcome: "confirm_scheduled", confirmOn: "2026-10-05" }, undefined, { platform }));
    expect(r.status).toBe("confirm_scheduled");
    await ops((s) => recordAttempt(s, { orderId: b!, outcome: "confirm_scheduled", confirmOn: "2026-10-05" }, undefined, { platform }));
    expect((await itemOf(a!)).scheduledConfirmOn).toBe("2026-10-05");
    expect((await orderOf(a!)).platformTags).toContain("conferma programmata");
    // planned items leave the "to call" list and have their own view
    const q = await ops((s) => queueItems(s, { view: "planned" }));
    expect(q.rows.map((x) => x.order.id)).toEqual(expect.arrayContaining([a, b]));
    expect((await ops((s) => queueItems(s, { view: "all" }))).rows.some((x) => x.order.id === a)).toBe(false);
    // the day before, or too early on the day: nothing happens
    expect(await system(new Date("2026-10-04T10:00:00Z"))((s) => runScheduledConfirmations(s, { timezone: TZ, platform }))).toEqual({ confirmed: 0, failed: 0 });
    expect(await system(new Date("2026-10-05T04:00:00Z"))((s) => runScheduledConfirmations(s, { timezone: TZ, platform }))).toEqual({ confirmed: 0, failed: 0 });
    // the platform refuses the first tag write: a stays scheduled with the error, b goes through
    platform.failures.failNext("network", 1);
    const day1 = await system(new Date("2026-10-05T07:30:00Z"))((s) => runScheduledConfirmations(s, { timezone: TZ, platform }));
    expect(day1).toEqual({ confirmed: 1, failed: 1 });
    const failed = [await itemOf(a!), await itemOf(b!)].find((i) => i.status === "confirm_scheduled")!;
    expect(failed.scheduledConfirmOn).toBe("2026-10-05");
    expect(failed.scheduledConfirmTriedOn).toBe("2026-10-05");
    expect(failed.scheduledConfirmError).toBeTruthy();
    // later the same day: not retried (daily)
    expect(await system(new Date("2026-10-05T15:00:00Z"))((s) => runScheduledConfirmations(s, { timezone: TZ, platform }))).toEqual({ confirmed: 0, failed: 0 });
    // next day's run confirms it
    expect(await system(new Date("2026-10-06T07:00:00Z"))((s) => runScheduledConfirmations(s, { timezone: TZ, platform }))).toEqual({ confirmed: 1, failed: 0 });
    for (const id of [a!, b!]) {
      expect((await itemOf(id)).status).toBe("confirmed");
      expect((await orderOf(id)).status).toBe("confirmed");
    }
    const attempts = await db((tx) => tx.select().from(schema.codAttempts).where(and(eq(schema.codAttempts.orderId, failed.orderId), eq(schema.codAttempts.outcome, "confirmed"))));
    expect(attempts[0]).toMatchObject({ channel: "scheduled", operatorId: null });
  });
});

describe("transfer, escalation and bulk actions (C.4, C.9)", () => {
  it("lets an operator pass an untouched item to a colleague within the daily limit, audited; never after the first call", async () => {
    await ops((s) => saveCodSettings(s, { transferDailyLimit: 2, tags: { queue: [], confirmed: [], cancelled: [], write: {} } }));
    for (const e of ["ops@northwind.demo", "care@northwind.demo", "care2@northwind.demo"]) await ops((s) => saveCapacity(s, { userId: uid(e), dailyHours: [8, 8, 8, 8, 8, 8, 8], isActive: true, allowedTags: [] }));
    await db((tx) => tx.delete(schema.codAssignmentLog).where(and(eq(schema.codAssignmentLog.tenantId, tenantId), eq(schema.codAssignmentLog.reason, "transfer"))));
    const ids = await freshCodOrders(4);
    for (const id of ids) await owner((s) => transferQueueItem(s, id, uid("ops@northwind.demo"), { isAdmin: true, timezone: TZ }));
    const r = await ops((s) => transferQueueItem(s, ids[0]!, uid("care@northwind.demo"), { isAdmin: false, timezone: TZ, note: "lingua" }));
    expect(r.transfersToday).toBe(1);
    expect((await itemOf(ids[0]!)).assignedTo).toBe(uid("care@northwind.demo"));
    await expect(ops((s) => transferQueueItem(s, ids[0]!, uid("care2@northwind.demo"), { isAdmin: false, timezone: TZ }))).rejects.toMatchObject({ code: "forbidden", detail: "not_yours" });
    await ops((s) => recordAttempt(s, { orderId: ids[1]!, outcome: "no_answer" }));
    await expect(ops((s) => transferQueueItem(s, ids[1]!, uid("care@northwind.demo"), { isAdmin: false, timezone: TZ }))).rejects.toMatchObject({ code: "forbidden", detail: "already_called" });
    await ops((s) => transferQueueItem(s, ids[2]!, uid("care@northwind.demo"), { isAdmin: false, timezone: TZ }));
    await expect(ops((s) => transferQueueItem(s, ids[3]!, uid("care@northwind.demo"), { isAdmin: false, timezone: TZ }))).rejects.toMatchObject({ code: "forbidden", detail: "daily_limit" });
    // admins are not limited and may move an item after calls
    await owner((s) => transferQueueItem(s, ids[1]!, uid("care2@northwind.demo"), { isAdmin: true, timezone: TZ }));
    const audits = await db((tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "cod.transferred"), eq(schema.auditLogs.entityId, ids[0]!))));
    expect(audits.at(-1)).toMatchObject({ actorUserId: uid("ops@northwind.demo") });
    const events = await db((tx) => tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, ids[0]!), eq(schema.orderEvents.type, "cod_assigned"))));
    expect(events.some((e) => (e.metadata as { reason?: string }).reason === "transfer")).toBe(true);
  });

  it("escalates to the admins and resolves with a reassignment", async () => {
    const [a] = await freshCodOrders(1);
    await expect(care((s) => escalateQueueItem(s, a!, "x"))).rejects.toMatchObject({ code: "invalid_input" });
    await care((s) => escalateQueueItem(s, a!, "Il cliente chiede un responsabile"));
    expect((await itemOf(a!)).escalationReason).toBe("Il cliente chiede un responsabile");
    expect((await care((s) => queueCounts(s, null))).escalated).toBeGreaterThanOrEqual(1);
    expect((await care((s) => queueItems(s, { view: "escalated" }))).rows.map((x) => x.order.id)).toContain(a);
    const notes = await db((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.tenantId, tenantId), eq(schema.notifications.userId, uid("owner@northwind.demo")), sql`${schema.notifications.metadata}->>'orderId' = ${a!}`)));
    expect(notes.length).toBeGreaterThan(0);
    await owner((s) => resolveEscalation(s, a!, { assignTo: uid("care2@northwind.demo"), timezone: TZ }));
    const item = await itemOf(a!);
    expect(item.escalatedAt).toBeNull();
    expect(item.assignedTo).toBe(uid("care2@northwind.demo"));
  });

  it("distributes the selection equally, and bulk-confirms reporting each refusal", async () => {
    const ids = await freshCodOrders(5);
    const r = await owner((s) => distributeEqually(s, [...ids, "00000000-0000-0000-0000-000000000001"], { timezone: TZ, userIds: [uid("ops@northwind.demo"), uid("care@northwind.demo")] }));
    expect(r.done).toBe(5);
    expect(r.failed).toEqual([{ orderId: "00000000-0000-0000-0000-000000000001", code: "not_in_queue" }]);
    const assigned = await Promise.all(ids.map(async (id) => (await itemOf(id)).assignedTo));
    const n = (u: string) => assigned.filter((x) => x === u).length;
    expect(Math.abs(n(uid("ops@northwind.demo")) - n(uid("care@northwind.demo")))).toBeLessThanOrEqual(1);
    const platform = mockPlatform();
    const out = await owner((s) => bulkOutcome(s, [ids[0]!, ids[1]!, "00000000-0000-0000-0000-000000000002"], "confirmed", { platform }));
    expect(out.done).toBe(2);
    expect(out.failed).toEqual([{ orderId: "00000000-0000-0000-0000-000000000002", code: "not_in_queue" }]);
    expect((await orderOf(ids[0]!)).status).toBe("confirmed");
    const cancel = await owner((s) => bulkOutcome(s, [ids[2]!], "cancelled", { platform }));
    expect(cancel.done).toBe(1);
    expect((await orderOf(ids[2]!)).cancelledAt).not.toBeNull();
  });
});

describe("tiles and navigation (C.1, C.3)", () => {
  it("counts and ages each view, and gives the previous and next order of a view", async () => {
    const ids = await freshCodOrders(3);
    const tiles = await ops((s) => queueTiles(s, uid("ops@northwind.demo")));
    const all = tiles.find((t) => t.view === "all")!;
    expect(all.count).toBeGreaterThanOrEqual(3);
    expect(all.avgAgeHours).not.toBeNull();
    expect(tiles.map((t) => t.view)).toEqual(["all", "mine", "unassigned", "scheduled", "planned", "unreachable", "escalated"]);
    const q = await ops((s) => queueItems(s, { view: "all" }));
    const middle = q.rows[1]!.order.id;
    const nav = (await ops((s) => queueNeighbours(s, middle, { view: "all", userId: uid("ops@northwind.demo") })))!;
    expect(nav.position).toBe(2);
    expect(nav.prev!.id).toBe(q.rows[0]!.order.id);
    expect(nav.next!.id).toBe(q.rows[2]!.order.id);
    void ids;
  });
});

describe("messages (C.17)", () => {
  it("renders templates, sends through the channel as an attempt, and follows delivery receipts forward only", async () => {
    await ops((s) => saveCodSettings(s, { messageTemplates: [{ key: "confirm", name: "Conferma", body: "Ciao {{first_name}}, confermi l'ordine {{order_name}} di {{total}} ({{items}})?" }] }));
    const [a] = await freshCodOrders(1, { phone: "+39 333 765 4321", phoneE164: "+393337654321", customerName: "Giulia Neri" });
    const rendered = await ops((s) => renderOrderTemplates(s, a!, { shopName: "Northwind", locale: "it" }));
    expect(rendered[0]!.text).toMatch(/^Ciao Giulia, confermi l'ordine .+ di .+€/);
    const channel = new MockMessagingChannel();
    await expect(ops((s) => sendCodMessage(s, channel, { orderId: a!, templateKey: "nope" }, { shopName: "Northwind", locale: "it" }))).rejects.toMatchObject({ code: "invalid_input" });
    const sent = await ops((s) => sendCodMessage(s, channel, { orderId: a!, templateKey: "confirm" }, { shopName: "Northwind", locale: "it" }));
    expect(sent.attemptNumber).toBe(1);
    expect(channel.sent[0]).toMatchObject({ to: "+393337654321", template: "confirm" });
    expect((await itemOf(a!)).attemptsCount).toBe(1);
    expect(await ops((s) => applyMessageStatus(s, sent.messageId, "read"))).toBe(true);
    expect(await ops((s) => applyMessageStatus(s, sent.messageId, "delivered"))).toBe(false);
    const list = await ops((s) => listOrderMessages(s, a!));
    expect(list[0]!.m).toMatchObject({ status: "read", templateKey: "confirm", provider: "messaging-mock" });
    const attempt = (await db((tx) => tx.select().from(schema.codAttempts).where(eq(schema.codAttempts.orderId, a!))))[0]!;
    expect(attempt).toMatchObject({ outcome: "message_sent", channel: "messaging-mock" });
  });
});

describe("carrier outcomes and risk (C.14, C.19)", () => {
  it("imports a carrier file matched by order name, feeds recipient risk and the risk panel", async () => {
    const [a, b] = await freshCodOrders(2, { phone: "+39 333 000 1111", phoneE164: "+393330001111", emailNormalized: "risk.demo@example.com" });
    const names = await Promise.all([a!, b!].map(async (id) => (await orderOf(id)).name));
    const parsed = parseCarrierCsv(`order;esito;data;costo\n${names[0]};rifiutato;01/09/2026;13,40\n${names[1]};rifiutato;02/09/2026;13,40\nUNKNOWN-1;consegnato;;\n`);
    const r = await ops((s) => importCarrierOutcomes(s, parsed.rows, { batch: "test-1" }));
    expect(r).toMatchObject({ imported: 3, matched: 2, unmatched: ["UNKNOWN-1"] });
    // re-importing the same reference updates it
    await ops((s) => importCarrierOutcomes(s, parseCarrierCsv(`order;esito\n${names[0]};rifiutato\n`).rows, { batch: "test-2" }));
    expect((await db((tx) => tx.select().from(schema.codCarrierOutcomes).where(eq(schema.codCarrierOutcomes.orderId, a!))))).toHaveLength(1);
    await ops((s) => recomputeRecipientProfiles(s, undefined, "IT"));
    const [profile] = await db((tx) => tx.select().from(schema.codRecipientProfiles).where(and(eq(schema.codRecipientProfiles.tenantId, tenantId), eq(schema.codRecipientProfiles.recipientKey, "+393330001111"))));
    expect(profile!.ordersReturned).toBe(2);
    expect(["high_risk", "blacklisted"]).toContain(profile!.tier);
    const [c] = await freshCodOrders(1, { phone: "+39 333 000 1111", phoneE164: "+393330001111", emailNormalized: "risk.demo@example.com" });
    await ops((s) => scoreQueueItem(s, c!, { timezone: TZ }));
    const panel = (await ops((s) => riskPanel(s, c!)))!;
    expect(panel.ordersRefused).toBe(2);
    expect(panel.refusedPct).toBe(100);
    expect(panel.wastedMinor).toBeGreaterThan(0);
    expect(panel.recipientKey).toMatch(/•/);
    const pre = (await ops((s) => orderPrecheck(s, c!, { timezone: TZ })))!;
    expect(pre.score).not.toBeNull();
    expect(Array.isArray(pre.flagged)).toBe(true);
  });

  it("auto-cancels a returned, unpaid COD parcel only when the setting is on, without restock, voiding the payment", async () => {
    const [a] = await freshCodOrders(1);
    const [ship] = await db((tx) => tx.insert(schema.shipments).values({ tenantId, orderId: a!, status: "returned", trackingNumber: "RTS-TEST-1" }).returning());
    await db((tx) => tx.insert(schema.shipmentCases).values({ tenantId, kind: "return_to_sender", shipmentId: ship!.id, orderId: a!, status: "open", shipmentStatus: "returned" }));
    await db((tx) => tx.update(schema.orders).set({ externalId: `ext-rts-${a}` }).where(eq(schema.orders.id, a!)));
    const platform = mockPlatform();
    await ops((s) => saveCodSettings(s, { rtsAutoCancel: false }));
    expect(await system()((s) => autoCancelReturnedToSender(s, { platform }))).toEqual({ cancelled: 0, failed: 0 });
    await ops((s) => saveCodSettings(s, { rtsAutoCancel: true }));
    const r = await system()((s) => autoCancelReturnedToSender(s, { platform }));
    const row = await orderOf(a!);
    expect(r.cancelled).toBeGreaterThanOrEqual(1);
    // idempotent: a cancelled order is not picked again
    expect((await system()((s) => autoCancelReturnedToSender(s, { platform }))).cancelled).toBe(0);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.paymentStatus).toBe("voided");
    expect(platform.writeLog.some((w) => w.op === "cancelOrder" && (w.args as { restock: boolean }).restock === false)).toBe(true);
    await ops((s) => saveCodSettings(s, { rtsAutoCancel: false }));
  });
});

describe("console (C.11)", () => {
  it("measures efficiency over a period and lists what each operator handled", async () => {
    const ids = await freshCodOrders(3);
    const from = new Date(Date.now() - 3600e3);
    await care((s) => recordAttempt(s, { orderId: ids[0]!, outcome: "no_answer" }));
    await care((s) => recordAttempt(s, { orderId: ids[0]!, outcome: "confirmed" }));
    await care((s) => recordAttempt(s, { orderId: ids[1]!, outcome: "confirmed" }));
    await care((s) => recordAttempt(s, { orderId: ids[2]!, outcome: "no_answer" }));
    const to = new Date(Date.now() + 3600e3);
    const eff = await owner((s) => operatorEfficiency(s, { from, to }, { userId: uid("care@northwind.demo") }));
    expect(eff).toHaveLength(1);
    expect(eff[0]).toMatchObject({ attempts: 4, handled: 3, confirmed: 2, cancelled: 0, noAnswer: 2, confirmedPct: 67, attemptsPerConfirmation: 1.5 });
    expect(eff[0]!.avgHandlingMinutes).not.toBeNull();
    const list = await owner((s) => operatorAttribution(s, uid("care@northwind.demo"), { from, to }));
    expect(list.map((r) => r.orderId).sort()).toEqual([...ids].sort());
    expect((await owner((s) => operatorAttribution(s, uid("care@northwind.demo"), { from, to }, { outcome: "confirmed" }))).map((r) => r.orderId).sort()).toEqual([ids[0], ids[1]].sort());
    const sup = await owner((s) => supervisorView(s));
    expect(sup.rows.length).toBeGreaterThan(0);
    expect(sup.rows.every((r) => typeof r.bottleneck === "boolean")).toBe(true);
  });
});

describe("payment method switch on replacement (C.13)", () => {
  it("recreates the order as bank transfer, drops the COD fee line and keeps it out of the queue", async () => {
    await ops((s) => saveCodSettings(s, { feeLineMatch: ["COD-FEE"], tags: { queue: [], confirmed: [], cancelled: [], write: {} } }));
    const [a] = await freshCodOrders(1);
    const lines = await db((tx) => tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, a!)));
    // mark one extra line as the COD fee
    const first = lines.find((l) => l.currentQuantity > 0)!;
    const [fee] = await db((tx) => tx.insert(schema.orderLines).values({ tenantId, orderId: a!, sku: "COD-FEE", title: "Contrassegno", quantity: 1, currentQuantity: 1, unitPriceMinor: 300, totalMinor: 300 }).returning());
    const p = mockPlatform();
    const r = await ops((s) => modifyCodOrder(s, p, { orderId: a!, paymentMethod: "bank_transfer" }, { country: "IT" }));
    expect(r.kind).toBe("replaced");
    if (r.kind !== "replaced") return;
    const created = await orderOf(r.newOrderId);
    expect(created.paymentMethod).toBe("bank_transfer");
    const newLines = await db((tx) => tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, r.newOrderId)));
    expect(newLines.some((l) => l.sku === "COD-FEE")).toBe(false);
    expect(newLines.some((l) => l.sku === first.sku)).toBe(true);
    expect((await db((tx) => tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, r.newOrderId))))).toHaveLength(0);
    expect((await itemOf(a!)).status).toBe("left");
    void fee;
  });
});

describe("dashboard widgets (C.10)", () => {
  const env = (addons: string[], userId: string) => ({ tenant: { id: tenantId, country: "IT", currency: "EUR", timezone: TZ, settings: {} as never }, role: "owner" as const, activeAddons: addons, userId, customs: [] });
  it("load with the add-on and are refused without it", async () => {
    const period = dashboardPeriod("30d", new Date(), TZ);
    await freshCodOrders(1);
    for (const type of ["cod_pending", "cod_operators", "cod_mine"] as const) {
      const on = await owner((s) => loadWidgetData(s, env(["addon.cod"], uid("ops@northwind.demo")), { type, settings: {} }, period, COD_WIDGET_LOADERS));
      expect(on.ok, type).toBe(true);
      const off = await owner((s) => loadWidgetData(s, env([], uid("ops@northwind.demo")), { type, settings: {} }, period, COD_WIDGET_LOADERS));
      expect(off).toEqual({ ok: false, reason: "module_disabled" });
    }
    const pending = await owner((s) => loadWidgetData(s, env(["addon.cod"], uid("ops@northwind.demo")), { type: "cod_pending", settings: {} }, period, COD_WIDGET_LOADERS));
    expect(pending.ok && (pending.data as { today: number }).today).toBeGreaterThanOrEqual(1);
  });
});

describe("isolation of the new tables", () => {
  it("never shows a tenant's messages or carrier outcomes to another tenant", async () => {
    const fromHarbor = await withTenant(harborId, async (tx) => ({ m: await tx.select().from(schema.codMessages), c: await tx.select().from(schema.codCarrierOutcomes) }), pools.app);
    expect(fromHarbor.m).toHaveLength(0);
    expect(fromHarbor.c).toHaveLength(0);
    const [order] = await db((tx) => tx.select({ id: schema.orders.id }).from(schema.orders).limit(1));
    await expect(withTenant(harborId, (tx) => tx.insert(schema.codCarrierOutcomes).values({ tenantId, orderId: order!.id, reference: "x", outcome: "refused", importBatch: "x" }), pools.app)).rejects.toBeTruthy();
    expect(CodError).toBeTruthy();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockSpokiChannel } from "@hullwise/integrations";
import { suppressedContacts, toolDenial, type ServiceContext } from "@hullwise/services";
import { applyCodReply, applyMessageStatus, sendCodMessage, syncQueue } from "@hullwise/addon-cod";
import { SPOKI_MCP_TOOLS, getSpokiApiFor, getSpokiSettings, listSpokiConversations, mockSpokiFor, sendSpokiReply, spokiConversation, processSpokiWebhookEvent, recordSpokiWebhook, retrySpokiWebhooks, runOrderNotifications, saveSpokiSettings, spokiChannelInTx, spokiMessagingChannel, type SpokiHooks, type TenantRun } from "../src";

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

const as = (email: string, tenant = () => tenantId) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenant(), (tx) => fn({ tenantId: tenant(), tx, actor: { type: "user", userId: ctx.userIds[email]! } }), pools.app);
const owner = as("owner@northwind.demo");
const ops = as("ops@northwind.demo");
const system: TenantRun = (fn) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "integration", userId: null } }), pools.app);
/** What the job runner hands to the Spoki processor when addon.cod is on too (packages/jobs `spokiHooksFor`), without a platform. */
const codHooks: SpokiHooks = { onStatus: (c, e) => applyMessageStatus(c, e.providerMessageId, e.status, e.at), onReply: (c, e) => applyCodReply(c, e) };

/** The webhook route's two steps: store once, then process. */
async function deliver(body: unknown, hooks: SpokiHooks = codHooks) {
  const rec = await system((s) => recordSpokiWebhook(s, body));
  const processed = rec.id ? await system((s) => processSpokiWebhookEvent(s, rec.id!, hooks)) : null;
  return { rec, processed };
}
const message = (providerMessageId: string) => system(async (s) => (await s.tx.select().from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, tenantId), eq(schema.spokiMessages.providerMessageId, providerMessageId))).limit(1))[0]!);

/** One fresh open COD order with a phone, in the queue. */
async function openCodOrder() {
  const [order] = await withTenant(tenantId, (tx) => tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.paymentMethod, "cod"), sql`${schema.orders.phoneE164} is not null`, sql`not exists (select 1 from spoki_messages m where m.order_id = ${schema.orders.id})`)).orderBy(desc(schema.orders.placedAt)).limit(1), pools.app);
  await withTenant(tenantId, (tx) => tx.update(schema.orders).set({ status: "pending_review", cancelledAt: null, placedAt: new Date(), manualStatus: null, platformTags: [], returnedFraction: 0, refundedMinor: 0, fulfillmentStatusRaw: null, paymentStatus: "pending", financialStatusRaw: "pending" }).where(eq(schema.orders.id, order!.id)), pools.app);
  await withTenant(tenantId, (tx) => tx.delete(schema.shipments).where(eq(schema.shipments.orderId, order!.id)), pools.app);
  await ops((s) => syncQueue(s));
  return order!;
}

describe("COD confirmation through Spoki", () => {
  let orderId = "";
  let messageId = "";
  it("sends the mapped template with custom fields and logs the message, a repeated key sends nothing", async () => {
    const order = await openCodOrder();
    orderId = order.id;
    const mock = mockSpokiFor(tenantId);
    const before = mock.sent.length;
    const r = await ops(async (s) => sendCodMessage(s, await spokiChannelInTx(s, { purpose: "cod", orderId, country: "IT" }), { orderId, templateKey: "conferma" }, { shopName: "Northwind Apparel", locale: "it", operatorName: "Sara" }));
    messageId = r.messageId;
    expect(mock.sent.length).toBe(before + 1);
    const sent = mock.sent.at(-1)!;
    expect(sent.templateId).toBe("40101");
    expect(sent.customFields).toMatchObject({ ORDER_NAME: order.name, SHOP_NAME: "Northwind Apparel" });
    const m = await message(messageId);
    expect(m).toMatchObject({ direction: "outbound", purpose: "cod", orderId, templateId: "40101", templateName: "cod_confirmation", status: "sent", phone: order.phoneE164 });
    // the log shows the approved template filled in
    expect(m.body).toContain(order.name);
    // the logging channel honours idempotency keys (Spoki has none)
    const send = () => ops(async (s) => (await spokiChannelInTx(s, { purpose: "test" })).sendMessage({ to: order.phoneE164!, template: "hello", variables: {}, idempotencyKey: "k-test-1" }));
    const a = await send();
    const b = await send();
    expect(b.messageId).toBe(a.messageId);
    expect(mock.sent.filter((x) => x.messageId === a.messageId)).toHaveLength(1);
  });

  it("receipts move the status forward only, keep the COD message in step, and replays are no-ops", async () => {
    const read = await deliver(MockSpokiChannel.statusBody(messageId, "read"));
    expect(read.processed?.status).toBe("processed");
    expect((await message(messageId)).status).toBe("read");
    // a late "delivered" never moves it back
    await deliver(MockSpokiChannel.statusBody(messageId, "delivered"));
    expect((await message(messageId)).status).toBe("read");
    const [cod] = await system((s) => s.tx.select().from(schema.codMessages).where(eq(schema.codMessages.providerMessageId, messageId)));
    expect(cod!.status).toBe("read");
    // the same delivery again: stored once, nothing processed
    const again = await deliver(MockSpokiChannel.statusBody(messageId, "read"));
    expect(again.rec).toMatchObject({ duplicate: true, id: null });
  });

  it("a confirm reply confirms the queue item through COD; replaying it changes nothing", async () => {
    const body = MockSpokiChannel.inboundBody((await message(messageId)).phone, "Sì!", { replyTo: messageId, messageId: "in-confirm-1" });
    const r = await deliver(body);
    expect(r.processed?.status).toBe("processed");
    const [item] = await system((s) => s.tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, orderId)));
    expect(item!.status).toBe("confirmed");
    const attempts = await system((s) => s.tx.select().from(schema.codAttempts).where(and(eq(schema.codAttempts.orderId, orderId), eq(schema.codAttempts.channel, "whatsapp"))));
    expect(attempts.map((x) => x.outcome)).toEqual(["confirmed"]);
    const [order] = await system((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.id, orderId)));
    expect(order!.status).toBe("confirmed");
    // the reply is logged on the order of the quoted message, and the confirmation is marked replied
    const inbound = await message("in-confirm-1");
    expect(inbound).toMatchObject({ direction: "inbound", status: "received", orderId, replyToMessageId: messageId });
    expect((await message(messageId)).status).toBe("replied");
    const events = await system((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, orderId), eq(schema.orderEvents.type, "whatsapp_reply"))));
    expect(events).toHaveLength(1);
    // replay: duplicate at the door, and processing the stored event again is skipped
    expect((await deliver(body)).rec.duplicate).toBe(true);
    expect((await system((s) => processSpokiWebhookEvent(s, r.rec.id!, codHooks))).status).toBe("skipped");
    const after = await system((s) => s.tx.select().from(schema.codAttempts).where(and(eq(schema.codAttempts.orderId, orderId), eq(schema.codAttempts.channel, "whatsapp"))));
    expect(after).toHaveLength(1);
  });

  it("a cancel reply escalates the item to a person, never cancels it", async () => {
    const order = await openCodOrder();
    const sent = await ops(async (s) => sendCodMessage(s, await spokiChannelInTx(s, { purpose: "cod", orderId: order.id, country: "IT" }), { orderId: order.id, templateKey: "conferma" }, { shopName: "Northwind Apparel", locale: "it" }));
    await deliver(MockSpokiChannel.inboundBody(order.phoneE164!, "Annulla", { replyTo: sent.messageId, messageId: "in-cancel-1" }));
    const [item] = await system((s) => s.tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order.id)));
    expect(item!.status).not.toBe("cancelled");
    expect(item!.escalatedAt).not.toBeNull();
    const [o] = await system((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)));
    expect(o!.cancelledAt).toBeNull();
  });

  it("without the COD hooks (addon.cod off) a reply is only logged", async () => {
    const order = await openCodOrder();
    const sent = await ops(async (s) => sendCodMessage(s, await spokiChannelInTx(s, { purpose: "cod", orderId: order.id, country: "IT" }), { orderId: order.id, templateKey: "conferma" }, { shopName: "Northwind Apparel", locale: "it" }));
    await deliver(MockSpokiChannel.inboundBody(order.phoneE164!, "sì", { replyTo: sent.messageId, messageId: "in-nohook-1" }), {});
    const [item] = await system((s) => s.tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, order.id)));
    expect(item!.status).toBe("pending");
    expect((await message("in-nohook-1")).orderId).toBe(order.id);
  });
});

describe("opt-out and suppression", () => {
  it("a STOP reply puts the number on the shared list: WhatsApp campaigns skip the customer", async () => {
    const [c] = await system((s) => s.tx.select().from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), sql`${schema.customers.phoneE164} is not null`, sql`not exists (select 1 from email_suppressions e where e.email = ${schema.customers.phoneE164})`)).limit(1));
    const api = await system((s) => getSpokiApiFor(s));
    const settings = await system((s) => getSpokiSettings(s));
    const { messageId } = await spokiMessagingChannel(system, api!, settings, { purpose: "campaign" }).sendMessage({ to: c!.phoneE164!, template: "Hi {first_name}", variables: { first_name: "Ana" }, idempotencyKey: `rc-test-optout:${c!.id}`, meta: { customerId: c!.id } });
    expect((await message(messageId)).templateId).toBe("40105");
    expect(await system((s) => suppressedContacts(s, [{ customerId: c!.id, email: null, phone: c!.phoneE164 }]))).not.toContain(c!.id);
    await deliver(MockSpokiChannel.inboundBody(c!.phoneE164!, "stop", { messageId: "in-stop-1" }));
    expect(await system((s) => suppressedContacts(s, [{ customerId: c!.id, email: null, phone: c!.phoneE164 }]))).toContain(c!.id);
    const inbound = await message("in-stop-1");
    // a campaign message never links an order
    expect(inbound).toMatchObject({ customerId: c!.id, orderId: null, replyToMessageId: messageId });
    const audit = await system((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "contact.suppressed"))).orderBy(desc(schema.auditLogs.createdAt)).limit(1));
    expect(audit[0]!.metadata).toMatchObject({ phone: c!.phoneE164, source: "spoki" });
  });

  it("the provider's stopped-marketing error suppresses too", async () => {
    const [c] = await system((s) => s.tx.select().from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), sql`${schema.customers.phoneE164} is not null`, sql`not exists (select 1 from email_suppressions e where e.email = ${schema.customers.phoneE164})`)).offset(3).limit(1));
    const { messageId } = await owner(async (s) => (await spokiChannelInTx(s, { purpose: "campaign" })).sendMessage({ to: c!.phoneE164!, template: "x", variables: {}, meta: { customerId: c!.id } }));
    await deliver(MockSpokiChannel.statusBody(messageId, "failed", { errorCode: "whatsapp::131050" }));
    expect((await message(messageId))).toMatchObject({ status: "failed", errorCode: "whatsapp::131050" });
    expect(await system((s) => suppressedContacts(s, [{ customerId: c!.id, email: null, phone: c!.phoneE164 }]))).toContain(c!.id);
  });
});

describe("webhook retries and order notifications", () => {
  it("a receipt for an unknown message without a phone fails and is retried; with a phone it is logged as external", async () => {
    const r = await deliver(MockSpokiChannel.statusBody("spk_unknown_1", "delivered"));
    expect(r.processed).toMatchObject({ status: "failed" });
    const [ev] = await system((s) => s.tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, r.rec.id!)));
    expect(ev).toMatchObject({ status: "failed", attempts: 1, source: "spoki" });
    expect(ev!.lastError).toContain("unknown message");
    const retried = await system((s) => retrySpokiWebhooks(s, codHooks));
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    const [ev2] = await system((s) => s.tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, r.rec.id!)));
    expect(ev2!.attempts).toBe(2);
    await deliver(MockSpokiChannel.statusBody("spk_unknown_2", "delivered", { phone: "+390000000001" }));
    expect(await message("spk_unknown_2")).toMatchObject({ purpose: "external", status: "delivered", phone: "+390000000001" });
  });

  it("notifies forward status changes since the cursor, once per order and event, only for events switched on", async () => {
    const [o] = await system((s) => s.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.phoneE164} is not null`, sql`not exists (select 1 from spoki_messages m where m.order_id = ${schema.orders.id})`)).limit(1));
    const since = new Date(Date.now() - 60e3);
    await system((s) => s.tx.update(schema.spokiSettings).set({ notifiedUntil: since }).where(eq(schema.spokiSettings.tenantId, tenantId)));
    await system((s) => s.tx.insert(schema.orderEvents).values([
      { tenantId, orderId: o!.id, type: "status_changed", actorType: "system", diff: { status: { from: "fulfilling", to: "shipped" } }, createdAt: new Date(Date.now() - 30e3) },
      // order_confirmed is off in the demo settings
      { tenantId, orderId: o!.id, type: "status_changed", actorType: "system", diff: { status: { from: "pending_review", to: "confirmed" } }, createdAt: new Date(Date.now() - 40e3) },
    ]));
    const api = await system((s) => getSpokiApiFor(s));
    const opts = { shopName: "Northwind Apparel", locale: "it", country: "IT" };
    const first = await runOrderNotifications(system, api!, opts);
    expect(first.sent).toBe(1);
    expect(first.disabled).toBeGreaterThanOrEqual(1);
    const logged = await system((s) => s.tx.select().from(schema.spokiMessages).where(and(eq(schema.spokiMessages.orderId, o!.id), eq(schema.spokiMessages.purpose, "order_shipped"))));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.idempotencyKey).toBe(`order:${o!.id}:order_shipped`);
    const ev = await system((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, o!.id), eq(schema.orderEvents.type, "whatsapp_message"))));
    expect(ev).toHaveLength(1);
    // the cursor moved: nothing again; rewound: the key stops a second message
    expect((await runOrderNotifications(system, api!, opts)).sent).toBe(0);
    await system((s) => s.tx.update(schema.spokiSettings).set({ notifiedUntil: since }).where(eq(schema.spokiSettings.tenantId, tenantId)));
    expect(await runOrderNotifications(system, api!, opts)).toMatchObject({ sent: 0, duplicate: 1 });
  });

  it("saves settings with validation and an audited diff", async () => {
    await owner((s) => saveSpokiSettings(s, { senderNumber: "+15550001111", notify: { order_confirmed: true } }));
    const s1 = await owner((s) => getSpokiSettings(s));
    expect(s1.senderNumber).toBe("+15550001111");
    expect(s1.notify).toMatchObject({ order_confirmed: true, order_shipped: true });
    expect(s1.templates.order_shipped?.templateId).toBe("40103");
    await expect(owner((s) => saveSpokiSettings(s, { senderNumber: "12" }))).rejects.toMatchObject({ code: "invalid_input" });
    const [a] = await system((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, "spoki.settings_updated"))).orderBy(desc(schema.auditLogs.createdAt)).limit(1));
    expect(a!.diff).toHaveProperty("senderNumber");
  });
});

describe("conversations and team replies", () => {
  it("groups the log by number, flags the threads awaiting a reply, and answers within the 24-hour window only", async () => {
    // a customer answers a shipping notice: their thread is awaiting a reply, the window is open
    const [o] = await system((s) => s.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.phoneE164} is not null`, sql`not exists (select 1 from spoki_messages m where m.phone = ${schema.orders.phoneE164})`)).limit(1));
    const { messageId } = await owner(async (s) => (await spokiChannelInTx(s, { purpose: "order_shipped", orderId: o!.id, country: "IT" })).sendMessage({ to: o!.phoneE164!, template: "order_shipped", variables: { order_name: o!.name }, idempotencyKey: `conv-test:${o!.id}` }));
    await deliver(MockSpokiChannel.inboundBody(o!.phoneE164!, "Posso cambiare indirizzo?", { replyTo: messageId, messageId: "in-conv-1" }), {});
    const list = await owner((s) => listSpokiConversations(s, { awaitingOnly: true, limit: 100 }));
    const row = list.rows.find((r) => r.phone === o!.phoneE164);
    expect(row).toMatchObject({ awaitingReply: true, windowOpen: true, lastDirection: "inbound", lastBody: "Posso cambiare indirizzo?" });
    expect(list.awaiting).toBeGreaterThanOrEqual(1);
    const thread = await owner((s) => spokiConversation(s, row!.lastMessageId));
    expect(thread!.messages.map((m) => m.m.direction).slice(-2)).toEqual(["outbound", "inbound"]);
    expect(thread!.windowOpen).toBe(true);
    // the team answers in free text: logged as a manual message on the thread's order, the thread is no longer awaiting
    const before = mockSpokiFor(tenantId).sent.length;
    const r = await as("care@northwind.demo")((s) => sendSpokiReply(s, { messageId: row!.lastMessageId, text: "Certo, mandaci il nuovo indirizzo.", country: "IT" }));
    expect(r.orderId).toBe(o!.id);
    expect(mockSpokiFor(tenantId).sent.at(-1)).toMatchObject({ to: o!.phoneE164, templateId: null, text: "Certo, mandaci il nuovo indirizzo." });
    expect(mockSpokiFor(tenantId).sent.length).toBe(before + 1);
    expect(await message(r.messageId)).toMatchObject({ direction: "outbound", purpose: "manual", orderId: o!.id, sentBy: ctx.userIds["care@northwind.demo"] });
    const all = await owner((s) => listSpokiConversations(s, { limit: 100 }));
    expect(all.rows.find((x) => x.phone === o!.phoneE164)).toMatchObject({ awaitingReply: false, lastPurpose: "manual" });
    // more than 24 hours after the customer's last message: refused, nothing sent
    const later = { now: new Date(Date.now() + 25 * 3600e3) };
    await expect(withTenant(tenantId, (tx) => sendSpokiReply({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@northwind.demo"]! }, ...later }, { messageId: row!.lastMessageId, text: "Ci sei?" }), pools.app)).rejects.toMatchObject({ code: "window_closed" });
    expect(mockSpokiFor(tenantId).sent.length).toBe(before + 1);
    await expect(owner((s) => sendSpokiReply(s, { messageId: row!.lastMessageId, text: "   " }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("an opt-out, or a COD keyword the queue acted on, does not wait for an answer", async () => {
    const stop = await message("in-stop-1");
    const confirm = await message("in-confirm-1");
    const plain = await owner((s) => listSpokiConversations(s, { limit: 100, awaitingOnly: true }));
    expect(plain.rows.map((r) => r.phone)).not.toContain(stop.phone);
    // without the COD keywords (addon.cod off) the "Sì!" is just a customer message waiting for someone
    expect(plain.rows.map((r) => r.phone)).toContain(confirm.phone);
    const withCod = await owner((s) => listSpokiConversations(s, { limit: 100, awaitingOnly: true, autoReplies: ["sì", "no"] }));
    expect(withCod.rows.map((r) => r.phone)).not.toContain(confirm.phone);
    expect(withCod.awaiting).toBeLessThan(plain.awaiting);
  });
});

describe("gating", () => {
  it("a tenant without the add-on has no Spoki account, no rows and no MCP tool", async () => {
    const harbor = as("owner@harborhome.demo", () => harborId);
    expect(await harbor((s) => getSpokiApiFor(s))).toBeNull();
    const rows = await harbor((s) => s.tx.select().from(schema.spokiMessages));
    expect(rows).toHaveLength(0);
    // RLS: Harbor cannot read Northwind's log even by id
    const cross = await harbor((s) => s.tx.select().from(schema.spokiMessages).where(eq(schema.spokiMessages.tenantId, tenantId)));
    expect(cross).toHaveLength(0);
    const tool = SPOKI_MCP_TOOLS[0]!;
    expect(toolDenial(tool, { role: "owner", activeAddons: [] })).toBe("module");
    expect(toolDenial(tool, { role: "owner", activeAddons: ["addon.whatsapp_spoki"] })).toBeNull();
  });
});

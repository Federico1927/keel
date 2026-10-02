import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import {
  EMAIL_STRINGS, addEmailSuppression, addOrderNote, addRecordNote, adminListSupportTickets, adminReplyToTicket, adminSupportAttachment, checkLateToShip, createReturn, createTask, isEmailSuppressed, listMentions, listNotificationsPage, listSupportTickets, listTasks, drainEmailJobs, mockEmailOutbox, queueEmail,
  notifyUsers, openSupportTicket, orderReturnContext, preferenceMatrix, renderEmail, returnDetail, setMentionsRead, setNotificationPreference, setNotificationsRead, signUnsubscribeToken, supportAttachment, supportTicketThread, sweepTaskRules, tasksForRecord, transitionReturn, updateTask, verifyUnsubscribeToken,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let harborId = "";
const settings = parseTenantSettings({ returnWindowDays: 30, returnShippingFallbackDays: 5 });
const uid = (email: string) => ctx.userIds[email]!;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
  harborId = ctx.tenantIds.harbor;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, as = "owner@northwind.demo", tid = tenantId) => withTenant(tid, (tx) => fn({ tenantId: tid, tx, actor: { type: "user", userId: uid(as) } }), pools.app);
/** Emails the mock provider captured for an address, after delivering what the services queued. */
const emailsTo = async (address: string) => {
  await drainEmailJobs(pools.admin);
  return mockEmailOutbox().to(address);
};

describe("preferences are enforced on the server", () => {
  it("turning off mention emails stops them while in-app notifications continue", async () => {
    const care = uid("care@northwind.demo");
    const order = await run(async (s) => (await s.tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.tenantId, tenantId)).limit(1))[0]!);
    const note = (text: string) => run((s) => addOrderNote(s, { orderId: order.id, body: `@[Luca](${care}) ${text}`, allowedMentionIds: [care], link: `/t/northwind-apparel/orders/${order.id}`, orderName: order.name, authorName: "Giulia" }));
    const inApp = () => run(async (s) => (await s.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.userId, care), eq(schema.notifications.type, "mention"), eq(schema.notifications.inApp, true))))[0]!.n);

    const before = (await emailsTo("care@northwind.demo")).length;
    const inAppBefore = await inApp();
    await note("first");
    expect((await emailsTo("care@northwind.demo")).length).toBe(before + 1);
    const mail = (await emailsTo("care@northwind.demo")).at(-1)!.message;
    expect(mail.subject).toContain(order.name);
    expect(mail.html).toContain("<blockquote");
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(/\/api\/email\/unsubscribe\?token=/);
    expect(mail.text).toMatch(/\/u\/[\w-]+\.[\w-]+/);

    await run((s) => setNotificationPreference(s, care, "mention", "email", false), "care@northwind.demo");
    await note("second");
    expect((await emailsTo("care@northwind.demo")).length).toBe(before + 1);
    expect(await inApp()).toBe(inAppBefore + 2);
    const matrix = await run((s) => preferenceMatrix(s, care, ["mention", "digest"]), "care@northwind.demo");
    expect(matrix[0]!.channels.email).toEqual({ allowed: true, enabled: false, isDefault: false });
    expect(matrix[1]!.channels.in_app.allowed).toBe(false);

    // in-app off too: nothing in the bell, the row only records the (absent) deliveries
    await run((s) => setNotificationPreference(s, care, "mention", "in_app", false), "care@northwind.demo");
    await note("third");
    expect(await inApp()).toBe(inAppBefore + 2);
    await run((s) => setNotificationPreference(s, care, "mention", "in_app", null), "care@northwind.demo");
  });

  it("the notifications page filters and toggles read state", async () => {
    const ops = uid("ops@northwind.demo");
    await run((s) => notifyUsers(s, { userIds: [ops], type: "late_to_ship", title: "5", body: "48h", link: "/orders" }));
    const page = await run((s) => listNotificationsPage(s, ops, { status: "unread", type: "late_to_ship" }), "ops@northwind.demo");
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.types.some((t) => t.type === "late_to_ship")).toBe(true);
    const id = page.rows[0]!.id;
    expect(await run((s) => setNotificationsRead(s, ops, [id], true), "ops@northwind.demo")).toBe(1);
    expect((await run((s) => listNotificationsPage(s, ops, { status: "read", type: "late_to_ship" }), "ops@northwind.demo")).rows.some((r) => r.id === id)).toBe(true);
    // someone else's notification cannot be toggled
    expect(await run((s) => setNotificationsRead(s, uid("care@northwind.demo"), [id], false), "care@northwind.demo")).toBe(0);
  });
});

describe("email", () => {
  it("templates exist in every language with the same keys and render with Intl", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
    expect(keys(EMAIL_STRINGS.it)).toEqual(keys(EMAIL_STRINGS.en));
    expect(keys(EMAIL_STRINGS.es)).toEqual(keys(EMAIL_STRINGS.en));
    const itMail = renderEmail("supplier_po", "it", { companyName: "Northwind", supplierName: "Tessitura", poNumber: "PO-1", url: "https://x/s/1", expectedAt: new Date("2026-10-20T10:00:00Z"), timezone: "Europe/Rome" });
    expect(itMail.subject).toBe("Ordine d'acquisto PO-1 da Northwind");
    expect(itMail.text).toContain("20 ott 2026");
    const ml = renderEmail("magic_link", "es", { url: "https://x/m?<b>", minutes: 15 });
    expect(ml.html).toContain("https://x/m?&lt;b&gt;");
    expect(renderEmail("invite", "xx", { tenantName: "T", inviterName: "A", role: "operations", url: "https://x", days: 7 }).subject).toBe("A invited you to T on Keel as operations");
    const digest = renderEmail("digest", "en", { tenantName: "T", groups: [{ type: "mention", count: 5, titles: ["a", "b"] }], url: "https://x" });
    expect(digest.text).toContain("Mentions (5): a · b and 3 more");
    expect(renderEmail("notification", "it", { title: "4", body: "SKU-1", url: null, type: "stock_critical_no_po" }).subject).toBe("4 varianti in vendita con stock critico e nessun ordine d'acquisto");
    expect(renderEmail("notification", "en", { title: "Blue tee is out", body: "x", url: null, type: "stock_critical_no_po" }).subject).toBe("Blue tee is out");
  });

  it("signs unsubscribe links and honours the suppression list", async () => {
    const token = signUnsubscribeToken({ tenantId, email: "Someone@Example.com", category: "mention" });
    expect(verifyUnsubscribeToken(token)).toEqual({ tenantId, email: "someone@example.com", category: "mention" });
    expect(verifyUnsubscribeToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
    await run((s) => addEmailSuppression(s, { email: "someone@example.com", reason: "unsubscribe", category: "mention", source: "link" }));
    expect(await run((s) => isEmailSuppressed(s, "someone@example.com", "mention"))).toBe(true);
    expect(await run((s) => isEmailSuppressed(s, "someone@example.com", "digest"))).toBe(false);
    expect(await run((s) => isEmailSuppressed(s, "someone@example.com", "transactional"))).toBe(false);
    await run((s) => addEmailSuppression(s, { email: "gone@example.com", reason: "bounce" }));
    const r = await run((s) => queueEmail(s, { to: "gone@example.com", template: "invite", data: { tenantName: "N", inviterName: "G", role: "viewer", url: "https://x", days: 7 }, locale: "it", event: "t1" }));
    expect(r.outcome).toBe("suppressed");
    // the list is per tenant
    expect(await run((s) => isEmailSuppressed(s, "gone@example.com", "mention"), "owner@harborhome.demo", harborId)).toBe(false);
  });
});

describe("mentions inbox", () => {
  it("notes on purchase orders and returns land in the mentioned user's inbox", async () => {
    const ops = uid("ops@northwind.demo");
    const po = await run(async (s) => (await s.tx.select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, tenantId)).limit(1))[0]!);
    const before = await run((s) => listMentions(s, ops, { status: "unread" }), "ops@northwind.demo");
    const r = await run((s) => addRecordNote(s, { entityType: "purchase_order", entityId: po.id, body: `@[Sara](${ops}) check the dock`, allowedMentionIds: [ops], authorName: "Giulia" }));
    expect(r.mentions).toEqual([ops]);
    const after = await run((s) => listMentions(s, ops, { status: "unread" }), "ops@northwind.demo");
    expect(after.unread).toBe(before.unread + 1);
    const row = after.rows.find((m) => m.m.noteId === r.noteId)!;
    expect(row.m.entityLabel).toBe(po.number);
    expect(row.m.link).toBe(`/purchasing/${po.id}`);
    await run((s) => setMentionsRead(s, ops, [row.m.id], true), "ops@northwind.demo");
    expect((await run((s) => listMentions(s, ops, { status: "unread" }), "ops@northwind.demo")).unread).toBe(before.unread);
    await expect(run((s) => addRecordNote(s, { entityType: "return", entityId: po.id, body: "x", allowedMentionIds: [], authorName: "G" }))).rejects.toThrow("not_found");
  });
});

describe("staff tasks", () => {
  async function deliveredOrderWithoutReturns() {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select o.id from orders o join shipments s on s.order_id = o.id
        where o.tenant_id = ${tenantId} and o.status = 'delivered' and s.delivered_at > now() - interval '20 days' and s.delivered_at < now()
          and not exists (select 1 from return_requests r where r.order_id = o.id)
          and exists (select 1 from order_lines l where l.order_id = o.id and l.variant_id is not null and l.is_ancillary = false)
        order by s.delivered_at desc limit 1`);
      return rows.rows[0]!.id;
    }, pools.app);
  }

  it("return received → inspect: opens a task and closes it when the return is inspected", async () => {
    const orderId = await deliveredOrderWithoutReturns();
    const context = await run((s) => orderReturnContext(s, settings, orderId), "ops@northwind.demo");
    const line = context.lines.find((l) => l.returnable > 0 && l.variantId)!;
    const reason = await run(async (s) => (await s.tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)).limit(1))[0]!);
    const created = await run((s) => createReturn(s, settings, { orderId, reasonCode: reason.code, resolution: "refund", lines: [{ orderLineId: line.id, quantity: 1 }] }), "ops@northwind.demo");
    await run((s) => transitionReturn(s, { returnId: created.id, to: "approved" }), "ops@northwind.demo");
    expect(await run((s) => tasksForRecord(s, "return", created.id))).toHaveLength(0);

    await run((s) => transitionReturn(s, { returnId: created.id, to: "received" }), "ops@northwind.demo");
    const open = await run((s) => tasksForRecord(s, "return", created.id));
    expect(open).toHaveLength(1);
    expect(open[0]!.t.status).toBe("open");
    expect(open[0]!.t.title).toBe("Ispeziona gli articoli resi");
    expect(open[0]!.t.entityLabel).toBe(`R-${created.number}`);
    expect(open[0]!.t.assigneeId).toBe(uid("ops@northwind.demo"));
    const assigned = await run(async (s) => s.tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, uid("ops@northwind.demo")), eq(schema.notifications.type, "task_assigned"), eq(schema.notifications.link, `/returns/${created.id}`))));
    expect(assigned.length).toBe(1);

    // the sweep does not duplicate it
    await run((s) => sweepTaskRules({ ...s, actor: { type: "system", userId: null } }));
    expect(await run((s) => tasksForRecord(s, "return", created.id))).toHaveLength(1);

    const detail = await run((s) => returnDetail(s, created.id));
    await run((s) => transitionReturn(s, { returnId: created.id, to: "inspected", inspection: detail!.lines.map((l) => ({ lineId: l.id, outcome: "intact" as const, amountMinor: l.unitAmountMinor * l.quantity })) }), "ops@northwind.demo");
    const closed = await run((s) => tasksForRecord(s, "return", created.id));
    expect(closed[0]!.t.status).toBe("done");
    expect(closed[0]!.t.closedReason).toBe("auto");
    const audit = await run(async (s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, closed[0]!.t.id), eq(schema.auditLogs.action, "task.auto_closed"))));
    expect(audit).toHaveLength(1);
  });

  it("a task closed by hand is not reopened while the record stays put; manual tasks are listed and audited", async () => {
    const r = await run(async (s) => (await s.tx.select().from(schema.tasks).where(and(eq(schema.tasks.tenantId, tenantId), eq(schema.tasks.status, "open"), sql`${schema.tasks.ruleId} is not null`)).limit(1))[0]);
    if (r) {
      await run((s) => updateTask(s, r.id, { status: "done" }));
      await run((s) => sweepTaskRules({ ...s, actor: { type: "system", userId: null } }));
      const again = await run(async (s) => s.tx.select().from(schema.tasks).where(and(eq(schema.tasks.entityId, r.entityId!), eq(schema.tasks.ruleId, r.ruleId!))));
      expect(again.filter((t) => t.status === "open")).toHaveLength(0);
    }
    const product = await run(async (s) => (await s.tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.tenantId, tenantId)).limit(1))[0]!);
    const marketing = uid("marketing@northwind.demo");
    const id = await run((s) => createTask(s, { title: "Shoot new photos", assigneeId: marketing, entityType: "product", entityId: product.id, dueAt: new Date(Date.now() + 864e5) }));
    const mine = await run((s) => listTasks(s, marketing, { scope: "mine", status: "open" }), "marketing@northwind.demo");
    expect(mine.rows.some((x) => x.t.id === id)).toBe(true);
    await expect(run((s) => createTask(s, { title: "x", assigneeId: uid("owner@harborhome.demo") }))).rejects.toMatchObject({ code: "invalid_input" });
    await run((s) => updateTask(s, id, { status: "done" }), "marketing@northwind.demo");
    const audit = await run(async (s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.action, "task.updated"))));
    expect((audit[0]!.diff as Record<string, { to: unknown }>).status!.to).toBe("done");
  });
});

describe("system notifications", () => {
  it("late to ship notifies once a day", async () => {
    const n1 = await run((s) => checkLateToShip({ ...s, actor: { type: "system", userId: null } }, parseTenantSettings({ lateToShipBusinessDays: 0 })));
    if (n1 === 0) return;
    const count = () => run(async (s) => (await s.tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.tenantId, tenantId), eq(schema.notifications.type, "late_to_ship"), eq(schema.notifications.userId, uid("ops@northwind.demo")))))[0]!.n);
    const c1 = await count();
    await run((s) => checkLateToShip({ ...s, actor: { type: "system", userId: null } }, parseTenantSettings({ lateToShipBusinessDays: 0 })));
    expect(await count()).toBe(c1);
  });
});

describe("support tickets", () => {
  it("opened with an attachment, answered from the console, the author is notified, everything audited", async () => {
    const ops = uid("ops@northwind.demo");
    const { id, number } = await run((s) => openSupportTicket(s, { subject: "Sync stuck", category: "problem", body: "Orders stopped at 10:00", attachment: { name: "log.txt", type: "text/plain", data: Buffer.from("trace") } }), "ops@northwind.demo");
    expect(number).toBeGreaterThan(0);
    await expect(run((s) => openSupportTicket(s, { subject: "x", category: "problem", body: "y", attachment: { name: "a.exe", type: "application/x-msdownload", data: Buffer.from("x") } }))).rejects.toMatchObject({ code: "attachment_type" });
    // RLS: the other tenant sees nothing
    expect((await run((s) => listSupportTickets(s), "owner@harborhome.demo", harborId)).some((t) => t.t.id === id)).toBe(false);
    expect(await run((s) => supportTicketThread(s, id), "owner@harborhome.demo", harborId)).toBeNull();

    const admin = uid("superadmin@keel.demo");
    const list = await adminListSupportTickets(pools.admin, { status: "open" });
    expect(list.rows.some((r) => r.t.id === id)).toBe(true);
    await adminReplyToTicket(pools.admin, id, admin, { body: "Fixed, please retry" }, { runInTenant: (tid, fn) => withTenant(tid, fn, pools.app) });
    const thread = await run((s) => supportTicketThread(s, id), "ops@northwind.demo");
    expect(thread!.ticket.status).toBe("answered");
    expect(thread!.messages.map((m) => m.side)).toEqual(["tenant", "platform"]);
    const att = await run((s) => supportAttachment(s, thread!.messages[0]!.id), "ops@northwind.demo");
    expect(att!.data.toString()).toBe("trace");
    expect((await adminSupportAttachment(pools.admin, thread!.messages[0]!.id, admin))!.name).toBe("log.txt");
    const notified = await run(async (s) => s.tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ops), eq(schema.notifications.type, "support_reply"), eq(schema.notifications.link, `/support/${id}`))));
    expect(notified).toHaveLength(1);
    const audit = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.tenantId, tenantId)));
    expect(audit.map((a) => a.action).sort()).toEqual(["support.attachment_viewed", "support.platform_replied", "support.ticket_opened"]);
    expect(audit.find((a) => a.action === "support.platform_replied")!.actorType).toBe("super_admin");
  });
});

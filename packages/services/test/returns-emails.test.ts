import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { brandColorsFor, parseTenantSettings } from "@keel/core";
import { BRAND_SURFACES } from "@keel/ui/tokens";
import { addEmailSuppression, createReturn, drainEmailJobs, emailIdempotencyKey, importFulfillment, mockEmailOutbox, notifyReturnCustomer, portalLookup, portalSubmit, returnDetail, saveReturnPolicy, savePortalConfig, transitionReturn, verifyPortalSession, type ServiceContext } from "../src";

/** Return status emails to the end customer (issue #7): one per return and event, store identity, opt-in per event, suppressions respected. */
const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
const settings = parseTenantSettings({ returnWindowDays: 60 });
const ALL_ON = { approved: true, received: true, refunded: true, voucher_issued: true, exchange_shipped: true };
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["ops@northwind.demo"]! } }), pools.app);
const setEmails = (value: Record<string, boolean>) => pools.admin.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{returnCustomerEmails}', ${JSON.stringify(value)}::jsonb) where id = ${tenantId}`);
const used = new Set<string>();

/** A delivered order with an email, a returnable line and no return yet (a different one each call). */
async function freshOrder(recent = false) {
  return run(async (s) => {
    const r = await s.tx.execute<{ id: string; name: string; email: string }>(sql`
      select o.id, o.name, o.email from orders o
      where o.tenant_id = ${tenantId} and o.status = 'delivered' and o.email is not null ${recent ? sql`` : sql`and o.payment_method = 'card'`}
        and not exists (select 1 from return_requests r where r.order_id = o.id)
        and exists (select 1 from order_lines l where l.order_id = o.id and l.is_ancillary = false and l.variant_id is not null)
        and exists (select 1 from shipments sh where sh.order_id = o.id ${recent ? sql`and sh.delivered_at > now() - interval '50 days'` : sql``})
      order by o.placed_at desc limit 50`);
    const row = r.rows.find((x) => !used.has(x.id))!;
    used.add(row.id);
    return row;
  });
}
async function openReturn(resolution: "refund" | "voucher" = "refund") {
  const order = await freshOrder();
  return run(async (s) => {
    const [line] = await s.tx.select({ id: schema.orderLines.id }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, order.id), eq(schema.orderLines.isAncillary, false))).limit(1);
    const [reason] = await s.tx.select({ code: schema.returnReasons.code }).from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)).limit(1);
    const r = await createReturn(s, settings, { orderId: order.id, reasonCode: reason!.code, resolution, lines: [{ orderLineId: line!.id, quantity: 1 }], overrideWindow: true, staffNote: "test" });
    return { ...r, order };
  });
}
/** Email log rows of one return, matched through the idempotency key (tenant, template, recipient, event). */
async function emailsOf(returnId: string, to: string) {
  const templates = ["return_approved", "return_received", "return_refunded", "return_voucher_issued", "return_exchange_shipped"] as const;
  const events = ["approved", "received", "refunded", "voucher_issued", "exchange_shipped"] as const;
  const keys = templates.flatMap((t) => events.map((e) => ({ key: emailIdempotencyKey(tenantId, t, to, `return:${returnId}:${e}`), t })));
  const found = await pools.admin.select().from(schema.emailMessages).where(inArray(schema.emailMessages.idempotencyKey, keys.map((k) => k.key)));
  return found.map((f) => ({ template: f.template, status: f.status, locale: f.locale, category: f.category }));
}

describe("return status emails to the customer", () => {
  it("send nothing until the store switches the event on", async () => {
    await setEmails({});
    const r = await openReturn();
    await run((s) => transitionReturn(s, { returnId: r.id, to: "approved" }));
    expect(await emailsOf(r.id, r.order.email)).toEqual([]);
  });

  it("queue exactly one email per transition, never twice, with the store as sender", async () => {
    await setEmails(ALL_ON);
    await run((s) => savePortalConfig(s, { enabled: true, supportEmail: "help@northwind.example", primaryColor: "#7a1f5c", instructions: { it: "Spedisci a: Magazzino resi", en: "Ship to: Returns" } }));
    const r = await openReturn();
    await run((s) => transitionReturn(s, { returnId: r.id, to: "approved" }));
    expect(await emailsOf(r.id, r.order.email)).toEqual([{ template: "return_approved", status: "queued", locale: "it", category: "return_updates" }]);
    // replay of the same event: no second email, no second timeline entry
    expect((await run((s) => notifyReturnCustomer(s, r.id, "approved"))).outcome).toBe("duplicate");
    const detail = await run((s) => returnDetail(s, r.id));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "received" }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "inspected", inspection: detail!.lines.map((l) => ({ lineId: l.id, outcome: "intact" as const, amountMinor: l.unitAmountMinor * l.quantity })) }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "refunded" }));
    const templates = (await emailsOf(r.id, r.order.email)).map((e) => e.template).sort();
    expect(templates).toEqual(["return_approved", "return_received", "return_refunded"]);
    const events = await pools.admin.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, r.order.id), eq(schema.orderEvents.type, "customer_email")));
    expect(events.map((e) => (e.metadata as { event: string }).event).sort()).toEqual(["approved", "received", "refunded"]);

    // delivered with the store's name on the platform address, replies to the store's support address
    const outbox = mockEmailOutbox();
    await drainEmailJobs(pools.admin);
    const sent = outbox.to(r.order.email);
    expect(sent).toHaveLength(3);
    const refund = sent.find((m) => m.message.tags?.template === "return_refunded")!.message;
    expect(refund.from).toMatch(/^"Northwind Apparel" <.+@.+>$/);
    expect(refund.replyTo).toBe("help@northwind.example");
    expect(refund.subject).toContain(`R-${r.number}`);
    expect(refund.html).toContain(brandColorsFor("#7a1f5c", BRAND_SURFACES.light).primary);
    const approved = sent.find((m) => m.message.tags?.template === "return_approved")!.message;
    expect(approved.text).toContain("Spedisci a: Magazzino resi");
    expect(approved.text).not.toContain("Keel");
  });

  it("tells the customer the store-credit code", async () => {
    const r = await openReturn("voucher");
    await run((s) => transitionReturn(s, { returnId: r.id, to: "approved", notifyCustomer: false }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "received", notifyCustomer: false }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "inspected" }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "voucher_issued", voucherCode: "CREDIT-42" }));
    expect((await emailsOf(r.id, r.order.email)).map((e) => e.template)).toEqual(["return_voucher_issued"]);
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().to(r.order.email).at(-1)!.message.text).toContain("CREDIT-42");
  });

  it("skip suppressed addresses", async () => {
    const r = await openReturn();
    await run((s) => addEmailSuppression(s, { email: r.order.email, reason: "manual", category: "return_updates" }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "approved" }));
    expect(await emailsOf(r.id, r.order.email)).toEqual([expect.objectContaining({ template: "return_approved", status: "suppressed" })]);
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().to(r.order.email)).toHaveLength(0);
  });

  it("announce the replacement once, at the exchange order's first parcel", async () => {
    const r = await openReturn();
    const exchange = await freshOrder();
    await pools.admin.update(schema.returnRequests).set({ exchangeOrderId: exchange.id }).where(eq(schema.returnRequests.id, r.id));
    const at = new Date();
    const parcel = (n: number) => ({ externalId: `exch-${r.id}-${n}`, status: "in_transit" as const, externalStatus: "in_transit", trackingNumber: `TRK${n}`, trackingUrl: `https://track.example/TRK${n}`, carrier: "DHL", createdAt: at, updatedAt: at, deliveredAt: null });
    await run((s) => importFulfillment(s, exchange.id, parcel(1), at));
    await run((s) => importFulfillment(s, exchange.id, parcel(2), at));
    await run((s) => importFulfillment(s, exchange.id, { ...parcel(1), status: "delivered", deliveredAt: at }, at));
    expect((await emailsOf(r.id, r.order.email)).map((e) => e.template)).toEqual(["return_exchange_shipped"]);
    await drainEmailJobs(pools.admin);
    const mail = mockEmailOutbox().to(r.order.email).at(-1)!.message;
    expect(mail.text).toContain("TRK1");
    expect(mail.text).toContain("https://track.example/TRK1");
  });

  it("portal returns approved by an automation email the approval with the prepaid label", async () => {
    await run((s) => saveReturnPolicy(s, { automations: [{ id: "auto", name: "Approve portal returns", active: true, trigger: "created", action: "approve", conditions: { sources: ["portal"] } }] }));
    const config = await run((s) => savePortalConfig(s, { enabled: true, supportEmail: "help@northwind.example", returnLabel: { enabled: true, destination: "Returns\nVia Roma 1\n20100 Milano" } }));
    const order = await freshOrder(true);
    const view = await run(async (s) => (await portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: order.name, contact: order.email, ip: "7.7.7.7" }))!);
    const session = verifyPortalSession(view.token)!;
    const [reason] = await withTenant(tenantId, (tx) => tx.select({ code: schema.returnReasons.code }).from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)).limit(1), pools.app);
    const created = await run((s) => portalSubmit(s, settings, config, session, { lines: [{ orderLineId: view.lines[0]!.id, quantity: 1 }], reasonCode: reason!.code, resolution: "refund", locale: "es" }));
    expect(await emailsOf(created.id, order.email)).toEqual([{ template: "return_approved", status: "queued", locale: "es", category: "return_updates" }]);
    await drainEmailJobs(pools.admin);
    const mail = mockEmailOutbox().to(order.email).at(-1)!.message;
    expect(mail.subject).toContain("aprobada");
    expect(mail.text).toMatch(new RegExp(`/r/northwind-apparel/label/${created.id}\\?sig=`));
  });
});

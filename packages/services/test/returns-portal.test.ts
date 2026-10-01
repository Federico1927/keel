import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parsePortalConfig, parseTenantSettings, type TenantSettings } from "@keel/core";
import { MockCommercePlatform, decryptJson } from "@keel/integrations";
import { PortalError, getPortalConfig, saveReturnPolicy, portalLookup, portalSubmit, returnEvidenceList, returnsToSync, savePortalConfig, savePortalPhoto, syncReturnToPlatform, transitionReturn, verifyPortalSession, type ServiceContext } from "../src";

process.env.AUTH_SECRET ??= "test-secret";
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let settings: TenantSettings;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
  settings = parseTenantSettings({ returnWindowDays: 3650, returnShippingCostMinor: 590, returnPlatformTags: { refunded: ["REFUNDED"] } });
  // the seeded automations would approve or refund some returns on creation; this suite tests the portal and the write-back alone
  await withTenant(tenantId, (tx) => saveReturnPolicy({ tenantId, tx, actor: { type: "system", userId: null } }, {}), pools.app);
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const mock = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 90000 });

/** A delivered order with a returnable line and no return yet. */
async function deliveredOrder(payment?: string) {
  return run(async (s) => {
    const r = await s.tx.execute<{ id: string; name: string; email: string; phone: string | null; payment_method: string }>(sql`
      select o.id, o.name, o.email, o.phone, o.payment_method from orders o
      where o.tenant_id = ${tenantId} and o.status = 'delivered' and o.email is not null and o.external_id is not null
        ${payment ? sql`and o.payment_method = ${payment}` : sql``}
        and not exists (select 1 from return_requests r where r.order_id = o.id)
        and exists (select 1 from order_lines l where l.order_id = o.id and l.is_ancillary = false and l.external_id is not null)
        and exists (select 1 from shipments sh where sh.order_id = o.id)
      order by o.placed_at desc limit 1`);
    return r.rows[0]!;
  });
}

describe("return portal", () => {
  it("is off until configured, then finds the order by number and email", async () => {
    const order = await deliveredOrder();
    const off = await run((s) => savePortalConfig(s, { enabled: false }));
    await expect(run((s) => portalLookup(s, settings, { orderNumberPrefix: "NW-" }, off, { orderNumber: order.name, contact: order.email, ip: "1.1.1.1" }))).rejects.toMatchObject({ code: "disabled" });
    const config = await run((s) => savePortalConfig(s, { enabled: true, title: { en: "Returns" }, bankDetailsFor: ["cod"], tracking: { mode: "optional", carriers: ["DHL"] }, photos: { mode: "optional", max: 2 }, fields: [{ key: "worn", type: "checkbox", label: { en: "Worn?" }, required: false }] }));
    const view = await run(async (s) => (await portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: order.name.replace("#NW-", ""), contact: order.email.toUpperCase(), ip: "1.1.1.1" }))!);
    expect(view.orderName).toBe(order.name);
    expect(view.eligible).toBe(true);
    expect(view.lines.length).toBeGreaterThan(0);
    expect(verifyPortalSession(view.token)?.orderId).toBe(order.id);
    expect(verifyPortalSession(`${view.token}x`)).toBeNull();
  });

  it("blocks after five failed lookups from the same address", async () => {
    const config = await run((s) => getPortalConfig(s));
    for (let i = 0; i < 5; i++) expect(await run((s) => portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: `99999${i}`, contact: "x@example.com", ip: "9.9.9.9" }))).toBeNull();
    const order = await deliveredOrder();
    await expect(run((s) => portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: order.name, contact: order.email, ip: "9.9.9.9" }))).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("submits a return with tracking, photos, answers and the shipping deduction, idempotently", async () => {
    const config = await run((s) => getPortalConfig(s));
    // card-paid, so no bank details are asked (that path has its own test)
    const order = await deliveredOrder("card");
    const view = await run(async (s) => (await portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: order.name, contact: order.email, ip: "2.2.2.2" }))!);
    const session = verifyPortalSession(view.token)!;
    await run((s) => savePortalPhoto(s, config, session, { contentType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) }));
    await expect(run((s) => savePortalPhoto(s, config, session, { contentType: "application/pdf", data: Buffer.from("x") }))).rejects.toMatchObject({ code: "photo_type" });
    const reason = await run(async (s) => (await s.tx.select().from(schema.returnReasons).where(and(eq(schema.returnReasons.tenantId, tenantId), eq(schema.returnReasons.defaultFault, "customer"))).limit(1))[0]!);
    const line = view.lines[0]!;
    const input = { lines: [{ orderLineId: line.id, quantity: 1 }], reasonCode: reason.code, resolution: "refund", trackingCode: "1z 999 aa1 0123", trackingCarrier: "DHL", answers: { worn: "on" }, idempotencyKey: `test-${order.id}` };
    await expect(run((s) => portalSubmit(s, settings, config, session, { ...input, resolution: "exchange" }))).rejects.toMatchObject({ code: "exchange_note_required" });
    const r = await run((s) => portalSubmit(s, settings, config, session, input));
    expect(r.duplicate).toBe(false);
    const again = await run((s) => portalSubmit(s, settings, config, session, input));
    expect(again).toEqual({ ...r, duplicate: true });
    const row = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r.id)))[0]!);
    expect(row).toMatchObject({ source: "portal", trackingCode: "1Z999AA10123", trackingCarrier: "DHL", customFields: { worn: true }, deductionMinor: Math.min(590, line.unitNetMinor), platformSyncStatus: "pending" });
    expect(row.proposedAmountMinor).toBe(line.unitNetMinor - row.deductionMinor);
    expect(await run((s) => returnEvidenceList(s, r.id))).toHaveLength(1);
  });

  it("asks bank details for orders paid on delivery and stores them encrypted", async () => {
    const config = await run((s) => getPortalConfig(s));
    const order = await deliveredOrder("cod");
    const view = await run(async (s) => (await portalLookup(s, settings, { orderNumberPrefix: "NW-" }, config, { orderNumber: order.name, contact: order.email, ip: "3.3.3.3" }))!);
    expect(view.needsBankDetailsFor).toEqual(["refund"]);
    const session = verifyPortalSession(view.token)!;
    const base = { lines: [{ orderLineId: view.lines[0]!.id, quantity: 1 }], reasonCode: (await run((s) => s.tx.select().from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, tenantId)).limit(1)))[0]!.code, resolution: "refund" };
    await expect(run((s) => portalSubmit(s, settings, config, session, base))).rejects.toBeInstanceOf(PortalError);
    await expect(run((s) => portalSubmit(s, settings, config, session, { ...base, bankHolder: "Anna Rossi", iban: "IT60X0542811101000000123457" }))).rejects.toMatchObject({ code: "iban_invalid" });
    const r = await run((s) => portalSubmit(s, settings, config, session, { ...base, bankHolder: "Anna Rossi", iban: "IT60 X054 2811 1010 0000 0123 456" }));
    const row = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r.id)))[0]!);
    expect(row.bankDetailsEnc).not.toContain("IT60");
    expect(decryptJson<{ iban: string }>(row.bankDetailsEnc!).iban).toBe("IT60X0542811101000000123456");
  });
});

describe("return write-back to the platform", () => {
  it("requests, approves, restocks, refunds, closes and tags; resumes after a failure", async () => {
    const r = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, tenantId), sql`${schema.returnRequests.idempotencyKey} like 'test-%'`)).limit(1))[0]!);
    const p = mock();
    const first = await run((s) => syncReturnToPlatform(s, p, settings, r.id));
    expect(first).toMatchObject({ status: "synced", steps: ["requested"] });
    const loc = await run(async (s) => (await s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))))[0]!);
    const lines = await run((s) => s.tx.select().from(schema.returnLines).where(eq(schema.returnLines.returnId, r.id)));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "approved" }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "received", restock: { locationId: loc.id, lineIds: lines.map((l) => l.id) } }));
    // the platform fails once: the approval step is retried by the next call, nothing is repeated
    p.failures.failNext("network");
    const failed = await run((s) => syncReturnToPlatform(s, p, settings, r.id));
    expect(failed.status).toBe("error");
    expect(await run((s) => returnsToSync(s))).toBeInstanceOf(Array);
    const resumed = await run((s) => syncReturnToPlatform(s, p, settings, r.id));
    expect(resumed.status).toBe("synced");
    expect(resumed.steps).toContain("approved");
    await run((s) => transitionReturn(s, { returnId: r.id, to: "inspected" }));
    await run((s) => transitionReturn(s, { returnId: r.id, to: "refunded" }));
    const last = await run((s) => syncReturnToPlatform(s, p, settings, r.id));
    expect(last.steps).toEqual(expect.arrayContaining(["refunded", "closed", "tagged"]));
    const ops = p.writeLog.map((w) => w.op);
    expect(ops.filter((o) => o === "requestReturn")).toHaveLength(1);
    expect(ops.filter((o) => o === "approveReturn")).toHaveLength(1);
    expect(ops).toEqual(expect.arrayContaining(["refundReturn", "closeReturn", "updateOrderTags"]));
    const row = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r.id)))[0]!);
    expect(row).toMatchObject({ platformSyncStatus: "synced", platformStatus: "closed", platformError: null });
    expect(row.platformRefundId).toBeTruthy();
    // a second sync is a no-op apart from the idempotent tag
    const noop = await run((s) => syncReturnToPlatform(s, p, settings, r.id));
    expect(noop.steps).toEqual(["tagged"]);
  });

  it("does nothing when write-back is off", async () => {
    const r = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, tenantId), eq(schema.returnRequests.platformSyncStatus, "pending"))).limit(1))[0]);
    if (!r) return;
    const res = await run((s) => syncReturnToPlatform(s, mock(), parseTenantSettings({ returnsWriteBack: false }), r.id));
    expect(res.status).toBe("not_required");
    void parsePortalConfig;
  });
});

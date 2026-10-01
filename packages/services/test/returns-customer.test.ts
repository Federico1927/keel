import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import { MockReturnLabelProvider } from "@keel/integrations";
import { createReturnLabel, customerTracking, pnlForPeriod, returnLabelPdf, returnsAnalytics, signReturnLink, verifyReturnLink, type ServiceContext } from "../src";

process.env.AUTH_SECRET ??= "test-secret";
const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.01 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);

describe("customer tracking", () => {
  it("shows status, parcels and carrier events without prices", async () => {
    const o = await run(async (s) => (await s.tx.execute<{ id: string }>(sql`select o.id from orders o where o.tenant_id = ${tenantId} and exists (select 1 from shipments sh where sh.order_id = o.id) limit 1`)).rows[0]!);
    const tr = await run((s) => customerTracking(s, o.id));
    expect(tr?.shipments.length).toBeGreaterThan(0);
    expect(Object.keys(tr!)).toEqual(["orderName", "status", "placedAt", "shipments"]);
    expect(await run((s) => customerTracking(s, "00000000-0000-0000-0000-000000000000"))).toBeNull();
  });
});

describe("return labels", () => {
  it("issues a label, stores the tracking and renders a signed PDF", async () => {
    const r = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, tenantId)).limit(1))[0]!);
    const provider = new MockReturnLabelProvider();
    const label = await run((s) => createReturnLabel(s, provider, r.id, "Returns dept\nVia Roma 1\n40100 Bologna"));
    expect(label.trackingCode).toMatch(/^MR\d{12}$/);
    const after = await run(async (s) => (await s.tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, r.id)))[0]!);
    expect(after).toMatchObject({ trackingCode: label.trackingCode, labelProvider: "mock" });
    const pdf = await run((s) => returnLabelPdf(s, r.id, { title: "Return label", from: "From", to: "To", reference: "Return", carrier: "Carrier", tracking: "Tracking", instructions: "Print it" }, "Returns dept\nVia Roma 1"));
    const text = Array.from(pdf!.bytes, (c) => String.fromCharCode(c)).join("");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain(label.trackingCode);
    const sig = signReturnLink(tenantId, r.id);
    expect(verifyReturnLink(tenantId, r.id, sig)).toBe(true);
    expect(verifyReturnLink(ctx.tenantIds.harbor, r.id, sig)).toBe(false);
  });
});

describe("return costs", () => {
  it("adds labels and handling to the P/L contribution and the returns analytics", async () => {
    const period = { from: new Date(Date.now() - 365 * 864e5), to: new Date() };
    const base = parseTenantSettings({});
    const costed = parseTenantSettings({ returnLabelCostMinor: 600, returnHandlingCostMinor: 200 });
    const tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome" };
    const a = await run((s) => pnlForPeriod(s, { ...tenant, settings: base }, period));
    const b = await run((s) => pnlForPeriod(s, { ...tenant, settings: costed }, period));
    expect(a.returnCostsMinor).toBe(0);
    expect(b.returnCostsMinor).toBe(b.returnCosts.totalMinor);
    expect(b.returnCostsMinor).toBeGreaterThan(0);
    expect(b.contributionMinor).toBe(a.contributionMinor - b.returnCostsMinor);
    const ra = await run((s) => returnsAnalytics(s, period, { labelMinor: 600, handlingMinor: 200 }));
    expect(ra.costs.totalMinor).toBe(b.returnCosts.totalMinor);
    expect(ra.byOption.length).toBeGreaterThan(0);
    expect(ra.byOption.every((o) => o.rate >= 0 && o.returned <= o.sold * 5)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import { MockMessagingChannel } from "@keel/integrations";
import { deleteRetentionCampaign, listRetentionCampaigns, previewRetentionSend, RetentionCampaignError, retentionCampaignDetail, retentionCampaignResults, saveRetentionCampaign, saveSegment, sendRetentionCampaign, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, id = tenantId) => withTenant(id, (tx) => fn({ tenantId: id, tx, actor: { type: "user", userId: ctx.userIds["marketing@northwind.demo"]! } }), pools.app);

describe("customer campaigns", () => {
  it("the seeded win-back is measured against its control group, with the code redemptions", async () => {
    // the sign of the uplift is checked on the full-size demo; at test scale the control group is a handful of customers
    const list = await run((s) => listRetentionCampaigns(s, tenant));
    const sent = list.find((c) => c.status === "sent")!;
    expect(sent.results!.report.measurable).toBe(true);
    expect(sent.results!.windowOpen).toBe(false);
    const r = sent.results!.report;
    expect(r.treated.customers + r.holdout.customers).toBe(sent.treatedCount + sent.holdoutCount);
    expect(r.treated.converters).toBeGreaterThanOrEqual(sent.results!.codeRedemptions);
    expect(sent.results!.codeRedemptions).toBeGreaterThan(0);
    expect(list.some((c) => c.status === "draft")).toBe(true);
  });

  it("sends to the treated group only, records the control group, and measures intention-to-treat", async () => {
    const segmentId = await run((s) => saveSegment(s, { name: "Campaign test", rules: { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 1 }] }, holdoutPercentage: 30 }));
    const id = await run((s) => saveRetentionCampaign(s, { name: "Test", segmentId, channel: "email", message: "Hi {first_name}, {code}", discountCode: "TEST5", costPerMessageMinor: 3, attributionDays: 7 }));
    const preview = await run((s) => previewRetentionSend(s, id));
    expect(preview.treated).toBeGreaterThan(0);
    expect(preview.holdout).toBeGreaterThan(0);
    expect(preview.minimumDetectableUplift).toBeGreaterThan(0);
    const channel = new MockMessagingChannel();
    const res = await run((s) => sendRetentionCampaign(s, id, channel));
    expect(res.treated).toBe(preview.treated);
    expect(res.holdout).toBe(preview.holdout);
    expect(channel.sent.length).toBe(res.delivered);
    expect(channel.sent[0]!.template).toContain("TEST5");
    const holdoutIds = await run((s) => s.tx.select({ customerId: schema.retentionExposures.customerId, email: schema.customers.email }).from(schema.retentionExposures).innerJoin(schema.customers, eq(schema.customers.id, schema.retentionExposures.customerId)).where(and(eq(schema.retentionExposures.campaignId, id), eq(schema.retentionExposures.groupName, "holdout"))));
    const messaged = new Set(channel.sent.map((m) => m.to));
    for (const h of holdoutIds) expect(messaged.has(h.email!)).toBe(false);
    await expect(run((s) => sendRetentionCampaign(s, id, channel))).rejects.toBeInstanceOf(RetentionCampaignError);
    await expect(run((s) => saveRetentionCampaign(s, { name: "x", segmentId, channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 7 }, id))).rejects.toThrow("already_sent");
    await expect(run((s) => deleteRetentionCampaign(s, id))).rejects.toThrow("already_sent");

    // an order by a treated customer two days later is attributed; one after the window is not
    const [exposure] = await run((s) => s.tx.select().from(schema.retentionExposures).where(and(eq(schema.retentionExposures.campaignId, id), eq(schema.retentionExposures.groupName, "treated"))).limit(1));
    const later = (days: number) => new Date(exposure!.exposedAt.getTime() + days * 864e5);
    const before = (await run((s) => retentionCampaignResults(s, tenant, id)))!;
    await run(async (s) => {
      const base = { tenantId, customerId: exposure!.customerId, currency: "EUR", shippingCountry: "IT", paymentGateways: [] as string[], platformTags: [] as string[], paymentMethod: "card", paymentStatus: "paid", totalMinor: 12200, taxMinor: 2200, subtotalMinor: 10000 };
      await s.tx.insert(schema.orders).values({ ...base, orderNumber: 990001, name: "#RT-1", status: "delivered", placedAt: later(2) });
      await s.tx.insert(schema.orders).values({ ...base, orderNumber: 990002, name: "#RT-2", status: "delivered", placedAt: later(9) });
    });
    const s2 = { ...(ctxNow(later(20))) };
    const after = (await run((s) => retentionCampaignResults({ ...s, ...s2 }, tenant, id)))!;
    expect(after.report.treated.orders).toBe(before.report.treated.orders + 1);
    expect(after.report.costMinor).toBe(res.delivered * 3);
    expect(after.windowOpen).toBe(false);
    const detail = await run((s) => retentionCampaignDetail(s, tenant, id));
    expect(detail!.exposureStatus.find((x) => x.status === "held_out")!.n).toBe(res.holdout);
  });

  it("manual campaigns record exposures without messaging; drafts can be deleted; inputs are validated", async () => {
    const [segment] = await run((s) => s.tx.select({ id: schema.segments.id }).from(schema.segments).where(eq(schema.segments.name, "Clienti ricorrenti")).limit(1));
    const id = await run((s) => saveRetentionCampaign(s, { name: "Manual", segmentId: segment!.id, channel: "manual", message: "", costPerMessageMinor: 0, attributionDays: 14 }));
    const channel = new MockMessagingChannel();
    const res = await run((s) => sendRetentionCampaign(s, id, channel));
    expect(channel.sent).toHaveLength(0);
    expect(res.delivered).toBe(res.treated);
    const draft = await run((s) => saveRetentionCampaign(s, { name: "Draft", segmentId: segment!.id, channel: "sms", message: "x", costPerMessageMinor: 5, attributionDays: 10 }));
    await run((s) => deleteRetentionCampaign(s, draft));
    await expect(run((s) => saveRetentionCampaign(s, { name: "Bad", segmentId: segment!.id, channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 0 }))).rejects.toThrow("invalid_input");
    await expect(run((s) => saveRetentionCampaign(s, { name: "Bad", segmentId: "00000000-0000-0000-0000-000000000000", channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 7 }))).rejects.toThrow("no_segment");
  });

  it("another tenant sees none of these campaigns", async () => {
    const other = ctx.tenantIds.harbor;
    const otherTenant = { ...tenant, id: other };
    const mine = await run((s) => listRetentionCampaigns(s, tenant));
    const theirs = await run((s) => listRetentionCampaigns(s, otherTenant), other);
    for (const c of theirs) expect(mine.some((m) => m.id === c.id)).toBe(false);
    expect(await run((s) => retentionCampaignDetail(s, otherTenant, mine[0]!.id), other)).toBeNull();
  });
});

function ctxNow(now: Date): Partial<ServiceContext> {
  return { now };
}

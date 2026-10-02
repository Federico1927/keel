import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, type Period } from "@hullwise/core";
import { IntegrationError, type MockAdsPlatform, type MockCommercePlatform } from "@hullwise/integrations";
import { AdPlatformNotInPlanError, adRows, adPlatformInPlan, campaignAdSets, campaignSpendReconciliation, campaignsWithEconomics, enqueuePlatformWrite, executePlatformWrite, getAdsPlatformFor, getCommercePlatformFor, importOrder, mockAdsFor, requestAdStatus, requestCampaignStatus, resetMockPlatforms, runAdsBackfill, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
const T: Record<"northwind" | "harbor", { id: string; tenant: AnalyticsTenant; platform: { id: string; currency: string; country: string; orderNumberPrefix: string } }> = {} as never;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  resetMockPlatforms();
  T.northwind = { id: ctx.tenantIds.northwind, tenant: { id: ctx.tenantIds.northwind, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) }, platform: { id: ctx.tenantIds.northwind, currency: "EUR", country: "IT", orderNumberPrefix: "NW-" } };
  T.harbor = { id: ctx.tenantIds.harbor, tenant: { id: ctx.tenantIds.harbor, country: "US", currency: "USD", timezone: "America/New_York", settings: parseTenantSettings({}) }, platform: { id: ctx.tenantIds.harbor, currency: "USD", country: "US", orderNumberPrefix: "HH-" } };
});
afterAll(() => pools.close());
const run = <R>(key: "northwind" | "harbor", fn: (s: ServiceContext) => Promise<R>) => withTenant(T[key].id, (tx) => fn({ tenantId: T[key].id, tx, actor: { type: "user", userId: ctx.userIds[key === "northwind" ? "marketing@northwind.demo" : "owner@harborhome.demo"] ?? null } }), pools.app);
const runner = (key: "northwind" | "harbor") => <R>(fn: (s: ServiceContext) => Promise<R>) => withTenant(T[key].id, (tx) => fn({ tenantId: T[key].id, tx, actor: { type: "system", userId: null } }), pools.app);
const last = (days: number): Period => ({ from: new Date(Date.now() - days * 864e5), to: new Date(Date.now() + 60_000) });
const tiktokCampaigns = (key: "northwind" | "harbor") => run(key, (s) => s.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, T[key].id), eq(schema.campaigns.platform, "tiktok"))).orderBy(schema.campaigns.externalId));

describe("TikTok on the demo tenants", () => {
  it("Northwind (Growth) has TikTok connected with campaigns, ad groups, ads and daily metrics; Harbor (Starter) has none", async () => {
    const nw = await tiktokCampaigns("northwind");
    expect(nw.length).toBe(6);
    const [integration] = await run("northwind", (s) => s.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, T.northwind.id), eq(schema.integrations.provider, "tiktok"))));
    expect(integration).toMatchObject({ status: "connected", mode: "mock" });
    const ads = await run("northwind", (s) => adRows(s, T.northwind.tenant, last(90), { platform: "tiktok" }));
    expect(ads.rows.length).toBeGreaterThanOrEqual(20);
    expect(ads.rows.every((a) => a.utm.ok)).toBe(true);
    expect(ads.rows.some((a) => a.economics.attributedOrders > 0)).toBe(true);
    expect(await tiktokCampaigns("harbor")).toEqual([]);
    expect(await run("harbor", (s) => s.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, T.harbor.id), eq(schema.integrations.provider, "tiktok"))))).toEqual([]);
  });

  it("campaigns vs stock: a winning and a losing TikTok campaign, profit only on orders not cancelled or returned, ad groups that add up", async () => {
    // over the campaigns' whole life: the test seed has few orders, so a shorter window can miss a winner's sales
    const rows = await run("northwind", (s) => campaignsWithEconomics(s, T.northwind.tenant, last(365), { platform: "tiktok" }));
    expect(rows.every((r) => r.platform === "tiktok")).toBe(true);
    const winner = rows.find((r) => r.name.startsWith("Spark Ads"))!;
    const loser = rows.find((r) => r.name.startsWith("UGC try-on"))!;
    expect(winner.metrics.profitMinor).toBeGreaterThan(0);
    expect(loser.metrics.profitMinor).toBeLessThan(0);
    expect(loser.light).toBe("bad");
    expect(["pause", "consider_pause", "pause_stock"]).toContain(loser.action);
    expect(winner.light).toBe("good");
    for (const r of [winner, loser]) expect(r.metrics.profitMinor).toBe(r.metrics.marginMinor - r.metrics.spendMinor);
    expect(winner.products.length).toBe(1);
    // the orders behind the number: TikTok orders that were cancelled or returned are not in it
    const all = await run("northwind", (s) => s.tx.select({ status: schema.orders.status }).from(schema.orderAttribution).innerJoin(schema.orders, eq(schema.orders.id, schema.orderAttribution.orderId)).where(and(eq(schema.orderAttribution.tenantId, T.northwind.id), eq(schema.orderAttribution.campaignId, winner.id))));
    const placed = all.filter((o) => o.status !== "cancelled" && o.status !== "returned" && o.status !== "refunded").length;
    expect(winner.metrics.attributedOrders).toBeLessThanOrEqual(placed);
    for (const c of rows.filter((r) => r.metrics.spendMinor > 0)) {
      const rec = await run("northwind", (s) => campaignSpendReconciliation(s, c.id, last(60)));
      expect(rec.childrenMinor + rec.unallocatedMinor).toBe(rec.campaignMinor);
      const sets = await run("northwind", (s) => campaignAdSets(s, T.northwind.tenant, last(60), c.id));
      expect(sets.rows.reduce((a, x) => a + x.metrics.spendMinor, 0)).toBe(rec.campaignMinor);
    }
  });

  it("an order with ttclid and utm_campaign set to a TikTok campaign id is attributed to that campaign, its ad and ad group", async () => {
    const [campaign] = await tiktokCampaigns("northwind");
    const [ad] = await run("northwind", (s) => s.tx.select().from(schema.adCreatives).where(and(eq(schema.adCreatives.tenantId, T.northwind.id), eq(schema.adCreatives.campaignId, campaign!.id))).limit(1));
    const commerce = (await run("northwind", (s) => getCommercePlatformFor(s, T.northwind.platform))) as MockCommercePlatform;
    const order = commerce.generateOrder(new Date());
    order.landingSite = `/products/x?utm_source=tiktok&utm_medium=paid_social&utm_campaign=${campaign!.externalId}&utm_content=${ad!.externalId}&utm_term=${ad!.adsetExternalId}&ttclid=E.C.P.test`;
    order.noteAttributes = [];
    const r = await run("northwind", (s) => importOrder(s, order, { country: "IT", source: "webhook" }));
    const [attr] = await run("northwind", (s) => s.tx.select().from(schema.orderAttribution).where(eq(schema.orderAttribution.orderId, r.id)));
    expect(attr).toMatchObject({ campaignId: campaign!.id, channel: "paid_social", utmContent: ad!.externalId, utmTerm: ad!.adsetExternalId });
    expect(attr!.clickIds).toMatchObject({ ttclid: "E.C.P.test" });
  });
});

describe("TikTok through the adapter factory and the outbox", () => {
  it("the plan gates TikTok server side: Harbor gets no adapter and a queued TikTok write fails instead of retrying", async () => {
    // other suites may move Harbor to another plan (billing): pin it to Starter, which has no TikTok
    await pools.admin.update(schema.tenants).set({ planKey: "starter" }).where(eq(schema.tenants.id, T.harbor.id));
    expect(await run("harbor", (s) => adPlatformInPlan(s, "tiktok"))).toBe(false);
    expect(await run("harbor", (s) => adPlatformInPlan(s, "meta"))).toBe(true);
    await expect(run("harbor", (s) => getAdsPlatformFor(s, T.harbor.platform, "tiktok"))).rejects.toBeInstanceOf(AdPlatformNotInPlanError);
    const write = await run("harbor", (s) => enqueuePlatformWrite(s, { kind: "campaign.status", entityType: "campaign", entityId: null, payload: { provider: "tiktok", campaignExternalId: "1780000000000100", status: "paused" } }));
    await executePlatformWrite(runner("harbor"), T.harbor.platform, write.id);
    const [row] = await run("harbor", (s) => s.tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.id, write.id)));
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "permission" });
    // a Northwind TikTok ad is invisible from Harbor
    const nwAd = (await run("northwind", (s) => adRows(s, T.northwind.tenant, last(30), { platform: "tiktok" }))).rows[0]!;
    expect(await run("harbor", (s) => requestAdStatus(s, nwAd.id, "paused"))).toEqual({ ok: false, error: "not_found" });
  });

  it("pausing a TikTok campaign after confirmation is audited, queued and reaches the mock adapter once", async () => {
    const campaign = (await tiktokCampaigns("northwind")).find((c) => c.status === "active")!;
    const out = await run("northwind", (s) => requestCampaignStatus(s, campaign.id, "paused"));
    expect(out.ok).toBe(true);
    const write = out.ok ? out.write! : null;
    expect(write).toMatchObject({ kind: "campaign.status", provider: "tiktok", status: "pending" });
    // asking again changes nothing and queues nothing
    expect(await run("northwind", (s) => requestCampaignStatus(s, campaign.id, "paused"))).toEqual({ ok: true, write: null });
    const first = await executePlatformWrite(runner("northwind"), T.northwind.platform, write!.id);
    const again = await executePlatformWrite(runner("northwind"), T.northwind.platform, write!.id);
    expect(first.status).toBe("succeeded");
    expect(again.status).toBe("skipped");
    const mock = mockAdsFor(T.northwind.id, "tiktok")!;
    expect(mock.writeLog.filter((w) => w.op === "setCampaignStatus")).toEqual([{ op: "setCampaignStatus", args: { externalId: campaign.externalId, status: "paused" } }]);
    expect((await mock.fetchCampaigns()).find((c) => c.externalId === campaign.externalId)!.status).toBe("paused");
    const audit = await run("northwind", (s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, T.northwind.id), eq(schema.auditLogs.entityId, campaign.id))));
    expect(audit.map((a) => a.action)).toContain("campaign.paused");
    // TikTok ads can be paused too (no write-scope toggle as on Google)
    const ad = (await run("northwind", (s) => adRows(s, T.northwind.tenant, last(30), { platform: "tiktok" }))).rows.find((a) => a.status === "active")!;
    const adOut = await run("northwind", (s) => requestAdStatus(s, ad.id, "paused"));
    expect(adOut.ok && adOut.write).toMatchObject({ kind: "ad.status", provider: "tiktok" });
  });

  it("connecting in mock mode imports campaigns, ad groups, ads and 90 days of metrics; a rate limit pauses the backfill and the next run resumes it", async () => {
    resetMockPlatforms();
    const platform = (await run("northwind", (s) => getAdsPlatformFor(s, T.northwind.platform, "tiktok"))) as MockAdsPlatform;
    expect(platform.capabilities).toMatchObject({ supportsKeywords: false, supportsSearchTerms: false });
    // the platform answers "too many requests" once in the entity phase: the backfill pauses on that window
    const fetchEntityMetrics = platform.fetchEntityMetrics.bind(platform);
    let limited = false;
    platform.fetchEntityMetrics = async (level, window) => {
      if (!limited) {
        limited = true;
        throw new IntegrationError("rate_limited", "Mock: rate limit exceeded", 1200);
      }
      return fetchEntityMetrics(level, window);
    };
    const first = await run("northwind", (s) => runAdsBackfill(s, platform, { days: 90, budgetMs: 60_000 }));
    expect(first.error).toBeNull();
    expect(first.campaigns).toBe(6);
    expect(first.rateLimited).toBe(true);
    expect(first.finished).toBe(false);
    expect(first.retryAfterMs).toBe(1200);
    const done = await run("northwind", (s) => runAdsBackfill(s, platform, { days: 90, budgetMs: 60_000 }));
    expect(done.finished).toBe(true);
    expect(done.counts.adSets).toBe(11);
    expect(done.counts.ads).toBe(22);
    expect(done.counts.ad_set).toBeGreaterThan(0);
    expect(done.counts.ad).toBeGreaterThan(0);
    expect(done.counts.keyword ?? 0).toBe(0);
    const active = (await tiktokCampaigns("northwind")).filter((c) => c.status === "active").length;
    expect(done.metrics).toBe(active * 90);
    const since = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
    const days = await run("northwind", (s) => s.tx.selectDistinct({ date: schema.adMetricsDaily.date }).from(schema.adMetricsDaily).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adMetricsDaily.campaignId)).where(and(eq(schema.campaigns.tenantId, T.northwind.id), eq(schema.campaigns.platform, "tiktok"))));
    expect(days.filter((d) => d.date >= since).length).toBe(90);
  });

  it("a store on Growth without TikTok data gets the simulated demo account when it connects", async () => {
    // Harbor moves to Growth for this test: the plan check reads the tenant row
    await pools.admin.update(schema.tenants).set({ planKey: "growth" }).where(eq(schema.tenants.id, T.harbor.id));
    try {
      resetMockPlatforms();
      const platform = await run("harbor", (s) => getAdsPlatformFor(s, T.harbor.platform, "tiktok"));
      const out = await run("harbor", (s) => runAdsBackfill(s, platform, { days: 14, budgetMs: 60_000 }));
      expect(out).toMatchObject({ campaigns: 4, finished: true, error: null });
      expect(out.counts).toMatchObject({ adSets: 8, ads: 16, assets: 16 });
      expect((await tiktokCampaigns("harbor")).length).toBe(4);
    } finally {
      await pools.admin.update(schema.tenants).set({ planKey: "starter" }).where(eq(schema.tenants.id, T.harbor.id));
    }
  });
});

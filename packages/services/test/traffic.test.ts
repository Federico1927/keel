import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { normalizeLandingPath, type Period } from "@hullwise/core";
import { conversionReport, getAnalyticsPlatformFor, landingPathSql, mockAnalyticsFor, orderListWhere, parseOrderFilters, periodDays, resetMockPlatforms, runTrafficSync, trafficByCampaign, trafficRows, trafficState, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
const TZ = { northwind: "Europe/Rome", harbor: "America/New_York" } as const;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  resetMockPlatforms();
});
afterAll(() => pools.close());
const id = (k: "northwind" | "harbor") => ctx.tenantIds[k];
const run = <R>(k: "northwind" | "harbor", fn: (s: ServiceContext) => Promise<R>) => withTenant(id(k), (tx) => fn({ tenantId: id(k), tx, actor: { type: "system", userId: null } }), pools.app);
const utcDays = (back: number): Period => {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  return { from: new Date(today.getTime() - back * 864e5), to: new Date(today.getTime() + 864e5) };
};
const T = schema.analyticsTrafficDaily;
const stored = (k: "northwind" | "harbor", propertyId: string, since?: string) => run(k, async (s) => (await s.tx.select({ n: sql<number>`count(*)::int`, sessions: sql<number>`coalesce(sum(${T.sessions}),0)::int` }).from(T).where(and(eq(T.propertyId, propertyId), since ? sql`${T.date} >= ${since}` : sql`true`)))[0]!);

describe("GA4 on the demo tenants (#86)", () => {
  it("Northwind is connected with 12 months of traffic converting around 2%; Harbor is not connected", async () => {
    const nw = await run("northwind", (s) => trafficState(s));
    expect(nw).toMatchObject({ connected: true, propertyId: "312456789", mode: "mock" });
    expect(nw.firstDate! <= new Date(Date.now() - 360 * 864e5).toISOString().slice(0, 10)).toBe(true);
    const report = await run("northwind", (s) => conversionReport(s, { timezone: TZ.northwind }, utcDays(90), "channel"));
    expect(report.totals.orders).toBeGreaterThan(0);
    expect(report.totals.rate).toBeGreaterThan(0.01);
    expect(report.totals.rate).toBeLessThan(0.035);
    expect(report.rows[0]!.key).toBe("paid_social");
    expect(report.rows.every((r) => r.pixelSessions !== null)).toBe(true);
    const hb = await run("harbor", (s) => trafficState(s));
    expect(hb.connected).toBe(false);
    expect((await run("harbor", (s) => conversionReport(s, { timezone: TZ.harbor }, utcDays(30), "channel"))).rows).toEqual([]);
    expect(await run("harbor", (s) => getAnalyticsPlatformFor(s))).toBeNull();
    expect(await run("harbor", (s) => trafficByCampaign(s, { timezone: TZ.harbor }, utcDays(30)))).toBeNull();
  });

  it("every order count links to the orders filter that lists the same orders", async () => {
    const period = utcDays(60);
    const from = period.from.toISOString().slice(0, 10);
    const to = new Date(period.to.getTime() - 864e5).toISOString().slice(0, 10);
    const scope = { tenantId: id("northwind"), userId: null, orderNumberPrefix: "NW-" };
    const count = (sp: Record<string, string>) => run("northwind", async (s) => (await s.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(orderListWhere(scope, parseOrderFilters({ from, to, channel: "web", ...sp }))))[0]!.n);
    const byChannel = await run("northwind", (s) => conversionReport(s, { timezone: TZ.northwind }, period, "channel"));
    for (const r of byChannel.rows.filter((x) => x.orders > 0).slice(0, 4)) expect(await count({ attrChannel: r.key }), r.key).toBe(r.orders);
    const byLanding = await run("northwind", (s) => conversionReport(s, { timezone: TZ.northwind }, period, "landing", { limit: 10 }));
    const withOrders = byLanding.rows.filter((x) => x.orders > 0);
    expect(withOrders.length).toBeGreaterThan(0);
    for (const r of withOrders.slice(0, 3)) expect(await count({ landing: r.key }), r.key).toBe(r.orders);
    expect(byLanding.rows.length).toBeLessThanOrEqual(10);
  });

  it("the SQL landing path equals the core normalisation", async () => {
    const samples = ["/products/Linen-Shirt?utm_source=fb&fbclid=1", "https://Shop.example/products/x/#r", "//collections//new/", "/", "/?a=1", "https://shop.example", "products/x", "", "(not set)", "/Blogs/Journal/"];
    const rows = await run("northwind", (s) => s.tx.execute<{ v: string | null; p: string }>(sql`select v, ${landingPathSql(sql`v`)} as p from unnest(${sql.param(samples)}::text[]) as v`));
    for (const r of rows.rows) expect(r.p, String(r.v)).toBe(normalizeLandingPath(r.v));
    const nul = await run("northwind", (s) => s.tx.execute<{ p: string }>(sql`select ${landingPathSql(sql`null::text`)} as p`));
    expect(nul.rows[0]!.p).toBe(normalizeLandingPath(null));
  });

  it("campaign rows get the GA4 sessions of their UTM campaign, and the rows view lists the same sessions", async () => {
    const period = utcDays(90);
    const map = (await run("northwind", (s) => trafficByCampaign(s, { timezone: TZ.northwind }, period)))!;
    expect(map.size).toBeGreaterThan(0);
    const [campaignId, sessions] = [...map.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const page = await run("northwind", (s) => trafficRows(s, { timezone: TZ.northwind }, period, { campaignId }, { pageSize: 10 }));
    expect(page.totals.sessions).toBe(sessions);
    expect(page.rows.length).toBeGreaterThan(0);
    const channel = await run("northwind", (s) => trafficRows(s, { timezone: TZ.northwind }, period, { channel: "email" }));
    const report = await run("northwind", (s) => conversionReport(s, { timezone: TZ.northwind }, period, "channel"));
    expect(channel.totals.sessions).toBe(report.rows.find((r) => r.key === "email")!.sessions);
  });
});

describe("GA4 sync", () => {
  it("a re-sync of the last days is idempotent and writes what the seed wrote", async () => {
    const since = periodDays({ from: new Date(Date.now() - 2 * 864e5), to: new Date() }, TZ.northwind).since;
    const before = await stored("northwind", "312456789", since);
    for (let i = 0; i < 2; i++) {
      const r = await run("northwind", async (s) => {
        const p = (await getAnalyticsPlatformFor(s))!;
        return runTrafficSync(s, p.platform, { propertyId: p.propertyId, kind: "reconcile", timeZone: TZ.northwind });
      });
      expect(r).toMatchObject({ finished: true, error: null });
      expect(await stored("northwind", "312456789", since)).toEqual(before);
    }
    const [health] = await run("northwind", (s) => s.tx.select().from(schema.integrationHealth).where(eq(schema.integrationHealth.source, "ga4")));
    expect(health).toMatchObject({ status: "ok", consecutiveFailures: 0 });
  });

  it("a backfill resumes after a time-budget pause and after a quota error, from the slice it stopped at", async () => {
    const property = "312456790";
    const sync = (budgetMs: number) => run("northwind", async (s) => {
      const p = (await getAnalyticsPlatformFor(s, { propertyId: property }))!;
      return runTrafficSync(s, p.platform, { propertyId: p.propertyId, kind: "backfill", timeZone: TZ.northwind, budgetMs, windowDays: 30 });
    });
    const first = await sync(0);
    expect(first).toMatchObject({ finished: false, rateLimited: false, error: null });
    const mock = mockAnalyticsFor(id("northwind"), property)!;
    expect(mock.calls).toHaveLength(1);
    mock.failures.failNext("rate_limited");
    const limited = await sync(0);
    expect(limited).toMatchObject({ finished: false, rateLimited: true, error: null });
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.runId).toBe(first.runId);
    const [paused] = await run("northwind", (s) => s.tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, first.runId)));
    expect(paused).toMatchObject({ status: "paused", error: expect.stringMatching(/rate_limited/) });
    expect((paused!.cursor as { window: number }).window).toBe(1);
    const done = await sync(60_000);
    expect(done).toMatchObject({ finished: true, runId: first.runId, error: null });
    // 13 slices of 30 days, each read once: the refused call never reached the data, the resumed run did not repeat slice 1
    expect(mock.calls.length).toBe(13);
    expect(new Set(mock.calls.map((c) => c.since)).size).toBe(13);
    const all = await mock.fetchDailyTraffic({ since: (paused!.cursor as { since: string }).since, until: (paused!.cursor as { until: string }).until });
    const total = await stored("northwind", property);
    expect(total.sessions).toBe(all.reduce((s, r) => s + r.sessions, 0));
    // running the whole backfill again changes nothing
    const again = await sync(60_000);
    expect(again.finished).toBe(true);
    expect(await stored("northwind", property)).toEqual(total);
  });

  it("an auth error fails the run with a readable error on the integration", async () => {
    const r = await run("northwind", async (s) => {
      const p = (await getAnalyticsPlatformFor(s))!;
      mockAnalyticsFor(id("northwind"), p.propertyId)!.failures.failNext("permission");
      return runTrafficSync(s, p.platform, { propertyId: p.propertyId, kind: "daily", timeZone: TZ.northwind });
    });
    expect(r.error).toMatch(/^\[permission\]/);
    const [row] = await run("northwind", (s) => s.tx.select().from(schema.integrations).where(eq(schema.integrations.provider, "ga4")));
    expect(row!.lastError).toMatch(/permission/);
    expect(row!.status).toBe("connected");
  });
});

describe("GA4 isolation", () => {
  it("Harbor neither sees nor touches Northwind's traffic, and its own sync writes nothing for Northwind", async () => {
    const nw = await stored("northwind", "312456789");
    expect(nw.n).toBeGreaterThan(0);
    const seen = await run("harbor", (s) => s.tx.select({ n: sql<number>`count(*)::int` }).from(T));
    expect(seen[0]!.n).toBe(0);
    await run("harbor", (s) => s.tx.delete(T).where(eq(T.propertyId, "312456789")));
    await run("harbor", (s) => s.tx.update(T).set({ sessions: 0 }).where(eq(T.propertyId, "312456789")));
    expect(await stored("northwind", "312456789")).toEqual(nw);
    // a Harbor connection to the same simulated property id stores Harbor's own rows
    await run("harbor", async (s) => {
      await s.tx.insert(schema.integrations).values({ tenantId: id("harbor"), provider: "ga4", status: "connected", mode: "mock", externalAccountId: "312456789" });
      const p = (await getAnalyticsPlatformFor(s))!;
      return runTrafficSync(s, p.platform, { propertyId: p.propertyId, kind: "backfill", timeZone: TZ.harbor, windowDays: 400 });
    });
    expect(await stored("northwind", "312456789")).toEqual(nw);
    const own = await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from analytics_traffic_daily where tenant_id = ${id("harbor")}::uuid`);
    expect(own.rows[0]!.n).toBeGreaterThan(0);
    await expect(run("harbor", (s) => s.tx.insert(T).values({ tenantId: id("northwind"), propertyId: "1", date: "2026-01-01", channelGroup: "Direct", source: "x", medium: "y", campaignName: "z", landingPath: "/" }))).rejects.toThrow();
    await pools.admin.execute(sql`delete from analytics_traffic_daily where tenant_id = ${id("harbor")}::uuid`);
    await pools.admin.execute(sql`delete from integrations where tenant_id = ${id("harbor")}::uuid and provider = 'ga4'`);
  });
});

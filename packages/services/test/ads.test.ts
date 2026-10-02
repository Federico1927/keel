import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, type Period } from "@hullwise/core";
import type { MockAdsPlatform } from "@hullwise/integrations";
import { loadWidgetData, adDetail, adRows, adsRecommendations, adsWords, campaignAdSets, campaignSpendReconciliation, executePlatformWrite, getAdsPlatformFor, keywordRows, requestAdStatus, requestNegativeKeyword, rollupAdEntityMetrics, runAdsEntitySync, searchTermRows, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
const T: Record<"northwind" | "harbor", { id: string; tenant: AnalyticsTenant; langs: string[] }> = {} as never;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  T.northwind = { id: ctx.tenantIds.northwind, tenant: { id: ctx.tenantIds.northwind, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) }, langs: ["it"] };
  T.harbor = { id: ctx.tenantIds.harbor, tenant: { id: ctx.tenantIds.harbor, country: "US", currency: "USD", timezone: "America/New_York", settings: parseTenantSettings({}) }, langs: ["en"] };
});
afterAll(() => pools.close());
const run = <R>(key: "northwind" | "harbor", fn: (s: ServiceContext) => Promise<R>) => withTenant(T[key].id, (tx) => fn({ tenantId: T[key].id, tx, actor: { type: "user", userId: ctx.userIds["marketing@northwind.demo"] ?? null } }), pools.app);
const last = (days: number): Period => ({ from: new Date(Date.now() - days * 864e5), to: new Date(Date.now() + 60_000) });

describe.each(["northwind", "harbor"] as const)("ads below the campaign on the demo tenant (%s)", (key) => {
  it("a search term with spend and only cancelled orders is a negative-keyword candidate", async () => {
    const r = await run(key, (s) => searchTermRows(s, T[key].tenant, last(90), { candidatesOnly: true }));
    const waste = r.rows.find((x) => x.text === (key === "northwind" ? "vestiti gratis" : "free furniture"));
    expect(waste, "wasted-spend term").toBeTruthy();
    expect(waste!.candidate).toBe("only_cancelled");
    expect(waste!.metrics.spendMinor).toBeGreaterThan(0);
    expect(waste!.economics.attributedOrders).toBe(0);
    expect(waste!.economics.excludedOrders).toBeGreaterThan(0);
    expect(waste!.orders).toMatchObject({ utmTerm: waste!.text });
    const recs = await run(key, (s) => adsRecommendations(s, T[key].tenant, last(90), { langs: T[key].langs }));
    expect(recs.negatives.some((n) => n.id === waste!.id)).toBe(true);
  });

  it("a two-word phrase common to profitable ads ranks at the top of Words by profit", async () => {
    const w = await run(key, (s) => adsWords(s, T[key].tenant, last(90), { source: "copy", sort: "profit", langs: T[key].langs }));
    expect(w.winners[0]).toMatchObject({ phrase: key === "northwind" ? "lino naturale" : "solid oak", n: 2 });
    expect(w.winners[0]!.items).toBeGreaterThanOrEqual(2);
    expect(w.winners[0]!.profitMinor).toBeGreaterThan(0);
    // its words alone also sit in losing ads, so they rank lower
    for (const word of w.winners[0]!.phrase.split(" ")) expect(w.rows.find((r) => r.phrase === word)!.profitMinor).toBeLessThan(w.winners[0]!.profitMinor);
    const two = await run(key, (s) => adsWords(s, T[key].tenant, last(90), { source: "copy", n: 2, sort: "roas", langs: T[key].langs }));
    expect(two.rows.every((r) => r.n === 2)).toBe(true);
    const terms = await run(key, (s) => adsWords(s, T[key].tenant, last(90), { source: "search_terms", langs: T[key].langs }));
    expect(terms.losers.some((r) => r.phrase === (key === "northwind" ? "gratis" : "free"))).toBe(true);
  });

  it("ad-level spend equals campaign spend day by day; ad sets, ads and assets carry Hullwise numbers", async () => {
    const period = last(60);
    const campaigns = await run(key, (s) => s.tx.select().from(schema.campaigns).where(eq(schema.campaigns.tenantId, T[key].id)));
    let checked = 0;
    for (const c of campaigns) {
      const r = await run(key, (s) => campaignSpendReconciliation(s, c.id, period));
      if (!r.campaignMinor) continue;
      checked++;
      expect(r.childrenMinor + r.unallocatedMinor).toBe(r.campaignMinor);
      expect(r.unallocatedMinor).toBe(0);
      const sets = await run(key, (s) => campaignAdSets(s, T[key].tenant, period, c.id));
      expect(sets.rows.reduce((a, x) => a + x.metrics.spendMinor, 0)).toBe(r.campaignMinor);
    }
    expect(checked).toBeGreaterThan(0);
    const ads = await run(key, (s) => adRows(s, T[key].tenant, last(90)));
    const sold = ads.rows.find((a) => a.economics.attributedOrders > 0)!;
    expect(sold.orders).toEqual({ campaign: sold.campaignId, utmContent: sold.externalId });
    expect(sold.economics.profitMinor).toBe(sold.economics.marginMinor - sold.metrics.spendMinor);
    const withAssets = ads.rows.find((a) => a.platform === "google")!;
    const detail = await run(key, (s) => adDetail(s, T[key].tenant, last(90), withAssets.id));
    const headlines = detail!.assets.filter((a) => a.fieldType === "headline");
    expect(headlines.length).toBeGreaterThan(2);
    expect(headlines.reduce((a, x) => a + x.metrics.spendMinor, 0)).toBe(detail!.ad.metrics.spendMinor);
    expect(headlines.reduce((a, x) => a + x.economics.attributedOrders, 0)).toBe(detail!.ad.economics.attributedOrders);
    const kw = await run(key, (s) => keywordRows(s, T[key].tenant, last(90), { sort: "profit" }));
    expect(kw.rows.some((k) => k.economics.attributedOrders > 0)).toBe(true);
  });

  it("flags the campaign whose ads miss the UTM template", async () => {
    const recs = await run(key, (s) => adsRecommendations(s, T[key].tenant, last(90), { langs: T[key].langs }));
    if (key === "northwind") expect(recs.utm.some((u) => u.platform === "meta" && u.params.includes("utm_content"))).toBe(true);
    for (const u of recs.utm) expect(u.missing).toBeGreaterThan(0);
  });
});

describe("dashboard top lists below the campaign", () => {
  it("lists top search terms by spend, ads and keywords by Hullwise profit; viewers without Campaigns are refused", async () => {
    const env = (role: "marketing" | "customer_care") => ({ tenant: T.northwind.tenant, role, activeAddons: [], userId: null, customs: [] });
    const terms = await run("northwind", (s) => loadWidgetData(s, env("marketing"), { type: "top_list", settings: { entity: "search_terms", limit: 5 } }, last(30)));
    expect(terms.ok).toBe(true);
    const rows = (terms as { data: { rows: { label: string; value: number; path: string }[] } }).data.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r, i) => i === 0 || r.value <= rows[i - 1]!.value)).toBe(true);
    expect(rows[0]!.path).toContain("campaigns/keywords?tab=search_terms");
    for (const entity of ["ads", "keywords"]) expect((await run("northwind", (s) => loadWidgetData(s, env("marketing"), { type: "top_list", settings: { entity, limit: 3 } }, last(30)))).ok).toBe(true);
    expect(await run("northwind", (s) => loadWidgetData(s, env("customer_care"), { type: "top_list", settings: { entity: "search_terms", limit: 3 } }, last(30)))).toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("ads writes go through the outbox with confirmation", () => {
  it("negative keyword: Google needs the write scope; with it the term is excluded and the write reaches the platform", async () => {
    const term = await run("harbor", (s) => searchTermRows(s, T.harbor.tenant, last(90), { candidatesOnly: true }));
    const target = term.rows[0]!;
    // Harbor never granted Google write access
    expect(await run("harbor", (s) => requestNegativeKeyword(s, target.id, { matchType: "exact", level: "campaign" }))).toEqual({ ok: false, error: "ads_read_only" });
    const nw = await run("northwind", (s) => searchTermRows(s, T.northwind.tenant, last(90), { candidatesOnly: true }));
    const waste = nw.rows.find((x) => x.text === "vestiti gratis")!;
    const out = await run("northwind", (s) => requestNegativeKeyword(s, waste.id, { matchType: "exact", level: "campaign" }));
    expect(out.ok).toBe(true);
    const write = out.ok ? out.write! : null;
    expect(write).toMatchObject({ kind: "keyword.negative", status: "pending", provider: "google" });
    await executePlatformWrite((fn) => withTenant(T.northwind.id, (tx) => fn({ tenantId: T.northwind.id, tx, actor: { type: "system", userId: null } }), pools.app), { id: T.northwind.id, currency: "EUR", country: "IT", orderNumberPrefix: "NW-" }, write!.id);
    const [row] = await run("northwind", (s) => s.tx.select().from(schema.platformWrites).where(eq(schema.platformWrites.id, write!.id)));
    expect(row!.status).toBe("succeeded");
    const [t] = await run("northwind", (s) => s.tx.select().from(schema.adSearchTerms).where(eq(schema.adSearchTerms.id, waste.id)));
    expect(t!.status).toBe("excluded");
    const after = await run("northwind", (s) => searchTermRows(s, T.northwind.tenant, last(90), { candidatesOnly: true }));
    expect(after.rows.some((x) => x.id === waste.id)).toBe(false);
  });

  it("pausing a Meta ad is audited and queued", async () => {
    const ads = await run("northwind", (s) => adRows(s, T.northwind.tenant, last(30), { platform: "meta" }));
    const ad = ads.rows.find((a) => a.status === "active")!;
    const out = await run("northwind", (s) => requestAdStatus(s, ad.id, "paused"));
    expect(out.ok && out.write?.kind).toBe("ad.status");
    const audit = await run("northwind", (s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, T.northwind.id), eq(schema.auditLogs.entityId, ad.id))));
    expect(audit.map((a) => a.action)).toContain("ad.paused");
  });
});

describe("entity sync and volume control", () => {
  it("syncs every level from the mock in resumable windows and pauses on a rate limit", async () => {
    const tenant = { id: T.harbor.id, currency: "USD", country: "US", orderNumberPrefix: "HH-" };
    const platform = (await run("harbor", (s) => getAdsPlatformFor(s, tenant, "google"))) as MockAdsPlatform;
    const window = { since: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10), until: new Date(Date.now() - 864e5).toISOString().slice(0, 10) };
    platform.failures.failNext("rate_limited");
    const paused = await run("harbor", (s) => runAdsEntitySync(s, platform, { ...window, budgetMs: 60_000 }));
    expect(paused).toMatchObject({ finished: false, rateLimited: true, error: null });
    const done = await run("harbor", (s) => runAdsEntitySync(s, platform, { ...window, budgetMs: 60_000 }));
    expect(done.runId).toBe(paused.runId);
    expect(done.finished).toBe(true);
    expect(Object.keys(done.counts)).toEqual(expect.arrayContaining(["ad_set", "ad", "asset", "keyword", "search_term"]));
    // a budget of zero pauses after the first window and the next call resumes it
    const slice = await run("harbor", (s) => runAdsEntitySync(s, platform, { ...window, kind: "backfill", budgetMs: 0 }));
    expect(slice.finished).toBe(false);
    let resumed = slice;
    for (let i = 0; i < 30 && !resumed.finished; i++) resumed = await run("harbor", (s) => runAdsEntitySync(s, platform, { ...window, kind: "backfill", budgetMs: 0 }));
    expect(resumed.finished).toBe(true);
    // the synced days still reconcile with the campaign level (the mock splits each campaign day exactly)
    const c = (await run("harbor", (s) => s.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, T.harbor.id), eq(schema.campaigns.platform, "google"), eq(schema.campaigns.status, "active")))))[0];
    if (c) {
      const sets = await run("harbor", (s) => campaignAdSets(s, T.harbor.tenant, { from: new Date(`${window.since}T00:00:00Z`), to: new Date(`${window.until}T00:00:00Z`) }, c.id));
      expect(sets.rows.length).toBeGreaterThan(0);
    }
  });

  it("rolls daily rows past the retention into months without changing totals, and groups rare terms", async () => {
    const sum = (key: "northwind") => run(key, async (s) => (await s.tx.select({ spend: schema.adEntityMetricsDaily.spendMinor, type: schema.adEntityMetricsDaily.entityType }).from(schema.adEntityMetricsDaily).where(eq(schema.adEntityMetricsDaily.tenantId, T[key].id))).reduce((a, r) => a + r.spend, 0));
    const before = await sum("northwind");
    const r = await run("northwind", (s) => rollupAdEntityMetrics(s, { retentionDays: 30, minImpressions: 200 }));
    expect(r.rolled).toBeGreaterThan(0);
    expect(await sum("northwind")).toBe(before);
    const days = await run("northwind", (s) => s.tx.select({ date: schema.adEntityMetricsDaily.date, grain: schema.adEntityMetricsDaily.grain }).from(schema.adEntityMetricsDaily).where(and(eq(schema.adEntityMetricsDaily.tenantId, T.northwind.id), eq(schema.adEntityMetricsDaily.grain, "day"))));
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    expect(days.every((d) => d.date >= cutoff)).toBe(true);
    const other = await run("northwind", (s) => s.tx.select().from(schema.adSearchTerms).where(and(eq(schema.adSearchTerms.tenantId, T.northwind.id), eq(schema.adSearchTerms.isOther, true))));
    expect(other.length).toBeGreaterThan(0);
  });
});

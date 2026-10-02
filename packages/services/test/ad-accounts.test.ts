import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, summarizeAccountRuns, type Period } from "@hullwise/core";
import { AdAccountError, AdAccountUnavailableError, addAdAccount, adAccountNames, campaignsWithEconomics, executePlatformWrite, getAdsPlatformFor, listAdAccounts, mockAdsFor, removeAdAccount, requestCampaignStatus, resetMockPlatforms, runAdsSyncForAccounts, type AnalyticsTenant, type ServiceContext } from "../src";

/** Several Meta ad accounts per store (#82). */
const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
let platformTenant: { id: string; currency: string; country: string; orderNumberPrefix: string };
const OUTLET = "act_demo_outlet";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  resetMockPlatforms();
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
  platformTenant = { id: tenantId, currency: "EUR", country: "IT", orderNumberPrefix: "NW-" };
});
afterAll(() => pools.close());
const as = (id: string) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(id, (tx) => fn({ tenantId: id, tx, actor: { type: "user", userId: ctx.userIds["owner@northwind.demo"] ?? null } }), pools.app);
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => as(tenantId)(fn);
const last = (days: number): Period => ({ from: new Date(Date.now() - days * 864e5), to: new Date(Date.now() + 60_000) });
const metricsOf = (campaignIds: string[]) => run((s) => s.tx.select().from(schema.adMetricsDaily).where(and(eq(schema.adMetricsDaily.tenantId, tenantId), inArray(schema.adMetricsDaily.campaignId, campaignIds))).orderBy(schema.adMetricsDaily.campaignId, schema.adMetricsDaily.date));
const metaCampaigns = (account: string) => run((s) => s.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, tenantId), eq(schema.campaigns.platform, "meta"), eq(schema.campaigns.accountExternalId, account))));

describe("Meta ad accounts on the demo stores", () => {
  it("Northwind has two connected Meta accounts, Harbor one; the campaigns list filters by account", async () => {
    const nw = await run((s) => listAdAccounts(s, "meta"));
    expect(nw.map((a) => [a.externalAccountId, a.isPrimary])).toEqual([["act_demo", true], [OUTLET, false]]);
    const harbor = await as(ctx.tenantIds.harbor)((s) => listAdAccounts(s, "meta"));
    expect(harbor.map((a) => a.externalAccountId)).toEqual(["act_demo"]);
    // row level security: Harbor never sees Northwind's outlet account
    expect((await as(ctx.tenantIds.harbor)((s) => adAccountNames(s))).some((a) => a.externalId === OUTLET)).toBe(false);
    const outlet = await run((s) => campaignsWithEconomics(s, tenant, last(90), { account: { provider: "meta", externalId: OUTLET, primary: false } }));
    expect(outlet.length).toBe(4);
    expect(outlet.every((c) => c.accountExternalId === OUTLET && c.platform === "meta")).toBe(true);
    expect(outlet.some((c) => c.metrics.spendMinor > 0)).toBe(true);
    // orders it won carry the account on their attribution
    const won = await run((s) => s.tx.select({ campaignId: schema.orderAttribution.campaignId }).from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, tenantId), eq(schema.orderAttribution.adAccountExternalId, OUTLET))));
    expect(won.every((w) => outlet.some((c) => c.id === w.campaignId))).toBe(true);
    const primary = await run((s) => campaignsWithEconomics(s, tenant, last(90), { account: { provider: "meta", externalId: "act_demo", primary: true } }));
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.some((c) => c.accountExternalId === OUTLET)).toBe(false);
  });
});

describe("syncing several accounts", () => {
  it("syncing one account leaves the other untouched", async () => {
    const outletIds = (await metaCampaigns(OUTLET)).map((c) => c.id);
    const primaryIds = (await metaCampaigns("act_demo")).map((c) => c.id);
    const before = await metricsOf(primaryIds);
    const until = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const r = await runAdsSyncForAccounts(run, platformTenant, "meta", { since, until, account: OUTLET, entities: false });
    expect(r.results).toEqual([{ account: OUTLET, ok: true, error: null, rows: expect.any(Number) }]);
    expect(r.campaigns).toBe(4);
    expect(await metricsOf(primaryIds)).toEqual(before);
    const outletRows = (await metricsOf(outletIds)).filter((m) => m.date >= since);
    expect(outletRows.length).toBeGreaterThan(0);
    expect(outletRows.every((m) => m.accountExternalId === OUTLET)).toBe(true);
    const acc = (await run((s) => listAdAccounts(s, "meta"))).find((a) => a.externalAccountId === OUTLET)!;
    expect(acc).toMatchObject({ status: "connected", lastError: null, cursor: { since, until } });
    // its own health source; the primary's is not touched
    const health = await run((s) => s.tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, tenantId), eq(schema.integrationHealth.source, `meta:${OUTLET}`))));
    expect(health[0]).toMatchObject({ status: "ok" });
  });

  it("a failing account is reported without blocking the others", async () => {
    const until = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await run(async (s) => getAdsPlatformFor(s, platformTenant, "meta"));
    mockAdsFor(tenantId, "meta")!.failures.failNext("token_expired");
    const r = await runAdsSyncForAccounts(run, platformTenant, "meta", { since, until, entities: false });
    expect(r.results.map((x) => [x.account, x.ok])).toEqual([["act_demo", false], [OUTLET, true]]);
    const s = summarizeAccountRuns(r.results);
    expect(s).toMatchObject({ ok: 1, allFailed: false, failed: [{ account: "act_demo" }] });
    const accounts = await run((x) => listAdAccounts(x, "meta"));
    expect(accounts.find((a) => a.isPrimary)).toMatchObject({ status: "error" });
    expect(accounts.find((a) => a.isPrimary)!.lastError).toMatch(/token|expired/i);
    expect(accounts.find((a) => !a.isPrimary)).toMatchObject({ status: "connected", lastError: null });
  });
});

describe("writes and account management", () => {
  it("pausing a campaign calls the account it lives in", async () => {
    const [c] = (await metaCampaigns(OUTLET)).filter((x) => x.status === "active");
    const out = await run((s) => requestCampaignStatus(s, c!.id, "paused"));
    expect(out.ok && out.write?.payload).toMatchObject({ provider: "meta", campaignExternalId: c!.externalId, accountExternalId: OUTLET });
    const res = await executePlatformWrite(run, platformTenant, out.ok ? out.write!.id : "", { force: true });
    expect(res.status).toBe("succeeded");
    expect(mockAdsFor(tenantId, "meta", OUTLET)!.writeLog).toContainEqual({ op: "setCampaignStatus", args: { externalId: c!.externalId, status: "paused" } });
    expect(mockAdsFor(tenantId, "meta")!.writeLog.some((w) => (w.args as { externalId: string }).externalId === c!.externalId)).toBe(false);
  });

  it("an admin adds a simulated account, syncs it, then removes it; the primary cannot be removed or added twice", async () => {
    const added = await run((s) => addAdAccount(s, "meta", { externalAccountId: "998877", name: "Pop-up store", mode: "mock", credentialsEncrypted: null }));
    expect(added).toMatchObject({ externalAccountId: "act_998877", isPrimary: false, status: "connected" });
    const until = new Date().toISOString().slice(0, 10);
    const r = await runAdsSyncForAccounts(run, platformTenant, "meta", { since: until, until, account: "act_998877", entities: false });
    expect(r.results[0]).toMatchObject({ ok: true });
    expect((await metaCampaigns("act_998877")).length).toBe(4);
    await expect(run((s) => addAdAccount(s, "meta", { externalAccountId: "act_demo", name: "dup", mode: "mock", credentialsEncrypted: null }))).rejects.toMatchObject({ code: "primary" });
    const primary = (await run((s) => listAdAccounts(s, "meta"))).find((a) => a.isPrimary)!;
    await expect(run((s) => removeAdAccount(s, "meta", primary.id))).rejects.toBeInstanceOf(AdAccountError);
    await run((s) => removeAdAccount(s, "meta", added.id));
    expect((await run((s) => listAdAccounts(s, "meta"))).map((a) => a.externalAccountId)).not.toContain("act_998877");
    // its campaigns keep its name; nothing can be sent to it any more
    expect((await run((s) => adAccountNames(s))).find((a) => a.externalId === "act_998877")).toMatchObject({ name: "Pop-up store", connected: false });
    resetMockPlatforms();
    await expect(run((s) => getAdsPlatformFor(s, platformTenant, "meta", { account: "act_998877" }))).rejects.toBeInstanceOf(AdAccountUnavailableError);
    const [kept] = (await metaCampaigns("act_998877")).filter((c) => c.status === "active");
    expect(await run((s) => requestCampaignStatus(s, kept!.id, "paused"))).toEqual({ ok: false, error: "ad_account_removed" });
    expect((await runAdsSyncForAccounts(run, platformTenant, "meta", { since: until, until, account: "act_998877" })).skipped).toBe("account_not_connected");
    const audit = await run((s) => s.tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.entityId, added.id))));
    expect(audit.map((a) => a.action).sort()).toEqual(["ad_account.added", "ad_account.removed"]);
  });

  it("an integration connected before accounts existed gets its primary row on first use", async () => {
    const harbor = ctx.tenantIds.harbor;
    await as(harbor)((s) => s.tx.delete(schema.adAccounts).where(eq(schema.adAccounts.tenantId, harbor)));
    const rows = await as(harbor)((s) => listAdAccounts(s, "meta"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalAccountId: "act_demo", isPrimary: true, status: "connected" });
  });
});

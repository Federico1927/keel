import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings } from "@hullwise/core";
import { campaignDailyLedger, campaignLinkSuggestions, campaignsWithEconomics, linkCampaignProduct, type AnalyticsTenant } from "../src";
import type { ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["marketing@northwind.demo"]! } }), pools.app);

describe("campaign economics", () => {
  const period = { from: new Date(Date.now() - 365 * 864e5), to: new Date() };
  it("computes spend, attributed sales and a recommendation per campaign", async () => {
    const rows = await run((s) => campaignsWithEconomics(s, tenant, period));
    expect(rows.length).toBeGreaterThan(0);
    const withSpend = rows.find((r) => r.metrics.spendMinor > 0);
    expect(withSpend).toBeTruthy();
    for (const r of rows) {
      expect(["good", "medium", "bad", "none"]).toContain(r.light);
      expect(r.metrics.profitMinor).toBe(r.metrics.marginMinor - r.metrics.spendMinor);
      if (r.status === "active" && r.stock !== null && r.stock <= tenant.settings.campaignStockThreshold && r.incoming <= 0 && (r.stock === 0 || !r.products.some((p) => p.repurchasable))) expect(r.action).toBe("pause_stock");
    }
  });
  it("ledger rows carry flags and never divide by zero", async () => {
    const rows = await run((s) => campaignDailyLedger(s, tenant, { from: new Date(Date.now() - 30 * 864e5), to: new Date() }));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) if (r.spendMinor === 0) expect(r.roas).toBeNull();
  });
  it("suggests and links products", async () => {
    const sugg = await run((s) => campaignLinkSuggestions(s));
    const campaign = await run(async (s) => (await s.tx.select().from(schema.campaigns).where(eq(schema.campaigns.tenantId, tenantId)).limit(1))[0]!);
    const product = await run(async (s) => (await s.tx.select().from(schema.products).where(eq(schema.products.tenantId, tenantId)).limit(1))[0]!);
    await run((s) => linkCampaignProduct(s, campaign.id, product.id, true, "manual"));
    const links = await run((s) => s.tx.select().from(schema.campaignProductLinks).where(eq(schema.campaignProductLinks.campaignId, campaign.id)));
    expect(links.some((l) => l.productId === product.id && l.isPrimary)).toBe(true);
    expect(links.filter((l) => l.isPrimary)).toHaveLength(1);
    expect(Array.isArray(sugg)).toBe(true);
  });
});

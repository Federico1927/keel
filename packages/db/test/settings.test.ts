import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../src/schema";
import { testPools } from "../src/test-utils";
import { ensureDemoSettings, seedPlatform, type SeedContext } from "../src/seed";
import { seedDomainForTests } from "./seed-for-tests";

const pools = testPools();
let ctx: SeedContext;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomainForTests(pools.admin, ctx);
});
afterAll(() => pools.close());

describe("demo settings step (db:seed:settings)", () => {
  it("creates the configuration rows a deploy is missing, never overwrites an edited one, and is idempotent", async () => {
    const harbor = ctx.tenantIds.harbor;
    const northwind = ctx.tenantIds.northwind;
    // a production seeded before these features existed: no portal, no survey, no AI key, no return costs
    await pools.admin.delete(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, harbor));
    await pools.admin.delete(schema.surveySettings).where(eq(schema.surveySettings.tenantId, harbor));
    await pools.admin.delete(schema.integrations).where(and(eq(schema.integrations.tenantId, harbor), eq(schema.integrations.provider, "anthropic")));
    await pools.admin.execute(sql`update tenants set settings = settings - 'returnLabelCostMinor' - 'returnHandlingCostMinor' where id = ${harbor}`);
    // a merchant edited Northwind's portal
    const [portal] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, northwind));
    await pools.admin.update(schema.returnPortalSettings).set({ config: { ...(portal!.config as object), enabled: false } }).where(eq(schema.returnPortalSettings.tenantId, northwind));

    const report = await ensureDemoSettings(pools.admin);
    const h = report.find((r) => r.tenant === "harbor-home")!;
    expect(h.created).toEqual(expect.arrayContaining(["return_portal_settings", "survey_settings", "integrations:anthropic", "tenant_settings:return_costs"]));
    expect(report.find((r) => r.tenant === "northwind-apparel")!.created).toEqual([]);

    const [hp] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, harbor));
    expect((hp!.config as { enabled: boolean }).enabled).toBe(true);
    const [np] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, northwind));
    expect((np!.config as { enabled: boolean }).enabled).toBe(false);
    const [t] = await pools.admin.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, harbor));
    expect(t!.settings).toMatchObject({ returnLabelCostMinor: 900, returnHandlingCostMinor: 300 });

    const again = await ensureDemoSettings(pools.admin);
    expect(again.every((r) => r.created.length === 0)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../src/schema";
import { testPools } from "../src/test-utils";
import { ensureDemoSettings, ensurePlatformOwner, seedPlatform, type SeedContext } from "../src/seed";
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
    await pools.admin.execute(sql`update tenants set settings = settings - 'returnLabelCostMinor' - 'returnHandlingCostMinor' - 'returnCustomerEmails' where id = ${harbor}`);
    // a merchant edited Northwind's portal
    const [portal] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, northwind));
    await pools.admin.update(schema.returnPortalSettings).set({ config: { ...(portal!.config as object), enabled: false } }).where(eq(schema.returnPortalSettings.tenantId, northwind));

    const report = await ensureDemoSettings(pools.admin);
    const h = report.find((r) => r.tenant === "harbor-home")!;
    expect(h.created).toEqual(expect.arrayContaining(["return_portal_settings", "survey_settings", "integrations:anthropic", "tenant_settings:return_costs", "tenant_settings:customer_emails"]));
    expect(report.find((r) => r.tenant === "northwind-apparel")!.created).toEqual([]);

    const [hp] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, harbor));
    expect((hp!.config as { enabled: boolean }).enabled).toBe(true);
    const [np] = await pools.admin.select().from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, northwind));
    expect((np!.config as { enabled: boolean }).enabled).toBe(false);
    const [t] = await pools.admin.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, harbor));
    expect(t!.settings).toMatchObject({ returnLabelCostMinor: 900, returnHandlingCostMinor: 300, returnCustomerEmails: { approved: true, exchange_shipped: true } });

    const again = await ensureDemoSettings(pools.admin);
    expect(again.every((r) => r.created.length === 0)).toBe(true);
  });

  it("renames the platform demo users created before the product rename, once, never onto a taken address", async () => {
    await pools.admin.execute(sql`update users set email = 'superadmin@keel.demo' where email = 'superadmin@hullwise.demo'`);
    const report = await ensureDemoSettings(pools.admin);
    expect(report.find((r) => r.tenant === "platform")?.created).toEqual(["user_email:superadmin@hullwise.demo"]);
    const rows = await pools.admin.select({ email: schema.users.email }).from(schema.users).where(sql`${schema.users.email} in ('superadmin@keel.demo', 'superadmin@hullwise.demo')`);
    expect(rows.map((r) => r.email)).toEqual(["superadmin@hullwise.demo"]);
    expect((await ensureDemoSettings(pools.admin)).find((r) => r.tenant === "platform")).toBeUndefined();
  });

  it("gives every demo product a gallery served by the app and the Shopify mirror, without touching edited ones (issue #19)", async () => {
    const harbor = ctx.tenantIds.harbor;
    const products = await pools.admin.select().from(schema.products).where(eq(schema.products.tenantId, harbor));
    const media = await pools.admin.select().from(schema.productMedia).where(eq(schema.productMedia.tenantId, harbor));
    expect(products.every((p) => p.imageUrl?.startsWith("/demo-media/") && p.descriptionHtml && p.platformUpdatedAt && p.publishedChannels)).toBe(true);
    expect(new Set(media.map((m) => m.productId)).size).toBe(products.length);
    const variants = await pools.admin.select().from(schema.productVariants).where(eq(schema.productVariants.tenantId, harbor));
    expect(variants.every((v) => v.imageMediaId && v.inventoryPolicy && v.countryOfOrigin)).toBe(true);
    // a production seeded before #19: no gallery, an old CDN cover, no mirror; one product edited by hand
    const [first, second] = products;
    await pools.admin.delete(schema.productMedia).where(eq(schema.productMedia.tenantId, harbor));
    await pools.admin.update(schema.products).set({ imageUrl: "https://cdn.hullwise.example/demo/x.jpg", descriptionHtml: null, platformUpdatedAt: null }).where(eq(schema.products.tenantId, harbor));
    await pools.admin.update(schema.products).set({ descriptionHtml: "<p>Edited</p>" }).where(eq(schema.products.id, second!.id));
    const report = await ensureDemoSettings(pools.admin);
    expect(report.find((r) => r.tenant === "harbor-home")!.created).toEqual(expect.arrayContaining([`product_media:${media.length}`]));
    const after = await pools.admin.select().from(schema.productMedia).where(eq(schema.productMedia.tenantId, harbor));
    // same ids as the full seed: deterministic
    expect(after.map((m) => m.id).sort()).toEqual(media.map((m) => m.id).sort());
    const [p1] = await pools.admin.select().from(schema.products).where(eq(schema.products.id, first!.id));
    expect(p1!.imageUrl).toBe(media.filter((m) => m.productId === first!.id).sort((a, b) => a.position - b.position)[0]!.url);
    expect(p1!.descriptionHtml).toBeTruthy();
    const [p2] = await pools.admin.select().from(schema.products).where(eq(schema.products.id, second!.id));
    expect(p2!.descriptionHtml).toBe("<p>Edited</p>");
    const again = await ensureDemoSettings(pools.admin);
    expect(again.every((r) => r.created.length === 0)).toBe(true);
  });
});

describe("platform owner step (db:seed:settings)", () => {
  it("creates the owner once, keeps its password afterwards, and takes the console away from the demo super-admin", async () => {
    const email = "owner-test@example.com";
    const demo = "superadmin@hullwise.demo";
    const superOf = async (e: string) => (await pools.admin.select({ s: schema.users.isSuperAdmin, h: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.email, e)))[0];
    try {
      expect(await ensurePlatformOwner(pools.admin, {})).toEqual({ owner: "not_configured", demoted: [] });
      expect((await superOf(demo))!.s).toBe(true);
      expect((await ensurePlatformOwner(pools.admin, { HULLWISE_OWNER_EMAIL: email, HULLWISE_OWNER_PASSWORD: "short" })).owner).toBe("missing_password");
      await expect(ensurePlatformOwner(pools.admin, { HULLWISE_OWNER_EMAIL: "me@x.demo", HULLWISE_OWNER_PASSWORD: "a-long-enough-password" })).rejects.toThrow(/real address/);

      const first = await ensurePlatformOwner(pools.admin, { HULLWISE_OWNER_EMAIL: ` ${email.toUpperCase()} `, HULLWISE_OWNER_PASSWORD: "a-long-enough-password" });
      expect(first).toEqual({ owner: "created", demoted: [demo] });
      const created = await superOf(email);
      expect(created!.s).toBe(true);
      expect((await superOf(demo))!.s).toBe(false);
      // a later deploy with another password value leaves the owner's password alone
      expect(await ensurePlatformOwner(pools.admin, { HULLWISE_OWNER_EMAIL: email, HULLWISE_OWNER_PASSWORD: "another-long-password" })).toEqual({ owner: "unchanged", demoted: [] });
      expect((await superOf(email))!.h).toBe(created!.h);
    } finally {
      await pools.admin.delete(schema.users).where(eq(schema.users.email, email));
      await pools.admin.update(schema.users).set({ isSuperAdmin: true }).where(eq(schema.users.email, demo));
    }
  });
});

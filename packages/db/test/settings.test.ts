import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../src/schema";
import { testPools } from "../src/test-utils";
import { ensureDemoSettings, ensurePlatformOwner, seedPlatform, type SeedContext } from "../src/seed";
import { seedDomainForTests } from "./seed-for-tests";
import { SCHEDULED_SHOWCASE_CAMPAIGN, WHATSAPP_SHOWCASE_CAMPAIGN } from "../src/seed/addon-showcase";

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

describe("add-on showcase on a deployed demo (#9, #34)", () => {
  it("adds the WhatsApp campaign, its messages, the customer threads and the scheduled campaign once, and re-enables nothing switched off", async () => {
    const northwind = ctx.tenantIds.northwind;
    const showcase = async () => (await pools.admin.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, northwind), eq(schema.retentionCampaigns.name, WHATSAPP_SHOWCASE_CAMPAIGN))))[0];
    // the full seed already has them: a measured WhatsApp campaign with its Spoki log, the threads with one awaiting reply
    const seeded = await showcase();
    expect(seeded).toMatchObject({ channel: "whatsapp", status: "sent" });
    expect(seeded!.deliveredCount).toBeGreaterThan(0);
    const logged = await pools.admin.select().from(schema.spokiMessages).where(eq(schema.spokiMessages.campaignId, seeded!.id));
    expect(logged.filter((m) => m.direction === "outbound")).toHaveLength(seeded!.deliveredCount);
    expect(logged.some((m) => m.direction === "inbound")).toBe(true);
    const conv = await pools.admin.select().from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, northwind), sql`${schema.spokiMessages.providerMessageId} like 'seed-spk-conv-%'`));
    expect(conv.some((m) => m.purpose === "manual" && m.sentBy === ctx.userIds["care@northwind.demo"])).toBe(true);
    // a demo deployed before the showcase: no showcase rows, the WhatsApp add-on row missing, campaigns switched off in the console
    await pools.admin.delete(schema.spokiMessages).where(sql`${schema.spokiMessages.campaignId} = ${seeded!.id} or ${schema.spokiMessages.providerMessageId} like 'seed-spk-conv-%'`);
    await pools.admin.delete(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, northwind), sql`${schema.retentionCampaigns.name} in (${WHATSAPP_SHOWCASE_CAMPAIGN}, ${SCHEDULED_SHOWCASE_CAMPAIGN})`));
    await pools.admin.delete(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, northwind), eq(schema.tenantAddons.moduleKey, "addon.whatsapp_spoki")));
    await pools.admin.update(schema.tenantAddons).set({ isActive: false }).where(and(eq(schema.tenantAddons.tenantId, northwind), eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns")));
    const off = (await ensureDemoSettings(pools.admin)).find((r) => r.tenant === "northwind-apparel")!;
    expect(off.created).toEqual(expect.arrayContaining(["tenant_addons:addon.whatsapp_spoki", "spoki_messages:conversations"]));
    expect(off.created.some((c) => c.startsWith("retention_campaigns:"))).toBe(false);
    const [campaigns] = await pools.admin.select().from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, northwind), eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns")));
    expect(campaigns!.isActive).toBe(false);
    // switched back on: the campaigns and the campaign messages arrive on the next deploy, then nothing more
    await pools.admin.update(schema.tenantAddons).set({ isActive: true }).where(and(eq(schema.tenantAddons.tenantId, northwind), eq(schema.tenantAddons.moduleKey, "addon.customer_campaigns")));
    const on = (await ensureDemoSettings(pools.admin)).find((r) => r.tenant === "northwind-apparel")!;
    expect(on.created).toEqual(expect.arrayContaining(["retention_campaigns:whatsapp_showcase", "retention_campaigns:scheduled_showcase", "spoki_messages:campaign"]));
    const again = await showcase();
    expect(again!.deliveredCount).toBeGreaterThan(0);
    const [scheduled] = await pools.admin.select().from(schema.retentionCampaigns).where(and(eq(schema.retentionCampaigns.tenantId, northwind), eq(schema.retentionCampaigns.name, SCHEDULED_SHOWCASE_CAMPAIGN)));
    expect(scheduled).toMatchObject({ status: "scheduled" });
    expect(scheduled!.scheduledAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await ensureDemoSettings(pools.admin)).every((r) => r.created.length === 0)).toBe(true);
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

import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { generateTenantDataset, type TenantSeedConfig } from "./generator";
import { writeDataset } from "./writer";
import { ensureDemoProductCatalog, type DemoCatalogKey } from "./media";
import { DEMO_COD_SETTINGS, DEMO_CUSTOMER_EMAILS, DEMO_RETURN_COSTS, REASON_LABELS, REASON_PLATFORM, demoConversionSettings, demoPixelSettings, demoPortalConfig, demoReturnPolicy, demoSurveySettings } from "./settings";
export { ensureDemoSettings } from "./settings";
export { ensureDemoProductCatalog, demoMediaUrl, DEMO_MEDIA_PREFIX } from "./media";
import { seedCollab } from "./collab";
import { seedEmailLog } from "./email";
import { seedLists } from "./lists";
import { seedPayments } from "./payments";
import { seedFulfilment } from "./fulfilment";
import { seedConsoleTenants, seedDemoLifecycle } from "./console";
import { seedInventoryControl } from "./inventory-control";
import { seedDashboards } from "./dashboards";
import { seedMcp } from "./mcp";
import { seedAdsDepth } from "./ads";
import { seedTiktok } from "./tiktok";
import { seedPlatformReliability, seedReliability } from "./reliability";
import { seedSubscriptions } from "./subscriptions";
import { createRng } from "@hullwise/integrations";
import { SALE_STATUSES, allocateLandedCost, assignHoldout, campaignMessageKey, normalizePhone, runPredictionModel, type CustomerHistory } from "@hullwise/core";
import { MODULES, PLANS, PLATFORM_CURRENCY, isAddonModule, releasedVersion } from "@hullwise/config";
import { encryptJson } from "@hullwise/integrations";
import { sql } from "drizzle-orm";

/** Password of every demo user; override with HULLWISE_DEMO_PASSWORD on a hosted demo (an empty value keeps the default). */
export const DEMO_PASSWORD = process.env.HULLWISE_DEMO_PASSWORD || "hullwise-demo-2026";

export const DEMO_TENANTS = {
  northwind: {
    slug: "northwind-apparel",
    name: "Northwind Apparel",
    country: "IT",
    currency: "EUR",
    timezone: "Europe/Rome",
    defaultLocale: "it",
    orderNumberPrefix: "NW-",
    planKey: "growth",
    addons: ["addon.cod", "addon.customer_campaigns"],
    taxRates: [
      { country: "IT", rateBps: 2200 },
      { country: "DE", rateBps: 1900 },
      { country: "FR", rateBps: 2000 },
      { country: "ES", rateBps: 2100 },
    ],
  },
  harbor: {
    slug: "harbor-home",
    name: "Harbor Home",
    country: "US",
    currency: "USD",
    timezone: "America/New_York",
    defaultLocale: "en",
    orderNumberPrefix: "HH-",
    planKey: "starter",
    // merchant subscriptions (#67): Harbor sells refills on subscription through Shopify Subscriptions
    addons: ["addon.subscriptions"] as string[],
    taxRates: [{ country: "US", rateBps: 0, pricesIncludeTax: false }],
  },
} as const;

export const DEMO_USERS = [
  { email: "superadmin@hullwise.demo", name: "Platform Admin", superAdmin: true, memberships: [] as { tenant: keyof typeof DEMO_TENANTS; role: string }[] },
  { email: "owner@northwind.demo", name: "Giulia Ferri", memberships: [{ tenant: "northwind", role: "owner" }] },
  { email: "admin@northwind.demo", name: "Marco Bianchi", memberships: [{ tenant: "northwind", role: "admin" }] },
  { email: "ops@northwind.demo", name: "Sara Conti", memberships: [{ tenant: "northwind", role: "operations" }] },
  { email: "care@northwind.demo", name: "Luca Romano", memberships: [{ tenant: "northwind", role: "customer_care" }] },
  { email: "care2@northwind.demo", name: "Elena Greco", memberships: [{ tenant: "northwind", role: "customer_care" }] },
  { email: "marketing@northwind.demo", name: "Chiara Rizzo", memberships: [{ tenant: "northwind", role: "marketing" }] },
  { email: "viewer@northwind.demo", name: "Paolo Moretti", memberships: [{ tenant: "northwind", role: "viewer" }] },
  { email: "owner@harborhome.demo", name: "Emily Carter", memberships: [{ tenant: "harbor", role: "owner" }] },
  { email: "ops@harborhome.demo", name: "James Walker", memberships: [{ tenant: "harbor", role: "operations" }] },
  { email: "marketing@harborhome.demo", name: "Olivia Brooks", memberships: [{ tenant: "harbor", role: "marketing" }] },
  { email: "care@harborhome.demo", name: "Ava Mitchell", memberships: [{ tenant: "harbor", role: "customer_care" }] },
  { email: "multi@hullwise.demo", name: "Alex Multi", memberships: [{ tenant: "northwind", role: "admin" }, { tenant: "harbor", role: "viewer" }] },
] as const;

export interface SeedContext {
  tenantIds: Record<keyof typeof DEMO_TENANTS, string>;
  userIds: Record<string, string>;
}

/** Seeds platform rows: tenants, users, memberships, add-ons, tax rates. Idempotent. */
export async function seedPlatform(db: ReturnType<typeof drizzle<typeof schema>>): Promise<SeedContext> {
  const tenantIds = {} as SeedContext["tenantIds"];
  for (const [key, t] of Object.entries(DEMO_TENANTS) as [keyof typeof DEMO_TENANTS, (typeof DEMO_TENANTS)[keyof typeof DEMO_TENANTS]][]) {
    const [row] = await db
      .insert(schema.tenants)
      .values({
        slug: t.slug,
        name: t.name,
        country: t.country,
        currency: t.currency,
        timezone: t.timezone,
        defaultLocale: t.defaultLocale,
        orderNumberPrefix: t.orderNumberPrefix,
        planKey: t.planKey,
      })
      .onConflictDoUpdate({ target: schema.tenants.slug, set: { name: t.name } })
      .returning({ id: schema.tenants.id });
    tenantIds[key] = row!.id;
    for (const addon of t.addons) {
      await db
        .insert(schema.tenantAddons)
        .values({ tenantId: row!.id, moduleKey: addon, note: "Enabled by seed", version: isAddonModule(addon) ? (releasedVersion(addon)?.version ?? null) : null })
        .onConflictDoNothing();
    }
    for (const tr of t.taxRates) {
      await db
        .insert(schema.tenantTaxRates)
        .values({ tenantId: row!.id, country: tr.country, rateBps: tr.rateBps, pricesIncludeTax: "pricesIncludeTax" in tr ? tr.pricesIncludeTax : true })
        .onConflictDoNothing();
    }
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userIds: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: u.email,
        name: u.name,
        passwordHash,
        isSuperAdmin: "superAdmin" in u ? Boolean(u.superAdmin) : false,
        emailVerified: new Date(),
        preferredName: demoPreferredName(u),
        // explicit English: an empty language now means "the tenant's language" at sign-in (Northwind is Italian)
        locale: "en",
      })
      .onConflictDoUpdate({ target: schema.users.email, set: { name: u.name, passwordHash, preferredName: demoPreferredName(u), locale: "en" } })
      .returning({ id: schema.users.id });
    userIds[u.email] = row!.id;
    for (const m of u.memberships) {
      await db
        .insert(schema.tenantMemberships)
        .values({ tenantId: tenantIds[m.tenant], userId: row!.id, role: m.role as "owner" })
        .onConflictDoUpdate({
          target: [schema.tenantMemberships.tenantId, schema.tenantMemberships.userId],
          set: { role: m.role as "owner", isActive: true },
        })
        .returning();
    }
  }
  for (const [key, id] of Object.entries(tenantIds) as [keyof typeof DEMO_TENANTS, string][]) {
    await db.insert(schema.tenantBranding).values({ tenantId: id, brandColor: DEMO_BRAND_COLORS[key] }).onConflictDoNothing();
  }
  await seedBilling(db, tenantIds);
  await seedInvitations(db, tenantIds, userIds);
  const consoleIds = await seedConsoleTenants(db);
  await seedPlatformReliability(db, consoleIds, new Date());
  return { tenantIds, userIds };
}

/**
 * Demo invitations (#52): one pending and one expired for Northwind, one pending for Harbor Home, so
 * the Users page shows the list. The stored hashes are of strings that are not valid tokens: nobody
 * can accept these from a link.
 */
const DEMO_INVITATIONS = [
  { tenant: "northwind", email: "marta.esposito@northwind.demo", name: "Marta Esposito", role: "operations", inviter: "owner@northwind.demo", sentDaysAgo: 2 },
  { tenant: "northwind", email: "stagista@northwind.demo", name: null, role: "viewer", inviter: "admin@northwind.demo", sentDaysAgo: 9 },
  { tenant: "harbor", email: "new.hire@harborhome.demo", name: "Noah Bennett", role: "customer_care", inviter: "owner@harborhome.demo", sentDaysAgo: 1 },
] as const;

async function seedInvitations(db: ReturnType<typeof drizzle<typeof schema>>, tenantIds: SeedContext["tenantIds"], userIds: Record<string, string>) {
  const now = Date.now();
  for (const inv of DEMO_INVITATIONS) {
    const sent = new Date(now - inv.sentDaysAgo * 86_400_000);
    const expiresAt = new Date(sent.getTime() + 7 * 86_400_000);
    const values = { tenantId: tenantIds[inv.tenant], email: inv.email, name: inv.name, role: inv.role, invitedBy: userIds[inv.inviter] ?? null, tokenHash: createHash("sha256").update(`seed-invite:${inv.tenant}:${inv.email}`).digest("hex"), expiresAt, status: "pending" as const, lastSentAt: sent, createdAt: sent };
    await db.insert(schema.invitations).values(values).onConflictDoUpdate({ target: schema.invitations.tokenHash, set: { expiresAt, lastSentAt: sent, status: "pending" } });
  }
}

/** Demo branding: Northwind keeps the product blue, Harbor Home shows a brand colour of its own. */
export const DEMO_BRAND_COLORS: Record<keyof typeof DEMO_TENANTS, string | null> = { northwind: null, harbor: "#3d5a40" };

/** The first name, as a person would fill "preferred name"; the platform admin has none. */
function demoPreferredName(u: (typeof DEMO_USERS)[number]): string | null {
  return "superAdmin" in u ? null : u.name.split(" ")[0]!;
}

/** Demo billing: Northwind active on Growth with COD add-on and a paid history; Harbor Home past due on Starter. */
async function seedBilling(db: ReturnType<typeof drizzle<typeof schema>>, tenantIds: SeedContext["tenantIds"]) {
  const now = new Date();
  const month = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const plans: Record<keyof typeof DEMO_TENANTS, { planKey: string; monthly: number; setup: number; currency: string; months: number; lastPaid: boolean }> = {
    northwind: { planKey: "growth", monthly: PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor! + MODULES["addon.customer_campaigns"].monthlyPriceMinor!, setup: PLANS.growth.setupFeeMinor, currency: PLATFORM_CURRENCY, months: 6, lastPaid: true },
    harbor: { planKey: "starter", monthly: PLANS.starter.monthlyPriceMinor + MODULES["addon.subscriptions"].monthlyPriceMinor!, setup: PLANS.starter.setupFeeMinor, currency: PLATFORM_CURRENCY, months: 3, lastPaid: false },
  };
  for (const key of Object.keys(plans) as (keyof typeof DEMO_TENANTS)[]) {
    const tenantId = tenantIds[key];
    const p = plans[key];
    // demo billing is rewritten on every seed so the console always shows the same starting point
    await db.delete(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    const start = month(p.months);
    // lifecycle (#48): an unpaid last invoice makes the store past due once its due date has passed
    const lastDue = new Date(month(0).getTime() + 7 * 864e5);
    const pastDue = !p.lastPaid && lastDue < now;
    await seedDemoLifecycle(db, [{ tenantId, planKey: p.planKey as "growth", addons: [...DEMO_TENANTS[key].addons], createdAt: start, status: pastDue ? "past_due" : "active", statusSince: pastDue ? lastDue : null }], now);
    const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey: p.planKey, status: pastDue ? "past_due" : "active", provider: "mock", externalCustomerId: `mock_cus_${tenantId.slice(0, 8)}`, currency: p.currency, currentPeriodStart: month(0), currentPeriodEnd: month(-1), trialEndsAt: new Date(start.getTime() + 14 * 864e5), setupFeeMinor: p.setup }).returning({ id: schema.subscriptions.id });
    const rows = [{ number: `INV-${start.getUTCFullYear()}-0001`, kind: "setup", amountMinor: p.setup, lines: [{ kind: "setup", key: p.planKey, amountMinor: p.setup }], issuedAt: start, dueAt: new Date(start.getTime() + 7 * 864e5), paidAt: new Date(start.getTime() + 3 * 864e5) as Date | null, periodStart: null as Date | null, periodEnd: null as Date | null }];
    for (let m = p.months - 1; m >= 0; m--) {
      const issued = month(m);
      const isLast = m === 0;
      rows.push({ number: `INV-${issued.getUTCFullYear()}-${String(rows.length + 1).padStart(4, "0")}`, kind: "subscription", amountMinor: p.monthly, lines: p.planKey === "growth" ? [{ kind: "plan", key: "growth", amountMinor: PLANS.growth.monthlyPriceMinor }, { kind: "addon", key: "addon.cod", amountMinor: MODULES["addon.cod"].monthlyPriceMinor! }] : [{ kind: "plan", key: "starter", amountMinor: PLANS.starter.monthlyPriceMinor }, { kind: "addon", key: "addon.subscriptions", amountMinor: MODULES["addon.subscriptions"].monthlyPriceMinor! }], issuedAt: issued, dueAt: new Date(issued.getTime() + 7 * 864e5), paidAt: isLast && !p.lastPaid ? null : new Date(issued.getTime() + 2 * 864e5), periodStart: issued, periodEnd: month(m - 1) });
    }
    for (const r of rows) await db.insert(schema.invoices).values({ tenantId, subscriptionId: sub!.id, number: r.number, provider: "mock", externalId: `mock_in_${r.number}`, status: r.paidAt ? "paid" : "open", kind: r.kind, amountMinor: r.amountMinor, currency: p.currency, lines: r.lines, periodStart: r.periodStart, periodEnd: r.periodEnd, issuedAt: r.issuedAt, dueAt: r.dueAt, paidAt: r.paidAt }).onConflictDoNothing();
  }
}

export interface SeedOptions {
  /** 1 = full demo volume (~15k + ~6k orders). Tests use a small fraction. */
  scale?: number;
  now?: Date;
  log?: (msg: string) => void;
}

export function tenantSeedConfigs(ctx: SeedContext, opts: SeedOptions = {}): TenantSeedConfig[] {
  const scale = opts.scale ?? 1;
  const now = opts.now ?? new Date();
  const members = (key: keyof typeof DEMO_TENANTS) =>
    DEMO_USERS.filter((u) => u.memberships.some((m) => m.tenant === key)).map((u) => ctx.userIds[u.email]!).filter(Boolean);
  return [
    {
      key: "northwind", tenantId: ctx.tenantIds.northwind, addons: DEMO_TENANTS.northwind.addons, seed: 20261001, currency: "EUR", country: "IT", timezone: "Europe/Rome", locale: "it", orderNumberPrefix: "NW-",
      orderCount: Math.max(40, Math.round(15000 * scale)), productCount: Math.max(6, Math.round(120 * Math.min(1, scale * 4))), locationNames: ["Magazzino Milano", "Magazzino Bologna", "3PL Berlin"],
      supplierNames: ["Tessitura Lombarda", "Maglificio Dolomiti", "Confezioni Adriatica", "Pellami Toscani"], metaCampaigns: Math.max(3, Math.round(25 * Math.min(1, scale * 4))), googleCampaigns: Math.max(1, Math.round(6 * Math.min(1, scale * 4))),
      codShare: 0.1, returnRate: 0.12, cancelRate: 0.06, userIds: members("northwind"), now,
    },
    {
      key: "harbor", tenantId: ctx.tenantIds.harbor, addons: DEMO_TENANTS.harbor.addons, seed: 20261002, currency: "USD", country: "US", timezone: "America/New_York", locale: "en", orderNumberPrefix: "HH-",
      orderCount: Math.max(40, Math.round(6000 * scale)), productCount: Math.max(6, Math.round(60 * Math.min(1, scale * 4))), locationNames: ["Newark Warehouse", "LA Showroom"],
      supplierNames: ["Harbor Workshop", "Coastal Textiles"], metaCampaigns: Math.max(2, Math.round(8 * Math.min(1, scale * 4))), googleCampaigns: Math.max(1, Math.round(3 * Math.min(1, scale * 4))),
      codShare: 0, returnRate: 0.07, cancelRate: 0.045, userIds: members("harbor"), now,
    },
  ];
}

/** Platform + full domain dataset for both demo tenants. Idempotent: domain rows are regenerated. */
export async function seedDomain(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, opts: SeedOptions = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  for (const cfg of tenantSeedConfigs(ctx, opts)) {
    // Wipe previous domain rows of this tenant (cascade from the parent tables).
    for (const table of [schema.casePacks, schema.backorders, schema.orders, schema.supplierPayments, schema.purchaseOrders, schema.suppliers, schema.segments, schema.customers, schema.inventoryMovements, schema.products, schema.locations, schema.campaigns, schema.discounts, schema.discountPools, schema.stateRules, schema.shipmentStatusMappings, schema.costSettings, schema.periodCosts, schema.touchpoints, schema.alertEvents, schema.alertRules, schema.customMetrics, schema.metricTargets, schema.dashboards, schema.returnReasons, schema.notifications, schema.integrations, schema.integrationHealth, schema.webhookEvents, schema.syncRuns, schema.platformWrites, schema.inventoryDrift, schema.auditLogs, schema.codOperatorCapacity, schema.codCapacityExceptions, schema.codSettings, schema.codRecipientProfiles, schema.codCarrierOutcomes, schema.demandEvents, schema.returnPortalSettings, schema.publicRateLimits, schema.returnPolicies, schema.retentionCampaigns, schema.customerPredictionModels, schema.segmentDestinations, schema.pixelSettings, schema.pixelEvents, schema.pixelIdentities, schema.conversionSettings, schema.surveySettings, schema.assistantThreads, schema.subscriptionContracts, schema.subscriptionCancellationReasons]) {
      await db.delete(table).where(eq(table.tenantId, cfg.tenantId));
    }
    const started = Date.now();
    const ds = generateTenantDataset(cfg);
    const genMs = Date.now() - started;
    const step = async (name: string, fn: () => Promise<unknown>) => { const t0 = Date.now(); await fn(); if (process.env.SEED_TIMING) log(`[db:seed]   ${name} ${Date.now() - t0}ms`); };
    let counts: Record<string, number> = {};
    await step("write", async () => { counts = await writeDataset(db, ds); });
    await step("media", () => ensureDemoProductCatalog(db, cfg.tenantId, cfg.key as DemoCatalogKey, opts.now ?? new Date()));
    if (cfg.key === "northwind") await step("cod", () => seedCod(db, ctx, cfg.tenantId, opts.now ?? new Date()));
    await step("analytics", () => seedAnalyticsExtras(db, ctx, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("planning", () => seedPlanningExtras(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("returns", () => seedReturnsExtras(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("fulfilment", () => seedFulfilment(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("campaigns", () => seedRetentionCampaigns(db, ctx, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("predictions", () => seedPredictions(db, cfg.tenantId, opts.now ?? new Date()));
    await step("destinations", () => seedDestinations(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("tracking", () => seedTracking(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("survey", () => seedSurvey(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("assistant", () => seedAssistant(db, ctx, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("catalog", () => seedCatalogDuplicate(db, cfg.tenantId));
    await step("collab", () => seedCollab(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, cfg.locale, opts.now ?? new Date()));
    await step("email", () => seedEmailLog(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, cfg.locale, opts.now ?? new Date()));
    await step("lists", () => seedLists(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("payments", () => seedPayments(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("inventory-control", () => seedInventoryControl(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("dashboards", () => seedDashboards(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("mcp", () => seedMcp(db, ctx.userIds, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("ads", () => seedAdsDepth(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date()));
    await step("tiktok", () => seedTiktok(db, DEMO_TENANTS[cfg.key as keyof typeof DEMO_TENANTS].planKey, cfg.tenantId, opts.now ?? new Date()));
    await step("subscriptions", () => seedSubscriptions(db, { tenantId: cfg.tenantId, addons: cfg.addons, now: opts.now ?? new Date(), scale: opts.scale ?? 1, careUserId: ctx.userIds["care@harborhome.demo"] ?? null, ownerUserId: ctx.userIds["owner@harborhome.demo"] ?? null }));
    await step("reliability", () => seedReliability(db, cfg.key as "northwind" | "harbor", cfg.tenantId, ctx.userIds[cfg.key === "northwind" ? "owner@northwind.demo" : "owner@harborhome.demo"] ?? null, opts.now ?? new Date()));
    log(`[db:seed] ${cfg.key}: generated in ${genMs}ms, wrote ${Object.values(counts).reduce((a, b) => a + b, 0)} rows in ${Date.now() - started - genMs}ms (orders ${counts.orders}, lines ${counts.orderLines}, events ${counts.orderEvents})`);
  }
}

/**
 * Customer campaigns (add-on `addon.customer_campaigns`, active on Northwind only) measured against
 * the segment's control group. Northwind's win-back went
 * out 35 days ago with a 10% code; about 12% of the treated customers answered with an order that
 * reuses one of their past baskets, so the results page shows a real, significant uplift. An
 * earlier newsletter was sent from another tool (manual channel) and had no effect, which the
 * control group shows too. A draft on a segment without control group shows the warning.
 */
async function seedRetentionCampaigns(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const it = key === "northwind";
  if (!DEMO_TENANTS[key].addons.includes("addon.customer_campaigns")) return;
  const sender = ctx.userIds[it ? "marketing@northwind.demo" : "marketing@harborhome.demo"] ?? null;
  const segmentId = async (name: string) => (await db.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, tenantId), eq(schema.segments.name, name))).limit(1))[0]?.id ?? null;
  const send = async (name: string, segment: string, channel: string, message: string, code: string | null, cost: number, daysAgo: number) => {
    const segId = await segmentId(segment);
    if (!segId) return null;
    const sentAt = new Date(now.getTime() - daysAgo * 864e5);
    const [c] = await db.insert(schema.retentionCampaigns).values({ tenantId, name, segmentId: segId, channel, message, discountCode: code, costPerMessageMinor: cost, attributionDays: 14, status: "sent", sentAt, sentBy: sender, createdBy: sender, createdAt: sentAt, updatedAt: sentAt }).returning({ id: schema.retentionCampaigns.id });
    await db.execute(sql`
      insert into retention_exposures (tenant_id, campaign_id, customer_id, group_name, status, message_id, exposed_at)
      select ${tenantId}, ${c!.id}, m.customer_id, m.group_name,
        case when m.group_name = 'holdout' then 'held_out' when ${channel} = 'email' and c.email is null then 'skipped' else 'sent' end,
        case when m.group_name = 'treated' and ${channel} <> 'manual' then 'mock-msg-seed-' || left(m.customer_id::text, 8) end, ${sentAt}
      from segment_memberships m join customers c on c.id = m.customer_id
      where m.segment_id = ${segId} and c.accepts_marketing`);
    const [counts] = (await db.execute<{ t: number; h: number; d: number; s: number }>(sql`select count(*) filter (where group_name = 'treated')::int as t, count(*) filter (where group_name = 'holdout')::int as h, count(*) filter (where status = 'sent')::int as d, count(*) filter (where status = 'skipped')::int as s from retention_exposures where campaign_id = ${c!.id}`)).rows;
    await db.update(schema.retentionCampaigns).set({ treatedCount: counts!.t, holdoutCount: counts!.h, deliveredCount: counts!.d, skippedCount: counts!.s }).where(eq(schema.retentionCampaigns.id, c!.id));
    return { id: c!.id, sentAt };
  };
  if (it) {
    const sent = await send("Win-back clienti ricorrenti -10%", "Clienti ricorrenti", "email", "Ciao {first_name}, ci manchi! Per te il 10% di sconto con il codice {code}.", "BACK10", 2, 35);
    if (sent) {
      // response orders, reusing each responder's last basket. The demo promises a measurable effect, so
      // the count is set structurally, not by chance (a reseed at another hour once left p = 0.09):
      // responders are treated customers who did not already buy in the window, enough of them for the
      // treated conversion to beat the control group's by RESPONSE_UPLIFT.
      const RESPONSE_UPLIFT = 0.08;
      const [tenant] = await db.select({ prefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      // copy every stored column (generated ones such as the search blob are recomputed)
      const cols = async (table: string) => (await db.execute<{ c: string }>(sql`select quote_ident(column_name) as c from information_schema.columns where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' order by ordinal_position`)).rows.map((r) => r.c).join(", ");
      const orderCols = sql.raw(await cols("orders"));
      const lineCols = sql.raw(await cols("order_lines"));
      await db.execute(sql`
        with window_buyers as (
          select e.customer_id, e.group_name, exists (
            select 1 from orders o where o.customer_id = e.customer_id and o.placed_at > e.exposed_at and o.placed_at <= e.exposed_at + interval '14 days' and o.status not in ('cancelled', 'returned')
          ) as bought
          from retention_exposures e where e.campaign_id = ${sent.id}
        ),
        needed as (
          -- at least a few responders even when chance already favours the treated group (small test seeds)
          select greatest(ceil(0.05 * count(*) filter (where group_name = 'treated')),
            ceil((coalesce(avg(bought::int) filter (where group_name = 'holdout'), 0) + ${RESPONSE_UPLIFT}) * count(*) filter (where group_name = 'treated'))
            - count(*) filter (where group_name = 'treated' and bought))::int as n
          from window_buyers
        ),
        responders as (
          select e.customer_id, e.exposed_at from retention_exposures e join window_buyers w on w.customer_id = e.customer_id
          where e.campaign_id = ${sent.id} and e.group_name = 'treated' and not w.bought
            and exists (select 1 from orders o where o.customer_id = e.customer_id and o.placed_at < e.exposed_at and o.status in ('delivered', 'shipped'))
          order by abs(hashtext(e.customer_id::text || 'resp')), e.customer_id
          limit (select n from needed)
        ),
        picks as (
          select distinct on (r.customer_id) o.id as old_id, gen_random_uuid() as new_id,
            r.exposed_at + make_interval(days => 1 + abs(hashtext(r.customer_id::text || 'day')) % 12, hours => abs(hashtext(r.customer_id::text)) % 10) as at
          from responders r join orders o on o.customer_id = r.customer_id and o.placed_at < r.exposed_at and o.status in ('delivered', 'shipped')
          order by r.customer_id, o.placed_at desc
        ),
        numbered as (select p.*, (select max(order_number) from orders where tenant_id = ${tenantId}) + row_number() over (order by p.at) as num from picks p),
        ins as (
          insert into orders (${orderCols}) select ${orderCols} from (select (jsonb_populate_record(null::orders, to_jsonb(o) || jsonb_build_object(
            'id', n.new_id, 'external_id', 'crm-' || n.new_id, 'order_number', n.num, 'name', '#' || ${tenant!.prefix} || n.num,
            'status', 'delivered', 'status_changed_at', n.at + interval '4 days', 'cancelled_at', null, 'cancel_reason', null, 'refunded_minor', 0, 'returned_fraction_bps', 0,
            'placed_at', n.at, 'closed_at', n.at + interval '4 days', 'platform_updated_at', n.at + interval '4 days', 'created_at', n.at, 'updated_at', n.at + interval '4 days'))).*
            from orders o join numbered n on n.old_id = o.id) r
          returning id, total_minor
        ),
        lines as (
          insert into order_lines (${lineCols}) select ${lineCols} from (select (jsonb_populate_record(null::order_lines, to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'order_id', n.new_id, 'external_id', 'crm-' || gen_random_uuid(), 'created_at', n.at))).*
            from order_lines l join numbered n on n.old_id = l.order_id) r
          returning id
        )
        insert into order_discounts (tenant_id, order_id, code, type, amount_minor)
        select ${tenantId}, ins.id, 'BACK10', 'percentage', round(ins.total_minor * 0.1)::int from ins`);
    }
    const segId = await segmentId("Nuovi con consenso marketing");
    if (segId) await db.insert(schema.retentionCampaigns).values({ tenantId, name: "Benvenuto, secondo acquisto", segmentId: segId, channel: "email", message: "Ciao {first_name}, grazie per il primo ordine! Il codice {code} vale per il secondo.", discountCode: "SECONDO15", costPerMessageMinor: 2, attributionDays: 21, status: "draft", createdBy: sender });
    // an earlier newsletter sent from the email tool, with no measurable effect: the control group shows that too
    await send("Newsletter di primavera (inviata dallo strumento email)", "Clienti ricorrenti", "manual", "", null, 0, 75);
    await seedCampaignWorkflow(db, ctx, tenantId, now, sender);
  }
}

/**
 * Approval, scheduling and sequences (#34) on Northwind: an SMS reactivation waiting for the
 * owner's approval (test already sent), an approved newsletter scheduled for tomorrow at 10:00, and
 * an always-on win-back sequence active for 30 days on a live "inactive 120–150 days" segment with
 * a permanent 15% control group, whose entrants were messaged as they arrived.
 */
async function seedCampaignWorkflow(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, tenantId: string, now: Date, sender: string | null) {
  const owner = ctx.userIds["owner@northwind.demo"] ?? null;
  const admin = ctx.userIds["admin@northwind.demo"] ?? null;
  const segmentId = async (name: string) => (await db.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, tenantId), eq(schema.segments.name, name))).limit(1))[0]?.id ?? null;
  const day = 864e5;
  const highValue = await segmentId("Alto valore, inattivi 90gg");
  if (highValue) {
    const [c] = await db.insert(schema.retentionCampaigns).values({ tenantId, name: "Riattivazione alto valore -15%", segmentId: highValue, channel: "sms", message: "{first_name}, ti aspettiamo: -15% con il codice {code} fino a domenica.", discountCode: "TORNA15", costPerMessageMinor: 6, attributionDays: 14, status: "pending_approval", submittedAt: new Date(now.getTime() - 20 * 3600e3), submittedBy: sender, testSentAt: new Date(now.getTime() - 21 * 3600e3), testSentBy: sender, createdBy: sender, createdAt: new Date(now.getTime() - 26 * 3600e3) }).returning({ id: schema.retentionCampaigns.id });
    const recipients = [owner, admin].filter((x): x is string => Boolean(x));
    if (recipients.length) await db.insert(schema.notifications).values(recipients.map((userId) => ({ tenantId, userId, type: "customer_campaign", title: "Riattivazione alto valore -15%", body: "approval_requested", link: `/segments/campaigns/${c!.id}`, metadata: { event: "approval_requested", campaignId: c!.id }, createdAt: new Date(now.getTime() - 20 * 3600e3) })));
  }
  const repeat = await segmentId("Clienti ricorrenti");
  if (repeat) {
    // tomorrow at 10:00 in Rome (09:00 UTC in winter, 08:00 in summer: close enough for a demo, the window still applies)
    const tomorrow = new Date(now.getTime() + day);
    const at = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 8, 0));
    await db.insert(schema.retentionCampaigns).values({ tenantId, name: "Nuova collezione autunno", segmentId: repeat, channel: "email", message: "Ciao {first_name}, è arrivata la nuova collezione: la vedi per primo.", costPerMessageMinor: 1, attributionDays: 14, status: "scheduled", submittedAt: new Date(now.getTime() - 3 * day), submittedBy: sender, approvedAt: new Date(now.getTime() - 2 * day), approvedBy: owner, scheduledAt: at, scheduledBy: sender, testSentAt: new Date(now.getTime() - 3 * day), testSentBy: sender, createdBy: sender, createdAt: new Date(now.getTime() - 4 * day) });
  }
  // the sequence's segment: inactive 120–150 days, live, 15% permanent control group
  const rules = { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 1 }, { field: "days_since_last_order", op: "between", value: [120, 150] }] };
  const [seg] = await db.insert(schema.segments).values({ tenantId, name: "Inattivi da 120 giorni", description: "Ingresso nella sequenza di win-back automatica", rules, holdoutPercentage: 15, liveUpdates: true, lastEvaluatedAt: now, createdBy: sender }).returning({ id: schema.segments.id, salt: schema.segments.holdoutSalt });
  const members = (await db.execute<{ customer_id: string; last_at: string; accepts_marketing: boolean; phone: string | null }>(sql`
    select o.customer_id, max(o.placed_at) as last_at, bool_or(c.accepts_marketing) as accepts_marketing, max(c.phone_e164) as phone
    from orders o join customers c on c.id = o.customer_id
    where o.tenant_id = ${tenantId} and o.customer_id is not null and o.replaced_by_order_id is null and o.status in ${SALE_STATUSES as readonly string[]}
    group by o.customer_id
    having floor(extract(epoch from (${now}::timestamptz - max(o.placed_at))) / 86400) between 120 and 150
    order by o.customer_id`)).rows;
  const groups = members.map((m) => ({ ...m, group: assignHoldout(seg!.id, m.customer_id, 15, seg!.salt) }));
  for (let i = 0; i < groups.length; i += 1000) await db.insert(schema.segmentMemberships).values(groups.slice(i, i + 1000).map((m) => ({ tenantId, segmentId: seg!.id, customerId: m.customer_id, groupName: m.group, evaluatedAt: now })));
  await db.update(schema.segments).set({ lastCount: groups.length }).where(eq(schema.segments.id, seg!.id));
  const activatedAt = new Date(now.getTime() - 30 * day);
  const [sq] = await db.insert(schema.retentionCampaigns).values({ tenantId, name: "Win-back automatico a 120 giorni", segmentId: seg!.id, channel: "whatsapp", kind: "sequence", message: "Ciao {first_name}, è un po' che non ci vediamo: per te il 10% con {code}.", discountCode: "CIAO10", costPerMessageMinor: 4, attributionDays: 21, status: "active", submittedAt: new Date(activatedAt.getTime() - 2 * day), submittedBy: sender, approvedAt: new Date(activatedAt.getTime() - day), approvedBy: owner, sentAt: activatedAt, sentBy: sender, createdBy: sender, createdAt: new Date(activatedAt.getTime() - 3 * day) }).returning({ id: schema.retentionCampaigns.id });
  // entrants: the day they reached 120 days without an order, with consent; no phone → skipped
  const rows = groups.filter((m) => m.accepts_marketing).map((m) => {
    const exposedAt = new Date(Math.max(activatedAt.getTime(), new Date(m.last_at).getTime() + 120 * day) + 9 * 3600e3);
    const treated = m.group === "treated";
    const status = !treated ? "held_out" : m.phone ? "sent" : "skipped";
    return { tenantId, campaignId: sq!.id, customerId: m.customer_id, groupName: m.group, status, exposedAt: exposedAt.getTime() > now.getTime() ? now : exposedAt, sentAt: status === "sent" ? (exposedAt.getTime() > now.getTime() ? now : exposedAt) : null, messageId: status === "sent" ? `mock-msg-seed-${m.customer_id.slice(0, 8)}` : null, idempotencyKey: treated && m.phone ? campaignMessageKey(sq!.id, m.customer_id, "whatsapp") : null, attempts: status === "sent" ? 1 : 0 };
  });
  for (let i = 0; i < rows.length; i += 1000) await db.insert(schema.retentionExposures).values(rows.slice(i, i + 1000));
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  await db.update(schema.retentionCampaigns).set({ treatedCount: count((r) => r.groupName === "treated"), holdoutCount: count((r) => r.groupName === "holdout"), deliveredCount: count((r) => r.status === "sent"), skippedCount: count((r) => r.status === "skipped"), exclusionCounts: { no_consent: groups.length - rows.length } }).where(eq(schema.retentionCampaigns.id, sq!.id));
}

/**
 * Post-purchase survey answers on ~30% of the last 120 days' orders. A little over half agree with
 * the order's click channel; the rest name channels clicks never see (word of mouth, influencers,
 * podcasts), which is what the survey is for. The secret is fixed so demo links are reproducible.
 */
async function seedSurvey(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  await db.insert(schema.surveySettings).values(demoSurveySettings(key, tenantId));
  const locale = DEMO_TENANTS[key].defaultLocale;
  await db.execute(sql`
    with picked as (
      select o.id, o.customer_id, o.placed_at, a.channel as click, abs(hashtext(o.id::text || 'ans')) % 100 as h
      from orders o left join order_attribution a on a.order_id = o.id
      where o.tenant_id = ${tenantId} and o.placed_at >= ${new Date(now.getTime() - 120 * 864e5)} and o.placed_at < ${new Date(now.getTime() - 864e5)}
        and o.status in ('confirmed','fulfilling','shipped','delivered','returned_partial') and abs(hashtext(o.id::text || 'sv')) % 100 < 30
    ),
    answered as (
      select id, customer_id, placed_at,
        case
          when h < 55 then case click when 'paid_social' then 'social_ad' when 'organic_search' then 'search' when 'paid_search' then 'search' when 'email' then 'email' when 'social' then 'social_post' else 'friend' end
          when h < 72 then 'friend' when h < 82 then 'influencer' when h < 90 then 'podcast' when h < 96 then 'social_post' else 'search'
        end as answer
      from picked
    )
    insert into survey_responses (tenant_id, order_id, customer_id, answer_key, channel, locale, source, responded_at)
    select ${tenantId}, id, customer_id, answer,
      case answer when 'search' then 'organic_search' when 'social_ad' then 'paid_social' when 'social_post' then 'social' when 'friend' then 'word_of_mouth' when 'influencer' then 'influencer' when 'podcast' then 'podcast' when 'email' then 'email' end,
      ${locale}, 'seed', placed_at + interval '26 hours'
    from answered`);
}

/**
 * Pixel traffic for the last 14 days and the server-side conversion log, as the live pipeline
 * would leave them. About 60% of recent orders have a browser journey: one or two earlier
 * sessions (stitched to the order as pixel touchpoints) plus the converting session's events;
 * twice as many sessions never convert. The converting session itself is represented by the
 * order's landing touch the seed already writes, so it is not added twice.
 */
async function seedTracking(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const rng = createRng(key === "northwind" ? 7101 : 7102);
  const DAY = 864e5;
  await db.insert(schema.pixelSettings).values(demoPixelSettings(key, tenantId));
  const orders = (await db.execute<{ id: string; external_id: string | null; customer_id: string | null; placed_at: string | Date; email: string | null }>(sql`
    select id, external_id, customer_id, placed_at, email_normalized as email from orders
    where tenant_id = ${tenantId} and placed_at >= ${new Date(now.getTime() - 14 * DAY)} and status in ('confirmed','fulfilling','shipped','delivered','returned_partial') order by placed_at`)).rows;
  const channels: [string, string | null, string | null, boolean][] = [["organic_search", "google", "organic", false], ["paid_social", "facebook", "paid", true], ["email", "newsletter", "email", false], ["social", "instagram", "social", false], ["direct", null, null, false], ["paid_search", "google", "cpc", true]];
  const events: (typeof schema.pixelEvents.$inferInsert)[] = [];
  const touches: (typeof schema.touchpoints.$inferInsert)[] = [];
  const identities: (typeof schema.pixelIdentities.$inferInsert)[] = [];
  const host = key === "northwind" ? "https://northwind-apparel.example" : "https://harbor-home.example";
  const id = (p: string) => `${p}${rng.uuid().replace(/-/g, "").slice(0, 16)}`;
  const session = (anon: string, at: Date, ch: [string, string | null, string | null, boolean], orderId: string | null, customerId: string | null, extra: string[]) => {
    const sid = id("s");
    const url = ch[1] ? `${host}/?utm_source=${ch[1]}&utm_medium=${ch[2]}` : `${host}/`;
    touches.push({ tenantId, orderId, customerId, anonymousId: anon, sessionId: sid, occurredAt: at, channel: ch[0], source: ch[1], medium: ch[2], paid: ch[3], landingUrl: url, origin: "pixel" });
    ["page_view", ...extra].forEach((e, i) => events.push({ tenantId, anonymousId: anon, sessionId: sid, event: e, url: i ? `${host}/products/item-${rng.int(1, 60)}` : url, referrer: null, props: {}, occurredAt: new Date(at.getTime() + i * 45_000), receivedAt: new Date(at.getTime() + i * 45_000) }));
    return sid;
  };
  let converted = 0;
  for (const o of orders) {
    if (!rng.chance(0.6)) continue;
    converted++;
    const placed = new Date(o.placed_at);
    const anon = id("a");
    for (let k = 0, n = rng.int(1, 2); k < n; k++) session(anon, new Date(placed.getTime() - rng.int(1, 10) * DAY - rng.int(0, 600) * 60_000), rng.pick(channels), o.id, o.customer_id, ["product_view"]);
    const sid = id("s");
    for (const [e, min] of [["page_view", -20], ["add_to_cart", -10], ["checkout_started", -5], ["checkout_completed", 1]] as const) {
      const at = new Date(placed.getTime() + min * 60_000);
      const done = e === "checkout_completed";
      events.push({ tenantId, anonymousId: anon, sessionId: sid, event: e, url: done ? `${host}/checkouts/thank-you` : `${host}/cart`, referrer: null, props: done ? { orderId: o.external_id, fbp: `fb.1.${placed.getTime()}.${rng.int(1e8, 9e8)}` } : {}, clientIp: done ? `198.51.100.${rng.int(1, 254)}` : null, userAgent: done ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" : null, occurredAt: at, receivedAt: at });
    }
    identities.push({ tenantId, anonymousId: anon, orderExternalId: o.external_id, customerId: o.customer_id, linkedAt: placed });
  }
  for (let i = 0; i < converted * 2; i++) session(id("a"), new Date(now.getTime() - rng.int(0, 14 * 24 * 60) * 60_000), rng.pick(channels), null, null, rng.chance(0.5) ? ["product_view"] : []);
  for (let i = 0; i < events.length; i += 2000) await db.insert(schema.pixelEvents).values(events.slice(i, i + 2000));
  for (let i = 0; i < touches.length; i += 2000) await db.insert(schema.touchpoints).values(touches.slice(i, i + 2000));
  for (let i = 0; i < identities.length; i += 2000) await db.insert(schema.pixelIdentities).values(identities.slice(i, i + 2000));
  await db.execute(sql`update pixel_identities i set email_sha256 = encode(sha256(convert_to(o.email_normalized, 'UTF8')), 'hex') from orders o where i.tenant_id = ${tenantId} and o.tenant_id = ${tenantId} and o.external_id = i.order_external_id and o.email_normalized is not null`);

  // server-side conversions: both platforms on, consent required; the last week's log
  await db.insert(schema.conversionSettings).values(demoConversionSettings(tenantId));
  for (const provider of ["meta", "google"]) {
    await db.execute(sql`
      insert into conversion_events (tenant_id, provider, order_id, event_id, status, reason, attempts, last_error, sent_at, created_at)
      select ${tenantId}, ${provider}, o.id, 'order-' || coalesce(o.external_id, o.id::text),
        case when not coalesce(c.accepts_marketing, false) then 'skipped' when abs(hashtext(o.id::text || ${provider})) % 40 = 0 then 'failed' else 'sent' end,
        case when not coalesce(c.accepts_marketing, false) then 'no_consent' end,
        case when not coalesce(c.accepts_marketing, false) then 0 when abs(hashtext(o.id::text || ${provider})) % 40 = 0 then 6 else 1 end,
        case when coalesce(c.accepts_marketing, false) and abs(hashtext(o.id::text || ${provider})) % 40 = 0 then 'rate_limited: Mock: rate limit exceeded' end,
        case when coalesce(c.accepts_marketing, false) and abs(hashtext(o.id::text || ${provider})) % 40 <> 0 then o.placed_at + interval '6 minutes' end,
        o.placed_at + interval '5 minutes'
      from orders o left join customers c on c.id = o.customer_id
      where o.tenant_id = ${tenantId} and o.placed_at >= ${new Date(now.getTime() - 7 * DAY)} and o.status in ('confirmed','fulfilling','shipped','delivered','returned_partial')`);
  }
}

/**
 * The repeat-customer segment is live and pushed to one destination per store (mock adapters):
 * Northwind to a Meta Custom Audience without its control group (it has the customer-campaigns
 * add-on), Harbor to its email tool with every consenting member.
 */
async function seedDestinations(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const it = key === "northwind";
  const [segment] = await db.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, tenantId), eq(schema.segments.name, it ? "Clienti ricorrenti" : "Repeat customers"))).limit(1);
  if (!segment) return;
  await db.update(schema.segments).set({ liveUpdates: true }).where(eq(schema.segments.id, segment.id));
  const provider = it ? "meta_custom_audience" : "email_tool";
  const excludeHoldout = DEMO_TENANTS[key].addons.includes("addon.customer_campaigns");
  const [d] = await db.insert(schema.segmentDestinations).values({ tenantId, segmentId: segment.id, provider, audienceName: it ? "Hullwise · Clienti ricorrenti" : "Hullwise · Repeat customers", externalAudienceId: "mock-aud-1", autoSync: true, status: "ok", lastSyncAt: new Date(now.getTime() - 2 * 36e5), createdAt: new Date(now.getTime() - 20 * 864e5) }).returning({ id: schema.segmentDestinations.id });
  const matchable = provider === "email_tool" ? sql`c.email is not null` : sql`(c.email is not null or c.phone_e164 is not null)`;
  await db.execute(sql`
    insert into segment_destination_members (tenant_id, destination_id, customer_id, synced_at)
    select ${tenantId}, ${d!.id}, m.customer_id, ${new Date(now.getTime() - 2 * 36e5)}
    from segment_memberships m join customers c on c.id = m.customer_id
    where m.segment_id = ${segment.id} and c.accepts_marketing and ${matchable} ${excludeHoldout ? sql`and m.group_name = 'treated'` : sql``}`);
  const [n] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from segment_destination_members where destination_id = ${d!.id}`)).rows;
  await db.update(schema.segmentDestinations).set({ memberCount: n!.n, lastAdded: n!.n }).where(eq(schema.segmentDestinations.id, d!.id));
}

/** Customer predictions as the nightly job would compute them (same core run as the service). */
/**
 * One past conversation with the AI assistant per store, stored as the assistant loop stores it:
 * the question, the model's tool call, the tool result and the answer with its citation. The
 * figures are the top products of the last 30 days, computed like the analytics service does, so
 * the citation agrees with the page it links to.
 */
async function seedAssistant(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const t = DEMO_TENANTS[key];
  const it = key === "northwind";
  const userId = ctx.userIds[`owner@${it ? "northwind" : "harborhome"}.demo`];
  if (!userId) return;
  const toDay = now.toISOString().slice(0, 10);
  const fromDay = new Date(now.getTime() - 29 * 864e5).toISOString().slice(0, 10);
  const from = new Date(`${fromDay}T00:00:00Z`);
  const to = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 864e5);
  const res = await db.execute<{ product_id: string; title: string; units: number; orders: number; gross: number; cogs: number; returned: number }>(sql`
    select ol.product_id, max(ol.title) as title, coalesce(sum(ol.current_quantity), 0)::int as units, count(distinct ol.order_id)::int as orders,
           coalesce(sum(ol.total_minor - ol.discount_minor), 0)::int as gross, coalesce(sum(ol.current_quantity * coalesce(ol.unit_cost_minor, 0)), 0)::int as cogs,
           coalesce((select sum(rl.quantity) from return_lines rl join return_requests rr on rr.id = rl.return_id where rl.order_line_id = any(array_agg(ol.id)) and rr.status in ('refunded','exchanged','voucher_issued')), 0)::int as returned
    from order_lines ol join orders o on o.id = ol.order_id
    where ol.tenant_id = ${tenantId} and o.placed_at >= ${from} and o.placed_at < ${to} and o.status in ('confirmed','fulfilling','shipped','delivered','returned_partial') and ol.product_id is not null
    group by ol.product_id order by gross desc`);
  const all = res.rows;
  if (!all.length) return;
  const top = all.slice(0, 5);
  const major = (m: number) => m / 100;
  const money = (m: number) => new Intl.NumberFormat(t.defaultLocale, { style: "currency", currency: t.currency }).format(major(m));
  const rate = (r: (typeof top)[number]) => (r.units ? r.returned / r.units : 0);
  const total = all.reduce((s, r) => s + r.gross, 0);
  const share = total ? top.reduce((s, r) => s + r.gross, 0) / total : 0;
  const question = it ? "Quali prodotti hanno venduto di più negli ultimi 30 giorni?" : "Which products sold the most in the last 30 days?";
  const [thread] = await db.insert(schema.assistantThreads).values({ tenantId, userId, title: question, inputTokens: 5400, outputTokens: 310, createdAt: new Date(now.getTime() - 2 * 3600e3), updatedAt: new Date(now.getTime() - 2 * 3600e3) }).returning({ id: schema.assistantThreads.id });
  const at = (min: number) => new Date(now.getTime() - 2 * 3600e3 + min * 1000);
  const input = { from: fromDay, to: toDay, sort: "revenue", limit: 5 };
  const data = { period: { from: fromDay, to: toDay }, currency: t.currency, sort: "revenue", productsWithSales: all.length, products: top.map((r) => ({ title: r.title, units: r.units, orders: r.orders, revenue: major(r.gross), grossMargin: major(r.gross - r.cogs), returnedUnits: r.returned, returnRate: Math.round(rate(r) * 1e4) / 1e4 })) };
  const best = top[0]!;
  const answer = it
    ? `Negli ultimi 30 giorni (${fromDay} – ${toDay}) il prodotto con più ricavi è «${best.title}»: ${best.units} pezzi venduti in ${best.orders} ordini, ${money(best.gross)} di ricavi e ${money(best.gross - best.cogs)} di margine lordo. I primi cinque prodotti fanno il ${Math.round(share * 100)}% dei ricavi dei ${all.length} prodotti venduti nel periodo.\n\nPrima di spingerli in pubblicità, controlla lo stock: chiedimi pure quali varianti sono da riordinare.`
    : `In the last 30 days (${fromDay} – ${toDay}) the product with the most revenue was "${best.title}": ${best.units} units in ${best.orders} orders, ${money(best.gross)} of revenue and ${money(best.gross - best.cogs)} of gross margin. The top five products make ${Math.round(share * 100)}% of the revenue of the ${all.length} products sold in the period.\n\nBefore pushing them in ads, check their stock: ask me which variants need reordering.`;
  const citation = {
    tool: "get_top_products",
    period: { from: fromDay, to: toDay },
    filters: { sort: "revenue" },
    figures: [{ key: "products_with_sales", value: all.length, format: "number" }],
    rows: top.map((r) => ({ label: r.title, href: `/t/${t.slug}/products/${r.product_id}`, figures: [{ key: "units", value: r.units, format: "number" }, { key: "revenue", value: r.gross, format: "money" }, { key: "gross_margin", value: r.gross - r.cogs, format: "money" }, { key: "return_rate", value: rate(r), format: "percent" }] })),
    href: `/t/${t.slug}/analytics?tab=products&from=${fromDay}&to=${toDay}`,
  };
  await db.insert(schema.assistantMessages).values([
    { tenantId, threadId: thread!.id, seq: 1, role: "user", content: [{ type: "text", text: question }], createdAt: at(0) },
    { tenantId, threadId: thread!.id, seq: 2, role: "assistant", content: [{ type: "tool_use", id: "seed_tool_1", name: "get_top_products", input }], stopReason: "tool_use", provider: "mock", model: "mock-assistant", inputTokens: 2600, outputTokens: 70, createdAt: at(2) },
    { tenantId, threadId: thread!.id, seq: 3, role: "user", content: [{ type: "tool_result", toolUseId: "seed_tool_1", content: JSON.stringify(data) }], createdAt: at(3) },
    { tenantId, threadId: thread!.id, seq: 4, role: "assistant", content: [{ type: "text", text: answer }], citations: [citation], stopReason: "end_turn", provider: "mock", model: "mock-assistant", inputTokens: 2800, outputTokens: 240, createdAt: at(9) },
  ]);
}

async function seedPredictions(db: ReturnType<typeof drizzle<typeof schema>>, tenantId: string, now: Date) {
  const started = Date.now();
  const res = await db.execute<{ customer_id: string; placed_at: string | Date; total_minor: number }>(sql`select customer_id, placed_at, total_minor from orders where tenant_id = ${tenantId} and customer_id is not null and status in ${SALE_STATUSES as string[]} order by customer_id, placed_at`);
  const map = new Map<string, CustomerHistory>();
  for (const r of res.rows) {
    const h = map.get(r.customer_id) ?? { customerId: r.customer_id, orders: [] };
    h.orders.push({ at: new Date(r.placed_at), valueMinor: Number(r.total_minor) });
    map.set(r.customer_id, h);
  }
  const run = runPredictionModel([...map.values()], now);
  await db.delete(schema.customerPredictions).where(eq(schema.customerPredictions.tenantId, tenantId));
  const rows = run.predictions.map((p) => ({ tenantId, customerId: p.customerId, pAlive: p.pAlive, expectedOrders90: p.expectedOrders90, expectedOrders365: p.expectedOrders365, expectedOrderValueMinor: p.expectedOrderValueMinor, predictedValue365Minor: p.predictedValue365Minor, churnRisk: p.churnRisk, nextOrderAt: p.nextOrderAt, computedAt: now }));
  for (let i = 0; i < rows.length; i += 1000) await db.insert(schema.customerPredictions).values(rows.slice(i, i + 1000));
  const c = run.calibration;
  const model = {
    tenantId,
    status: run.model ? "ok" : "insufficient_data",
    params: run.model ? { mbg: run.model.mbg, gammaGamma: run.model.gammaGamma, meanOrderValueMinor: run.model.meanOrderValueMinor, medianDaysToSecond: run.model.medianDaysToSecond } : null,
    customers: run.model?.customers ?? map.size,
    logLikelihood: run.model?.logLikelihood ?? null,
    calibration: c ? { ...c, cutoff: c.cutoff.toISOString(), end: c.end.toISOString() } : null,
    durationMs: Date.now() - started,
    fittedAt: now,
  };
  await db.insert(schema.customerPredictionModels).values(model).onConflictDoUpdate({ target: schema.customerPredictionModels.tenantId, set: { ...model } });
}

/** Alert rules with a few past firings, two custom metrics and the owner's dashboard, per tenant. */
async function seedAnalyticsExtras(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const it = key === "northwind";
  const owner = ctx.userIds[it ? "owner@northwind.demo" : "owner@harborhome.demo"] ?? null;
  const marketing = ctx.userIds[it ? "marketing@northwind.demo" : "marketing@harborhome.demo"] ?? null;
  const recipients = [owner, marketing].filter(Boolean);
  const rules = await db
    .insert(schema.alertRules)
    .values([
      { tenantId, name: it ? "ROAS blended sotto 2 per 2 giorni" : "Blended ROAS below 2 for 2 days", metric: "mer", condition: { kind: "threshold", op: "lt", value: 2, days: 2 }, channels: ["in_app", "email"], recipients, cooldownHours: 24, createdBy: owner },
      { tenantId, name: it ? "Spesa ads anomala" : "Unusual ad spend", metric: "ad_spend", condition: { kind: "anomaly", direction: "up", sensitivity: 3, baselineDays: 28 }, channels: ["in_app", "slack"], recipients, cooldownHours: 12, createdBy: marketing ?? owner },
      { tenantId, name: it ? "Calo ordini" : "Orders drop", metric: "orders", condition: { kind: "anomaly", direction: "down", sensitivity: 3, baselineDays: 28 }, channels: ["in_app"], recipients, cooldownHours: 24, createdBy: owner },
      { tenantId, name: it ? "Varianti in rottura di stock" : "Variants running out", metric: "stockouts", condition: { kind: "threshold", op: "gt", value: 10, days: 1 }, channels: ["in_app"], recipients, cooldownHours: 24, createdBy: owner },
    ])
    .returning({ id: schema.alertRules.id, metric: schema.alertRules.metric });
  const spendRule = rules.find((r) => r.metric === "ad_spend")!;
  const merRule = rules.find((r) => r.metric === "mer")!;
  await db.insert(schema.alertEvents).values([
    { tenantId, ruleId: spendRule.id, firedAt: new Date(now.getTime() - 3 * 864e5), value: "48210", baseline: "31200", score: "4.1", reason: "anomaly_up", delivered: { in_app: "ok", slack: "mock" } },
    { tenantId, ruleId: merRule.id, firedAt: new Date(now.getTime() - 9 * 864e5), value: "1.84", baseline: "2", score: null, reason: "threshold", delivered: { in_app: "ok", email: "mock" } },
  ]);
  await db.update(schema.alertRules).set({ lastFiredAt: new Date(now.getTime() - 3 * 864e5), lastEvaluatedAt: now }).where(eq(schema.alertRules.id, spendRule.id));
  await db.insert(schema.customMetrics).values([
    { tenantId, key: "profit_per_order", label: it ? "Utile per ordine" : "Profit per order", formula: "operating_profit / orders", format: "money", createdBy: owner },
    { tenantId, key: "ads_share", label: it ? "Peso della pubblicità" : "Ads share of revenue", formula: "ad_spend / net_revenue", format: "percent", createdBy: owner },
    { tenantId, key: "contribution_after_ads", label: it ? "Contribuzione dopo ads" : "Contribution after ads", formula: "contribution - ad_spend", format: "money", createdBy: owner },
  ]);
  if (owner) await db.insert(schema.dashboards).values({ tenantId, userId: owner, name: it ? "La mia dashboard" : "My dashboard", isDefault: true, widgets: [{ metric: "net_revenue" }, { metric: "orders" }, { metric: "mer" }, { metric: "poas" }, { metric: "custom:profit_per_order" }, { metric: "custom:ads_share" }, { metric: "new_customers" }, { metric: "operating_profit" }] });
}

/** 1×1 PNG used as a stand-in for customer photos in the demo. */
const DEMO_PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/**
 * Return portal demo: configuration in the tenant's languages, translated reasons with the store
 * reason code, a share of recent returns coming from the portal (tracking, answers, photos, bank
 * details for orders paid on delivery) and the write-back state to the store, including one failure.
 */
async function seedReturnsExtras(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const it = key === "northwind";
  const rng = createRng(it ? 5151 : 5252);
  for (const [code, labels] of Object.entries(REASON_LABELS)) await db.update(schema.returnReasons).set({ labels, platformReason: REASON_PLATFORM[code] ?? null }).where(sql`${schema.returnReasons.tenantId} = ${tenantId} and ${schema.returnReasons.code} = ${code}`);
  await db.insert(schema.returnPortalSettings).values({ tenantId, config: demoPortalConfig(key) });
  await db.insert(schema.publicRateLimits).values({ tenantId, key: "lookup:ip:demo", windowStart: now, count: 1 });
  // what a return costs the store (label and handling), for the P/L; merged into existing settings
  await db.execute(sql`update tenants set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ ...DEMO_RETURN_COSTS[key], ...DEMO_CUSTOMER_EMAILS })}::jsonb where id = ${tenantId}`);
  // recent returns: a share from the portal, with the store write-back state
  const recent = await db.execute<{ id: string; status: string; resolution: string; payment_method: string; external_id: string | null; created: Date }>(sql`
    select r.id, r.status, r.resolution, o.payment_method, o.external_id, r.requested_at as created
    from return_requests r join orders o on o.id = r.order_id
    where r.tenant_id = ${tenantId} order by r.requested_at desc limit 400`);
  const canEncrypt = Boolean(process.env.APP_ENCRYPTION_KEY);
  const carriers = it ? ["Poste Italiane", "DHL", "UPS"] : ["UPS", "USPS", "FedEx"];
  let photos = 0;
  let errorDone = false;
  for (const [i, r] of recent.rows.entries()) {
    const portal = i % 3 !== 2;
    const closed = ["refunded", "exchanged", "voucher_issued"].includes(r.status);
    const patch: Partial<typeof schema.returnRequests.$inferInsert> = {};
    if (portal) {
      patch.source = "portal";
      patch.customerLocale = it ? (rng.chance(0.85) ? "it" : "en") : "en";
      if (rng.chance(0.7)) {
        patch.trackingCarrier = rng.pick(carriers);
        patch.trackingCode = `${rng.pick(["RR", "1Z", "LX"])}${rng.int(100000000, 999999999)}`;
      }
      patch.customFields = it ? { worn: rng.chance(0.4) } : { packaging: rng.pick(["yes", "yes", "partial", "no"]) };
      if (r.resolution === "exchange") patch.exchangeNote = it ? rng.pick(["Taglia M", "Taglia più grande", "Stesso modello in blu"]) : rng.pick(["Size L", "Same item in sand"]);
      if (canEncrypt && r.resolution === "refund" && (r.payment_method === "cod" || r.payment_method === "bank_transfer")) patch.bankDetailsEnc = encryptJson({ holder: it ? "Cliente Demo" : "Demo Customer", iban: "IT60X0542811101000000123456" });
    }
    if (r.external_id) {
      if (r.status === "rejected") Object.assign(patch, { platformSyncStatus: "synced", platformStatus: "declined", externalId: `mock-r-${1000 + i}`, platformSyncedAt: new Date(r.created) });
      else if (closed) Object.assign(patch, { platformSyncStatus: "synced", platformStatus: "closed", externalId: `mock-r-${1000 + i}`, platformRefundId: r.status === "refunded" ? `mock-refund-${1000 + i}` : null, platformSyncedAt: new Date(r.created) });
      else if (!errorDone && r.status === "requested") {
        Object.assign(patch, { platformSyncStatus: "error", platformError: "returnRequest: Line is not fulfilled on Shopify for 1 units" });
        errorDone = true;
      } else if (i < 6 && r.status === "requested") patch.platformSyncStatus = "pending";
      else Object.assign(patch, { platformSyncStatus: "synced", platformStatus: r.status === "requested" ? "requested" : "approved", externalId: `mock-r-${1000 + i}`, platformSyncedAt: new Date(r.created) });
    }
    // some returns were opened on the store itself and imported by webhook (issue #35)
    if (!portal && i % 6 === 5 && patch.externalId && patch.platformSyncStatus === "synced") patch.source = "platform";
    if (Object.keys(patch).length) await db.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, r.id));
    if (portal && photos < 12 && i % 4 === 0) {
      await db.insert(schema.returnEvidence).values([1, 2].map((n) => ({ tenantId, returnId: r.id, sessionNonce: `seed-${i}-${n}`, contentType: "image/png", sizeBytes: DEMO_PHOTO.length, data: DEMO_PHOTO })));
      photos += 2;
    }
  }
  // return policy: longer windows abroad and for gifts, exclusions, final sale, limit, automations
  const types = (await db.selectDistinct({ v: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, tenantId))).map((x) => x.v).filter((x): x is string => Boolean(x)).sort();
  await db.insert(schema.returnPolicies).values({ tenantId, policy: demoReturnPolicy(key, types) });
  // a few serial returners with an open return: earlier refunded returns on their other delivered orders
  const candidates = await db.execute<{ customer_id: string }>(sql`
    select o.customer_id from return_requests r join orders o on o.id = r.order_id
    where r.tenant_id = ${tenantId} and r.status in ('requested','approved') and o.customer_id is not null
      and (select count(*) from orders o2 where o2.customer_id = o.customer_id and o2.status = 'delivered' and o2.id <> o.id) >= 3
    group by 1 order by 1 limit 3`);
  const [maxNumber] = (await db.execute<{ n: number }>(sql`select coalesce(max(number), 0)::int as n from return_requests where tenant_id = ${tenantId}`)).rows;
  let nextNumber = Number(maxNumber?.n ?? 0);
  for (const c of candidates.rows) {
    const orders = await db.execute<{ id: string; placed_at: string }>(sql`
      select o.id, o.placed_at from orders o where o.customer_id = ${c.customer_id} and o.status = 'delivered'
        and not exists (select 1 from return_requests r where r.order_id = o.id) order by o.placed_at desc limit 3`);
    for (const o of orders.rows) {
      const lines = await db.select().from(schema.orderLines).where(and(eq(schema.orderLines.orderId, o.id), eq(schema.orderLines.isAncillary, false)));
      if (!lines.length) continue;
      const at = new Date(new Date(o.placed_at).getTime() + 6 * 864e5);
      const value = lines.reduce((sum, l) => sum + l.totalMinor, 0);
      const [rr] = await db.insert(schema.returnRequests).values({ tenantId, orderId: o.id, number: ++nextNumber, status: "refunded", reasonCode: "changed_mind", resolution: "refund", fault: "customer", proposedAmountMinor: value, refundedAmountMinor: value, requestedAt: at, approvedAt: at, receivedAt: at, closedAt: at, source: "portal", platformSyncStatus: "not_required" }).returning({ id: schema.returnRequests.id });
      await db.insert(schema.returnLines).values(lines.map((l) => ({ tenantId, returnId: rr!.id, orderLineId: l.id, quantity: l.quantity, unitAmountMinor: l.unitPriceMinor, inspectionOutcome: "intact", inspectionAmountMinor: l.totalMinor, restocked: true })));
      await db.update(schema.orders).set({ returnedFraction: 10000, refundedMinor: value, status: "returned" }).where(eq(schema.orders.id, o.id));
    }
  }
  // risk on recent returns from each customer's history (same rule as the service), review flags, returnless examples
  const risky = await db.execute<{ id: string; status: string; level: string; reasons: string[] }>(sql`
    with per_customer as (
      select o.customer_id, count(distinct r.id)::int as returns, coalesce(sum(rl.quantity), 0)::int as items_returned
      from return_requests r join orders o on o.id = r.order_id left join return_lines rl on rl.return_id = r.id
      where r.tenant_id = ${tenantId} and r.status <> 'rejected' and o.customer_id is not null group by 1
    ), bought as (
      select o.customer_id, coalesce(sum(l.quantity), 0)::int as items from orders o join order_lines l on l.order_id = o.id
      where o.tenant_id = ${tenantId} and o.status <> 'cancelled' and l.is_ancillary = false and o.customer_id is not null group by 1
    )
    select r.id, r.status,
      case when pc.returns >= 3 and pc.items_returned * 10000 >= 5000 * greatest(b.items, 1) then 'high'
           when pc.returns >= 3 and pc.items_returned * 10000 >= 3000 * greatest(b.items, 1) then 'watch' else 'none' end as level,
      case when pc.returns >= 3 and pc.items_returned * 10000 >= 5000 * greatest(b.items, 1) then '["serial_returner"]'::jsonb
           when pc.returns >= 3 and pc.items_returned * 10000 >= 3000 * greatest(b.items, 1) then '["frequent_returner"]'::jsonb else '[]'::jsonb end as reasons
    from return_requests r join orders o on o.id = r.order_id
    left join per_customer pc on pc.customer_id = o.customer_id left join bought b on b.customer_id = o.customer_id
    where r.tenant_id = ${tenantId} order by r.requested_at desc limit 400`);
  for (const r of risky.rows) {
    const open = !["refunded", "exchanged", "voucher_issued", "rejected"].includes(r.status);
    await db.update(schema.returnRequests).set({ riskLevel: r.level, riskReasons: r.reasons, needsReview: open && r.level !== "none", automations: open && r.level !== "none" ? [{ id: "flag-risky", name: it ? "Segnala clienti a rischio" : "Flag risky customers", action: "flag" }] : [] }).where(eq(schema.returnRequests.id, r.id));
  }
  const cheap = await db.execute<{ id: string }>(sql`
    select id from return_requests where tenant_id = ${tenantId} and status = 'refunded' and reason_code in ('damaged','defective') and proposed_amount_minor <= ${it ? 1500 : 2500} limit 5`);
  for (const r of cheap.rows) {
    await db.update(schema.returnRequests).set({ returnless: true, automations: [{ id: "keep-cheap", name: it ? "Tieni gli articoli economici danneggiati" : "Keep cheap damaged items", action: "returnless" }] }).where(eq(schema.returnRequests.id, r.id));
    await db.update(schema.returnLines).set({ restocked: false }).where(eq(schema.returnLines.returnId, r.id));
  }
  // exchanges: the wanted variant (another of the same product) and the price difference
  const exchanges = await db.execute<{ id: string; return_line_id: string; quantity: number; unit_amount_minor: number; variant_id: string; title: string; price_minor: number }>(sql`
    select distinct on (r.id) r.id, rl.id as return_line_id, rl.quantity, rl.unit_amount_minor, v.id as variant_id, p.title || ' ' || v.title as title, v.price_minor
    from return_requests r join return_lines rl on rl.return_id = r.id join order_lines ol on ol.id = rl.order_line_id
    join product_variants v on v.product_id = ol.product_id and v.id <> ol.variant_id and v.is_active
    join products p on p.id = v.product_id
    where r.tenant_id = ${tenantId} and r.resolution = 'exchange'
    order by r.id, v.price_minor desc limit 60`);
  let exchangeRows = exchanges.rows;
  if (!exchangeRows.length) {
    // tiny scales may have no exchange: turn the newest return into one so every table has rows
    const any = await db.execute<{ id: string; return_line_id: string; quantity: number; unit_amount_minor: number; variant_id: string; title: string; price_minor: number }>(sql`
      select r.id, rl.id as return_line_id, rl.quantity, rl.unit_amount_minor, v.id as variant_id, p.title || ' ' || v.title as title, v.price_minor
      from return_requests r join return_lines rl on rl.return_id = r.id join order_lines ol on ol.id = rl.order_line_id
      join product_variants v on v.product_id = ol.product_id join products p on p.id = v.product_id
      where r.tenant_id = ${tenantId} order by r.requested_at desc limit 1`);
    exchangeRows = any.rows;
    if (exchangeRows[0]) await db.update(schema.returnRequests).set({ resolution: "exchange" }).where(eq(schema.returnRequests.id, exchangeRows[0].id));
  }
  for (const x of exchangeRows) {
    await db.insert(schema.returnExchangeLines).values({ tenantId, returnId: x.id, returnLineId: x.return_line_id, variantId: x.variant_id, title: x.title, quantity: Number(x.quantity), unitPriceMinor: Number(x.price_minor) });
    await db.update(schema.returnRequests).set({ exchangeDifferenceMinor: Number(x.quantity) * (Number(x.price_minor) - Number(x.unit_amount_minor)) }).where(eq(schema.returnRequests.id, x.id));
  }
  // vouchers: the credit bonus on issued vouchers
  await db.execute(sql`update return_requests set credit_bonus_minor = (coalesce(refunded_amount_minor, proposed_amount_minor) * ${it ? 1000 : 500} / 10000)::int
    where tenant_id = ${tenantId} and resolution = 'voucher' and status = 'voucher_issued'`);
  // the isolation suite needs at least one photo per tenant even at tiny scales
  if (!photos && recent.rows[0]) await db.insert(schema.returnEvidence).values({ tenantId, returnId: recent.rows[0].id, sessionNonce: "seed-0", contentType: "image/png", sizeBytes: DEMO_PHOTO.length, data: DEMO_PHOTO });
}

/**
 * Planning data: supplier terms (lead-time variability, deposit, balance days, MOQ), the
 * supplier of each variant (from the purchase history), seasonal demand events, two forecast
 * overrides, duties and freight on the open purchase orders (with landed cost), one bundle
 * and one bill of materials made of existing variants.
 */
async function seedPlanningExtras(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date) {
  const it = key === "northwind";
  const rng = createRng(it ? 4242 : 4343);
  const suppliers = await db.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).orderBy(schema.suppliers.name);
  if (!suppliers.length) return;
  for (const [i, s] of suppliers.entries()) {
    await db.update(schema.suppliers).set({ leadTimeSdDays: [3, 7, 2, 10][i % 4]!, depositBps: [3000, 0, 5000, 2000][i % 4]!, balanceDays: [30, 60, 0, 45][i % 4]!, moqDefault: [50, null, 100, 24][i % 4] ?? null, orderMultipleDefault: [10, 6, 12, null][i % 4] ?? null, contactName: it ? ["Giulia Bassi", "Rui Costa", "Ayşe Demir", "Marco Neri"][i % 4]! : ["Dana Price", "Linh Tran", "Arjun Mehta"][i % 3]! }).where(eq(schema.suppliers.id, s.id));
  }
  // supplier of each variant: the most frequent supplier in its PO history, else round-robin by product
  const hist = await db.execute<{ variant_id: string; supplier_id: string; n: number; cost: number }>(sql`
    select l.variant_id, p.supplier_id, count(*)::int as n, max(l.unit_cost_minor)::int as cost
    from purchase_order_lines l join purchase_orders p on p.id = l.purchase_order_id
    where l.tenant_id = ${tenantId} and l.variant_id is not null group by 1, 2 order by 1, 3 desc`);
  const supplierOf = new Map<string, { supplierId: string; cost: number }>();
  for (const r of hist.rows) if (!supplierOf.has(r.variant_id)) supplierOf.set(r.variant_id, { supplierId: r.supplier_id, cost: Number(r.cost) });
  const variants = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, sku: schema.productVariants.sku, costMinor: schema.productVariants.costMinor, productType: schema.products.productType }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(eq(schema.productVariants.tenantId, tenantId)).orderBy(schema.productVariants.sku);
  const productIndex = new Map([...new Set(variants.map((v) => v.productId))].map((p, i) => [p, i]));
  // every eighth product never bought before has no default supplier yet, so the bulk assignment has work to do
  const links = variants.filter((v) => supplierOf.has(v.id) || (productIndex.get(v.productId) ?? 0) % 8 !== 7).map((v) => {
    const known = supplierOf.get(v.id);
    const supplier = known ? suppliers.find((s) => s.id === known.supplierId)! : suppliers[(productIndex.get(v.productId) ?? 0) % suppliers.length]!;
    return { tenantId, supplierId: supplier.id, variantId: v.id, supplierSku: v.sku ? `${supplier.name.slice(0, 3).toUpperCase()}-${v.sku}` : null, unitCostMinor: known?.cost ?? v.costMinor ?? null, moq: rng.chance(0.15) ? rng.pick([20, 30, 60]) : null, orderMultiple: null, leadTimeDays: rng.chance(0.2) ? (supplier.leadTimeDays ?? 21) + rng.int(-5, 10) : null, isPrimary: true };
  });
  for (let i = 0; i < links.length; i += 500) await db.insert(schema.supplierVariants).values(links.slice(i, i + 500));
  // seasonal events in the next 12 months
  const types = [...new Set(variants.map((v) => v.productType).filter((t): t is string => Boolean(t)))].sort();
  const monthIn = (m: number) => {
    const y = now.getUTCFullYear() + (m <= now.getUTCMonth() ? 1 : 0);
    return `${y}-${String(m + 1).padStart(2, "0")}`;
  };
  const events = it
    ? [
        { name: "Black Friday", month: monthIn(10), upliftBps: 6000, scope: "all", scopeValue: null },
        { name: "Natale", month: monthIn(11), upliftBps: 3500, scope: "all", scopeValue: null },
        { name: "Saldi estivi", month: monthIn(6), upliftBps: 2500, scope: types[0] ? "product_type" : "all", scopeValue: types[0] ?? null },
      ]
    : [
        { name: "Black Friday", month: monthIn(10), upliftBps: 5000, scope: "all", scopeValue: null },
        { name: "Holiday season", month: monthIn(11), upliftBps: 3000, scope: "all", scopeValue: null },
        { name: "Memorial Day sale", month: monthIn(4), upliftBps: 2000, scope: types[0] ? "product_type" : "all", scopeValue: types[0] ?? null },
      ];
  await db.insert(schema.demandEvents).values(events.map((e) => ({ tenantId, ...e })));
  // two manual forecast corrections next month
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nm = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  const overrides = variants.slice(0, 2).map((v, i) => ({ tenantId, variantId: v.id, month: nm, units: i === 0 ? 120 : 15, note: it ? (i === 0 ? "Campagna influencer prevista" : "Fine serie") : i === 0 ? "Retail partner launch" : "Phasing out" }));
  await db.insert(schema.forecastOverrides).values(overrides);
  // duties and freight on the open purchase orders, landed cost on their lines
  const open = await db.select({ id: schema.purchaseOrders.id, total: schema.purchaseOrders.totalMinor }).from(schema.purchaseOrders).where(sql`${schema.purchaseOrders.tenantId} = ${tenantId} and ${schema.purchaseOrders.status} in ('sent','confirmed','in_transit')`).orderBy(schema.purchaseOrders.number);
  const targets = open.length ? open.slice(0, 3) : (await db.select({ id: schema.purchaseOrders.id, total: schema.purchaseOrders.totalMinor }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, tenantId)).orderBy(schema.purchaseOrders.number).limit(1));
  for (const po of targets) {
    const charges = [
      { kind: "freight", amountMinor: Math.max(5000, Math.round(po.total * 0.04)), basis: "weight", note: it ? "Trasporto via camion" : "Ocean freight" },
      { kind: "duty", amountMinor: Math.round(po.total * (it ? 0.08 : 0.12)), basis: "value", note: it ? "Dazi doganali" : "Import duty" },
    ];
    await db.insert(schema.purchaseOrderCharges).values(charges.map((c) => ({ tenantId, purchaseOrderId: po.id, ...c })));
    const lines = await db.select({ id: schema.purchaseOrderLines.id, quantity: schema.purchaseOrderLines.quantity, unitCostMinor: schema.purchaseOrderLines.unitCostMinor, weightGrams: schema.productVariants.weightGrams }).from(schema.purchaseOrderLines).leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.purchaseOrderLines.variantId)).where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id));
    for (const r of allocateLandedCost(lines, charges as { kind: "freight"; amountMinor: number; basis: "weight" }[])) await db.update(schema.purchaseOrderLines).set({ landedUnitCostMinor: r.landedUnitCostMinor }).where(eq(schema.purchaseOrderLines.id, r.id));
  }
  // stock imbalance between locations for a few fast movers, so the transfer planner has work to do
  const fast = await db.execute<{ variant_id: string }>(sql`
    select l.variant_id from order_lines l join orders o on o.id = l.order_id
    where o.tenant_id = ${tenantId} and o.placed_at >= ${new Date(now.getTime() - 90 * 864e5)} and l.variant_id is not null
      and l.variant_id in (select variant_id from inventory_levels where tenant_id = ${tenantId} group by 1 having count(*) >= 2)
    group by 1 order by sum(l.current_quantity) desc, 1 limit 6`);
  const locs = await db.select().from(schema.locations).where(eq(schema.locations.tenantId, tenantId));
  const main = locs.find((l) => l.isDefault);
  for (const r of fast.rows) {
    const levels = await db.select().from(schema.inventoryLevels).where(eq(schema.inventoryLevels.variantId, r.variant_id));
    const short = levels.find((l) => l.locationId !== main?.id);
    const surplus = levels.find((l) => l.locationId === main?.id);
    if (!short || !surplus) continue;
    await db.update(schema.inventoryLevels).set({ available: 0, onHand: 0 }).where(eq(schema.inventoryLevels.id, short.id));
    await db.update(schema.inventoryLevels).set({ available: surplus.available + short.available + 240, onHand: (surplus.onHand ?? surplus.available) + short.available + 240 }).where(eq(schema.inventoryLevels.id, surplus.id));
  }
  await seedPurchasingDepth(db, key, tenantId, now, suppliers);
  // one bundle and one bill of materials made of existing variants
  if (variants.length >= 6) {
    const [bundle, b1, b2, kit, m1, m2] = [variants[variants.length - 1]!, variants[0]!, variants[3]!, variants[variants.length - 2]!, variants[1]!, variants[4]!];
    await db.insert(schema.bundleComponents).values([
      { tenantId, parentVariantId: bundle.id, componentVariantId: b1.id, quantity: 1, kind: "bundle" },
      { tenantId, parentVariantId: bundle.id, componentVariantId: b2.id, quantity: 2, kind: "bundle" },
      { tenantId, parentVariantId: kit.id, componentVariantId: m1.id, quantity: 2, kind: "bom" },
      { tenantId, parentVariantId: kit.id, componentVariantId: m2.id, quantity: 1, kind: "bom" },
    ]);
  }
}

/**
 * Purchasing depth: a case pack on a product with options (Northwind: a size run for every product
 * with a "Size" option; Harbor Home: a mixed carton on one product), a draft PO with a free-text
 * line (packaging) next to catalogue lines, and one expired supplier link with its blocked view.
 */
async function seedPurchasingDepth(db: ReturnType<typeof drizzle<typeof schema>>, key: keyof typeof DEMO_TENANTS, tenantId: string, now: Date, suppliers: (typeof schema.suppliers.$inferSelect)[]) {
  const it = key === "northwind";
  const products = await db.select({ id: schema.products.id, options: schema.products.options }).from(schema.products).where(eq(schema.products.tenantId, tenantId)).orderBy(schema.products.title);
  // the product with the most options, and its option with the most values (a size run on apparel, whatever the option is called)
  const withOption = products
    .map((p) => ({ id: p.id, options: p.options as { name: string; values: string[] }[] }))
    .filter((p) => p.options.some((o) => o.values.length >= 2))
    .sort((a, b) => b.options.length - a.options.length)
    .map((p) => ({ id: p.id, option: [...p.options].sort((a, b) => b.values.length - a.values.length)[0] }))[0];
  if (withOption?.option) {
    const values = withOption.option.values;
    const units = Object.fromEntries(values.map((v, i) => [v, i === 0 || i === values.length - 1 ? 1 : 2]));
    await db.insert(schema.casePacks).values({ tenantId, name: it ? `Scatola ${withOption.option.name.toLowerCase()} ${values.join("-")}` : `Mixed carton ${values.join("/")}`, optionName: withOption.option.name, units, productId: it ? null : withOption.id });
  }
  // a draft PO with catalogue lines and a free-text packaging line
  const [draft] = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, tenantId), eq(schema.purchaseOrders.status, "draft"))).orderBy(schema.purchaseOrders.number).limit(1);
  let draftId = draft?.id;
  if (!draftId && suppliers[0]) {
    const prefix = `PO-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
    const taken = await db.select({ n: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, tenantId), sql`${schema.purchaseOrders.number} like ${prefix + "%"}`));
    const next = taken.reduce((m, r) => Math.max(m, Number(r.n.slice(prefix.length)) || 0), 0) + 1;
    const [po] = await db.insert(schema.purchaseOrders).values({ tenantId, supplierId: suppliers[0].id, number: `${prefix}${String(next).padStart(3, "0")}`, status: "draft", currency: it ? "EUR" : "USD", totalMinor: 0 }).returning({ id: schema.purchaseOrders.id });
    draftId = po!.id;
    const vs = await db.select({ id: schema.productVariants.id, cost: schema.productVariants.costMinor }).from(schema.productVariants).where(eq(schema.productVariants.tenantId, tenantId)).orderBy(schema.productVariants.sku).limit(2);
    if (vs.length) await db.insert(schema.purchaseOrderLines).values(vs.map((v) => ({ tenantId, purchaseOrderId: draftId!, variantId: v.id, quantity: 24, unitCostMinor: v.cost ?? 1000 })));
  }
  if (draftId) {
    await db.insert(schema.purchaseOrderLines).values({ tenantId, purchaseOrderId: draftId, variantId: null, description: it ? "Cartellini e buste di confezionamento" : "Hang tags and poly bags", quantity: 500, unitCostMinor: it ? 12 : 15 });
    const lines = await db.select({ q: schema.purchaseOrderLines.quantity, c: schema.purchaseOrderLines.unitCostMinor }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, draftId));
    await db.update(schema.purchaseOrders).set({ totalMinor: lines.reduce((t, l) => t + l.q * l.c, 0) }).where(eq(schema.purchaseOrders.id, draftId));
  }
  // one supplier link that expired last week, and the blocked view it logged
  const [sent] = await db.select({ id: schema.purchaseOrders.id, email: schema.purchaseOrders.sentToEmail, sentAt: schema.purchaseOrders.sentAt, supplierId: schema.purchaseOrders.supplierId }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, tenantId), sql`${schema.purchaseOrders.status} in ('sent','confirmed','in_transit','partially_received','received')`)).orderBy(schema.purchaseOrders.number).limit(1);
  if (sent) {
    const createdAt = new Date(now.getTime() - 37 * 864e5);
    const token = `seed-expired-${tenantId}`;
    const [link] = await db.insert(schema.supplierLinks).values({ tenantId, purchaseOrderId: sent.id, tokenHash: createHash("sha256").update(token).digest("hex"), tokenHint: token.slice(-4), sentToEmail: sent.email ?? suppliers.find((s) => s.id === sent.supplierId)?.email ?? null, expiresAt: new Date(createdAt.getTime() + 30 * 864e5), createdAt, lastViewedAt: new Date(now.getTime() - 2 * 864e5), viewCount: 2 }).returning({ id: schema.supplierLinks.id });
    await db.insert(schema.supplierLinkViews).values([
      { tenantId, linkId: link!.id, purchaseOrderId: sent.id, kind: "view", outcome: "active", createdAt: new Date(createdAt.getTime() + 864e5) },
      { tenantId, linkId: link!.id, purchaseOrderId: sent.id, kind: "view", outcome: "expired", createdAt: new Date(now.getTime() - 2 * 864e5) },
    ]);
  }
}

/**
 * Demo rows for `addon.cod` on the tenant that has the add-on: operator capacity, a day off,
 * queue items for the open COD orders with a few attempts, and recipient profiles with risk tiers.
 * The live queue sync, scoring and risk recompute take over from here.
 */
/**
 * One SKU reused by a second product, as happens when a merchant copies a product on the platform:
 * the catalog data-quality page lists both and the cost import refuses to guess between them.
 * Written last because the planning extras order variants by SKU.
 */
async function seedCatalogDuplicate(db: ReturnType<typeof drizzle<typeof schema>>, tenantId: string) {
  const firsts = await db.execute<{ id: string; sku: string }>(sql`
    select distinct on (p.title) v.id, v.sku from product_variants v join products p on p.id = v.product_id
    where v.tenant_id = ${tenantId} and v.sku is not null and p.status = 'active' order by p.title, v.sku, v.id`);
  const rows = firsts.rows;
  if (rows.length < 4) return;
  const [source, target] = [rows[Math.floor(rows.length / 3)]!, rows[Math.floor(rows.length / 3) + 1]!];
  await db.update(schema.productVariants).set({ sku: source.sku }).where(eq(schema.productVariants.id, target.id));
}

async function seedCod(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, tenantId: string, now: Date) {
  const rng = createRng(2026);
  const operators = ["ops@northwind.demo", "care@northwind.demo", "care2@northwind.demo"].map((e) => ctx.userIds[e]).filter((x): x is string => Boolean(x));
  const hours = [[0, 8, 8, 8, 8, 8, 0], [0, 4, 4, 4, 4, 4, 0], [0, 6, 6, 0, 6, 6, 4]];
  // the third operator only handles modification requests: skill routing by tag
  for (const [i, userId] of operators.entries()) await db.insert(schema.codOperatorCapacity).values({ tenantId, userId, dailyHours: hours[i]!, isActive: 1, allowedTags: i === 2 ? ["Richiesta modifica", "Da chiamare"] : [] }).onConflictDoNothing();
  if (operators[1]) await db.insert(schema.codCapacityExceptions).values({ tenantId, userId: operators[1], date: new Date(now.getTime() + 2 * 864e5).toISOString().slice(0, 10), kind: "off", note: "Day off" }).onConflictDoNothing();
  await db.insert(schema.codSettings).values({ tenantId, config: DEMO_COD_SETTINGS }).onConflictDoNothing();
  const open = await db.execute<{ id: string; placed_at: Date }>(sql`select o.id, o.placed_at from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('new','pending_review') and o.cancelled_at is null and o.fulfillment_status_raw is null and not exists (select 1 from shipments s where s.order_id = o.id) and o.placed_at > ${new Date(now.getTime() - 60 * 864e5)} order by o.placed_at`);
  // small test seeds may have no open COD order: fall back to recent COD orders as closed items so every table has rows
  const isOpen = open.rows.length > 0;
  const candidates = isOpen ? open.rows : (await db.execute<{ id: string; placed_at: Date }>(sql`select o.id, o.placed_at from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' order by o.placed_at desc limit 10`)).rows;
  for (const [i, o] of candidates.entries()) {
    const attempts = Math.max(i === 0 ? 1 : 0, rng.weighted([[0, 55], [1, 30], [2, 15]] as const));
    const assignedTo = attempts > 0 || rng.chance(0.5) ? rng.pick(operators) : null;
    const callBack = attempts > 0 && rng.chance(0.3);
    const enteredAt = new Date(o.placed_at);
    const [item] = await db.insert(schema.codQueueItems).values({ tenantId, orderId: o.id, status: !isOpen ? "left" : callBack ? "scheduled" : "pending", closedAt: isOpen ? null : now, assignedTo, assignedAt: assignedTo ? enteredAt : null, attemptsCount: attempts, noAnswerCount: callBack ? Math.max(0, attempts - 1) : attempts, lastAttemptAt: attempts ? new Date(enteredAt.getTime() + 3600e3 * attempts) : null, callBackAt: callBack ? new Date(now.getTime() + (i % 3 === 0 ? -2 : 6) * 3600e3) : null, enteredAt }).onConflictDoNothing().returning({ id: schema.codQueueItems.id });
    if (!item) continue;
    for (let n = 1; n <= attempts; n++) await db.insert(schema.codAttempts).values({ tenantId, queueItemId: item.id, orderId: o.id, operatorId: assignedTo, attemptNumber: n, outcome: callBack && n === attempts ? "call_back" : "no_answer", callBackAt: callBack && n === attempts ? new Date(now.getTime() + 6 * 3600e3) : null, createdAt: new Date(enteredAt.getTime() + 3600e3 * n) });
    if (assignedTo) await db.insert(schema.codAssignmentLog).values({ tenantId, orderId: o.id, assignedTo, source: "cron", reason: "auto", assignedAt: enteredAt });
    // a confirmation agreed for a later day, an escalation and a sent confirmation message (C.5, C.9, C.17)
    if (isOpen && i === 1) await db.update(schema.codQueueItems).set({ status: "confirm_scheduled", scheduledConfirmOn: new Date(now.getTime() + 2 * 864e5).toISOString().slice(0, 10), callBackAt: null }).where(eq(schema.codQueueItems.id, item.id));
    if (isOpen && i === 2 && operators[1]) await db.update(schema.codQueueItems).set({ escalatedAt: new Date(enteredAt.getTime() + 2 * 3600e3), escalatedBy: operators[1], escalationReason: "Il cliente chiede di parlare con un responsabile" }).where(eq(schema.codQueueItems.id, item.id));
    if (i < 3 || !isOpen) {
      const sentAt = new Date(enteredAt.getTime() + 30 * 60e3);
      await db.insert(schema.codMessages).values({ tenantId, orderId: o.id, queueItemId: item.id, templateKey: "conferma", provider: "messaging-mock", recipient: "+39 333 ••• ••••", body: "Ciao, confermi l'ordine in contrassegno? Rispondi SÌ per confermare.", providerMessageId: `seed-msg-${i}`, status: i === 0 ? "read" : "delivered", statusAt: new Date(sentAt.getTime() + 5 * 60e3), sentBy: assignedTo, createdAt: sentAt });
    }
  }
  // carrier billing import (C.19): outcomes of past COD parcels, one reference not matched
  const shipped = await db.execute<{ id: string; name: string; status: string }>(sql`select o.id, o.name, o.status from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('delivered','returned','refunded') order by o.placed_at desc limit 24`);
  const batch = `seed-${now.toISOString().slice(0, 7)}`;
  for (const [i, o] of shipped.rows.entries()) await db.insert(schema.codCarrierOutcomes).values({ tenantId, orderId: o.id, reference: o.name, outcome: o.status === "delivered" ? "delivered" : "refused", occurredAt: new Date(now.getTime() - (i + 3) * 864e5), costMinor: o.status === "delivered" ? 690 : 1340, importBatch: batch }).onConflictDoNothing();
  await db.insert(schema.codCarrierOutcomes).values({ tenantId, orderId: null, reference: "TRK-UNMATCHED-0001", outcome: "refused", occurredAt: new Date(now.getTime() - 3 * 864e5), costMinor: 1340, importBatch: batch }).onConflictDoNothing();
  const returned = await db.execute<{ phone: string | null; email: string | null; n: number; last: Date }>(sql`select o.phone, o.email_normalized as email, count(*)::int as n, max(o.placed_at) as last from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('returned','refunded') and (o.phone is not null or o.email_normalized is not null) group by 1, 2 order by n desc limit 12`);
  // small test seeds may have no returned COD order: profile a few recent recipients as "watch" so the table has rows
  const profiled = returned.rows.length > 0 ? returned.rows : (await db.execute<{ phone: string | null; email: string | null; n: number; last: Date }>(sql`select o.phone, o.email_normalized as email, 1::int as n, max(o.placed_at) as last from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and (o.phone is not null or o.email_normalized is not null) group by 1, 2 order by last desc limit 3`)).rows;
  for (const r of profiled) {
    const key = r.phone ? normalizePhone(r.phone, "IT") ?? `email:${r.email}` : `email:${r.email}`;
    const weighted = r.n;
    const tier = weighted >= 3 ? "blacklisted" : weighted >= 2 ? "high_risk" : "watch";
    await db.insert(schema.codRecipientProfiles).values({ tenantId, recipientKey: key, ordersTotal: r.n + 1, ordersDelivered: 1, ordersReturned: r.n, weightedReturns: weighted, consecutiveDeliveries: 0, tier, lastReturnAt: new Date(r.last), computedAt: now }).onConflictDoNothing();
  }
}

export async function seedAll(adminUrl: string, opts: SeedOptions = {}): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const db = drizzle(pool, { schema });
  try {
    const ctx = await seedPlatform(db);
    const check = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, DEMO_TENANTS.northwind.slug));
    if (check.length !== 1) throw new Error("seed sanity check failed");
    console.info(`[db:seed] platform: ${Object.keys(ctx.tenantIds).length} tenants, ${Object.keys(ctx.userIds).length} users`);
    await seedDomain(db, ctx, { ...opts, log: console.info });
  } finally {
    await pool.end();
  }
}

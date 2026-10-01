import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { generateTenantDataset, type TenantSeedConfig } from "./generator";
import { writeDataset } from "./writer";

export const DEMO_PASSWORD = "keel-demo-2026";

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
    addons: ["addon.cod"],
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
    addons: [] as string[],
    taxRates: [{ country: "US", rateBps: 0, pricesIncludeTax: false }],
  },
} as const;

export const DEMO_USERS = [
  { email: "superadmin@keel.demo", name: "Platform Admin", superAdmin: true, memberships: [] as { tenant: keyof typeof DEMO_TENANTS; role: string }[] },
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
  { email: "multi@keel.demo", name: "Alex Multi", memberships: [{ tenant: "northwind", role: "admin" }, { tenant: "harbor", role: "viewer" }] },
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
        .values({ tenantId: row!.id, moduleKey: addon, note: "Enabled by seed" })
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
      })
      .onConflictDoUpdate({ target: schema.users.email, set: { name: u.name, passwordHash } })
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
  await seedBilling(db, tenantIds);
  return { tenantIds, userIds };
}

/** Demo billing: Northwind active on Growth with COD add-on and a paid history; Harbor Home past due on Starter. */
async function seedBilling(db: ReturnType<typeof drizzle<typeof schema>>, tenantIds: SeedContext["tenantIds"]) {
  const now = new Date();
  const month = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const plans: Record<keyof typeof DEMO_TENANTS, { planKey: string; monthly: number; setup: number; currency: string; months: number; lastPaid: boolean }> = {
    northwind: { planKey: "growth", monthly: 34900 + 9900, setup: 99000, currency: "EUR", months: 6, lastPaid: true },
    harbor: { planKey: "starter", monthly: 14900, setup: 49000, currency: "EUR", months: 3, lastPaid: false },
  };
  for (const key of Object.keys(plans) as (keyof typeof DEMO_TENANTS)[]) {
    const tenantId = tenantIds[key];
    const p = plans[key];
    const [existing] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
    if (existing) continue;
    const start = month(p.months);
    const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey: p.planKey, status: p.lastPaid ? "active" : "past_due", provider: "mock", externalCustomerId: `mock_cus_${tenantId.slice(0, 8)}`, currency: p.currency, currentPeriodStart: month(0), currentPeriodEnd: month(-1), trialEndsAt: new Date(start.getTime() + 14 * 864e5), setupFeeMinor: p.setup }).returning({ id: schema.subscriptions.id });
    const rows = [{ number: `INV-${start.getUTCFullYear()}-0001`, kind: "setup", amountMinor: p.setup, lines: [{ kind: "setup", key: p.planKey, amountMinor: p.setup }], issuedAt: start, dueAt: new Date(start.getTime() + 7 * 864e5), paidAt: new Date(start.getTime() + 3 * 864e5) as Date | null, periodStart: null as Date | null, periodEnd: null as Date | null }];
    for (let m = p.months - 1; m >= 0; m--) {
      const issued = month(m);
      const isLast = m === 0;
      rows.push({ number: `INV-${issued.getUTCFullYear()}-${String(rows.length + 1).padStart(4, "0")}`, kind: "subscription", amountMinor: p.monthly, lines: p.planKey === "growth" ? [{ kind: "plan", key: "growth", amountMinor: 34900 }, { kind: "addon", key: "addon.cod", amountMinor: 9900 }] : [{ kind: "plan", key: "starter", amountMinor: 14900 }], issuedAt: issued, dueAt: new Date(issued.getTime() + 7 * 864e5), paidAt: isLast && !p.lastPaid ? null : new Date(issued.getTime() + 2 * 864e5), periodStart: issued, periodEnd: month(m - 1) });
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
      key: "northwind", tenantId: ctx.tenantIds.northwind, seed: 20261001, currency: "EUR", country: "IT", timezone: "Europe/Rome", locale: "it", orderNumberPrefix: "NW-",
      orderCount: Math.max(40, Math.round(15000 * scale)), productCount: Math.max(6, Math.round(120 * Math.min(1, scale * 4))), locationNames: ["Magazzino Milano", "Magazzino Bologna", "3PL Berlin"],
      supplierNames: ["Tessitura Lombarda", "Maglificio Dolomiti", "Confezioni Adriatica", "Pellami Toscani"], metaCampaigns: Math.max(3, Math.round(25 * Math.min(1, scale * 4))), googleCampaigns: Math.max(1, Math.round(6 * Math.min(1, scale * 4))),
      codShare: 0.1, returnRate: 0.12, cancelRate: 0.06, userIds: members("northwind"), now,
    },
    {
      key: "harbor", tenantId: ctx.tenantIds.harbor, seed: 20261002, currency: "USD", country: "US", timezone: "America/New_York", locale: "en", orderNumberPrefix: "HH-",
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
    for (const table of [schema.backorders, schema.orders, schema.supplierPayments, schema.purchaseOrders, schema.suppliers, schema.segments, schema.customers, schema.inventoryMovements, schema.products, schema.locations, schema.campaigns, schema.discounts, schema.discountPools, schema.stateRules, schema.shipmentStatusMappings, schema.costSettings, schema.returnReasons, schema.notifications, schema.integrations, schema.integrationHealth, schema.webhookEvents, schema.syncRuns, schema.auditLogs]) {
      await db.delete(table).where(eq(table.tenantId, cfg.tenantId));
    }
    const started = Date.now();
    const ds = generateTenantDataset(cfg);
    const genMs = Date.now() - started;
    const counts = await writeDataset(db, ds);
    log(`[db:seed] ${cfg.key}: generated in ${genMs}ms, wrote ${Object.values(counts).reduce((a, b) => a + b, 0)} rows in ${Date.now() - started - genMs}ms (orders ${counts.orders}, lines ${counts.orderLines}, events ${counts.orderEvents})`);
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

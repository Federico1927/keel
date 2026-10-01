import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

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
  return { tenantIds, userIds };
}

export async function seedAll(adminUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const db = drizzle(pool, { schema });
  try {
    const ctx = await seedPlatform(db);
    const check = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, DEMO_TENANTS.northwind.slug));
    if (check.length !== 1) throw new Error("seed sanity check failed");
    console.info(`[db:seed] platform: ${Object.keys(ctx.tenantIds).length} tenants, ${Object.keys(ctx.userIds).length} users`);
  } finally {
    await pool.end();
  }
}

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { generateTenantDataset, type TenantSeedConfig } from "./generator";
import { writeDataset } from "./writer";
import { createRng } from "@keel/integrations";
import { normalizePhone } from "@keel/core";
import { MODULES, PLANS, PLATFORM_CURRENCY } from "@keel/config";
import { sql } from "drizzle-orm";

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
  {
    email: "superadmin@keel.demo",
    name: "Platform Admin",
    superAdmin: true,
    memberships: [] as { tenant: keyof typeof DEMO_TENANTS; role: string }[],
  },
  {
    email: "owner@northwind.demo",
    name: "Giulia Ferri",
    memberships: [{ tenant: "northwind", role: "owner" }],
  },
  {
    email: "admin@northwind.demo",
    name: "Marco Bianchi",
    memberships: [{ tenant: "northwind", role: "admin" }],
  },
  {
    email: "ops@northwind.demo",
    name: "Sara Conti",
    memberships: [{ tenant: "northwind", role: "operations" }],
  },
  {
    email: "care@northwind.demo",
    name: "Luca Romano",
    memberships: [{ tenant: "northwind", role: "customer_care" }],
  },
  {
    email: "care2@northwind.demo",
    name: "Elena Greco",
    memberships: [{ tenant: "northwind", role: "customer_care" }],
  },
  {
    email: "marketing@northwind.demo",
    name: "Chiara Rizzo",
    memberships: [{ tenant: "northwind", role: "marketing" }],
  },
  {
    email: "viewer@northwind.demo",
    name: "Paolo Moretti",
    memberships: [{ tenant: "northwind", role: "viewer" }],
  },
  {
    email: "owner@harborhome.demo",
    name: "Emily Carter",
    memberships: [{ tenant: "harbor", role: "owner" }],
  },
  {
    email: "ops@harborhome.demo",
    name: "James Walker",
    memberships: [{ tenant: "harbor", role: "operations" }],
  },
  {
    email: "marketing@harborhome.demo",
    name: "Olivia Brooks",
    memberships: [{ tenant: "harbor", role: "marketing" }],
  },
  {
    email: "multi@keel.demo",
    name: "Alex Multi",
    memberships: [
      { tenant: "northwind", role: "admin" },
      { tenant: "harbor", role: "viewer" },
    ],
  },
] as const;

export interface SeedContext {
  tenantIds: Record<keyof typeof DEMO_TENANTS, string>;
  userIds: Record<string, string>;
}

/** Seeds platform rows: tenants, users, memberships, add-ons, tax rates. Idempotent. */
export async function seedPlatform(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<SeedContext> {
  const tenantIds = {} as SeedContext["tenantIds"];
  for (const [key, t] of Object.entries(DEMO_TENANTS) as [
    keyof typeof DEMO_TENANTS,
    (typeof DEMO_TENANTS)[keyof typeof DEMO_TENANTS],
  ][]) {
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
        .values({
          tenantId: row!.id,
          country: tr.country,
          rateBps: tr.rateBps,
          pricesIncludeTax: "pricesIncludeTax" in tr ? tr.pricesIncludeTax : true,
        })
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
async function seedBilling(
  db: ReturnType<typeof drizzle<typeof schema>>,
  tenantIds: SeedContext["tenantIds"],
) {
  const now = new Date();
  const month = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const plans: Record<
    keyof typeof DEMO_TENANTS,
    {
      planKey: string;
      monthly: number;
      setup: number;
      currency: string;
      months: number;
      lastPaid: boolean;
    }
  > = {
    northwind: {
      planKey: "growth",
      monthly: PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!,
      setup: PLANS.growth.setupFeeMinor,
      currency: PLATFORM_CURRENCY,
      months: 6,
      lastPaid: true,
    },
    harbor: {
      planKey: "starter",
      monthly: PLANS.starter.monthlyPriceMinor,
      setup: PLANS.starter.setupFeeMinor,
      currency: PLATFORM_CURRENCY,
      months: 3,
      lastPaid: false,
    },
  };
  for (const key of Object.keys(plans) as (keyof typeof DEMO_TENANTS)[]) {
    const tenantId = tenantIds[key];
    const p = plans[key];
    // demo billing is rewritten on every seed so the console always shows the same starting point
    await db.delete(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    const start = month(p.months);
    const [sub] = await db
      .insert(schema.subscriptions)
      .values({
        tenantId,
        planKey: p.planKey,
        status: p.lastPaid ? "active" : "past_due",
        provider: "mock",
        externalCustomerId: `mock_cus_${tenantId.slice(0, 8)}`,
        currency: p.currency,
        currentPeriodStart: month(0),
        currentPeriodEnd: month(-1),
        trialEndsAt: new Date(start.getTime() + 14 * 864e5),
        setupFeeMinor: p.setup,
      })
      .returning({ id: schema.subscriptions.id });
    const rows = [
      {
        number: `INV-${start.getUTCFullYear()}-0001`,
        kind: "setup",
        amountMinor: p.setup,
        lines: [{ kind: "setup", key: p.planKey, amountMinor: p.setup }],
        issuedAt: start,
        dueAt: new Date(start.getTime() + 7 * 864e5),
        paidAt: new Date(start.getTime() + 3 * 864e5) as Date | null,
        periodStart: null as Date | null,
        periodEnd: null as Date | null,
      },
    ];
    for (let m = p.months - 1; m >= 0; m--) {
      const issued = month(m);
      const isLast = m === 0;
      rows.push({
        number: `INV-${issued.getUTCFullYear()}-${String(rows.length + 1).padStart(4, "0")}`,
        kind: "subscription",
        amountMinor: p.monthly,
        lines:
          p.planKey === "growth"
            ? [
                { kind: "plan", key: "growth", amountMinor: PLANS.growth.monthlyPriceMinor },
                {
                  kind: "addon",
                  key: "addon.cod",
                  amountMinor: MODULES["addon.cod"].monthlyPriceMinor!,
                },
              ]
            : [{ kind: "plan", key: "starter", amountMinor: PLANS.starter.monthlyPriceMinor }],
        issuedAt: issued,
        dueAt: new Date(issued.getTime() + 7 * 864e5),
        paidAt: isLast && !p.lastPaid ? null : new Date(issued.getTime() + 2 * 864e5),
        periodStart: issued,
        periodEnd: month(m - 1),
      });
    }
    for (const r of rows)
      await db
        .insert(schema.invoices)
        .values({
          tenantId,
          subscriptionId: sub!.id,
          number: r.number,
          provider: "mock",
          externalId: `mock_in_${r.number}`,
          status: r.paidAt ? "paid" : "open",
          kind: r.kind,
          amountMinor: r.amountMinor,
          currency: p.currency,
          lines: r.lines,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          issuedAt: r.issuedAt,
          dueAt: r.dueAt,
          paidAt: r.paidAt,
        })
        .onConflictDoNothing();
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
    DEMO_USERS.filter((u) => u.memberships.some((m) => m.tenant === key))
      .map((u) => ctx.userIds[u.email]!)
      .filter(Boolean);
  return [
    {
      key: "northwind",
      tenantId: ctx.tenantIds.northwind,
      seed: 20261001,
      currency: "EUR",
      country: "IT",
      timezone: "Europe/Rome",
      locale: "it",
      orderNumberPrefix: "NW-",
      orderCount: Math.max(40, Math.round(15000 * scale)),
      productCount: Math.max(6, Math.round(120 * Math.min(1, scale * 4))),
      locationNames: ["Magazzino Milano", "Magazzino Bologna", "3PL Berlin"],
      supplierNames: [
        "Tessitura Lombarda",
        "Maglificio Dolomiti",
        "Confezioni Adriatica",
        "Pellami Toscani",
      ],
      metaCampaigns: Math.max(3, Math.round(25 * Math.min(1, scale * 4))),
      googleCampaigns: Math.max(1, Math.round(6 * Math.min(1, scale * 4))),
      codShare: 0.1,
      returnRate: 0.12,
      cancelRate: 0.06,
      userIds: members("northwind"),
      now,
    },
    {
      key: "harbor",
      tenantId: ctx.tenantIds.harbor,
      seed: 20261002,
      currency: "USD",
      country: "US",
      timezone: "America/New_York",
      locale: "en",
      orderNumberPrefix: "HH-",
      orderCount: Math.max(40, Math.round(6000 * scale)),
      productCount: Math.max(6, Math.round(60 * Math.min(1, scale * 4))),
      locationNames: ["Newark Warehouse", "LA Showroom"],
      supplierNames: ["Harbor Workshop", "Coastal Textiles"],
      metaCampaigns: Math.max(2, Math.round(8 * Math.min(1, scale * 4))),
      googleCampaigns: Math.max(1, Math.round(3 * Math.min(1, scale * 4))),
      codShare: 0,
      returnRate: 0.07,
      cancelRate: 0.045,
      userIds: members("harbor"),
      now,
    },
  ];
}

/** Platform + full domain dataset for both demo tenants. Idempotent: domain rows are regenerated. */
export async function seedDomain(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ctx: SeedContext,
  opts: SeedOptions = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  for (const cfg of tenantSeedConfigs(ctx, opts)) {
    // Wipe previous domain rows of this tenant (cascade from the parent tables).
    for (const table of [
      schema.backorders,
      schema.orders,
      schema.supplierPayments,
      schema.purchaseOrders,
      schema.suppliers,
      schema.segments,
      schema.customers,
      schema.inventoryMovements,
      schema.products,
      schema.locations,
      schema.campaigns,
      schema.discounts,
      schema.discountPools,
      schema.stateRules,
      schema.shipmentStatusMappings,
      schema.costSettings,
      schema.returnReasons,
      schema.notifications,
      schema.integrations,
      schema.integrationHealth,
      schema.webhookEvents,
      schema.syncRuns,
      schema.auditLogs,
      schema.codOperatorCapacity,
      schema.codCapacityExceptions,
      schema.codSettings,
      schema.codRecipientProfiles,
    ]) {
      await db.delete(table).where(eq(table.tenantId, cfg.tenantId));
    }
    const started = Date.now();
    const ds = generateTenantDataset(cfg);
    const genMs = Date.now() - started;
    const counts = await writeDataset(db, ds);
    if (cfg.key === "northwind") await seedCod(db, ctx, cfg.tenantId, opts.now ?? new Date());
    log(
      `[db:seed] ${cfg.key}: generated in ${genMs}ms, wrote ${Object.values(counts).reduce((a, b) => a + b, 0)} rows in ${Date.now() - started - genMs}ms (orders ${counts.orders}, lines ${counts.orderLines}, events ${counts.orderEvents})`,
    );
  }
}

/**
 * Demo rows for `addon.cod` on the tenant that has the add-on: operator capacity, a day off,
 * queue items for the open COD orders with a few attempts, and recipient profiles with risk tiers.
 * The live queue sync, scoring and risk recompute take over from here.
 */
async function seedCod(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ctx: SeedContext,
  tenantId: string,
  now: Date,
) {
  const rng = createRng(2026);
  const operators = ["ops@northwind.demo", "care@northwind.demo", "care2@northwind.demo"]
    .map((e) => ctx.userIds[e])
    .filter((x): x is string => Boolean(x));
  const hours = [
    [0, 8, 8, 8, 8, 8, 0],
    [0, 4, 4, 4, 4, 4, 0],
    [0, 6, 6, 0, 6, 6, 4],
  ];
  for (const [i, userId] of operators.entries())
    await db
      .insert(schema.codOperatorCapacity)
      .values({ tenantId, userId, dailyHours: hours[i]!, isActive: 1 })
      .onConflictDoNothing();
  if (operators[1])
    await db
      .insert(schema.codCapacityExceptions)
      .values({
        tenantId,
        userId: operators[1],
        date: new Date(now.getTime() + 2 * 864e5).toISOString().slice(0, 10),
        kind: "off",
        note: "Day off",
      })
      .onConflictDoNothing();
  await db
    .insert(schema.codSettings)
    .values({ tenantId, config: { queueCutoffDays: 60 } })
    .onConflictDoNothing();
  const open = await db.execute<{ id: string; placed_at: Date }>(
    sql`select o.id, o.placed_at from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('new','pending_review') and o.cancelled_at is null and not exists (select 1 from shipments s where s.order_id = o.id) and o.placed_at > ${new Date(now.getTime() - 60 * 864e5)} order by o.placed_at`,
  );
  // small test seeds may have no open COD order: fall back to recent COD orders as closed items so every table has rows
  const isOpen = open.rows.length > 0;
  const candidates = isOpen
    ? open.rows
    : (
        await db.execute<{ id: string; placed_at: Date }>(
          sql`select o.id, o.placed_at from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' order by o.placed_at desc limit 10`,
        )
      ).rows;
  for (const [i, o] of candidates.entries()) {
    const attempts = Math.max(
      i === 0 ? 1 : 0,
      rng.weighted([
        [0, 55],
        [1, 30],
        [2, 15],
      ] as const),
    );
    const assignedTo = attempts > 0 || rng.chance(0.5) ? rng.pick(operators) : null;
    const callBack = attempts > 0 && rng.chance(0.3);
    const enteredAt = new Date(o.placed_at);
    const [item] = await db
      .insert(schema.codQueueItems)
      .values({
        tenantId,
        orderId: o.id,
        status: !isOpen ? "left" : callBack ? "scheduled" : "pending",
        closedAt: isOpen ? null : now,
        assignedTo,
        assignedAt: assignedTo ? enteredAt : null,
        attemptsCount: attempts,
        noAnswerCount: callBack ? Math.max(0, attempts - 1) : attempts,
        lastAttemptAt: attempts ? new Date(enteredAt.getTime() + 3600e3 * attempts) : null,
        callBackAt: callBack ? new Date(now.getTime() + (i % 3 === 0 ? -2 : 6) * 3600e3) : null,
        enteredAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.codQueueItems.id });
    if (!item) continue;
    for (let n = 1; n <= attempts; n++)
      await db
        .insert(schema.codAttempts)
        .values({
          tenantId,
          queueItemId: item.id,
          orderId: o.id,
          operatorId: assignedTo,
          attemptNumber: n,
          outcome: callBack && n === attempts ? "call_back" : "no_answer",
          callBackAt: callBack && n === attempts ? new Date(now.getTime() + 6 * 3600e3) : null,
          createdAt: new Date(enteredAt.getTime() + 3600e3 * n),
        });
    if (assignedTo)
      await db
        .insert(schema.codAssignmentLog)
        .values({
          tenantId,
          orderId: o.id,
          assignedTo,
          source: "cron",
          reason: "auto",
          assignedAt: enteredAt,
        });
  }
  const returned = await db.execute<{
    phone: string | null;
    email: string | null;
    n: number;
    last: Date;
  }>(
    sql`select o.phone, o.email_normalized as email, count(*)::int as n, max(o.placed_at) as last from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('returned','refunded') and (o.phone is not null or o.email_normalized is not null) group by 1, 2 order by n desc limit 12`,
  );
  // small test seeds may have no returned COD order: profile a few recent recipients as "watch" so the table has rows
  const profiled =
    returned.rows.length > 0
      ? returned.rows
      : (
          await db.execute<{ phone: string | null; email: string | null; n: number; last: Date }>(
            sql`select o.phone, o.email_normalized as email, 1::int as n, max(o.placed_at) as last from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and (o.phone is not null or o.email_normalized is not null) group by 1, 2 order by last desc limit 3`,
          )
        ).rows;
  for (const r of profiled) {
    const key = r.phone
      ? (normalizePhone(r.phone, "IT") ?? `email:${r.email}`)
      : `email:${r.email}`;
    const weighted = r.n;
    const tier = weighted >= 3 ? "blacklisted" : weighted >= 2 ? "high_risk" : "watch";
    await db
      .insert(schema.codRecipientProfiles)
      .values({
        tenantId,
        recipientKey: key,
        ordersTotal: r.n + 1,
        ordersDelivered: 1,
        ordersReturned: r.n,
        weightedReturns: weighted,
        consecutiveDeliveries: 0,
        tier,
        lastReturnAt: new Date(r.last),
        computedAt: now,
      })
      .onConflictDoNothing();
  }
}

export async function seedAll(adminUrl: string, opts: SeedOptions = {}): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const db = drizzle(pool, { schema });
  try {
    const ctx = await seedPlatform(db);
    const check = await db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, DEMO_TENANTS.northwind.slug));
    if (check.length !== 1) throw new Error("seed sanity check failed");
    console.info(
      `[db:seed] platform: ${Object.keys(ctx.tenantIds).length} tenants, ${Object.keys(ctx.userIds).length} users`,
    );
    await seedDomain(db, ctx, { ...opts, log: console.info });
  } finally {
    await pool.end();
  }
}

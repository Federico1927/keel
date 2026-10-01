import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { generateTenantDataset, type TenantSeedConfig } from "./generator";
import { writeDataset } from "./writer";
import { createRng } from "@keel/integrations";
import { allocateLandedCost, normalizePhone } from "@keel/core";
import { MODULES, PLANS, PLATFORM_CURRENCY } from "@keel/config";
import { encryptJson } from "@keel/integrations";
import { sql } from "drizzle-orm";

/** Password of every demo user; override with KEEL_DEMO_PASSWORD on a hosted demo (an empty value keeps the default). */
export const DEMO_PASSWORD = process.env.KEEL_DEMO_PASSWORD || "keel-demo-2026";

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
    northwind: { planKey: "growth", monthly: PLANS.growth.monthlyPriceMinor + MODULES["addon.cod"].monthlyPriceMinor!, setup: PLANS.growth.setupFeeMinor, currency: PLATFORM_CURRENCY, months: 6, lastPaid: true },
    harbor: { planKey: "starter", monthly: PLANS.starter.monthlyPriceMinor, setup: PLANS.starter.setupFeeMinor, currency: PLATFORM_CURRENCY, months: 3, lastPaid: false },
  };
  for (const key of Object.keys(plans) as (keyof typeof DEMO_TENANTS)[]) {
    const tenantId = tenantIds[key];
    const p = plans[key];
    // demo billing is rewritten on every seed so the console always shows the same starting point
    await db.delete(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    const start = month(p.months);
    const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey: p.planKey, status: p.lastPaid ? "active" : "past_due", provider: "mock", externalCustomerId: `mock_cus_${tenantId.slice(0, 8)}`, currency: p.currency, currentPeriodStart: month(0), currentPeriodEnd: month(-1), trialEndsAt: new Date(start.getTime() + 14 * 864e5), setupFeeMinor: p.setup }).returning({ id: schema.subscriptions.id });
    const rows = [{ number: `INV-${start.getUTCFullYear()}-0001`, kind: "setup", amountMinor: p.setup, lines: [{ kind: "setup", key: p.planKey, amountMinor: p.setup }], issuedAt: start, dueAt: new Date(start.getTime() + 7 * 864e5), paidAt: new Date(start.getTime() + 3 * 864e5) as Date | null, periodStart: null as Date | null, periodEnd: null as Date | null }];
    for (let m = p.months - 1; m >= 0; m--) {
      const issued = month(m);
      const isLast = m === 0;
      rows.push({ number: `INV-${issued.getUTCFullYear()}-${String(rows.length + 1).padStart(4, "0")}`, kind: "subscription", amountMinor: p.monthly, lines: p.planKey === "growth" ? [{ kind: "plan", key: "growth", amountMinor: PLANS.growth.monthlyPriceMinor }, { kind: "addon", key: "addon.cod", amountMinor: MODULES["addon.cod"].monthlyPriceMinor! }] : [{ kind: "plan", key: "starter", amountMinor: PLANS.starter.monthlyPriceMinor }], issuedAt: issued, dueAt: new Date(issued.getTime() + 7 * 864e5), paidAt: isLast && !p.lastPaid ? null : new Date(issued.getTime() + 2 * 864e5), periodStart: issued, periodEnd: month(m - 1) });
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
    for (const table of [schema.backorders, schema.orders, schema.supplierPayments, schema.purchaseOrders, schema.suppliers, schema.segments, schema.customers, schema.inventoryMovements, schema.products, schema.locations, schema.campaigns, schema.discounts, schema.discountPools, schema.stateRules, schema.shipmentStatusMappings, schema.costSettings, schema.periodCosts, schema.touchpoints, schema.alertEvents, schema.alertRules, schema.customMetrics, schema.dashboards, schema.returnReasons, schema.notifications, schema.integrations, schema.integrationHealth, schema.webhookEvents, schema.syncRuns, schema.auditLogs, schema.codOperatorCapacity, schema.codCapacityExceptions, schema.codSettings, schema.codRecipientProfiles, schema.demandEvents, schema.returnPortalSettings, schema.publicRateLimits, schema.returnPolicies]) {
      await db.delete(table).where(eq(table.tenantId, cfg.tenantId));
    }
    const started = Date.now();
    const ds = generateTenantDataset(cfg);
    const genMs = Date.now() - started;
    const counts = await writeDataset(db, ds);
    if (cfg.key === "northwind") await seedCod(db, ctx, cfg.tenantId, opts.now ?? new Date());
    await seedAnalyticsExtras(db, ctx, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date());
    await seedPlanningExtras(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date());
    await seedReturnsExtras(db, cfg.key as keyof typeof DEMO_TENANTS, cfg.tenantId, opts.now ?? new Date());
    log(`[db:seed] ${cfg.key}: generated in ${genMs}ms, wrote ${Object.values(counts).reduce((a, b) => a + b, 0)} rows in ${Date.now() - started - genMs}ms (orders ${counts.orders}, lines ${counts.orderLines}, events ${counts.orderEvents})`);
  }
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

const REASON_LABELS: Record<string, Record<string, string>> = {
  wrong_size: { en: "Wrong size or fit", it: "Taglia sbagliata", es: "Talla incorrecta" },
  changed_mind: { en: "Changed my mind", it: "Ho cambiato idea", es: "He cambiado de opinión" },
  defective: { en: "Defective", it: "Difettoso", es: "Defectuoso" },
  damaged: { en: "Damaged in transit", it: "Danneggiato nel trasporto", es: "Dañado en el transporte" },
  not_as_described: { en: "Not as described", it: "Non conforme alla descrizione", es: "No coincide con la descripción" },
  wrong_item: { en: "Wrong item received", it: "Articolo sbagliato", es: "Artículo equivocado" },
  other: { en: "Other", it: "Altro", es: "Otro" },
};
const REASON_PLATFORM: Record<string, string> = { wrong_size: "SIZE_TOO_SMALL", changed_mind: "UNWANTED", defective: "DEFECTIVE", damaged: "DEFECTIVE", not_as_described: "NOT_AS_DESCRIBED", wrong_item: "WRONG_ITEM" };
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
  await db.insert(schema.returnPortalSettings).values({
    tenantId,
    config: {
      enabled: true,
      primaryColor: it ? "#1f3a5f" : "#3d5a40",
      title: it ? { it: "Reso o cambio", en: "Return or exchange", es: "Devolución o cambio" } : { en: "Start a return", es: "Iniciar una devolución", it: "Avvia un reso" },
      intro: it ? { it: "Hai 30 giorni dalla consegna. Ti servono il numero d'ordine e l'email usata per l'acquisto.", en: "You have 30 days from delivery. You need the order number and the email used for the purchase." } : { en: "You have 30 days from delivery to send items back. Have your order number and email at hand." },
      instructions: it ? { it: "Spedisci a: Northwind Apparel, Magazzino resi, Via dell'Industria 12, 40100 Bologna.\nImballa gli articoli nella confezione originale con il numero di reso all'esterno.", en: "Ship to: Northwind Apparel, Returns, Via dell'Industria 12, 40100 Bologna, Italy.\nPack the items in the original box with the return number on the outside." } : { en: "Ship to: Harbor Home Returns, 400 Dock St, Newark NJ 07105.\nUse a sturdy box and write the return number on the label." },
      successMessage: it ? { it: "Ti scriveremo appena il pacco arriva in magazzino.", en: "We will write to you as soon as the parcel reaches our warehouse." } : { en: "We will email you when your return arrives and is checked." },
      confirmText: it ? { it: "Confermo che gli articoli sono integri e con le etichette.", en: "I confirm the items are unworn and with their tags." } : {},
      resolutions: it ? ["refund", "exchange", "voucher"] : ["refund", "voucher"],
      bankDetailsFor: it ? ["cod", "bank_transfer"] : ["bank_transfer"],
      lookupBy: it ? "email_or_phone" : "email",
      tracking: it ? { mode: "optional", carriers: ["Poste Italiane", "DHL", "UPS"] } : { mode: "optional", carriers: ["UPS", "USPS", "FedEx"] },
      photos: { mode: "optional", max: 3 },
      supportEmail: it ? "assistenza@northwind.example" : "help@harborhome.example",
      fields: it
        ? [{ key: "worn", type: "checkbox", label: { it: "Ho provato il capo solo in casa", en: "I only tried the item on at home" }, required: false, options: [], optionLabels: {} }]
        : [{ key: "packaging", type: "select", label: { en: "Original packaging", es: "Embalaje original" }, required: true, options: ["yes", "partial", "no"], optionLabels: { yes: { en: "Yes, complete" }, partial: { en: "Partly" }, no: { en: "No" } } }],
    },
  });
  await db.insert(schema.publicRateLimits).values({ tenantId, key: "lookup:ip:demo", windowStart: now, count: 1 });
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
    if (Object.keys(patch).length) await db.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, r.id));
    if (portal && photos < 12 && i % 4 === 0) {
      await db.insert(schema.returnEvidence).values([1, 2].map((n) => ({ tenantId, returnId: r.id, sessionNonce: `seed-${i}-${n}`, contentType: "image/png", sizeBytes: DEMO_PHOTO.length, data: DEMO_PHOTO })));
      photos += 2;
    }
  }
  // return policy: longer windows abroad and for gifts, exclusions, final sale, limit, automations
  const types = (await db.selectDistinct({ v: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, tenantId))).map((x) => x.v).filter((x): x is string => Boolean(x)).sort();
  await db.insert(schema.returnPolicies).values({
    tenantId,
    policy: {
      windows: it
        ? [{ countries: ["DE", "AT", "FR", "ES"], productTypes: [], tags: [], days: 30 }, { countries: [], productTypes: [], tags: ["new"], days: 21 }]
        : [{ countries: [], productTypes: types.slice(0, 1), tags: [], days: 60 }, { countries: ["CA"], productTypes: [], tags: [], days: 45 }],
      exclusions: { productTypes: it ? [] : types.slice(-1), skuPrefixes: it ? ["GIFT-"] : [], titleContains: it ? ["gift card", "buono regalo"] : ["gift card"], tags: [] },
      finalSaleDiscountBps: it ? 5000 : 6000,
      customerLimit: it ? { count: 4, days: 90 } : null,
      risk: { days: 365, watchRateBps: 3000, highRateBps: 5000, minReturns: 3, quickReturnDays: 3, highValueMinor: it ? 40000 : 80000 },
      automations: [
        { id: "flag-risky", name: it ? "Segnala clienti a rischio" : "Flag risky customers", active: true, trigger: "created", action: "flag", fault: null, note: it ? "Controlla lo storico prima di approvare" : "Check the history before approving", conditions: { maxAmountMinor: null, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: [], productTypes: [], maxRisk: null, minRisk: "watch", firstReturnOnly: false } },
        { id: "keep-cheap", name: it ? "Tieni gli articoli economici danneggiati" : "Keep cheap damaged items", active: true, trigger: "created", action: "returnless", fault: null, note: null, conditions: { maxAmountMinor: it ? 1500 : 2500, minAmountMinor: null, reasonCodes: ["damaged", "defective"], resolutions: [], sources: [], productTypes: [], maxRisk: "watch", minRisk: null, firstReturnOnly: false } },
        { id: "approve-first", name: it ? "Approva il primo reso dal portale" : "Approve first portal returns", active: true, trigger: "created", action: "approve", fault: null, note: null, conditions: { maxAmountMinor: it ? 15000 : 30000, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: ["portal"], productTypes: [], maxRisk: "none", minRisk: null, firstReturnOnly: true } },
      ],
    },
  });
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
  const links = variants.map((v) => {
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
 * Demo rows for `addon.cod` on the tenant that has the add-on: operator capacity, a day off,
 * queue items for the open COD orders with a few attempts, and recipient profiles with risk tiers.
 * The live queue sync, scoring and risk recompute take over from here.
 */
async function seedCod(db: ReturnType<typeof drizzle<typeof schema>>, ctx: SeedContext, tenantId: string, now: Date) {
  const rng = createRng(2026);
  const operators = ["ops@northwind.demo", "care@northwind.demo", "care2@northwind.demo"].map((e) => ctx.userIds[e]).filter((x): x is string => Boolean(x));
  const hours = [[0, 8, 8, 8, 8, 8, 0], [0, 4, 4, 4, 4, 4, 0], [0, 6, 6, 0, 6, 6, 4]];
  // the third operator only handles modification requests: skill routing by tag
  for (const [i, userId] of operators.entries()) await db.insert(schema.codOperatorCapacity).values({ tenantId, userId, dailyHours: hours[i]!, isActive: 1, allowedTags: i === 2 ? ["Richiesta modifica", "Da chiamare"] : [] }).onConflictDoNothing();
  if (operators[1]) await db.insert(schema.codCapacityExceptions).values({ tenantId, userId: operators[1], date: new Date(now.getTime() + 2 * 864e5).toISOString().slice(0, 10), kind: "off", note: "Day off" }).onConflictDoNothing();
  const tags = {
    queue: ["Da confermare", "Da chiamare", "Richiesta modifica"],
    confirmed: ["Confermato", "Già pagato*"],
    cancelled: ["Annullato*", "Da annullare"],
    clearQueueTagsOnClose: true,
    write: {
      entered: { add: ["Da confermare"], remove: [] },
      confirmed: { add: ["Confermato"], remove: [] },
      no_answer: { add: [], remove: [] },
      call_back: { add: ["Da chiamare"], remove: ["Da confermare"] },
      modified: { add: ["Richiesta modifica"], remove: [] },
      cancelled: { add: ["Annullato"], remove: ["Confermato"] },
      unreachable: { add: ["Non raggiungibile"], remove: [] },
      replaced: { add: ["Annullato per variazione"], remove: ["Confermato"] },
    },
  };
  await db.insert(schema.codSettings).values({ tenantId, config: { queueCutoffDays: 60, tags } }).onConflictDoNothing();
  const open = await db.execute<{ id: string; placed_at: Date }>(sql`select o.id, o.placed_at from orders o where o.tenant_id = ${tenantId} and o.payment_method = 'cod' and o.status in ('new','pending_review') and o.cancelled_at is null and not exists (select 1 from shipments s where s.order_id = o.id) and o.placed_at > ${new Date(now.getTime() - 60 * 864e5)} order by o.placed_at`);
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
  }
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

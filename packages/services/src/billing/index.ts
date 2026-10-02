import { and, desc, eq, inArray, recordAudit, schema, sql, withTenant, type Database } from "@keel/db";
import { DEFAULT_SUSPEND_AFTER_DAYS, MODULES, PLANS, type PlanKey, isAddonModule } from "@keel/config";
import { addMonths, defaultStateRules, displayName, normalizeEmail, monthlyInvoiceLines, mrr, paymentHealth, setupInvoiceLines, type PaymentHealth } from "@keel/core";
import { getBillingProvider, type BillingProvider } from "./provider";
import { createInvitation, pendingInvitationCount } from "../account/invitations";

export * from "./provider";

/** Every call here runs on the admin connection: platform tables are not tenant data. */
export type AdminDb = Database;

const audit = (db: AdminDb, actorUserId: string | null, tenantId: string | null, action: string, extra: { entityType?: string; entityId?: string; diff?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}) => recordAudit(db, { tenantId, actorUserId, actorType: actorUserId ? "super_admin" : "system", action, ...extra });

async function nextInvoiceNumber(db: AdminDb, tenantId: string, now: Date): Promise<string> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
  return `INV-${now.getUTCFullYear()}-${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
}

async function activeAddonKeys(db: AdminDb, tenantId: string): Promise<string[]> {
  return (await db.select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true)))).map((r) => r.k);
}

async function createInvoice(db: AdminDb, provider: BillingProvider, tenant: { id: string; name: string; currency: string }, sub: { id: string; externalCustomerId: string | null } | null, input: { kind: "setup" | "subscription" | "adjustment"; lines: { kind: string; key: string; amountMinor: number }[]; dueAt: Date; periodStart?: Date | null; periodEnd?: Date | null; now: Date }) {
  const amount = input.lines.reduce((s, l) => s + l.amountMinor, 0);
  const number = await nextInvoiceNumber(db, tenant.id, input.now);
  let externalId: string | null = null;
  let hostedUrl: string | null = null;
  if (amount > 0) {
    const customerId = sub?.externalCustomerId ?? (await provider.ensureCustomer({ id: tenant.id, name: tenant.name }));
    const created = await provider.createInvoice({ customerId, number, currency: tenant.currency, lines: input.lines.map((l) => ({ key: l.key, label: `${l.kind}:${l.key}`, amountMinor: l.amountMinor })), dueAt: input.dueAt });
    externalId = created.externalId;
    hostedUrl = created.hostedUrl;
  }
  const [row] = await db.insert(schema.invoices).values({ tenantId: tenant.id, subscriptionId: sub?.id ?? null, number, provider: provider.provider, externalId, hostedUrl, status: amount > 0 ? "open" : "paid", kind: input.kind, amountMinor: amount, currency: tenant.currency, lines: input.lines, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, issuedAt: input.now, dueAt: input.dueAt, paidAt: amount > 0 ? null : input.now }).returning();
  return row!;
}

/** Trial subscription + setup-fee invoice for a new or plan-less tenant. */
export async function ensureSubscription(db: AdminDb, tenantId: string, opts: { planKey?: PlanKey; now?: Date; trialDays?: number; provider?: BillingProvider; actorUserId?: string | null } = {}) {
  const now = opts.now ?? new Date();
  const [existing] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (existing) return existing;
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error("tenant_not_found");
  const planKey = opts.planKey ?? (tenant.planKey as PlanKey);
  const provider = opts.provider ?? getBillingProvider();
  const trialDays = opts.trialDays ?? 14;
  const customerId = await provider.ensureCustomer({ id: tenant.id, name: tenant.name });
  const periodEnd = new Date(now.getTime() + trialDays * 864e5);
  const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey, status: "trialing", provider: provider.provider, externalCustomerId: customerId, currency: PLANS[planKey].currency, currentPeriodStart: now, currentPeriodEnd: periodEnd, trialEndsAt: periodEnd, setupFeeMinor: PLANS[planKey].setupFeeMinor }).returning();
  await createInvoice(db, provider, { id: tenant.id, name: tenant.name, currency: PLANS[planKey].currency }, sub!, { kind: "setup", lines: setupInvoiceLines(planKey), dueAt: new Date(now.getTime() + 7 * 864e5), now });
  await audit(db, opts.actorUserId ?? null, tenantId, "billing.subscription_created", { entityType: "subscription", entityId: sub!.id, diff: { planKey: { from: null, to: planKey }, status: { from: null, to: "trialing" } } });
  return sub!;
}

/** Monthly run: every subscription whose period ended gets an invoice for the next period. Idempotent per period. */
export async function issueDueInvoices(db: AdminDb, opts: { now?: Date; provider?: BillingProvider; actorUserId?: string | null } = {}): Promise<{ issued: number }> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? getBillingProvider();
  const subs = await db.select({ sub: schema.subscriptions, tenant: schema.tenants }).from(schema.subscriptions).innerJoin(schema.tenants, eq(schema.tenants.id, schema.subscriptions.tenantId)).where(and(inArray(schema.subscriptions.status, ["trialing", "active", "past_due"]), sql`${schema.subscriptions.currentPeriodEnd} <= ${now}`));
  let issued = 0;
  for (const { sub, tenant } of subs) {
    if (tenant.status === "churned") continue;
    const addons = await activeAddonKeys(db, tenant.id);
    const lines = monthlyInvoiceLines(sub.planKey as PlanKey, addons);
    const periodStart = sub.currentPeriodEnd;
    const periodEnd = addMonths(periodStart, 1);
    await createInvoice(db, provider, { id: tenant.id, name: tenant.name, currency: sub.currency }, sub, { kind: "subscription", lines, dueAt: new Date(periodStart.getTime() + 7 * 864e5), periodStart, periodEnd, now });
    await db.update(schema.subscriptions).set({ currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, status: sub.status === "trialing" ? "active" : sub.status, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    issued++;
  }
  if (issued) await audit(db, opts.actorUserId ?? null, null, "billing.invoices_issued", { metadata: { issued } });
  return { issued };
}

export async function recordInvoicePayment(db: AdminDb, invoiceId: string, actorUserId: string | null, now = new Date()): Promise<void> {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
  if (!inv || inv.status === "paid") return;
  await db.update(schema.invoices).set({ status: "paid", paidAt: now }).where(eq(schema.invoices.id, invoiceId));
  await audit(db, actorUserId, inv.tenantId, "billing.invoice_paid", { entityType: "invoice", entityId: inv.id, diff: { status: { from: inv.status, to: "paid" } } });
  await refreshTenantPaymentState(db, inv.tenantId, now, actorUserId);
}

export async function voidInvoice(db: AdminDb, invoiceId: string, actorUserId: string | null, now = new Date()): Promise<void> {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
  if (!inv || inv.status !== "open") return;
  await db.update(schema.invoices).set({ status: "void", voidedAt: now }).where(eq(schema.invoices.id, invoiceId));
  await audit(db, actorUserId, inv.tenantId, "billing.invoice_voided", { entityType: "invoice", entityId: inv.id });
  await refreshTenantPaymentState(db, inv.tenantId, now, actorUserId);
}

export async function tenantPaymentStatus(db: AdminDb, tenantId: string, now = new Date()): Promise<{ health: PaymentHealth; daysOverdue: number; openMinor: number }> {
  const [tenant] = await db.select({ suspendAfterDays: schema.tenants.suspendAfterDays }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const invs = await db.select({ status: schema.invoices.status, dueAt: schema.invoices.dueAt, amountMinor: schema.invoices.amountMinor }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
  const h = paymentHealth(invs, now, tenant?.suspendAfterDays ?? DEFAULT_SUSPEND_AFTER_DAYS);
  return { ...h, openMinor: invs.filter((i) => i.status === "open").reduce((s, i) => s + i.amountMinor, 0) };
}

/** Suspends after the grace period, marks past due before it, reactivates when nothing is overdue. */
export async function refreshTenantPaymentState(db: AdminDb, tenantId: string, now: Date, actorUserId: string | null): Promise<PaymentHealth> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant || tenant.status === "churned") return "none";
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const { health } = await tenantPaymentStatus(db, tenantId, now);
  const manual = (tenant.settings as { manualSuspension?: boolean } | null)?.manualSuspension === true;
  if (health === "suspended" && tenant.status !== "suspended") {
    await db.update(schema.tenants).set({ status: "suspended", suspendedAt: now, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
    if (sub) await db.update(schema.subscriptions).set({ status: "suspended", updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    await audit(db, actorUserId, tenantId, "tenant.suspended", { entityType: "tenant", entityId: tenantId, diff: { status: { from: tenant.status, to: "suspended" } }, metadata: { reason: "unpaid_invoice" } });
  } else if (health === "past_due" && sub && sub.status !== "past_due") {
    await db.update(schema.subscriptions).set({ status: "past_due", updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
  } else if ((health === "ok" || health === "none") && tenant.status === "suspended" && !manual) {
    await db.update(schema.tenants).set({ status: "active", suspendedAt: null, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
    if (sub) await db.update(schema.subscriptions).set({ status: sub.trialEndsAt && sub.trialEndsAt > now ? "trialing" : "active", updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    await audit(db, actorUserId, tenantId, "tenant.reactivated", { entityType: "tenant", entityId: tenantId, diff: { status: { from: "suspended", to: "active" } } });
  } else if (health === "ok" && sub && sub.status === "past_due") {
    await db.update(schema.subscriptions).set({ status: "active", updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
  }
  return health;
}

export async function applySuspensions(db: AdminDb, opts: { now?: Date; actorUserId?: string | null } = {}): Promise<{ checked: number; suspended: number }> {
  const now = opts.now ?? new Date();
  const tenants = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(inArray(schema.tenants.status, ["active", "trial", "suspended"]));
  let suspended = 0;
  for (const t of tenants) if ((await refreshTenantPaymentState(db, t.id, now, opts.actorUserId ?? null)) === "suspended") suspended++;
  return { checked: tenants.length, suspended };
}

export async function setTenantSuspension(db: AdminDb, tenantId: string, suspend: boolean, actorUserId: string, note?: string, now = new Date()): Promise<void> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error("tenant_not_found");
  const settings = { ...(tenant.settings as Record<string, unknown>), manualSuspension: suspend };
  await db.update(schema.tenants).set({ status: suspend ? "suspended" : "active", suspendedAt: suspend ? now : null, settings, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
  await audit(db, actorUserId, tenantId, suspend ? "tenant.suspended" : "tenant.reactivated", { entityType: "tenant", entityId: tenantId, diff: { status: { from: tenant.status, to: suspend ? "suspended" : "active" } }, metadata: { reason: "manual", note: note ?? null } });
}

/* ---------- plans and add-ons ---------- */

export async function setTenantPlan(db: AdminDb, tenantId: string, planKey: PlanKey, actorUserId: string, now = new Date()): Promise<void> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error("tenant_not_found");
  await db.update(schema.tenants).set({ planKey, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
  await db.update(schema.subscriptions).set({ planKey, updatedAt: now }).where(eq(schema.subscriptions.tenantId, tenantId));
  await audit(db, actorUserId, tenantId, "tenant.plan_changed", { entityType: "tenant", entityId: tenantId, diff: { planKey: { from: tenant.planKey, to: planKey } } });
}

export async function setTenantAddon(db: AdminDb, tenantId: string, moduleKey: string, active: boolean, actorUserId: string, note?: string | null, now = new Date()): Promise<void> {
  if (!isAddonModule(moduleKey) || MODULES[moduleKey].availability !== "implemented") throw new Error("addon_not_available");
  const [existing] = await db.select().from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, moduleKey))).limit(1);
  if (existing) await db.update(schema.tenantAddons).set({ isActive: active, activatedAt: active ? now : existing.activatedAt, deactivatedAt: active ? null : now, note: note ?? existing.note, activatedBy: actorUserId, updatedAt: now }).where(eq(schema.tenantAddons.id, existing.id));
  else if (active) await db.insert(schema.tenantAddons).values({ tenantId, moduleKey, isActive: true, activatedAt: now, note: note ?? null, activatedBy: actorUserId });
  await audit(db, actorUserId, tenantId, active ? "tenant.addon_enabled" : "tenant.addon_disabled", { entityType: "tenant_addon", entityId: moduleKey, diff: { isActive: { from: existing?.isActive ?? false, to: active } }, metadata: { note: note ?? null } });
}

/* ---------- tenant creation and checklist ---------- */

export interface CreateTenantInput {
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  defaultLocale: string;
  orderNumberPrefix: string;
  planKey: PlanKey;
  taxRateBps: number;
  ownerEmail: string;
  ownerName: string;
}

/**
 * Creates a tenant with its defaults and a trial subscription. The owner gets an invitation, the
 * same flow as any other member (#52): the super-admin never sees or sets a password.
 */
export async function createTenant(db: AdminDb, input: CreateTenantInput, actorUserId: string, opts: { now?: Date; provider?: BillingProvider } = {}): Promise<{ tenantId: string; invitationId: string; ownerEmail: string; delivery: string }> {
  const now = opts.now ?? new Date();
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("invalid_slug");
  const [dup] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (dup) throw new Error("slug_taken");
  const email = normalizeEmail(input.ownerEmail);
  if (!email) throw new Error("invalid_owner_email");
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: input.name.trim(), country: input.country.toUpperCase(), currency: input.currency.toUpperCase(), timezone: input.timezone, defaultLocale: input.defaultLocale, orderNumberPrefix: input.orderNumberPrefix, planKey: input.planKey, status: "trial", suspendAfterDays: DEFAULT_SUSPEND_AFTER_DAYS }).returning({ id: schema.tenants.id });
  const tenantId = tenant!.id;
  await db.insert(schema.tenantTaxRates).values({ tenantId, country: input.country.toUpperCase(), rateBps: input.taxRateBps, pricesIncludeTax: input.country.toUpperCase() !== "US" }).onConflictDoNothing();
  for (const r of defaultStateRules()) await db.insert(schema.stateRules).values({ tenantId, name: r.name, priority: r.priority, conditions: r.conditions, resultStatus: r.resultStatus, isActive: r.isActive });
  for (const provider of ["shopify", "meta", "google"]) await db.insert(schema.integrations).values({ tenantId, provider, status: "not_connected", mode: "mock" }).onConflictDoNothing();
  await ensureSubscription(db, tenantId, { planKey: input.planKey, now, provider: opts.provider, actorUserId });
  await audit(db, actorUserId, tenantId, "tenant.created", { entityType: "tenant", entityId: tenantId, diff: { name: { from: null, to: input.name }, planKey: { from: null, to: input.planKey }, owner: { from: null, to: email } } });
  const [admin] = await db.select({ name: schema.users.name, preferredName: schema.users.preferredName, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, actorUserId)).limit(1);
  const invite = await withTenant(
    tenantId,
    (tx) => createInvitation({ tenantId, tx, actor: { type: "user", userId: actorUserId }, now }, { email, role: "owner", name: input.ownerName, inviterName: displayName(admin ?? null), tenantName: input.name.trim(), tenantLocale: input.defaultLocale }, { auditAs: { actorUserId, actorType: "super_admin" } }),
    db,
  );
  return { tenantId, invitationId: invite.id, ownerEmail: email, delivery: invite.delivery };
}

export interface ChecklistItem {
  key: "company" | "owner" | "users" | "shopify" | "meta" | "google" | "state_rules" | "costs" | "billing";
  done: boolean;
  detail: string | null;
}

export async function tenantChecklist(db: AdminDb, tenantId: string, now = new Date()): Promise<ChecklistItem[]> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) return [];
  const members = await db.select({ role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, tenantId), eq(schema.tenantMemberships.isActive, true)));
  const integrations = await db.select({ provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId));
  const [rules] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stateRules).where(and(eq(schema.stateRules.tenantId, tenantId), eq(schema.stateRules.isActive, true)));
  const [costs] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.costSettings).where(eq(schema.costSettings.tenantId, tenantId));
  const pay = await tenantPaymentStatus(db, tenantId, now);
  const status = (p: string) => integrations.find((i) => i.provider === p)?.status ?? "not_connected";
  return [
    { key: "company", done: Boolean(tenant.name && tenant.country && tenant.currency && tenant.timezone), detail: `${tenant.country} · ${tenant.currency} · ${tenant.timezone}` },
    { key: "owner", done: members.some((m) => m.role === "owner"), detail: !members.some((m) => m.role === "owner") && (await pendingInvitationCount(db, tenantId, "owner", now)) > 0 ? "invited" : null },
    { key: "users", done: members.length >= 2, detail: String(members.length) },
    { key: "shopify", done: status("shopify") === "connected", detail: status("shopify") },
    { key: "meta", done: status("meta") === "connected", detail: status("meta") },
    { key: "google", done: status("google") === "connected", detail: status("google") },
    { key: "state_rules", done: (rules?.n ?? 0) > 0, detail: String(rules?.n ?? 0) },
    { key: "costs", done: (costs?.n ?? 0) > 0, detail: String(costs?.n ?? 0) },
    { key: "billing", done: pay.health === "ok", detail: pay.health },
  ];
}

/* ---------- console views ---------- */

export interface TenantOverviewRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  planKey: string;
  country: string;
  currency: string;
  addons: string[];
  integrations: { provider: string; status: string }[];
  ordersLast30: number;
  lastLoginAt: Date | null;
  payment: PaymentHealth;
  openMinor: number;
  createdAt: Date;
}

export async function tenantsOverview(db: AdminDb, now = new Date()): Promise<TenantOverviewRow[]> {
  const tenants = await db.select().from(schema.tenants).orderBy(schema.tenants.name);
  if (!tenants.length) return [];
  const ids = tenants.map((t) => t.id);
  const addons = await db.select({ tenantId: schema.tenantAddons.tenantId, key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(inArray(schema.tenantAddons.tenantId, ids), eq(schema.tenantAddons.isActive, true)));
  const integrations = await db.select({ tenantId: schema.integrations.tenantId, provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(and(inArray(schema.integrations.tenantId, ids), inArray(schema.integrations.provider, ["shopify", "meta", "google"])));
  const orders = await db.select({ tenantId: schema.orders.tenantId, n: sql<number>`count(*)::int` }).from(schema.orders).where(and(inArray(schema.orders.tenantId, ids), sql`${schema.orders.placedAt} > ${new Date(now.getTime() - 30 * 864e5)}`, sql`${schema.orders.status} <> 'cancelled'`)).groupBy(schema.orders.tenantId);
  const logins = await db.select({ tenantId: schema.tenantMemberships.tenantId, last: sql<Date | null>`max(${schema.users.lastLoginAt})` }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(inArray(schema.tenantMemberships.tenantId, ids)).groupBy(schema.tenantMemberships.tenantId);
  const invs = await db.select({ tenantId: schema.invoices.tenantId, status: schema.invoices.status, dueAt: schema.invoices.dueAt, amountMinor: schema.invoices.amountMinor }).from(schema.invoices).where(inArray(schema.invoices.tenantId, ids));
  return tenants.map((t) => {
    const mine = invs.filter((i) => i.tenantId === t.id);
    const pay = paymentHealth(mine, now, t.suspendAfterDays);
    const last = logins.find((l) => l.tenantId === t.id)?.last ?? null;
    return { id: t.id, slug: t.slug, name: t.name, status: t.status, planKey: t.planKey, country: t.country, currency: t.currency, addons: addons.filter((a) => a.tenantId === t.id).map((a) => a.key), integrations: integrations.filter((i) => i.tenantId === t.id).map((i) => ({ provider: i.provider, status: i.status })), ordersLast30: orders.find((o) => o.tenantId === t.id)?.n ?? 0, lastLoginAt: last ? new Date(last) : null, payment: pay.health, openMinor: mine.filter((i) => i.status === "open").reduce((s, i) => s + i.amountMinor, 0), createdAt: t.createdAt };
  });
}

export async function platformMetrics(db: AdminDb, now = new Date()) {
  const subs = await db.select({ status: schema.subscriptions.status, planKey: schema.subscriptions.planKey, tenantId: schema.subscriptions.tenantId }).from(schema.subscriptions);
  const addons = await db.select({ tenantId: schema.tenantAddons.tenantId, key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(eq(schema.tenantAddons.isActive, true));
  const tenants = await db.select({ status: schema.tenants.status }).from(schema.tenants);
  const [errors] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.integrationHealth).where(inArray(schema.integrationHealth.status, ["error", "degraded"]));
  const [openInv] = await db.select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${schema.invoices.amountMinor}),0)::int`, overdue: sql<number>`count(*) filter (where ${schema.invoices.dueAt} < ${now})::int` }).from(schema.invoices).where(eq(schema.invoices.status, "open"));
  const [paid30] = await db.select({ amount: sql<number>`coalesce(sum(${schema.invoices.amountMinor}),0)::int` }).from(schema.invoices).where(and(eq(schema.invoices.status, "paid"), sql`${schema.invoices.paidAt} > ${new Date(now.getTime() - 30 * 864e5)}`));
  const addonCounts = Object.entries(addons.reduce<Record<string, number>>((acc, a) => ((acc[a.key] = (acc[a.key] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  return {
    mrrMinor: mrr(subs.map((s) => ({ status: s.status, planKey: s.planKey as PlanKey, addons: addons.filter((a) => a.tenantId === s.tenantId).map((a) => a.key) }))),
    tenants: { total: tenants.length, active: tenants.filter((t) => t.status === "active").length, trial: tenants.filter((t) => t.status === "trial").length, suspended: tenants.filter((t) => t.status === "suspended").length, churned: tenants.filter((t) => t.status === "churned").length },
    subscriptions: { trialing: subs.filter((s) => s.status === "trialing").length, active: subs.filter((s) => s.status === "active").length, pastDue: subs.filter((s) => s.status === "past_due").length },
    addons: addonCounts,
    integrationErrors: errors?.n ?? 0,
    invoices: { open: openInv?.n ?? 0, openMinor: openInv?.amount ?? 0, overdue: openInv?.overdue ?? 0, paidLast30Minor: paid30?.amount ?? 0 },
  };
}

export async function tenantAdminDetail(db: AdminDb, tenantId: string, now = new Date()) {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const invoiceRows = await db.select().from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)).orderBy(desc(schema.invoices.issuedAt)).limit(50);
  const addons = await db.select().from(schema.tenantAddons).where(eq(schema.tenantAddons.tenantId, tenantId));
  const members = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.tenantMemberships.role, lastLoginAt: schema.users.lastLoginAt, isActive: schema.tenantMemberships.isActive }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, tenantId)).orderBy(schema.users.email);
  const integrations = await db.select().from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId));
  const health = await db.select().from(schema.integrationHealth).where(eq(schema.integrationHealth.tenantId, tenantId));
  const checklist = await tenantChecklist(db, tenantId, now);
  const payment = await tenantPaymentStatus(db, tenantId, now);
  const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.tenantId, tenantId)).orderBy(desc(schema.auditLogs.createdAt)).limit(20);
  const [orders30] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), sql`${schema.orders.placedAt} > ${new Date(now.getTime() - 30 * 864e5)}`));
  return { tenant, subscription: subscription ?? null, invoices: invoiceRows, addons, members, integrations, health, checklist, payment, audit: auditRows, ordersLast30: orders30?.n ?? 0 };
}

export async function listInvoices(db: AdminDb, opts: { status?: string; limit?: number } = {}) {
  const conds = opts.status ? [eq(schema.invoices.status, opts.status)] : [];
  return db.select({ invoice: schema.invoices, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.invoices.issuedAt)).limit(opts.limit ?? 100);
}

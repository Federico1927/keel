import { and, desc, eq, inArray, isNull, recordAudit, schema, sql, withTenant, type Database } from "@keel/db";
import { DEFAULT_SUSPEND_AFTER_DAYS, DEFAULT_TRIAL_DAYS, OPERATIONAL_TENANT_STATUSES, PLANS, type PlanKey, SOURCE_ERROR_STATUSES } from "@keel/config";
import { addMonths, defaultStateRules, displayName, normalizeEmail, monthlyInvoiceLines, mrr, paymentHealth, setupInvoiceLines, tenantHealth, type PaymentHealth, type TenantHealth } from "@keel/core";
import { getBillingProvider, type BillingProvider } from "./provider";
import { refreshTenantPaymentState, tenantPaymentStatus } from "./payment-state";
import { createInvitation, pendingInvitationCount } from "../account/invitations";
import { dataRetainedUntil, lifecycleHistory, recordLifecycleEvent, transitionTenant } from "./lifecycle";
import type { TenantBranding } from "../branding";
import { failedJobsByTenant } from "../reliability/jobs";

export * from "./provider";
export * from "./lifecycle";
export * from "./payment-state";
export * from "./subscriptions";
export * from "./plan";
export * from "./mirror";

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
    const customerId = sub?.externalCustomerId ?? (await provider.ensureCustomer({ tenantId: tenant.id, name: tenant.name }));
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
  const trialDays = opts.trialDays ?? DEFAULT_TRIAL_DAYS;
  const customerId = await provider.ensureCustomer({ tenantId: tenant.id, name: tenant.name });
  const periodEnd = tenant.trialEndsAt && tenant.trialEndsAt > now ? tenant.trialEndsAt : new Date(now.getTime() + trialDays * 864e5);
  const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey, status: "trialing", provider: provider.provider, externalCustomerId: customerId, currency: PLANS[planKey].currency, currentPeriodStart: now, currentPeriodEnd: periodEnd, trialEndsAt: periodEnd, setupFeeMinor: PLANS[planKey].setupFeeMinor }).returning();
  await createInvoice(db, provider, { id: tenant.id, name: tenant.name, currency: PLANS[planKey].currency }, sub!, { kind: "setup", lines: setupInvoiceLines(planKey), dueAt: new Date(now.getTime() + 7 * 864e5), now });
  await audit(db, opts.actorUserId ?? null, tenantId, "billing.subscription_created", { entityType: "subscription", entityId: sub!.id, diff: { planKey: { from: null, to: planKey }, status: { from: null, to: "trialing" } } });
  return sub!;
}

/** Monthly run of the Keel ledger: every subscription whose period ended gets an invoice for the next period. Idempotent per period. Subscriptions on a processor (Stripe, or the mock simulating it) are invoiced there and mirrored by webhooks. */
export async function issueDueInvoices(db: AdminDb, opts: { now?: Date; provider?: BillingProvider; actorUserId?: string | null } = {}): Promise<{ issued: number }> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? getBillingProvider();
  const subs = await db.select({ sub: schema.subscriptions, tenant: schema.tenants }).from(schema.subscriptions).innerJoin(schema.tenants, eq(schema.tenants.id, schema.subscriptions.tenantId)).where(and(inArray(schema.subscriptions.status, ["trialing", "active", "past_due"]), isNull(schema.subscriptions.externalSubscriptionId), sql`${schema.subscriptions.currentPeriodEnd} <= ${now}`));
  let issued = 0;
  for (const { sub, tenant } of subs) {
    if (tenant.status === "churned") continue;
    const addons = await activeAddonKeys(db, tenant.id);
    const lines = monthlyInvoiceLines(sub.planKey as PlanKey, addons);
    const periodStart = sub.currentPeriodEnd;
    const periodEnd = addMonths(periodStart, 1);
    await createInvoice(db, provider, { id: tenant.id, name: tenant.name, currency: sub.currency }, sub, { kind: "subscription", lines, dueAt: new Date(periodStart.getTime() + 7 * 864e5), periodStart, periodEnd, now });
    await db.update(schema.subscriptions).set({ currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, status: sub.status === "trialing" ? "active" : sub.status, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    // the first paid period ends the trial: the lifecycle follows (independent of the provider)
    if (tenant.status === "trial") await transitionTenant(db, tenant.id, { to: "active", reason: "trial_converted", note: null, actorUserId: opts.actorUserId ?? null, now });
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

export async function applySuspensions(db: AdminDb, opts: { now?: Date; actorUserId?: string | null } = {}): Promise<{ checked: number; suspended: number }> {
  const now = opts.now ?? new Date();
  const tenants = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(inArray(schema.tenants.status, [...OPERATIONAL_TENANT_STATUSES, "suspended"]));
  let suspended = 0;
  for (const t of tenants) if ((await refreshTenantPaymentState(db, t.id, now, opts.actorUserId ?? null)) === "suspended") suspended++;
  return { checked: tenants.length, suspended };
}

/** Manual suspension from the console (kept for callers that only toggle); the lifecycle dialog uses `transitionTenant`. */
export async function setTenantSuspension(db: AdminDb, tenantId: string, suspend: boolean, actorUserId: string, note?: string, now = new Date()): Promise<void> {
  await transitionTenant(db, tenantId, { to: suspend ? "suspended" : "active", reason: suspend ? "manual" : "payment_recovered", note: note ?? null, actorUserId, now, manual: suspend });
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
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: input.name.trim(), country: input.country.toUpperCase(), currency: input.currency.toUpperCase(), timezone: input.timezone, defaultLocale: input.defaultLocale, orderNumberPrefix: input.orderNumberPrefix, planKey: input.planKey, status: "trial", suspendAfterDays: DEFAULT_SUSPEND_AFTER_DAYS, trialEndsAt: new Date(now.getTime() + DEFAULT_TRIAL_DAYS * 864e5), statusReason: "tenant_created", statusChangedAt: now }).returning({ id: schema.tenants.id });
  const tenantId = tenant!.id;
  await db.insert(schema.tenantTaxRates).values({ tenantId, country: input.country.toUpperCase(), rateBps: input.taxRateBps, pricesIncludeTax: input.country.toUpperCase() !== "US" }).onConflictDoNothing();
  for (const r of defaultStateRules()) await db.insert(schema.stateRules).values({ tenantId, name: r.name, priority: r.priority, conditions: r.conditions, resultStatus: r.resultStatus, isActive: r.isActive });
  for (const provider of ["shopify", "meta", "google"]) await db.insert(schema.integrations).values({ tenantId, provider, status: "not_connected", mode: "mock" }).onConflictDoNothing();
  await ensureSubscription(db, tenantId, { planKey: input.planKey, now, provider: opts.provider, actorUserId });
  await recordLifecycleEvent(db, tenantId, { from: null, to: "trial", reason: "tenant_created", actorUserId, now });
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
  statusReason: string | null;
  planKey: string;
  country: string;
  currency: string;
  addons: string[];
  integrations: { provider: string; status: string }[];
  ordersLast30: number;
  lastLoginAt: Date | null;
  payment: PaymentHealth;
  openMinor: number;
  daysOverdue: number;
  /** Monthly charge counted in MRR (0 unless the subscription is billable). */
  mrrMinor: number;
  trialEndsAt: Date | null;
  churnedAt: Date | null;
  integrationErrors: number;
  failedJobs: number;
  health: TenantHealth;
  createdAt: Date;
}

/** Every tenant with the numbers the console shows and sorts by (platform-sized: computed in one pass). */
export async function tenantsOverview(db: AdminDb, now = new Date()): Promise<TenantOverviewRow[]> {
  const tenants = await db.select().from(schema.tenants).orderBy(schema.tenants.name);
  if (!tenants.length) return [];
  const ids = tenants.map((t) => t.id);
  const addons = await db.select({ tenantId: schema.tenantAddons.tenantId, key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(inArray(schema.tenantAddons.tenantId, ids), eq(schema.tenantAddons.isActive, true)));
  const integrations = await db.select({ tenantId: schema.integrations.tenantId, provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(and(inArray(schema.integrations.tenantId, ids), inArray(schema.integrations.provider, ["shopify", "meta", "google"])));
  const orders = await db.select({ tenantId: schema.orders.tenantId, n: sql<number>`count(*)::int` }).from(schema.orders).where(and(inArray(schema.orders.tenantId, ids), sql`${schema.orders.placedAt} > ${new Date(now.getTime() - 30 * 864e5)}`, sql`${schema.orders.status} <> 'cancelled'`)).groupBy(schema.orders.tenantId);
  const logins = await db.select({ tenantId: schema.tenantMemberships.tenantId, last: sql<Date | null>`max(${schema.users.lastLoginAt})` }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(inArray(schema.tenantMemberships.tenantId, ids)).groupBy(schema.tenantMemberships.tenantId);
  const invs = await db.select({ tenantId: schema.invoices.tenantId, status: schema.invoices.status, dueAt: schema.invoices.dueAt, amountMinor: schema.invoices.amountMinor, paymentFailedAt: schema.invoices.paymentFailedAt }).from(schema.invoices).where(inArray(schema.invoices.tenantId, ids));
  const subs = await db.select({ tenantId: schema.subscriptions.tenantId, status: schema.subscriptions.status, planKey: schema.subscriptions.planKey }).from(schema.subscriptions).where(inArray(schema.subscriptions.tenantId, ids));
  const healthErrors = await db.select({ tenantId: schema.integrationHealth.tenantId, n: sql<number>`count(*)::int` }).from(schema.integrationHealth).where(and(inArray(schema.integrationHealth.tenantId, ids), inArray(schema.integrationHealth.status, [...SOURCE_ERROR_STATUSES]))).groupBy(schema.integrationHealth.tenantId);
  // failed background work: failed job runs of the last 7 days (job history, #32)
  const failedRuns = await failedJobsByTenant(db, ids, 7, now);
  const countOf = (rows: { tenantId: string; n: number }[], id: string) => rows.find((r) => r.tenantId === id)?.n ?? 0;
  return tenants.map((t) => {
    const mine = invs.filter((i) => i.tenantId === t.id);
    const pay = paymentHealth(mine, now, t.suspendAfterDays);
    const last = logins.find((l) => l.tenantId === t.id)?.last ?? null;
    const lastLoginAt = last ? new Date(last) : null;
    const tenantAddons = addons.filter((a) => a.tenantId === t.id).map((a) => a.key);
    const sub = subs.find((x) => x.tenantId === t.id);
    const integrationErrors = countOf(healthErrors, t.id);
    const failedJobs = failedRuns.get(t.id) ?? 0;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      statusReason: t.statusReason,
      planKey: t.planKey,
      country: t.country,
      currency: t.currency,
      addons: tenantAddons,
      integrations: integrations.filter((i) => i.tenantId === t.id).map((i) => ({ provider: i.provider, status: i.status })),
      ordersLast30: orders.find((o) => o.tenantId === t.id)?.n ?? 0,
      lastLoginAt,
      payment: pay.health,
      openMinor: mine.filter((i) => i.status === "open").reduce((s, i) => s + i.amountMinor, 0),
      daysOverdue: pay.daysOverdue,
      mrrMinor: sub ? mrr([{ status: sub.status, planKey: sub.planKey as PlanKey, addons: tenantAddons }]) : 0,
      trialEndsAt: t.trialEndsAt,
      churnedAt: t.churnedAt,
      integrationErrors,
      failedJobs,
      health: tenantHealth({ integrationErrors, failedJobs, daysOverdue: pay.daysOverdue, daysSinceLastLogin: lastLoginAt ? Math.floor((now.getTime() - lastLoginAt.getTime()) / 864e5) : null }),
      createdAt: t.createdAt,
    };
  });
}

export async function platformMetrics(db: AdminDb, now = new Date()) {
  const subs = await db.select({ status: schema.subscriptions.status, planKey: schema.subscriptions.planKey, tenantId: schema.subscriptions.tenantId }).from(schema.subscriptions);
  const addons = await db.select({ tenantId: schema.tenantAddons.tenantId, key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(eq(schema.tenantAddons.isActive, true));
  const tenants = await db.select({ status: schema.tenants.status }).from(schema.tenants);
  const [errors] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.integrationHealth).where(inArray(schema.integrationHealth.status, [...SOURCE_ERROR_STATUSES]));
  const [openInv] = await db.select({ n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${schema.invoices.amountMinor}),0)::int`, overdue: sql<number>`count(*) filter (where ${schema.invoices.dueAt} < ${now})::int` }).from(schema.invoices).where(eq(schema.invoices.status, "open"));
  const [paid30] = await db.select({ amount: sql<number>`coalesce(sum(${schema.invoices.amountMinor}),0)::int` }).from(schema.invoices).where(and(eq(schema.invoices.status, "paid"), sql`${schema.invoices.paidAt} > ${new Date(now.getTime() - 30 * 864e5)}`));
  const addonCounts = Object.entries(addons.reduce<Record<string, number>>((acc, a) => ((acc[a.key] = (acc[a.key] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  return {
    mrrMinor: mrr(subs.map((s) => ({ status: s.status, planKey: s.planKey as PlanKey, addons: addons.filter((a) => a.tenantId === s.tenantId).map((a) => a.key) }))),
    tenants: { total: tenants.length, active: tenants.filter((t) => t.status === "active").length, trial: tenants.filter((t) => t.status === "trial").length, pastDue: tenants.filter((t) => t.status === "past_due").length, suspended: tenants.filter((t) => t.status === "suspended").length, churned: tenants.filter((t) => t.status === "churned").length },
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
  const lifecycle = await lifecycleHistory(db, tenantId, 30);
  const [b] = await db.select({ brandColor: schema.tenantBranding.brandColor, light: schema.tenantBranding.logoLightType, dark: schema.tenantBranding.logoDarkType, updatedAt: schema.tenantBranding.updatedAt }).from(schema.tenantBranding).where(eq(schema.tenantBranding.tenantId, tenantId)).limit(1);
  const branding: TenantBranding = b ? { brandColor: b.brandColor, logoLight: b.light ? { version: b.updatedAt.getTime() } : null, logoDark: b.dark ? { version: b.updatedAt.getTime() } : null, updatedAt: b.updatedAt } : { brandColor: null, logoLight: null, logoDark: null, updatedAt: null };
  return { tenant, subscription: subscription ?? null, invoices: invoiceRows, addons, members, integrations, health, checklist, payment, audit: auditRows, ordersLast30: orders30?.n ?? 0, lifecycle, branding, retainedUntil: dataRetainedUntil(tenant) };
}

export async function listInvoices(db: AdminDb, opts: { status?: string; limit?: number } = {}) {
  const conds = opts.status ? [eq(schema.invoices.status, opts.status)] : [];
  return db.select({ invoice: schema.invoices, tenantName: schema.tenants.name, tenantSlug: schema.tenants.slug }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.invoices.issuedAt)).limit(opts.limit ?? 100);
}

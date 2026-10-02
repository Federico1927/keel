import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { MODULES, PLANS, PLATFORM_CURRENCY, adPlatformsForPlan, type PlanKey, type TenantStatus } from "@hullwise/config";
import { monthlyChargeMinor, subscriptionStatusFor } from "@hullwise/core";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;

/**
 * Super-admin console demo (#48). The two demo stores get a lifecycle history consistent with their
 * billing; four platform-only tenants (no orders, owners without a password, so nobody signs in as
 * them) show the other states: a trial about to end, a healthy Scale customer with a broken
 * integration, a tenant suspended for an unpaid invoice and two churned ones, one of them past the
 * data-retention window. With them the metrics over time, the health column and the lifecycle
 * filters have something to show. Rewritten on every seed (dates relative to now).
 */
interface Step {
  daysAgo: number;
  status: TenantStatus;
  reason: string;
  note?: string;
  planKey?: PlanKey;
  addons?: string[];
}

interface ConsoleTenant {
  slug: string;
  name: string;
  country: string;
  currency: string;
  timezone: string;
  locale: string;
  planKey: PlanKey;
  addons: string[];
  owner: { email: string; name: string; lastLoginDaysAgo: number | null };
  steps: Step[];
  trialDays?: number;
  /** Invoices relative to now: amount from the plan unless given. */
  invoices: { kind: "setup" | "subscription"; issuedDaysAgo: number; paid: boolean }[];
  integrationErrors?: { source: string; status: "error" | "degraded"; error: string; failures: number }[];
  extraUser?: { email: string; name: string; role: "admin" | "operations"; disabledDaysAgo: number; reason: string };
}

export const CONSOLE_TENANTS: ConsoleTenant[] = [
  {
    slug: "alpine-outdoor", name: "Alpine Outdoor", country: "DE", currency: "EUR", timezone: "Europe/Berlin", locale: "en", planKey: "growth", addons: [],
    owner: { email: "owner@alpine-outdoor.demo", name: "Lena Huber", lastLoginDaysAgo: null },
    steps: [{ daysAgo: 9, status: "trial", reason: "tenant_created" }], trialDays: 14,
    invoices: [{ kind: "setup", issuedDaysAgo: 9, paid: true }],
  },
  {
    slug: "coral-beauty", name: "Coral Beauty", country: "ES", currency: "EUR", timezone: "Europe/Madrid", locale: "es", planKey: "scale", addons: ["addon.customer_campaigns"],
    owner: { email: "owner@coral-beauty.demo", name: "Lucía Ortega", lastLoginDaysAgo: 2 },
    steps: [{ daysAgo: 320, status: "trial", reason: "tenant_created", planKey: "growth", addons: [] }, { daysAgo: 306, status: "active", reason: "trial_converted", planKey: "growth", addons: [] }, { daysAgo: 150, status: "active", reason: "plan_changed", planKey: "scale", addons: [] }, { daysAgo: 120, status: "active", reason: "addons_changed", planKey: "scale", addons: ["addon.customer_campaigns"] }],
    invoices: [{ kind: "setup", issuedDaysAgo: 320, paid: true }, { kind: "subscription", issuedDaysAgo: 62, paid: true }, { kind: "subscription", issuedDaysAgo: 31, paid: true }, { kind: "subscription", issuedDaysAgo: 1, paid: false }],
    integrationErrors: [
      { source: "shopify", status: "error", error: "401 Unauthorized: the access token was revoked in the Shopify admin", failures: 6 },
      { source: "meta", status: "degraded", error: "Rate limited (code 17): insights for the last 2 days are delayed", failures: 2 },
    ],
  },
  {
    slug: "delta-gear", name: "Delta Gear", country: "US", currency: "USD", timezone: "America/Chicago", locale: "en", planKey: "growth", addons: ["addon.cod"],
    owner: { email: "owner@delta-gear.demo", name: "Mason Reed", lastLoginDaysAgo: 19 },
    steps: [{ daysAgo: 210, status: "trial", reason: "tenant_created" }, { daysAgo: 196, status: "active", reason: "trial_converted" }, { daysAgo: 25, status: "past_due", reason: "payment_overdue" }, { daysAgo: 11, status: "suspended", reason: "unpaid_invoice" }],
    invoices: [{ kind: "setup", issuedDaysAgo: 210, paid: true }, { kind: "subscription", issuedDaysAgo: 63, paid: true }, { kind: "subscription", issuedDaysAgo: 32, paid: false }],
    extraUser: { email: "ex.manager@delta-gear.demo", name: "Tyler Brooks", role: "admin", disabledDaysAgo: 40, reason: "Left the company; requested by the owner by email." },
  },
  {
    slug: "maple-kids", name: "Maple Kids", country: "CA", currency: "CAD", timezone: "America/Toronto", locale: "en", planKey: "starter", addons: [],
    owner: { email: "owner@maple-kids.demo", name: "Chloé Tremblay", lastLoginDaysAgo: 75 },
    steps: [{ daysAgo: 300, status: "trial", reason: "tenant_created" }, { daysAgo: 286, status: "active", reason: "trial_converted" }, { daysAgo: 130, status: "past_due", reason: "payment_overdue" }, { daysAgo: 110, status: "suspended", reason: "unpaid_invoice" }, { daysAgo: 60, status: "churned", reason: "customer_request", note: "Closing the online shop at the end of the season; asked for a data export." }],
    invoices: [{ kind: "setup", issuedDaysAgo: 300, paid: true }],
  },
  {
    slug: "fjord-home", name: "Fjord Home", country: "NO", currency: "NOK", timezone: "Europe/Oslo", locale: "en", planKey: "starter", addons: [],
    owner: { email: "owner@fjord-home.demo", name: "Ingrid Solberg", lastLoginDaysAgo: 200 },
    steps: [{ daysAgo: 335, status: "trial", reason: "tenant_created" }, { daysAgo: 321, status: "active", reason: "trial_converted" }, { daysAgo: 200, status: "churned", reason: "customer_request", note: "Moved to another platform." }],
    invoices: [{ kind: "setup", issuedDaysAgo: 335, paid: true }],
  },
];

async function writeHistory(db: Db, tenantId: string, base: { planKey: PlanKey; addons: string[] }, steps: Step[], now: Date) {
  await db.delete(schema.tenantLifecycleEvents).where(eq(schema.tenantLifecycleEvents.tenantId, tenantId));
  let prev: TenantStatus | null = null;
  for (const s of steps) {
    const planKey = s.planKey ?? base.planKey;
    const addons = s.addons ?? base.addons;
    await db.insert(schema.tenantLifecycleEvents).values({ tenantId, fromStatus: prev, toStatus: s.status, reason: s.reason, note: s.note ?? null, planKey, addons, monthlyMinor: monthlyChargeMinor(planKey, addons), actorType: "system", createdAt: new Date(now.getTime() - s.daysAgo * DAY) });
    prev = s.status;
  }
  const last = steps[steps.length - 1]!;
  const at = new Date(now.getTime() - last.daysAgo * DAY);
  await db.update(schema.tenants).set({ status: last.status, statusReason: last.reason, statusNote: last.note ?? null, statusChangedAt: at, suspendedAt: last.status === "suspended" ? at : null, churnedAt: last.status === "churned" ? at : null }).where(eq(schema.tenants.id, tenantId));
}

/** Lifecycle of the two demo stores, matching `seedBilling` (created `months` months ago, 14-day trial). */
export async function seedDemoLifecycle(db: Db, demo: { tenantId: string; planKey: PlanKey; addons: string[]; createdAt: Date; status: TenantStatus; statusSince: Date | null }[], now = new Date()) {
  for (const d of demo) {
    const trialEnd = new Date(d.createdAt.getTime() + 14 * DAY);
    const steps: Step[] = [{ daysAgo: (now.getTime() - d.createdAt.getTime()) / DAY, status: "trial", reason: "tenant_created" }, { daysAgo: (now.getTime() - trialEnd.getTime()) / DAY, status: "active", reason: "trial_converted" }];
    if (d.status !== "active" && d.statusSince) steps.push({ daysAgo: (now.getTime() - d.statusSince.getTime()) / DAY, status: d.status, reason: d.status === "past_due" ? "payment_overdue" : "unpaid_invoice" });
    await writeHistory(db, d.tenantId, d, steps, now);
    await db.update(schema.tenants).set({ trialEndsAt: trialEnd }).where(eq(schema.tenants.id, d.tenantId));
  }
}

export async function seedConsoleTenants(db: Db, now = new Date()): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const c of CONSOLE_TENANTS) {
    const created = new Date(now.getTime() - c.steps[0]!.daysAgo * DAY);
    const [row] = await db.insert(schema.tenants).values({ slug: c.slug, name: c.name, country: c.country, currency: c.currency, timezone: c.timezone, defaultLocale: c.locale, orderNumberPrefix: "", planKey: c.planKey, createdAt: created }).onConflictDoUpdate({ target: schema.tenants.slug, set: { name: c.name, planKey: c.planKey, createdAt: created } }).returning({ id: schema.tenants.id });
    const tenantId = row!.id;
    ids[c.slug] = tenantId;
    await db.update(schema.tenants).set({ trialEndsAt: c.trialDays ? new Date(created.getTime() + c.trialDays * DAY) : new Date(created.getTime() + 14 * DAY) }).where(eq(schema.tenants.id, tenantId));
    await db.delete(schema.tenantAddons).where(eq(schema.tenantAddons.tenantId, tenantId));
    for (const a of c.addons) await db.insert(schema.tenantAddons).values({ tenantId, moduleKey: a, note: "Enabled by seed", activatedAt: new Date(now.getTime() - 120 * DAY) });
    // owner (and, for Delta Gear, a former manager disabled platform-wide): no password, never a demo login
    const people = [{ ...c.owner, role: "owner" as const, disabled: null as null | { daysAgo: number; reason: string } }, ...(c.extraUser ? [{ email: c.extraUser.email, name: c.extraUser.name, role: c.extraUser.role, lastLoginDaysAgo: 45 as number | null, disabled: { daysAgo: c.extraUser.disabledDaysAgo, reason: c.extraUser.reason } }] : [])];
    for (const p of people) {
      const lastLoginAt = p.lastLoginDaysAgo === null ? null : new Date(now.getTime() - p.lastLoginDaysAgo * DAY);
      const disabledAt = p.disabled ? new Date(now.getTime() - p.disabled.daysAgo * DAY) : null;
      const values = { name: p.name, lastLoginAt, locale: c.locale, disabledAt, disabledReason: p.disabled?.reason ?? null, passwordHash: null };
      const [u] = await db.insert(schema.users).values({ email: p.email, emailVerified: created, ...values }).onConflictDoUpdate({ target: schema.users.email, set: values }).returning({ id: schema.users.id });
      await db.insert(schema.tenantMemberships).values({ tenantId, userId: u!.id, role: p.role }).onConflictDoUpdate({ target: [schema.tenantMemberships.tenantId, schema.tenantMemberships.userId], set: { role: p.role, isActive: true } });
    }
    for (const provider of ["shopify", ...adPlatformsForPlan(c.planKey)]) {
      const problem = c.integrationErrors?.find((e) => e.source === provider);
      const status = problem?.status === "error" ? "error" : problem || (provider === "shopify" && c.steps.some((s) => s.status === "active")) ? "connected" : "not_connected";
      await db.insert(schema.integrations).values({ tenantId, provider, status, mode: "mock", lastError: problem?.error ?? null }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { status, lastError: problem?.error ?? null } });
    }
    await db.delete(schema.integrationHealth).where(eq(schema.integrationHealth.tenantId, tenantId));
    for (const e of c.integrationErrors ?? []) await db.insert(schema.integrationHealth).values({ tenantId, source: e.source, status: e.status, lastError: e.error, consecutiveFailures: e.failures, lastAttemptAt: new Date(now.getTime() - 3600_000), lastSuccessAt: new Date(now.getTime() - (e.status === "error" ? 4 : 2) * DAY) });
    // billing consistent with the lifecycle
    await db.delete(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    const last = c.steps[c.steps.length - 1]!;
    const monthly = monthlyChargeMinor(c.planKey, c.addons);
    const periodStart = new Date(now.getTime() - 1 * DAY);
    const [sub] = await db.insert(schema.subscriptions).values({ tenantId, planKey: c.planKey, status: subscriptionStatusFor(last.status), provider: "mock", externalCustomerId: `mock_cus_${tenantId.slice(0, 8)}`, currency: PLATFORM_CURRENCY, currentPeriodStart: last.status === "trial" ? created : periodStart, currentPeriodEnd: last.status === "trial" ? new Date(created.getTime() + (c.trialDays ?? 14) * DAY) : new Date(periodStart.getTime() + 30 * DAY), trialEndsAt: new Date(created.getTime() + (c.trialDays ?? 14) * DAY), setupFeeMinor: PLANS[c.planKey].setupFeeMinor, cancelledAt: last.status === "churned" ? new Date(now.getTime() - last.daysAgo * DAY) : null }).returning({ id: schema.subscriptions.id });
    let n = 0;
    for (const inv of c.invoices) {
      n++;
      const issuedAt = new Date(now.getTime() - inv.issuedDaysAgo * DAY);
      const amount = inv.kind === "setup" ? PLANS[c.planKey].setupFeeMinor : monthly;
      const lines = inv.kind === "setup" ? [{ kind: "setup", key: c.planKey, amountMinor: amount }] : [{ kind: "plan", key: c.planKey, amountMinor: PLANS[c.planKey].monthlyPriceMinor }, ...c.addons.filter((a) => MODULES[a as keyof typeof MODULES]?.monthlyPriceMinor).map((a) => ({ kind: "addon", key: a, amountMinor: MODULES[a as keyof typeof MODULES].monthlyPriceMinor! }))];
      const number = `INV-${issuedAt.getUTCFullYear()}-${String(n).padStart(4, "0")}`;
      await db.insert(schema.invoices).values({ tenantId, subscriptionId: sub!.id, number, provider: "mock", externalId: `mock_in_${c.slug}_${n}`, status: inv.paid ? "paid" : "open", kind: inv.kind, amountMinor: amount, currency: PLATFORM_CURRENCY, lines, issuedAt, dueAt: new Date(issuedAt.getTime() + 7 * DAY), paidAt: inv.paid ? new Date(issuedAt.getTime() + 2 * DAY) : null, periodStart: inv.kind === "subscription" ? issuedAt : null, periodEnd: inv.kind === "subscription" ? new Date(issuedAt.getTime() + 30 * DAY) : null });
    }
    await writeHistory(db, tenantId, { planKey: c.planKey, addons: c.addons }, c.steps, now);
  }
  return ids;
}

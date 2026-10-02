import { eq, schema, type DbExecutor as AdminDb } from "@keel/db";
import { DEFAULT_SUSPEND_AFTER_DAYS } from "@keel/config";
import { paymentHealth, subscriptionSignal, type PaymentHealth } from "@keel/core";
import { transitionTenant } from "./lifecycle";

export async function tenantPaymentStatus(db: AdminDb, tenantId: string, now = new Date()): Promise<{ health: PaymentHealth; daysOverdue: number; openMinor: number }> {
  const [tenant] = await db.select({ suspendAfterDays: schema.tenants.suspendAfterDays }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const invs = await db.select({ status: schema.invoices.status, dueAt: schema.invoices.dueAt, amountMinor: schema.invoices.amountMinor, paymentFailedAt: schema.invoices.paymentFailedAt }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId));
  const h = paymentHealth(invs, now, tenant?.suspendAfterDays ?? DEFAULT_SUSPEND_AFTER_DAYS);
  return { ...h, openMinor: invs.filter((i) => i.status === "open" || i.status === "uncollectible").reduce((s, i) => s + i.amountMinor, 0) };
}

/**
 * Lifecycle from the invoices, whatever the provider: suspended after the grace period, past due
 * before it (a failed Stripe charge counts at once), back to active when nothing is overdue.
 * A Stripe subscription adds two signals: Stripe saying past_due/unpaid keeps the tenant past due,
 * and its first active period ends a trial. Manual suspensions and churned tenants are left alone.
 * `transitionTenant` stays the only writer of the state.
 */
export async function refreshTenantPaymentState(db: AdminDb, tenantId: string, now: Date, actorUserId: string | null): Promise<PaymentHealth> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant || tenant.status === "churned") return "none";
  const [sub] = await db.select({ externalSubscriptionId: schema.subscriptions.externalSubscriptionId, externalStatus: schema.subscriptions.externalStatus }).from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const signal = sub?.externalSubscriptionId ? subscriptionSignal(sub.externalStatus) : null;
  let { health } = await tenantPaymentStatus(db, tenantId, now);
  if (signal === "past_due" && (health === "ok" || health === "none")) health = "past_due";
  const manual = (tenant.settings as { manualSuspension?: boolean } | null)?.manualSuspension === true;
  const move = (to: "active" | "past_due" | "suspended", reason: "unpaid_invoice" | "payment_overdue" | "payment_recovered" | "trial_converted") => transitionTenant(db, tenantId, { to, reason, note: null, actorUserId, now });
  if (health === "suspended" && tenant.status !== "suspended") await move("suspended", "unpaid_invoice");
  else if (health === "past_due" && (tenant.status === "active" || tenant.status === "trial")) await move("past_due", "payment_overdue");
  else if ((health === "ok" || health === "none") && (tenant.status === "past_due" || (tenant.status === "suspended" && !manual))) await move("active", "payment_recovered");
  else if ((health === "ok" || health === "none") && tenant.status === "trial" && signal === "active") await move("active", "trial_converted");
  return health;
}

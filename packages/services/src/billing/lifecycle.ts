import { and, asc, desc, eq, isNotNull, lt, recordAudit, schema, type DbExecutor } from "@keel/db";
import { CHURN_RETENTION_DAYS, isTenantStatus, type LifecycleReason, type PlanKey, type TenantStatus } from "@keel/config";
import { canTransition, monthlyChargeMinor, retentionEndsAt, subscriptionStatusFor } from "@keel/core";

/**
 * Tenant lifecycle (#48): trial → active → past_due → suspended → churned. The state is Keel's, on
 * the tenant row; the subscription mirrors it whatever the billing provider (mock today, Stripe
 * subscriptions with #53). Every change stores a reason and a note, writes a history row with the
 * plan/add-on snapshot (for the metrics over time) and an audit row with the field diff.
 */

export class LifecycleError extends Error {
  constructor(readonly code: "tenant_not_found" | "invalid_transition" | "invalid_date") {
    super(code);
    this.name = "LifecycleError";
  }
}

export interface LifecycleChange {
  to: TenantStatus;
  reason: LifecycleReason;
  note?: string | null;
  /** null = the billing run (system). */
  actorUserId: string | null;
  now?: Date;
  /** Manual suspensions are not lifted by a payment (the billing run leaves them alone). */
  manual?: boolean;
}

const auditAction = (from: TenantStatus, to: TenantStatus) => (to === "suspended" ? "tenant.suspended" : to === "churned" ? "tenant.churned" : to === "active" && (from === "suspended" || from === "churned") ? "tenant.reactivated" : "tenant.lifecycle_changed");

async function activeAddons(db: DbExecutor, tenantId: string): Promise<string[]> {
  return (await db.select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true))).orderBy(asc(schema.tenantAddons.moduleKey))).map((r) => r.k);
}

/** History row with the tenant's current plan and add-ons (also used for plan and add-on changes). */
export async function recordLifecycleEvent(db: DbExecutor, tenantId: string, input: { from: string | null; to: string; reason: LifecycleReason; note?: string | null; actorUserId: string | null; now?: Date }): Promise<void> {
  const [tenant] = await db.select({ planKey: schema.tenants.planKey }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) return;
  const addons = await activeAddons(db, tenantId);
  await db.insert(schema.tenantLifecycleEvents).values({ tenantId, fromStatus: input.from, toStatus: input.to, reason: input.reason, note: input.note ?? null, planKey: tenant.planKey, addons, monthlyMinor: monthlyChargeMinor(tenant.planKey as PlanKey, addons), actorUserId: input.actorUserId, actorType: input.actorUserId ? "super_admin" : "system", createdAt: input.now ?? new Date() });
}

/** Moves a tenant to another state. A no-op when it is already there; refuses moves the lifecycle does not allow. */
export async function transitionTenant(db: DbExecutor, tenantId: string, change: LifecycleChange): Promise<{ changed: boolean; from: TenantStatus }> {
  const now = change.now ?? new Date();
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new LifecycleError("tenant_not_found");
  const from = (isTenantStatus(tenant.status) ? tenant.status : "active") as TenantStatus;
  if (from === change.to) return { changed: false, from };
  if (!canTransition(from, change.to)) throw new LifecycleError("invalid_transition");
  const note = change.note?.trim() || null;
  const settings = { ...(tenant.settings as Record<string, unknown>), manualSuspension: change.to === "suspended" && change.manual === true };
  const patch = {
    status: change.to,
    statusReason: change.reason,
    statusNote: note,
    statusChangedAt: now,
    suspendedAt: change.to === "suspended" ? now : null,
    churnedAt: change.to === "churned" ? now : null,
    settings,
    updatedAt: now,
  };
  await db.update(schema.tenants).set(patch).where(eq(schema.tenants.id, tenantId));
  await db
    .update(schema.subscriptions)
    .set({ status: subscriptionStatusFor(change.to), cancelledAt: change.to === "churned" ? now : null, updatedAt: now })
    .where(eq(schema.subscriptions.tenantId, tenantId));
  await recordLifecycleEvent(db, tenantId, { from, to: change.to, reason: change.reason, note, actorUserId: change.actorUserId, now });
  await recordAudit(db, {
    tenantId,
    actorUserId: change.actorUserId,
    actorType: change.actorUserId ? "super_admin" : "system",
    action: auditAction(from, change.to),
    entityType: "tenant",
    entityId: tenantId,
    diff: { status: { from, to: change.to }, ...(from === "suspended" || change.to === "suspended" ? { suspendedAt: { from: tenant.suspendedAt, to: patch.suspendedAt } } : {}), ...(from === "churned" || change.to === "churned" ? { churnedAt: { from: tenant.churnedAt, to: patch.churnedAt } } : {}) },
    metadata: { reason: change.reason, note },
  });
  return { changed: true, from };
}

/** Sets the end of the trial (extend or shorten). A trialing subscription's first period follows it. */
export async function setTrialEnd(db: DbExecutor, tenantId: string, trialEndsAt: Date, actorUserId: string, note: string | null, now = new Date()): Promise<void> {
  if (Number.isNaN(trialEndsAt.getTime())) throw new LifecycleError("invalid_date");
  const [tenant] = await db.select({ trialEndsAt: schema.tenants.trialEndsAt, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new LifecycleError("tenant_not_found");
  await db.update(schema.tenants).set({ trialEndsAt, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (sub) await db.update(schema.subscriptions).set({ trialEndsAt, ...(sub.status === "trialing" ? { currentPeriodEnd: trialEndsAt } : {}), updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: "tenant.trial_end_changed", entityType: "tenant", entityId: tenantId, diff: { trialEndsAt: { from: tenant.trialEndsAt, to: trialEndsAt } }, metadata: { note: note?.trim() || null } });
}

export async function lifecycleHistory(db: DbExecutor, tenantId: string, limit = 50) {
  return db
    .select({ event: schema.tenantLifecycleEvents, actorEmail: schema.users.email })
    .from(schema.tenantLifecycleEvents)
    .leftJoin(schema.users, eq(schema.users.id, schema.tenantLifecycleEvents.actorUserId))
    .where(eq(schema.tenantLifecycleEvents.tenantId, tenantId))
    .orderBy(desc(schema.tenantLifecycleEvents.createdAt))
    .limit(limit);
}

/** When a churned tenant's data stops being kept; null when the tenant is not churned. */
export function dataRetainedUntil(tenant: { status: string; churnedAt: Date | null }, days = CHURN_RETENTION_DAYS): Date | null {
  return tenant.status === "churned" && tenant.churnedAt ? retentionEndsAt(tenant.churnedAt, days) : null;
}

/** Churned tenants past the retention window: due for the data-export/delete flow (#32, not built yet). */
export async function churnedPastRetention(db: DbExecutor, now = new Date(), days = CHURN_RETENTION_DAYS) {
  return db
    .select({ id: schema.tenants.id, name: schema.tenants.name, churnedAt: schema.tenants.churnedAt })
    .from(schema.tenants)
    .where(and(eq(schema.tenants.status, "churned"), isNotNull(schema.tenants.churnedAt), lt(schema.tenants.churnedAt, new Date(now.getTime() - days * 864e5))))
    .orderBy(asc(schema.tenants.churnedAt));
}

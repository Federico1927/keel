/**
 * Tenant lifecycle (#48). The state lives on the tenant and does not depend on the billing
 * provider: the mock and, later, Stripe subscriptions (#53) only report payments, Keel decides the
 * state. `suspended` and `churned` block the tenant's users (the console and impersonation stay open).
 */
export const TENANT_STATUSES = ["trial", "active", "past_due", "suspended", "churned"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Why a tenant changed state. Every change stores one, plus a free note. */
export const LIFECYCLE_REASONS = ["tenant_created", "trial_converted", "trial_expired", "payment_overdue", "unpaid_invoice", "payment_recovered", "customer_request", "terms_violation", "win_back", "manual", "other", "plan_changed", "addons_changed"] as const;
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];
/** Reasons a super-admin can pick by hand (the others are written by the billing run). */
export const MANUAL_LIFECYCLE_REASONS = ["trial_converted", "trial_expired", "payment_overdue", "unpaid_invoice", "payment_recovered", "customer_request", "terms_violation", "win_back", "other"] as const satisfies readonly LifecycleReason[];

export const DEFAULT_TRIAL_DAYS = 14;
/** Days a churned tenant's data is kept before the data-export/delete flow (#32) takes over. */
export const CHURN_RETENTION_DAYS = 90;

export function isTenantStatus(v: unknown): v is TenantStatus {
  return typeof v === "string" && (TENANT_STATUSES as readonly string[]).includes(v);
}

/** Tenants whose syncs, jobs and public pages run: everything but suspended and churned. */
export function isTenantOperational(status: string): boolean {
  return status === "trial" || status === "active" || status === "past_due";
}

/** States that keep the tenant's own users out (redirect to /suspended). */
export function isTenantBlocked(status: string): boolean {
  return status === "suspended" || status === "churned";
}

export const OPERATIONAL_TENANT_STATUSES = ["trial", "active", "past_due"] as const satisfies readonly TenantStatus[];

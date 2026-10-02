import type { PlanKey, TenantStatus } from "@keel/config";
import { monthlyInvoiceLines, sumLines } from "./billing";
import { monthKey } from "./costs";

/* ---------- tenant lifecycle (#48) ---------- */

/**
 * Allowed moves between lifecycle states. A churned tenant can come back (win-back) while its data
 * is still kept; nothing goes back to `trial`.
 */
export const LIFECYCLE_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  trial: ["active", "past_due", "suspended", "churned"],
  active: ["past_due", "suspended", "churned"],
  past_due: ["active", "suspended", "churned"],
  suspended: ["active", "past_due", "churned"],
  churned: ["active"],
};

export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** The subscription status that mirrors a lifecycle state (whatever the provider). */
export function subscriptionStatusFor(status: TenantStatus): "trialing" | "active" | "past_due" | "suspended" | "cancelled" {
  return status === "trial" ? "trialing" : status === "churned" ? "cancelled" : status;
}

/** States whose subscription counts in MRR (trial counts at 0 until converted). */
export function isBillableStatus(status: string | null): boolean {
  return status === "active" || status === "past_due";
}

/** Monthly charge of a plan plus its priced add-ons. */
export function monthlyChargeMinor(planKey: PlanKey, addons: readonly string[]): number {
  return sumLines(monthlyInvoiceLines(planKey, addons));
}

export function retentionEndsAt(churnedAt: Date, days: number): Date {
  return new Date(churnedAt.getTime() + days * 864e5);
}

/* ---------- platform metrics over time ---------- */

/**
 * One lifecycle event: the tenant's state from `at` on, with the plan and add-ons it had then.
 * The first event of a tenant is its creation. Plan and add-on changes write an event with the
 * same status, so the series knows the charge of every month.
 */
export interface LifecycleSnapshot {
  tenantId: string;
  at: Date;
  status: TenantStatus;
  planKey: PlanKey;
  addons: readonly string[];
}

export interface PlatformMonth {
  /** `YYYY-MM` (UTC). */
  month: string;
  mrrMinor: number;
  /** Tenants with a billable subscription at the end of the month (active or past due). */
  active: string[];
  trial: string[];
  /** Created during the month. */
  new: string[];
  /** Moved to churned during the month. */
  churned: string[];
  /** Tenants (not churned) with the add-on at the end of the month. */
  addons: Record<string, string[]>;
  mrrByTenant: Record<string, number>;
}

/** The last `n` months up to the month of `now`, oldest first. */
export function lastMonths(now: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1))));
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/**
 * MRR, active and trial tenants, new and churned, add-on adoption for each month, with the tenant
 * ids behind every number (the console links them). The state of a month is the state at its end
 * (for the running month: now). MRR = the charge of every tenant whose subscription is billable then.
 */
export function platformSeries(events: readonly LifecycleSnapshot[], months: readonly string[]): PlatformMonth[] {
  const byTenant = new Map<string, LifecycleSnapshot[]>();
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const list = byTenant.get(e.tenantId) ?? [];
    list.push(e);
    byTenant.set(e.tenantId, list);
  }
  return months.map((month) => {
    const { start, end } = monthBounds(month);
    const point: PlatformMonth = { month, mrrMinor: 0, active: [], trial: [], new: [], churned: [], addons: {}, mrrByTenant: {} };
    for (const [tenantId, list] of byTenant) {
      const first = list[0]!;
      if (first.at >= start && first.at < end) point.new.push(tenantId);
      if (list.some((e, i) => e.status === "churned" && e.at >= start && e.at < end && list[i - 1]?.status !== "churned")) point.churned.push(tenantId);
      let state: LifecycleSnapshot | undefined;
      for (const e of list) if (e.at < end) state = e;
      if (!state) continue;
      if (state.status === "trial") point.trial.push(tenantId);
      if (isBillableStatus(state.status)) {
        const charge = monthlyChargeMinor(state.planKey, state.addons);
        point.active.push(tenantId);
        point.mrrByTenant[tenantId] = charge;
        point.mrrMinor += charge;
      }
      if (state.status !== "churned") for (const a of state.addons) (point.addons[a] ??= []).push(tenantId);
    }
    return point;
  });
}

/* ---------- tenant health ---------- */

export interface TenantHealthInput {
  /** Integration health rows in error or degraded. */
  integrationErrors: number;
  /** Failed background work in the last 7 days: sync runs, webhooks, outbound writes. */
  failedJobs: number;
  /** Days the oldest open invoice is past due (0 when none). */
  daysOverdue: number;
  /** Days since the last sign-in of any member; null when nobody ever signed in. */
  daysSinceLastLogin: number | null;
}

export type TenantHealthFactor = "integrations" | "jobs" | "invoices" | "login";

export interface TenantHealth {
  /** 100 = nothing to look at. */
  score: number;
  needsAttention: boolean;
  factors: { key: TenantHealthFactor; penalty: number }[];
}

export const HEALTH_ATTENTION_BELOW = 70;

/**
 * One score per tenant from what usually needs the platform owner: broken integrations, failing
 * background work, overdue invoices and a team that stopped signing in.
 */
export function tenantHealth(input: TenantHealthInput): TenantHealth {
  const factors: TenantHealth["factors"] = [];
  const add = (key: TenantHealthFactor, penalty: number) => penalty > 0 && factors.push({ key, penalty });
  add("integrations", Math.min(40, input.integrationErrors * 20));
  add("jobs", Math.min(25, input.failedJobs * 5));
  add("invoices", input.daysOverdue > 0 ? Math.min(40, 15 + input.daysOverdue) : 0);
  add("login", input.daysSinceLastLogin === null || input.daysSinceLastLogin > 30 ? 20 : input.daysSinceLastLogin > 14 ? 10 : 0);
  const score = Math.max(0, 100 - factors.reduce((s, f) => s + f.penalty, 0));
  return { score, needsAttention: score < HEALTH_ATTENTION_BELOW, factors: factors.sort((a, b) => b.penalty - a.penalty) };
}

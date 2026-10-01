import type { AnalyticsTenant, ServiceContext } from "@keel/services";
import type { TenantContext } from "@/server/tenant";

/** The tenant fields analytics services need. */
export function analyticsTenant(ctx: TenantContext): AnalyticsTenant {
  return { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
}

/** Runs an analytics read inside the tenant transaction as the current user. */
export function runAnalytics<T>(ctx: TenantContext, fn: (s: ServiceContext) => Promise<T>): Promise<T> {
  return ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
}

/** Escapes one CSV cell. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const minorToDecimal = (minor: number) => (minor / 100).toFixed(2);

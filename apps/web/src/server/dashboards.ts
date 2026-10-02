import { cache } from "react";
import { dashboardPeriod, type Period } from "@hullwise/core";
import { COD_WIDGET_LOADERS } from "@hullwise/addon-cod";
import { CORE_WIDGET_LOADERS, SUBSCRIPTION_WIDGET_LOADERS, listTenantMetrics, loadWidgetData, type CustomMetricRow, type Memo, type WidgetEnv, type WidgetLoader, type WidgetResult } from "@hullwise/services";
import { WIDGETS, type DashboardPeriod, type DashboardWidget, type TenantRole, type WidgetType } from "@hullwise/config";
import type { TenantContext } from "./tenant";

/** Core loaders plus the add-ons' (COD lives in its package); `loadWidgetData` refuses an add-on widget the tenant lacks. */
export const WIDGET_LOADERS: Partial<Record<WidgetType, WidgetLoader>> = { ...CORE_WIDGET_LOADERS, ...COD_WIDGET_LOADERS, ...SUBSCRIPTION_WIDGET_LOADERS };

/**
 * Short per-process cache shared by the widgets of a page and the requests right after it: the same
 * P/L, summary or campaign economics is computed once per (tenant, settings, period) for 60 seconds.
 * Failed computations are not kept.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 400;
const store = new Map<string, { at: number; value: Promise<unknown> }>();
export const sharedMemo: Memo = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  if (store.size >= MAX_ENTRIES) for (const [k, v] of store) if (now - v.at >= TTL_MS || store.size >= MAX_ENTRIES) store.delete(k);
  const value = fn().catch((e) => {
    store.delete(key);
    throw e;
  });
  store.set(key, { at: now, value });
  return value;
};

export const tenantCustoms = cache(async (ctx: TenantContext): Promise<CustomMetricRow[]> => ctx.run((tx) => listTenantMetrics({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } })));

export function analyticsTenant(ctx: TenantContext) {
  return { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
}

/** The environment widgets load in; `role` may be a manager's "preview as" role. */
export async function widgetEnv(ctx: TenantContext, role: TenantRole = ctx.role): Promise<WidgetEnv> {
  return { tenant: analyticsTenant(ctx), role, activeAddons: ctx.activeAddons, userId: ctx.user.id, locale: ctx.locale, customs: await tenantCustoms(ctx), memo: sharedMemo };
}

/** A minute-rounded clock, so the periods (and the cache keys built on them) of one page agree. */
export const pageNow = cache(() => new Date(Math.floor(Date.now() / 60_000) * 60_000));

export function widgetPeriod(w: Pick<DashboardWidget, "type" | "period">, dashboardPeriodKey: DashboardPeriod, timezone: string, now: Date): Period {
  return dashboardPeriod(WIDGETS[w.type].usesPeriod ? (w.period ?? dashboardPeriodKey) : "30d", now, timezone);
}

/** Loads one widget in its own tenant transaction, so widgets run in parallel and a slow one never blocks the others. */
export async function loadWidget(ctx: TenantContext, env: WidgetEnv, w: Pick<DashboardWidget, "type" | "settings">, period: Period): Promise<WidgetResult> {
  const key = `widget|${ctx.tenant.id}|${env.role}|${w.type}|${JSON.stringify(w.settings)}|${period.from.toISOString()}|${period.to.toISOString()}`;
  try {
    return await sharedMemo(key, async () => {
      const r = await ctx.run((tx) => loadWidgetData({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { ...env, now: period.to }, w, period, WIDGET_LOADERS));
      if (!r.ok && r.reason === "failed") throw Object.assign(new Error(r.message ?? "failed"), { result: r });
      return r;
    });
  } catch (e) {
    const result = (e as { result?: WidgetResult }).result;
    console.error(`[dashboard] widget ${w.type} failed:`, e instanceof Error ? e.message : e);
    return result ?? { ok: false, reason: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

import { and, eq, inArray, isNotNull, or, schema, sql } from "@hullwise/db";
import { subscriberCounts, timelineMrrAt } from "@hullwise/core";
import type { WidgetType } from "@hullwise/config";
import type { WidgetLoader } from "../dashboards/widgets";
import { loadSubscriptionTimelines } from "./analytics";

/**
 * Home widgets of `addon.subscriptions` (#43 registry): MRR, active subscribers, churn, value at
 * risk. Their definitions carry the module, so `loadWidgetData` refuses them without the add-on.
 */

export interface SubsMrrData { mrrMinor: number; previousMinor: number; currency: string; path: string }
export interface SubsActiveData { active: number; paused: number; new30: number; path: string }
export interface SubsChurnData { rate: number | null; voluntary: number; involuntary: number; cancelled: number; liveAtStart: number; path: string }
export interface SubsAtRiskData { count: number; valueAtRiskMinor: number; failing: number; highRisk: number; currency: string; path: string }

const subsMrr: WidgetLoader = async (ctx, env) => {
  const now = env.now ?? new Date();
  const { timelines } = await loadSubscriptionTimelines(ctx);
  return { mrrMinor: timelines.reduce((s, t) => s + timelineMrrAt(t, now), 0), previousMinor: timelines.reduce((s, t) => s + timelineMrrAt(t, new Date(now.getTime() - 30 * 864e5)), 0), currency: env.tenant.currency, path: "subscriptions" } satisfies SubsMrrData;
};

const subsActive: WidgetLoader = async (ctx, env) => {
  const now = env.now ?? new Date();
  const { timelines } = await loadSubscriptionTimelines(ctx);
  const c = subscriberCounts(timelines, { from: new Date(now.getTime() - 30 * 864e5), to: new Date(now.getTime() + 1) });
  return { active: c.active, paused: c.paused, new30: c.new, path: "subscriptions/subscribers?status=active" } satisfies SubsActiveData;
};

const subsChurn: WidgetLoader = async (ctx, _env, { period }) => {
  const { timelines } = await loadSubscriptionTimelines(ctx);
  const c = subscriberCounts(timelines, period);
  return { rate: c.churnRate, voluntary: c.voluntary, involuntary: c.involuntary, cancelled: c.cancelled, liveAtStart: c.liveAtStart, path: `subscriptions/subscribers?endedFrom=${period.from.toISOString().slice(0, 10)}&endedTo=${period.to.toISOString().slice(0, 10)}` } satisfies SubsChurnData;
};

const subsAtRisk: WidgetLoader = async (ctx, env) => {
  const c = schema.subscriptionContracts;
  const [r] = await ctx.tx.select({ count: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${c.priceMinor}), 0)::int`, failing: sql<number>`count(*) filter (where ${c.paymentFailingSince} is not null)::int`, high: sql<number>`count(*) filter (where ${c.churnRisk} = 'high')::int` }).from(c).where(and(eq(c.tenantId, ctx.tenantId), inArray(c.status, ["active", "paused"]), or(isNotNull(c.paymentFailingSince), eq(c.churnRisk, "high"))));
  return { count: r?.count ?? 0, valueAtRiskMinor: r?.value ?? 0, failing: r?.failing ?? 0, highRisk: r?.high ?? 0, currency: env.tenant.currency, path: "subscriptions/recovery" } satisfies SubsAtRiskData;
};

export const SUBSCRIPTION_WIDGET_LOADERS: Partial<Record<WidgetType, WidgetLoader>> = { subs_mrr: subsMrr, subs_active: subsActive, subs_churn: subsChurn, subs_at_risk: subsAtRisk };

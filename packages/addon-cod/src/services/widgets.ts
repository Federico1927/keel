import { and, eq, inArray, schema, sql } from "@hullwise/db";
import { localDateKey, zonedDayStart } from "@hullwise/core";
import type { QueueData, WidgetLoader } from "@hullwise/services";
import { OPEN_QUEUE_STATUSES, TO_CALL_STATUSES } from "../queue";

/**
 * The add-on's dashboard widgets (issue #43, C.10). Registered next to the core loaders by the app;
 * `loadWidgetData` refuses them for tenants without `addon.cod` (their definitions carry the module).
 */

const openWhere = (tenantId: string, statuses: readonly string[] = TO_CALL_STATUSES) => and(eq(schema.codQueueItems.tenantId, tenantId), inArray(schema.codQueueItems.status, [...statuses]));

const codQueue: WidgetLoader = async (ctx) => {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int`, unassigned: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} is null)::int` }).from(schema.codQueueItems).where(openWhere(ctx.tenantId));
  return { count: r?.n ?? 0, path: "cod", parts: { unassigned: r?.unassigned ?? 0 } } satisfies QueueData;
};

export interface CodPendingData {
  today: number;
  yesterday: number;
  week: number;
  total: number;
  path: string;
}
/** COD orders still to confirm by the day they were placed (tenant-local): today, yesterday, the last 7 days. */
const codPending: WidgetLoader = async (ctx, env) => {
  const now = env.now ?? new Date();
  const tz = env.tenant.timezone;
  const today = zonedDayStart(localDateKey(now, tz), tz);
  const yesterday = zonedDayStart(localDateKey(new Date(today.getTime() - 12 * 3600e3), tz), tz);
  const week = zonedDayStart(localDateKey(new Date(today.getTime() - 6 * 864e5 + 12 * 3600e3), tz), tz);
  const [r] = await ctx.tx
    .select({ today: sql<number>`count(*) filter (where ${schema.orders.placedAt} >= ${today})::int`, yesterday: sql<number>`count(*) filter (where ${schema.orders.placedAt} >= ${yesterday} and ${schema.orders.placedAt} < ${today})::int`, week: sql<number>`count(*) filter (where ${schema.orders.placedAt} >= ${week})::int`, total: sql<number>`count(*)::int` })
    .from(schema.codQueueItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.codQueueItems.orderId))
    .where(openWhere(ctx.tenantId, OPEN_QUEUE_STATUSES));
  return { today: r?.today ?? 0, yesterday: r?.yesterday ?? 0, week: r?.week ?? 0, total: r?.total ?? 0, path: "cod" } satisfies CodPendingData;
};

export interface CodOperatorsData {
  rows: { userId: string | null; name: string | null; toCall: number; overdue: number }[];
  path: string;
}
/** Open tickets per operator (to call, overdue call-backs), unassigned last. */
const codOperators: WidgetLoader = async (ctx, env) => {
  const now = env.now ?? new Date();
  const rows = await ctx.tx
    .select({ userId: schema.codQueueItems.assignedTo, name: sql<string | null>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})`, toCall: sql<number>`count(*) filter (where ${schema.codQueueItems.status} in ('pending','scheduled'))::int`, overdue: sql<number>`count(*) filter (where ${schema.codQueueItems.callBackAt} <= ${now})::int` })
    .from(schema.codQueueItems)
    .leftJoin(schema.users, eq(schema.users.id, schema.codQueueItems.assignedTo))
    .where(openWhere(ctx.tenantId, OPEN_QUEUE_STATUSES))
    .groupBy(schema.codQueueItems.assignedTo, schema.users.preferredName, schema.users.name, schema.users.email);
  return { rows: rows.sort((a, b) => Number(!a.userId) - Number(!b.userId) || b.toCall - a.toCall).slice(0, 12), path: "cod/team" } satisfies CodOperatorsData;
};

export interface CodMineData {
  toCall: number;
  callBacksDue: number;
  neverContacted: number;
  planned: number;
  unreachable: number;
  path: string;
}
/** The viewer's own assigned split. */
const codMine: WidgetLoader = async (ctx, env) => {
  const now = env.now ?? new Date();
  const [r] = await ctx.tx
    .select({ toCall: sql<number>`count(*) filter (where ${schema.codQueueItems.status} in ('pending','scheduled'))::int`, callBacksDue: sql<number>`count(*) filter (where ${schema.codQueueItems.callBackAt} <= ${now})::int`, neverContacted: sql<number>`count(*) filter (where ${schema.codQueueItems.status} = 'pending' and ${schema.codQueueItems.attemptsCount} = 0)::int`, planned: sql<number>`count(*) filter (where ${schema.codQueueItems.status} = 'confirm_scheduled')::int`, unreachable: sql<number>`count(*) filter (where ${schema.codQueueItems.status} = 'unreachable')::int` })
    .from(schema.codQueueItems)
    .where(and(openWhere(ctx.tenantId, OPEN_QUEUE_STATUSES), eq(schema.codQueueItems.assignedTo, env.userId ?? "00000000-0000-0000-0000-000000000000")));
  return { toCall: r?.toCall ?? 0, callBacksDue: r?.callBacksDue ?? 0, neverContacted: r?.neverContacted ?? 0, planned: r?.planned ?? 0, unreachable: r?.unreachable ?? 0, path: "cod?view=mine" } satisfies CodMineData;
};

export const COD_WIDGET_LOADERS: Record<"cod_queue" | "cod_pending" | "cod_operators" | "cod_mine", WidgetLoader> = { cod_queue: codQueue, cod_pending: codPending, cod_operators: codOperators, cod_mine: codMine };

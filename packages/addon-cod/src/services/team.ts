import { and, desc, eq, inArray, schema, sql } from "@keel/db";
import type { ServiceContext } from "@keel/services";
import { isBottleneck } from "../economics";
import { OPEN_QUEUE_STATUSES, TO_CALL_STATUSES, type QueueStatus } from "../queue";
import type { CodSettings } from "../settings";
import { getCodSettings } from "./index";

/**
 * Customer-care console (C.11): the supervisor's view of who holds what right now, efficiency per
 * operator over a period, and the per-operator attribution list (what each one handled, with links).
 */

export interface SupervisorRow {
  userId: string | null;
  name: string | null;
  email: string | null;
  open: number;
  toCall: number;
  overdueCallBacks: number;
  neverContacted: number;
  planned: number;
  unreachable: number;
  escalated: number;
  oldestHours: number | null;
  bottleneck: boolean;
}

export async function supervisorView(ctx: ServiceContext, settings?: CodSettings): Promise<{ rows: SupervisorRow[]; teamAverage: number }> {
  const s = settings ?? (await getCodSettings(ctx));
  const now = ctx.now ?? new Date();
  const items = await ctx.tx.select({ assignedTo: schema.codQueueItems.assignedTo, status: schema.codQueueItems.status, callBackAt: schema.codQueueItems.callBackAt, attemptsCount: schema.codQueueItems.attemptsCount, enteredAt: schema.codQueueItems.enteredAt, escalatedAt: schema.codQueueItems.escalatedAt }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const caps = await ctx.tx.select({ userId: schema.codOperatorCapacity.userId }).from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.isActive, 1)));
  const ids = [...new Set([...caps.map((c) => c.userId), ...items.map((i) => i.assignedTo).filter((x): x is string => Boolean(x))])];
  const users = ids.length ? await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
  const build = (userId: string | null): Omit<SupervisorRow, "bottleneck"> => {
    const mine = items.filter((i) => i.assignedTo === userId);
    const toCall = mine.filter((i) => TO_CALL_STATUSES.includes(i.status as QueueStatus));
    const oldest = toCall.reduce<Date | null>((m, i) => (!m || i.enteredAt < m ? i.enteredAt : m), null);
    const u = users.find((x) => x.id === userId);
    return { userId, name: u?.name ?? null, email: u?.email ?? null, open: mine.length, toCall: toCall.length, overdueCallBacks: mine.filter((i) => i.callBackAt && i.callBackAt <= now).length, neverContacted: toCall.filter((i) => i.attemptsCount === 0).length, planned: mine.filter((i) => i.status === "confirm_scheduled").length, unreachable: mine.filter((i) => i.status === "unreachable").length, escalated: mine.filter((i) => i.escalatedAt).length, oldestHours: oldest ? Math.floor((now.getTime() - oldest.getTime()) / 3600e3) : null };
  };
  const operators = ids.map(build);
  const teamAverage = operators.length ? operators.reduce((sum, r) => sum + r.toCall, 0) / operators.length : 0;
  const rows: SupervisorRow[] = operators.map((r) => ({ ...r, bottleneck: isBottleneck(r.toCall, teamAverage, s.bottleneckFactor) })).sort((a, b) => b.toCall - a.toCall || (a.email ?? "").localeCompare(b.email ?? ""));
  const unassigned = build(null);
  if (unassigned.open) rows.push({ ...unassigned, bottleneck: false });
  return { rows, teamAverage: Math.round(teamAverage * 10) / 10 };
}

export interface EfficiencyRow {
  operatorId: string | null;
  name: string | null;
  email: string | null;
  attempts: number;
  /** Orders the operator registered at least one attempt on. */
  handled: number;
  confirmed: number;
  cancelled: number;
  noAnswer: number;
  messages: number;
  confirmedPct: number | null;
  attemptsPerConfirmation: number | null;
  /** Minutes from entering the queue to the operator's closing call, averaged over closed orders. */
  avgHandlingMinutes: number | null;
  /** Orders closed (confirmed or cancelled) per day with activity. */
  closedPerDay: number | null;
}

/** Efficiency per operator over [from, to): outcomes, ratios and handling time, from attempts only. */
export async function operatorEfficiency(ctx: ServiceContext, period: { from: Date; to: Date }, opts: { userId?: string } = {}): Promise<EfficiencyRow[]> {
  const a = schema.codAttempts;
  const rows = await ctx.tx.execute<{ operator_id: string | null; name: string | null; email: string | null; attempts: number; handled: number; confirmed: number; cancelled: number; no_answer: number; messages: number; closing_attempts: number; avg_minutes: number | null; active_days: number }>(sql`
    with p as (
      select a.operator_id, a.order_id, a.outcome, a.created_at, qi.entered_at
      from ${a} a join ${schema.codQueueItems} qi on qi.id = a.queue_item_id
      where a.tenant_id = ${ctx.tenantId} and a.created_at >= ${period.from} and a.created_at < ${period.to}
        ${opts.userId ? sql`and a.operator_id = ${opts.userId}` : sql``}
    ), closed as (
      select operator_id, order_id, outcome, created_at, entered_at from p where outcome in ('confirmed','cancelled')
    )
    select p.operator_id, u.name, u.email,
      count(*)::int as attempts,
      count(distinct p.order_id)::int as handled,
      count(distinct p.order_id) filter (where p.outcome = 'confirmed')::int as confirmed,
      count(distinct p.order_id) filter (where p.outcome = 'cancelled')::int as cancelled,
      count(*) filter (where p.outcome = 'no_answer')::int as no_answer,
      count(*) filter (where p.outcome = 'message_sent')::int as messages,
      (select count(*) from p p2 where p2.operator_id is not distinct from p.operator_id and p2.order_id in (select order_id from closed c where c.operator_id is not distinct from p.operator_id and c.outcome = 'confirmed'))::int as closing_attempts,
      (select round(avg(extract(epoch from (c.created_at - c.entered_at)) / 60))::int from closed c where c.operator_id is not distinct from p.operator_id) as avg_minutes,
      count(distinct date_trunc('day', p.created_at)) filter (where p.outcome in ('confirmed','cancelled'))::int as active_days
    from p left join ${schema.users} u on u.id = p.operator_id
    group by p.operator_id, u.name, u.email
    order by attempts desc`);
  return rows.rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    email: r.email,
    attempts: r.attempts,
    handled: r.handled,
    confirmed: r.confirmed,
    cancelled: r.cancelled,
    noAnswer: r.no_answer,
    messages: r.messages,
    confirmedPct: r.handled ? Math.round((100 * r.confirmed) / r.handled) : null,
    attemptsPerConfirmation: r.confirmed ? Math.round((10 * r.closing_attempts) / r.confirmed) / 10 : null,
    avgHandlingMinutes: r.avg_minutes,
    closedPerDay: r.active_days ? Math.round((10 * (r.confirmed + r.cancelled)) / r.active_days) / 10 : null,
  }));
}

export interface AttributionRow {
  orderId: string;
  orderName: string;
  customerName: string | null;
  totalMinor: number;
  currency: string;
  attempts: number;
  lastOutcome: string;
  lastAt: Date;
  queueStatus: string | null;
}

/** What an operator handled in the period: one row per order, with their last outcome; `outcome` narrows to orders they closed that way. */
export async function operatorAttribution(ctx: ServiceContext, userId: string, period: { from: Date; to: Date }, opts: { outcome?: "confirmed" | "cancelled"; limit?: number } = {}): Promise<AttributionRow[]> {
  const a = schema.codAttempts;
  const rows = await ctx.tx
    .select({ orderId: a.orderId, orderName: schema.orders.name, customerName: schema.orders.customerName, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, attempts: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${a.createdAt})`, lastOutcome: sql<string>`(array_agg(${a.outcome} order by ${a.createdAt} desc))[1]`, queueStatus: schema.codQueueItems.status })
    .from(a)
    .innerJoin(schema.orders, eq(schema.orders.id, a.orderId))
    .leftJoin(schema.codQueueItems, eq(schema.codQueueItems.id, a.queueItemId))
    .where(and(eq(a.tenantId, ctx.tenantId), eq(a.operatorId, userId), sql`${a.createdAt} >= ${period.from}`, sql`${a.createdAt} < ${period.to}`, opts.outcome ? sql`exists (select 1 from cod_attempts x where x.order_id = ${a.orderId} and x.operator_id = ${userId} and x.outcome = ${opts.outcome} and x.created_at >= ${period.from} and x.created_at < ${period.to})` : undefined))
    .groupBy(a.orderId, schema.orders.name, schema.orders.customerName, schema.orders.totalMinor, schema.orders.currency, schema.codQueueItems.status)
    .orderBy(desc(sql`max(${a.createdAt})`))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({ ...r, lastAt: r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt) }));
}

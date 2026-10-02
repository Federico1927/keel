import { and, eq, inArray, recordAudit, schema, sql } from "@keel/db";
import { localDateKey, zonedDayStart } from "@keel/core";
import type { CommercePlatform } from "@keel/integrations";
import { notifyUsers, type ServiceContext } from "@keel/services";
import { localDay, hoursFor } from "../assignment";
import { OPEN_QUEUE_STATUSES, TO_CALL_STATUSES, bucketStats, splitEvenly, type QueueStatus } from "../queue";
import type { CodSettings } from "../settings";
import { operatorAllowed } from "../tags";
import { CodError, assignQueueItem, getCodSettings, queueItems, recordAttempt, type QueueFilters, type QueueView } from "./index";

/**
 * Queue operations of the add-on beyond a single call: tiles, navigation, transfers and escalation,
 * bulk actions and the daily scheduled confirmations. Every change leaves a `cod_assignment_log`
 * row or an order event, and the people-facing ones an audit row.
 */

const auditActor = (ctx: ServiceContext) => ({ actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? ("user" as const) : ("system" as const) });

async function openItem(ctx: ServiceContext, orderId: string) {
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) throw new CodError("not_in_queue");
  return item;
}

/* ---------- tiles and navigation (C.1, C.3) ---------- */

export interface QueueTile {
  view: QueueView;
  count: number;
  avgAgeHours: number | null;
}

/** Count and average age per view, from one read of the open items. */
export async function queueTiles(ctx: ServiceContext, userId: string | null): Promise<QueueTile[]> {
  const now = ctx.now ?? new Date();
  const items = await ctx.tx.select({ status: schema.codQueueItems.status, assignedTo: schema.codQueueItems.assignedTo, enteredAt: schema.codQueueItems.enteredAt, escalatedAt: schema.codQueueItems.escalatedAt }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const toCall = items.filter((i) => TO_CALL_STATUSES.includes(i.status as QueueStatus));
  const buckets: Record<QueueView, { enteredAt: Date }[]> = {
    all: toCall,
    mine: toCall.filter((i) => userId && i.assignedTo === userId),
    unassigned: toCall.filter((i) => !i.assignedTo),
    scheduled: items.filter((i) => i.status === "scheduled"),
    planned: items.filter((i) => i.status === "confirm_scheduled"),
    unreachable: items.filter((i) => i.status === "unreachable"),
    escalated: items.filter((i) => i.escalatedAt),
  };
  return (Object.keys(buckets) as QueueView[]).map((view) => ({ view, ...bucketStats(buckets[view], now) }));
}

/** Previous and next order of the same queue view, in calling order, for the detail navigator. */
export async function queueNeighbours(ctx: ServiceContext, orderId: string, f: QueueFilters): Promise<{ position: number; total: number; prev: { id: string; name: string } | null; next: { id: string; name: string } | null } | null> {
  const { rows } = await queueItems(ctx, { ...f, limit: f.limit ?? 500 });
  const i = rows.findIndex((r) => r.order.id === orderId);
  if (i < 0) return rows.length ? { position: 0, total: rows.length, prev: null, next: { id: rows[0]!.order.id, name: rows[0]!.order.name } } : null;
  const at = (k: number) => (rows[k] ? { id: rows[k]!.order.id, name: rows[k]!.order.name } : null);
  return { position: i + 1, total: rows.length, prev: at(i - 1), next: at(i + 1) };
}

/* ---------- transfer and escalation (C.9) ---------- */

async function activeMember(ctx: ServiceContext, userId: string) {
  const [m] = await ctx.tx.select({ role: schema.tenantMemberships.role }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
  return m ?? null;
}

/** Transfers made by a user today (tenant-local day): what the daily limit counts. */
export async function transfersToday(ctx: ServiceContext, userId: string, timezone: string): Promise<number> {
  const now = ctx.now ?? new Date();
  const start = zonedDayStart(localDateKey(now, timezone), timezone);
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.codAssignmentLog).where(and(eq(schema.codAssignmentLog.tenantId, ctx.tenantId), eq(schema.codAssignmentLog.actorUserId, userId), eq(schema.codAssignmentLog.reason, "transfer"), sql`${schema.codAssignmentLog.assignedAt} >= ${start}`));
  return r?.n ?? 0;
}

/**
 * Passes an item to a colleague. Operators: only their own items, never after the first attempt
 * (the reference's anti-abuse rule) and within the daily limit; admins without limits. The target
 * must be an active member allowed to take the item's entry tag.
 */
export async function transferQueueItem(ctx: ServiceContext, orderId: string, toUserId: string, opts: { isAdmin: boolean; timezone: string; settings?: CodSettings; note?: string | null }): Promise<{ transfersToday: number }> {
  const me = ctx.actor.userId;
  if (!me) throw new CodError("forbidden");
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const item = await openItem(ctx, orderId);
  if (toUserId === item.assignedTo) throw new CodError("invalid_input", "same_operator");
  if (!opts.isAdmin) {
    if (item.assignedTo !== me) throw new CodError("forbidden", "not_yours");
    if (item.attemptsCount > 0) throw new CodError("forbidden", "already_called");
  }
  const done = await transfersToday(ctx, me, opts.timezone);
  if (!opts.isAdmin && done >= settings.transferDailyLimit) throw new CodError("forbidden", "daily_limit");
  if (!(await activeMember(ctx, toUserId))) throw new CodError("invalid_input", "target");
  const [cap] = await ctx.tx.select({ allowedTags: schema.codOperatorCapacity.allowedTags }).from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.userId, toUserId))).limit(1);
  if (cap && !operatorAllowed(cap.allowedTags as string[], item.entryTag)) throw new CodError("operator_unavailable");
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.codQueueItems).set({ assignedTo: toUserId, assignedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.update(schema.orders).set({ assignedTo: toUserId }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId, assignedTo: toUserId, source: "manual", reason: "transfer", actorUserId: me, assignedAt: now });
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cod_assigned", actorType: ctx.actor.type, actorUserId: me, diff: { assignedTo: { from: item.assignedTo, to: toUserId } }, metadata: { source: "manual", reason: "transfer", note: opts.note ?? null }, createdAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.transferred", entityType: "order", entityId: orderId, diff: { assignedTo: { from: item.assignedTo, to: toUserId } }, metadata: { note: opts.note ?? null, transfersToday: done + 1, admin: opts.isAdmin } });
  if (toUserId !== me) await notifyUsers(ctx, { userIds: [toUserId], type: "cod_assigned", title: "cod_assigned", link: `/orders/${orderId}`, metadata: { orderId, transfer: true }, antiSpamMinutes: 1 });
  return { transfersToday: done + 1 };
}

/** Flags an item for an admin (a customer to handle with care, a decision above the operator). */
export async function escalateQueueItem(ctx: ServiceContext, orderId: string, reason: string): Promise<void> {
  const text = reason.trim().slice(0, 500);
  if (text.length < 3) throw new CodError("invalid_input", "reason");
  const item = await openItem(ctx, orderId);
  if (item.escalatedAt) return;
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.codQueueItems).set({ escalatedAt: now, escalatedBy: ctx.actor.userId, escalationReason: text, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cod_escalated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { escalated: { from: false, to: true } }, metadata: { reason: text }, createdAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.escalated", entityType: "order", entityId: orderId, diff: { escalated: { from: false, to: true } }, metadata: { reason: text } });
  const admins = await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true), inArray(schema.tenantMemberships.role, ["owner", "admin"])));
  const [order] = await ctx.tx.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  await notifyUsers(ctx, { userIds: admins.map((a) => a.userId).filter((u) => u !== ctx.actor.userId), type: "cod_assigned", title: `${order?.name ?? ""} ⚑ ${text}`.trim(), link: `/orders/${orderId}`, severity: "warning", metadata: { orderId, escalated: true }, antiSpamMinutes: 1 });
}

/** Admin: closes the escalation, optionally handing the item to someone. */
export async function resolveEscalation(ctx: ServiceContext, orderId: string, opts: { assignTo?: string | null; timezone: string }): Promise<void> {
  const item = await openItem(ctx, orderId);
  if (!item.escalatedAt) return;
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.codQueueItems).set({ escalatedAt: null, escalatedBy: null, escalationReason: null, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cod_escalated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { escalated: { from: true, to: false } }, metadata: { reason: item.escalationReason, resolved: true }, createdAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.escalation_resolved", entityType: "order", entityId: orderId, diff: { escalated: { from: true, to: false } }, metadata: { assignTo: opts.assignTo ?? null } });
  if (opts.assignTo && opts.assignTo !== item.assignedTo) await assignQueueItem(ctx, orderId, { source: "manual", timezone: opts.timezone, userId: opts.assignTo });
}

/* ---------- bulk actions (C.4) ---------- */

export interface BulkResult {
  done: number;
  failed: { orderId: string; code: string }[];
}

async function eachOrder(orderIds: readonly string[], fn: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const out: BulkResult = { done: 0, failed: [] };
  for (const id of [...new Set(orderIds)].slice(0, 200)) {
    try {
      await fn(id);
      out.done++;
    } catch (e) {
      if (!(e instanceof CodError)) throw e;
      out.failed.push({ orderId: id, code: e.code });
    }
  }
  return out;
}

/** Assigns (or, with `null`, unassigns) every selected open item: bulk reassign and bulk transfer. */
export async function bulkAssign(ctx: ServiceContext, orderIds: readonly string[], userId: string | null, opts: { timezone: string }): Promise<BulkResult> {
  if (userId && !(await activeMember(ctx, userId))) throw new CodError("invalid_input", "target");
  const now = ctx.now ?? new Date();
  const r = await eachOrder(orderIds, async (id) => {
    const item = await openItem(ctx, id);
    if (userId) return assignQueueItem(ctx, id, { source: "manual", timezone: opts.timezone, userId });
    if (!item.assignedTo) return;
    await ctx.tx.update(schema.codQueueItems).set({ assignedTo: null, assignedAt: null, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
    await ctx.tx.update(schema.orders).set({ assignedTo: null }).where(eq(schema.orders.id, id));
    await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId: id, assignedTo: null, source: "manual", reason: "admin_unassign", actorUserId: ctx.actor.userId, assignedAt: now });
  });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.bulk_assigned", metadata: { to: userId, done: r.done, failed: r.failed.length } });
  return r;
}

/** Operators working today (hours > 0, active, not off), for an equal split. */
export async function operatorsOnDuty(ctx: ServiceContext, timezone: string): Promise<string[]> {
  const now = ctx.now ?? new Date();
  const { dow, date } = localDay(now, timezone);
  const caps = await ctx.tx.select().from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.isActive, 1)));
  const ex = await ctx.tx.select().from(schema.codCapacityExceptions).where(and(eq(schema.codCapacityExceptions.tenantId, ctx.tenantId), eq(schema.codCapacityExceptions.date, date)));
  const members = new Set((await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true)))).map((m) => m.userId));
  return caps
    .filter((c) => members.has(c.userId))
    .filter((c) => {
      const e = ex.find((x) => x.userId === c.userId);
      return hoursFor(c.dailyHours as number[], dow, e ? { kind: e.kind as "off" | "extra", hours: e.hours } : null) > 0;
    })
    .map((c) => c.userId)
    .sort();
}

/** Splits the selected items equally (not by hours) across the given operators, or those on duty today. */
export async function distributeEqually(ctx: ServiceContext, orderIds: readonly string[], opts: { timezone: string; userIds?: string[] }): Promise<BulkResult> {
  const operators = opts.userIds?.length ? [...new Set(opts.userIds)] : await operatorsOnDuty(ctx, opts.timezone);
  if (!operators.length) throw new CodError("operator_unavailable");
  const items = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.orderId, [...new Set(orderIds)].slice(0, 200)), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]))).orderBy(schema.codQueueItems.enteredAt);
  const split = splitEvenly(items.map((i) => i.orderId), operators.map((userId) => ({ userId, load: 0 })));
  const out: BulkResult = { done: 0, failed: orderIds.filter((id) => !items.some((i) => i.orderId === id)).map((orderId) => ({ orderId, code: "not_in_queue" })) };
  for (const [userId, ids] of split) {
    const r = await eachOrder(ids, (id) => assignQueueItem(ctx, id, { source: "manual", timezone: opts.timezone, userId }));
    out.done += r.done;
    out.failed.push(...r.failed);
  }
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: "cod.distributed_equally", metadata: { operators, done: out.done, failed: out.failed.length } });
  return out;
}

/** Bulk confirm or cancel: each order is one attempt with that outcome, platform first; refusals are reported per order. */
export async function bulkOutcome(ctx: ServiceContext, orderIds: readonly string[], outcome: "confirmed" | "cancelled", opts: { platform?: CommercePlatform; settings?: CodSettings; note?: string | null }): Promise<BulkResult> {
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const r = await eachOrder(orderIds, (id) => recordAttempt(ctx, { orderId: id, outcome, note: opts.note ?? null, channel: "bulk" }, settings, { platform: opts.platform }));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditActor(ctx), action: `cod.bulk_${outcome}`, metadata: { done: r.done, failed: r.failed.length } });
  return r;
}

/* ---------- scheduled confirmations (C.5) ---------- */

/**
 * Daily job: from the configured local hour, confirms the items whose agreed day has come. A failed
 * platform call keeps the date and records the error; the item is tried again on the next day's run.
 */
export async function runScheduledConfirmations(ctx: ServiceContext, opts: { timezone: string; platform?: CommercePlatform; settings?: CodSettings }): Promise<{ confirmed: number; failed: number }> {
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const now = ctx.now ?? new Date();
  const today = localDateKey(now, opts.timezone);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: opts.timezone, hour: "numeric", hour12: false }).format(now)) % 24;
  if (hour < settings.scheduledConfirmHour) return { confirmed: 0, failed: 0 };
  const due = await ctx.tx
    .select({ id: schema.codQueueItems.id, orderId: schema.codQueueItems.orderId })
    .from(schema.codQueueItems)
    .where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.status, "confirm_scheduled"), sql`${schema.codQueueItems.scheduledConfirmOn} <= ${today}`, sql`(${schema.codQueueItems.scheduledConfirmTriedOn} is null or ${schema.codQueueItems.scheduledConfirmTriedOn} < ${today})`))
    .orderBy(schema.codQueueItems.scheduledConfirmOn)
    .limit(500);
  let confirmed = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await recordAttempt(ctx, { orderId: d.orderId, outcome: "confirmed", channel: "scheduled", note: null }, settings, { platform: opts.platform });
      confirmed++;
    } catch (e) {
      if (!(e instanceof CodError)) throw e;
      failed++;
      await ctx.tx.update(schema.codQueueItems).set({ scheduledConfirmTriedOn: today, scheduledConfirmError: (e.detail ?? e.code).slice(0, 300), updatedAt: now }).where(eq(schema.codQueueItems.id, d.id));
    }
  }
  return { confirmed, failed };
}

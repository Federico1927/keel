import { and, desc, eq, inArray, schema, sql, type SQL } from "@keel/db";
import { normalizePhone } from "@keel/core";
import { customerOrderHistory, duplicateSiblings, notifyUsers, recomputeOrderStatus, setManualStatus, type ServiceContext } from "@keel/services";
import { hoursFor, localDay, nextOperator } from "../assignment";
import { ATTEMPT_OUTCOMES, OPEN_QUEUE_STATUSES, applyOutcome, compareQueue, type AttemptOutcome, type QueueStatus } from "../queue";
import { buildRecipientProfile, classifyRecipient, recipientKey, type RecipientShipment } from "../risk";
import { computeDeliveryScore, type OutcomeRecord, type ScoreResult } from "../scoring";
import { parseCodSettings, type CodSettings, type RiskTier } from "../settings";

export class CodError extends Error {
  constructor(public readonly code: "not_in_queue" | "invalid_outcome" | "operator_unavailable" | "forbidden" | "not_found" | "invalid_input") {
    super(code);
  }
}

/* ---------- settings ---------- */

export async function getCodSettings(ctx: ServiceContext): Promise<CodSettings> {
  const [row] = await ctx.tx.select().from(schema.codSettings).where(eq(schema.codSettings.tenantId, ctx.tenantId)).limit(1);
  return parseCodSettings(row?.config);
}

export async function saveCodSettings(ctx: ServiceContext, patch: unknown): Promise<CodSettings> {
  const current = await getCodSettings(ctx);
  const merged = parseCodSettings({ ...current, ...(patch as object), weights: { ...current.weights, ...((patch as { weights?: object }).weights ?? {}) }, risk: { ...current.risk, ...((patch as { risk?: object }).risk ?? {}) } });
  await ctx.tx.insert(schema.codSettings).values({ tenantId: ctx.tenantId, config: merged }).onConflictDoUpdate({ target: [schema.codSettings.tenantId], set: { config: merged, updatedAt: new Date() } });
  return merged;
}

/* ---------- queue membership ---------- */

/** Which orders belong in the confirmation queue: COD, open canonical state, not shipped, inside the cutoff. */
function queueEligibleWhere(ctx: ServiceContext, settings: CodSettings, now: Date): SQL {
  return and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.paymentMethod, "cod"), inArray(schema.orders.status, ["new", "pending_review"]), sql`${schema.orders.cancelledAt} is null`, sql`${schema.orders.placedAt} >= ${new Date(now.getTime() - settings.queueCutoffDays * 864e5)}`, sql`not exists (select 1 from shipments s where s.order_id = ${schema.orders.id})`)!;
}

/**
 * Keeps `cod_queue_items` aligned with the orders: new eligible orders enter as `pending`,
 * items whose order left the open states close with the reason. Idempotent, cheap, run on page load and by the job.
 */
export async function syncQueue(ctx: ServiceContext, settings?: CodSettings): Promise<{ entered: number; closed: number }> {
  const now = ctx.now ?? new Date();
  const s = settings ?? (await getCodSettings(ctx));
  const eligible = await ctx.tx.select({ id: schema.orders.id }).from(schema.orders).where(queueEligibleWhere(ctx, s, now));
  const eligibleIds = new Set(eligible.map((e) => e.id));
  const open = await ctx.tx.select({ id: schema.codQueueItems.id, orderId: schema.codQueueItems.orderId, status: schema.codQueueItems.status }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const openByOrder = new Map(open.map((o) => [o.orderId, o]));
  let entered = 0;
  const toEnter = [...eligibleIds].filter((id) => !openByOrder.has(id));
  if (toEnter.length) {
    const existing = await ctx.tx.select({ id: schema.codQueueItems.id, orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(inArray(schema.codQueueItems.orderId, toEnter));
    const existingByOrder = new Map(existing.map((e) => [e.orderId, e.id]));
    for (const orderId of toEnter) {
      const prev = existingByOrder.get(orderId);
      if (prev) await ctx.tx.update(schema.codQueueItems).set({ status: "pending", closedAt: null, enteredAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, prev));
      else await ctx.tx.insert(schema.codQueueItems).values({ tenantId: ctx.tenantId, orderId, status: "pending", enteredAt: now });
      entered++;
    }
  }
  let closed = 0;
  const stale = open.filter((o) => !eligibleIds.has(o.orderId));
  if (stale.length) {
    const orders = await ctx.tx.select({ id: schema.orders.id, status: schema.orders.status, holdReason: schema.orders.holdReason }).from(schema.orders).where(inArray(schema.orders.id, stale.map((o) => o.orderId)));
    for (const o of stale) {
      const ord = orders.find((x) => x.id === o.orderId);
      const st = ord?.status;
      // an unreachable item parks the order on hold: it stays in the queue until an operator closes it
      if (st === "on_hold" && ord?.holdReason?.startsWith("cod_")) continue;
      const reason: QueueStatus = st === "cancelled" || st === "refunded" ? "cancelled" : st === "confirmed" || st === "fulfilling" || st === "shipped" || st === "delivered" ? "confirmed" : "left";
      await ctx.tx.update(schema.codQueueItems).set({ status: reason, closedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, o.id));
      closed++;
    }
  }
  return { entered, closed };
}

/* ---------- scoring ---------- */

async function tenantAov(ctx: ServiceContext, now: Date): Promise<number | null> {
  const [row] = await ctx.tx.select({ aov: sql<number | null>`round(avg(${schema.orders.totalMinor}))::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), sql`${schema.orders.placedAt} > ${new Date(now.getTime() - 90 * 864e5)}`, sql`${schema.orders.status} <> 'cancelled'`));
  return row?.aov ?? null;
}

function outcomeOf(status: string, shipmentStatus: string | null): OutcomeRecord["outcome"] {
  if (status === "delivered" || shipmentStatus === "delivered") return "delivered";
  if (status === "returned" || status === "refunded" || shipmentStatus === "returned" || shipmentStatus === "failed") return "refused";
  if (status === "cancelled") return "cancelled";
  return "other";
}

/** Computes and stores the explained score for one queue item; returns the breakdown. */
export async function scoreQueueItem(ctx: ServiceContext, orderId: string, opts: { settings?: CodSettings; timezone?: string } = {}): Promise<ScoreResult> {
  const now = ctx.now ?? new Date();
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new CodError("not_found");
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, orderId)).limit(1);
  const history = await customerOrderHistory(ctx, orderId);
  const others = history.orders.filter((o) => o.id !== orderId);
  const shipmentStatuses = others.length ? await ctx.tx.select({ orderId: schema.shipments.orderId, status: schema.shipments.status }).from(schema.shipments).where(inArray(schema.shipments.orderId, others.map((o) => o.id))) : [];
  const paymentMethods = others.length ? await ctx.tx.select({ id: schema.orders.id, paymentMethod: schema.orders.paymentMethod }).from(schema.orders).where(inArray(schema.orders.id, others.map((o) => o.id))) : [];
  const customerOrders: OutcomeRecord[] | null = history.identified
    ? others.map((o) => ({ outcome: outcomeOf(o.status, shipmentStatuses.find((s) => s.orderId === o.id)?.status ?? null), ageDays: (now.getTime() - new Date(o.placedAt).getTime()) / 864e5 }))
    : null;
  const prepaidDelivered = others.filter((o) => paymentMethods.find((p) => p.id === o.id)?.paymentMethod !== "cod" && outcomeOf(o.status, shipmentStatuses.find((s) => s.orderId === o.id)?.status ?? null) === "delivered").length;
  const lines = await ctx.tx.select({ productId: schema.orderLines.productId, variantId: schema.orderLines.variantId, quantity: schema.orderLines.quantity }).from(schema.orderLines).where(and(eq(schema.orderLines.orderId, orderId), eq(schema.orderLines.isAncillary, false)));
  const myProducts = new Set(lines.map((l) => l.productId).filter(Boolean));
  const recentCancelled = others.filter((o) => o.status === "cancelled" && now.getTime() - new Date(o.placedAt).getTime() < 90 * 864e5);
  let sharesProduct = false;
  if (recentCancelled.length && myProducts.size) {
    const theirLines = await ctx.tx.select({ productId: schema.orderLines.productId }).from(schema.orderLines).where(inArray(schema.orderLines.orderId, recentCancelled.map((o) => o.id)));
    sharesProduct = theirLines.some((l) => l.productId && myProducts.has(l.productId));
  }
  const dupes = await duplicateSiblings(ctx, orderId, 5);
  const duplicates = dupes.some((d) => d.matchType === "same_variant") ? "same_variant" : dupes.some((d) => d.matchType === "same_product") ? "same_product" : "none";
  let similar: { sample: number; delivered: number } | null = null;
  if (order.shippingZip) {
    const [row] = await ctx.tx.select({ sample: sql<number>`count(*)::int`, delivered: sql<number>`count(*) filter (where o.status = 'delivered' or exists (select 1 from shipments s where s.order_id = o.id and s.status = 'delivered'))::int` }).from(sql`orders o`).where(sql`o.tenant_id = ${ctx.tenantId} and o.id <> ${orderId} and o.shipping_zip = ${order.shippingZip} and o.payment_method = ${order.paymentMethod} and o.placed_at > ${new Date(now.getTime() - settings.similarOrdersLookbackDays * 864e5)} and (o.status in ('delivered','returned','refunded','cancelled') or exists (select 1 from shipments s where s.order_id = o.id and s.status in ('delivered','returned','failed')))`);
    similar = row ? { sample: row.sample, delivered: row.delivered } : null;
  }
  const addr = order.shippingAddress as { phone?: string | null; address1?: string | null; zip?: string | null; city?: string | null; province?: string | null; country?: string | null } | null;
  const key = recipientKey(normalizePhone(order.phone ?? addr?.phone ?? null, order.shippingCountry ?? "IT"), order.emailNormalized);
  const [profile] = key ? await ctx.tx.select({ tier: schema.codRecipientProfiles.tier }).from(schema.codRecipientProfiles).where(and(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId), eq(schema.codRecipientProfiles.recipientKey, key))).limit(1) : [];
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: opts.timezone ?? "UTC", hour: "numeric", hour12: false }).format(order.placedAt)) % 24;
  const result = computeDeliveryScore(
    {
      customerOrders,
      prepaidDelivered,
      attempts: item?.attemptsCount ?? 0,
      hoursSinceOrder: (now.getTime() - order.placedAt.getTime()) / 3600e3,
      closed: !["new", "pending_review"].includes(order.status),
      lines,
      address: addr ? { phone: order.phone ?? addr.phone ?? null, address1: addr.address1 ?? null, zip: addr.zip ?? order.shippingZip, city: addr.city ?? order.shippingCity, province: addr.province ?? null, country: addr.country ?? order.shippingCountry } : null,
      similarOrders: similar,
      totalMinor: order.totalMinor,
      aovMinor: await tenantAov(ctx, now),
      localHour,
      recentCancellations: { count: recentCancelled.length, sharesProduct },
      duplicates,
      riskTier: (profile?.tier as RiskTier | undefined) ?? null,
    },
    settings,
  );
  if (item) await ctx.tx.update(schema.codQueueItems).set({ score: result.score, scoreBreakdown: { base: result.base, factors: result.factors, computedAt: now.toISOString() }, riskTier: result.riskTier, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  return result;
}

/** Scores open items missing a score (or all, when `force`), oldest first, bounded. */
export async function scorePendingItems(ctx: ServiceContext, opts: { limit?: number; force?: boolean; timezone?: string } = {}): Promise<number> {
  const settings = await getCodSettings(ctx);
  const conds = [eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])];
  if (!opts.force) conds.push(sql`${schema.codQueueItems.score} is null`);
  const items = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(...conds)).orderBy(schema.codQueueItems.enteredAt).limit(opts.limit ?? 100);
  for (const i of items) await scoreQueueItem(ctx, i.orderId, { settings, timezone: opts.timezone });
  return items.length;
}

/* ---------- attempts and outcomes ---------- */

export interface AttemptInput {
  orderId: string;
  outcome: AttemptOutcome;
  note?: string | null;
  callBackAt?: Date | null;
  channel?: string;
}

/**
 * Records a contact attempt and applies the outcome machine. `confirmed` sets the canonical
 * manual status, `cancelled` only closes the queue item (the order cancellation is the core action).
 */
export async function recordAttempt(ctx: ServiceContext, input: AttemptInput, settings?: CodSettings): Promise<{ status: QueueStatus; attemptNumber: number }> {
  const now = ctx.now ?? new Date();
  const s = settings ?? (await getCodSettings(ctx));
  if (!ATTEMPT_OUTCOMES.includes(input.outcome)) throw new CodError("invalid_outcome");
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, input.orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) throw new CodError("not_in_queue");
  if (input.outcome === "call_back" && !input.callBackAt) throw new CodError("invalid_input");
  const next = applyOutcome({ status: item.status as QueueStatus, noAnswerCount: item.noAnswerCount }, input.outcome, s, input.callBackAt ?? null);
  const attemptNumber = item.attemptsCount + 1;
  await ctx.tx.insert(schema.codAttempts).values({ tenantId: ctx.tenantId, queueItemId: item.id, orderId: input.orderId, operatorId: ctx.actor.userId, attemptNumber, outcome: input.outcome, channel: input.channel ?? "phone", note: input.note ?? null, callBackAt: input.callBackAt ?? null });
  const closing = next.status === "confirmed" || next.status === "cancelled";
  await ctx.tx.update(schema.codQueueItems).set({ status: next.status, noAnswerCount: next.noAnswerCount, callBackAt: next.callBackAt, attemptsCount: attemptNumber, lastAttemptAt: now, closedAt: closing ? now : null, assignedTo: item.assignedTo ?? ctx.actor.userId, assignedAt: item.assignedAt ?? now, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "cod_attempt", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { queueStatus: { from: item.status, to: next.status } }, metadata: { attemptNumber, outcome: input.outcome, callBackAt: input.callBackAt?.toISOString() ?? null, note: input.note ?? null }, createdAt: now });
  if (input.outcome === "confirmed") await setManualStatus(ctx, input.orderId, "confirmed", "cod_confirmed");
  else if (input.outcome === "no_answer" && next.status === "unreachable") await setManualStatus(ctx, input.orderId, "on_hold", "cod_unreachable");
  else if (!item.assignedTo && ctx.actor.userId) await ctx.tx.update(schema.orders).set({ assignedTo: ctx.actor.userId }).where(eq(schema.orders.id, input.orderId));
  // re-score with the new attempt count (not for closed items)
  if (!closing) await scoreQueueItem(ctx, input.orderId, { settings: s }).catch(() => undefined);
  return { status: next.status, attemptNumber };
}

/* ---------- assignment ---------- */

async function availableOperators(ctx: ServiceContext, timezone: string, now: Date) {
  const { dow, date } = localDay(now, timezone);
  const caps = await ctx.tx.select().from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.isActive, 1)));
  if (!caps.length) return { date, operators: [] as { userId: string; hoursToday: number; assignedToday: number }[] };
  const exceptions = await ctx.tx.select().from(schema.codCapacityExceptions).where(and(eq(schema.codCapacityExceptions.tenantId, ctx.tenantId), eq(schema.codCapacityExceptions.date, date)));
  const members = await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true)));
  const active = new Set(members.map((m) => m.userId));
  const dayStart = new Date(`${date}T00:00:00Z`);
  const counts = await ctx.tx.select({ userId: schema.codAssignmentLog.assignedTo, n: sql<number>`count(*)::int` }).from(schema.codAssignmentLog).where(and(eq(schema.codAssignmentLog.tenantId, ctx.tenantId), sql`${schema.codAssignmentLog.assignedAt} >= ${new Date(dayStart.getTime() - 12 * 3600e3)}`, sql`${schema.codAssignmentLog.assignedTo} is not null`)).groupBy(schema.codAssignmentLog.assignedTo);
  const operators = caps
    .filter((c) => active.has(c.userId))
    .map((c) => {
      const ex = exceptions.find((e) => e.userId === c.userId);
      return { userId: c.userId, hoursToday: hoursFor(c.dailyHours as number[], dow, ex ? { kind: ex.kind as "off" | "extra", hours: ex.hours } : null), assignedToday: counts.find((x) => x.userId === c.userId)?.n ?? 0 };
    });
  return { date, operators };
}

/** Auto-assigns one open, unassigned queue item to the operator with the largest fair-share debt. */
export async function assignQueueItem(ctx: ServiceContext, orderId: string, opts: { source: "webhook" | "cron" | "manual" | "backfill"; timezone: string; userId?: string | null }): Promise<string | null> {
  const now = ctx.now ?? new Date();
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) throw new CodError("not_in_queue");
  let target = opts.userId ?? null;
  const reason = opts.userId ? "manual" : "auto";
  if (!target) {
    const { operators } = await availableOperators(ctx, opts.timezone, now);
    target = nextOperator(operators);
    if (!target) {
      await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId, assignedTo: null, source: opts.source, reason: "no_available_operator", actorUserId: ctx.actor.userId, assignedAt: now });
      return null;
    }
  } else if (opts.userId === item.assignedTo) return target;
  if (opts.userId === undefined && item.assignedTo) return item.assignedTo; // idempotent auto-assign
  await ctx.tx.update(schema.codQueueItems).set({ assignedTo: target, assignedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.update(schema.orders).set({ assignedTo: target }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId, assignedTo: target, source: opts.source, reason, actorUserId: ctx.actor.userId, assignedAt: now });
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cod_assigned", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { assignedTo: { from: item.assignedTo, to: target } }, metadata: { source: opts.source, reason }, createdAt: now });
  if (target !== ctx.actor.userId) await notifyUsers(ctx, { userIds: [target], type: "cod_assigned", title: "cod_assigned", link: `/orders/${orderId}`, metadata: { orderId }, antiSpamMinutes: 1 });
  return target;
}

/** Distributes every unassigned open item (oldest first); returns how many got an operator. */
export async function distributeUnassigned(ctx: ServiceContext, opts: { source: "cron" | "backfill" | "manual"; timezone: string; limit?: number }): Promise<{ assigned: number; skipped: number }> {
  const items = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]), sql`${schema.codQueueItems.assignedTo} is null`)).orderBy(schema.codQueueItems.enteredAt).limit(opts.limit ?? 500);
  let assigned = 0;
  for (const i of items) if (await assignQueueItem(ctx, i.orderId, { source: opts.source, timezone: opts.timezone })) assigned++;
  return { assigned, skipped: items.length - assigned };
}

export async function releaseQueueItem(ctx: ServiceContext, orderId: string, opts: { isAdmin: boolean }): Promise<void> {
  const now = ctx.now ?? new Date();
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item) throw new CodError("not_in_queue");
  // once an operator has registered an attempt only an admin can release/transfer (anti-abuse rule)
  if (!opts.isAdmin && (item.assignedTo !== ctx.actor.userId || item.attemptsCount > 0)) throw new CodError("forbidden");
  await ctx.tx.update(schema.codQueueItems).set({ assignedTo: null, assignedAt: null, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.update(schema.orders).set({ assignedTo: null }).where(eq(schema.orders.id, orderId));
  await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId, assignedTo: null, source: "manual", reason: opts.isAdmin ? "admin_unassign" : "released", actorUserId: ctx.actor.userId, assignedAt: now });
}

/* ---------- capacity ---------- */

export async function listCapacity(ctx: ServiceContext) {
  const rows = await ctx.tx.select({ cap: schema.codOperatorCapacity, email: schema.users.email, name: schema.users.name }).from(schema.codOperatorCapacity).innerJoin(schema.users, eq(schema.users.id, schema.codOperatorCapacity.userId)).where(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId)).orderBy(schema.users.email);
  const exceptions = await ctx.tx.select().from(schema.codCapacityExceptions).where(and(eq(schema.codCapacityExceptions.tenantId, ctx.tenantId), sql`${schema.codCapacityExceptions.date} >= ${new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}`)).orderBy(schema.codCapacityExceptions.date);
  return { operators: rows.map((r) => ({ ...r.cap, dailyHours: r.cap.dailyHours as number[], email: r.email, name: r.name })), exceptions };
}

export async function saveCapacity(ctx: ServiceContext, input: { userId: string; dailyHours: number[]; isActive: boolean }): Promise<void> {
  const hours = Array.from({ length: 7 }, (_, i) => Math.max(0, Math.min(24, Math.round(input.dailyHours[i] ?? 0))));
  await ctx.tx.insert(schema.codOperatorCapacity).values({ tenantId: ctx.tenantId, userId: input.userId, dailyHours: hours, isActive: input.isActive ? 1 : 0 }).onConflictDoUpdate({ target: [schema.codOperatorCapacity.tenantId, schema.codOperatorCapacity.userId], set: { dailyHours: hours, isActive: input.isActive ? 1 : 0, updatedAt: new Date() } });
}

export async function saveCapacityException(ctx: ServiceContext, input: { userId: string; date: string; kind: "off" | "extra"; hours?: number | null; note?: string | null }): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CodError("invalid_input");
  await ctx.tx.insert(schema.codCapacityExceptions).values({ tenantId: ctx.tenantId, userId: input.userId, date: input.date, kind: input.kind, hours: input.kind === "extra" ? (input.hours ?? null) : null, note: input.note ?? null }).onConflictDoUpdate({ target: [schema.codCapacityExceptions.tenantId, schema.codCapacityExceptions.userId, schema.codCapacityExceptions.date], set: { kind: input.kind, hours: input.kind === "extra" ? (input.hours ?? null) : null, note: input.note ?? null } });
}

export async function deleteCapacityException(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.tx.delete(schema.codCapacityExceptions).where(and(eq(schema.codCapacityExceptions.tenantId, ctx.tenantId), eq(schema.codCapacityExceptions.id, id)));
}

/* ---------- recipient risk ---------- */

/** Rebuilds every recipient profile from COD orders with a known delivery outcome. Overrides are kept. */
export async function recomputeRecipientProfiles(ctx: ServiceContext, settings?: CodSettings, country = "IT"): Promise<{ profiles: number; flagged: number }> {
  const now = ctx.now ?? new Date();
  const s = settings ?? (await getCodSettings(ctx));
  const rows = await ctx.tx.execute<{ phone: string | null; ship_phone: string | null; email: string | null; country: string | null; outcome: string; at: Date | string }>(sql`
    select o.phone, o.shipping_address->>'phone' as ship_phone, o.email_normalized as email, o.shipping_country as country,
      case when o.status = 'delivered' or sh.status = 'delivered' then 'delivered'
           when o.status in ('returned','refunded') or sh.status in ('returned','failed') then 'returned' end as outcome,
      coalesce(sh.delivered_at, sh.last_event_at, o.placed_at) as at
    from orders o left join lateral (select s.status, s.delivered_at, s.last_event_at from shipments s where s.order_id = o.id order by s.created_at desc limit 1) sh on true
    where o.tenant_id = ${ctx.tenantId} and o.payment_method = 'cod'
      and (o.status in ('delivered','returned','refunded') or sh.status in ('delivered','returned','failed'))`);
  const byKey = new Map<string, RecipientShipment[]>();
  for (const r of rows.rows) {
    const key = recipientKey(normalizePhone(r.phone ?? r.ship_phone ?? null, r.country ?? country), r.email);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push({ outcome: r.outcome as "delivered" | "returned", at: r.at instanceof Date ? r.at : new Date(r.at) });
    byKey.set(key, list);
  }
  const existing = await ctx.tx.select({ key: schema.codRecipientProfiles.recipientKey, override: schema.codRecipientProfiles.override, tier: schema.codRecipientProfiles.tier }).from(schema.codRecipientProfiles).where(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId));
  const overrides = new Map(existing.map((e) => [e.key, e.override as "force_clean" | "force_blacklist" | null]));
  let flagged = 0;
  for (const [key, shipments] of byKey) {
    const p = buildRecipientProfile(shipments, s, now);
    const { tier } = classifyRecipient(p, s, overrides.get(key) ?? null);
    if (tier === "high_risk" || tier === "blacklisted") flagged++;
    const values = { ordersTotal: p.ordersTotal, ordersDelivered: p.ordersDelivered, ordersReturned: p.ordersReturned, weightedReturns: p.weightedReturns, consecutiveDeliveries: p.consecutiveDeliveries, tier, lastReturnAt: p.lastReturnAt, lastDeliveryAt: p.lastDeliveryAt, computedAt: now, updatedAt: now };
    await ctx.tx.insert(schema.codRecipientProfiles).values({ tenantId: ctx.tenantId, recipientKey: key, ...values }).onConflictDoUpdate({ target: [schema.codRecipientProfiles.tenantId, schema.codRecipientProfiles.recipientKey], set: values });
  }
  // profiles that vanished from the history are zeroed but keep their override
  const gone = existing.filter((e) => !byKey.has(e.key));
  for (const g of gone) await ctx.tx.update(schema.codRecipientProfiles).set({ ordersTotal: 0, ordersDelivered: 0, ordersReturned: 0, weightedReturns: 0, consecutiveDeliveries: 0, tier: g.override === "force_blacklist" ? "blacklisted" : "clean", computedAt: now, updatedAt: now }).where(and(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId), eq(schema.codRecipientProfiles.recipientKey, g.key)));
  return { profiles: byKey.size, flagged };
}

export async function setRecipientOverride(ctx: ServiceContext, recipientKeyValue: string, override: "force_clean" | "force_blacklist" | null, reason: string | null, settings?: CodSettings): Promise<void> {
  const s = settings ?? (await getCodSettings(ctx));
  const [p] = await ctx.tx.select().from(schema.codRecipientProfiles).where(and(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId), eq(schema.codRecipientProfiles.recipientKey, recipientKeyValue))).limit(1);
  if (!p) throw new CodError("not_found");
  if (override && (!reason || reason.trim().length < 5)) throw new CodError("invalid_input");
  const { tier } = classifyRecipient({ ordersTotal: p.ordersTotal, ordersDelivered: p.ordersDelivered, ordersReturned: p.ordersReturned, weightedReturns: p.weightedReturns, consecutiveDeliveries: p.consecutiveDeliveries, lastReturnAt: p.lastReturnAt, lastDeliveryAt: p.lastDeliveryAt }, s, override);
  await ctx.tx.update(schema.codRecipientProfiles).set({ override, overrideReason: override ? reason : null, tier, updatedAt: new Date() }).where(eq(schema.codRecipientProfiles.id, p.id));
}

export async function listRiskyRecipients(ctx: ServiceContext, opts: { tiers?: RiskTier[]; limit?: number } = {}) {
  return ctx.tx.select().from(schema.codRecipientProfiles).where(and(eq(schema.codRecipientProfiles.tenantId, ctx.tenantId), inArray(schema.codRecipientProfiles.tier, opts.tiers ?? ["high_risk", "blacklisted"]))).orderBy(desc(schema.codRecipientProfiles.weightedReturns), desc(schema.codRecipientProfiles.lastReturnAt)).limit(opts.limit ?? 100);
}

/* ---------- queue views ---------- */

export interface QueueFilters {
  view?: "all" | "mine" | "unassigned" | "scheduled" | "unreachable";
  userId?: string | null;
  q?: string;
  limit?: number;
}

export async function queueItems(ctx: ServiceContext, f: QueueFilters = {}) {
  const now = ctx.now ?? new Date();
  const conds: SQL[] = [eq(schema.codQueueItems.tenantId, ctx.tenantId)];
  if (f.view === "unreachable") conds.push(eq(schema.codQueueItems.status, "unreachable"));
  else if (f.view === "scheduled") conds.push(eq(schema.codQueueItems.status, "scheduled"));
  else conds.push(inArray(schema.codQueueItems.status, ["pending", "scheduled"]));
  if (f.view === "mine" && f.userId) conds.push(eq(schema.codQueueItems.assignedTo, f.userId));
  if (f.view === "unassigned") conds.push(sql`${schema.codQueueItems.assignedTo} is null`);
  if (f.q) conds.push(sql`(${schema.orders.name} ilike ${"%" + f.q + "%"} or ${schema.orders.customerName} ilike ${"%" + f.q + "%"} or ${schema.orders.phone} ilike ${"%" + f.q + "%"})`);
  const rows = await ctx.tx.select({ item: schema.codQueueItems, order: { id: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, phone: schema.orders.phone, email: schema.orders.email, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, placedAt: schema.orders.placedAt, status: schema.orders.status, shippingCity: schema.orders.shippingCity, shippingCountry: schema.orders.shippingCountry } }).from(schema.codQueueItems).innerJoin(schema.orders, eq(schema.orders.id, schema.codQueueItems.orderId)).where(and(...conds)).limit(f.limit ?? 300);
  const sorted = rows.sort((a, b) => compareQueue({ status: a.item.status as QueueStatus, callBackAt: a.item.callBackAt, attemptsCount: a.item.attemptsCount, enteredAt: a.item.enteredAt }, { status: b.item.status as QueueStatus, callBackAt: b.item.callBackAt, attemptsCount: b.item.attemptsCount, enteredAt: b.item.enteredAt }, now));
  const counts = await ctx.tx.select({ status: schema.codQueueItems.status, assigned: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} is not null)::int`, n: sql<number>`count(*)::int`, mine: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} = ${f.userId ?? "00000000-0000-0000-0000-000000000000"}::uuid)::int` }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]))).groupBy(schema.codQueueItems.status);
  const sum = (fn: (c: (typeof counts)[number]) => number, statuses?: string[]) => counts.filter((c) => !statuses || statuses.includes(c.status)).reduce((s, c) => s + fn(c), 0);
  return { rows: sorted, counts: { all: sum((c) => c.n, ["pending", "scheduled"]), mine: sum((c) => c.mine, ["pending", "scheduled"]), unassigned: sum((c) => c.n - c.assigned, ["pending", "scheduled"]), scheduled: sum((c) => c.n, ["scheduled"]), unreachable: sum((c) => c.n, ["unreachable"]) } };
}

export async function queueItemDetail(ctx: ServiceContext, orderId: string) {
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item) return null;
  const attempts = await ctx.tx.select({ a: schema.codAttempts, operator: schema.users.name, operatorEmail: schema.users.email }).from(schema.codAttempts).leftJoin(schema.users, eq(schema.users.id, schema.codAttempts.operatorId)).where(eq(schema.codAttempts.queueItemId, item.id)).orderBy(desc(schema.codAttempts.createdAt));
  return { item, attempts };
}

/** Operator KPIs for the last N days: attempts, confirmations, cancellations, confirmation rate. */
export async function operatorKpis(ctx: ServiceContext, days = 7) {
  const since = new Date((ctx.now ?? new Date()).getTime() - days * 864e5);
  return ctx.tx.select({ operatorId: schema.codAttempts.operatorId, name: schema.users.name, email: schema.users.email, attempts: sql<number>`count(*)::int`, confirmed: sql<number>`count(*) filter (where ${schema.codAttempts.outcome} = 'confirmed')::int`, cancelled: sql<number>`count(*) filter (where ${schema.codAttempts.outcome} = 'cancelled')::int`, noAnswer: sql<number>`count(*) filter (where ${schema.codAttempts.outcome} = 'no_answer')::int` }).from(schema.codAttempts).leftJoin(schema.users, eq(schema.users.id, schema.codAttempts.operatorId)).where(and(eq(schema.codAttempts.tenantId, ctx.tenantId), sql`${schema.codAttempts.createdAt} >= ${since}`)).groupBy(schema.codAttempts.operatorId, schema.users.name, schema.users.email).orderBy(sql`count(*) desc`);
}

export { recomputeOrderStatus };

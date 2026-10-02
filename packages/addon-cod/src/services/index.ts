import { and, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { normalizePhone } from "@hullwise/core";
import type { AddressProvider, CommercePlatform } from "@hullwise/integrations";
import { applyCancellation, customerOrderHistory, duplicateSiblings, notifyUsers, recomputeOrderStatus, runPlatformWriteNow, setManualStatus, type ServiceContext } from "@hullwise/services";
import { hoursFor, localDay, nextOperator } from "../assignment";
import { ATTEMPT_OUTCOMES, OPEN_QUEUE_STATUSES, TO_CALL_STATUSES, applyOutcome, compareQueue, type AttemptOutcome, type QueueStatus } from "../queue";
import { buildRecipientProfile, classifyRecipient, recipientKey, type RecipientShipment } from "../risk";
import { computeDeliveryScore, type OutcomeRecord, type ScoreResult } from "../scoring";
import { parseCodSettings, type CodSettings, type RiskTier } from "../settings";
import { classifyTags, normTag, operatorAllowed, planTagWrites, type TagWriteEvent } from "../tags";

export class CodError extends Error {
  constructor(
    public readonly code: "not_in_queue" | "invalid_outcome" | "operator_unavailable" | "forbidden" | "not_found" | "invalid_input" | "platform_error",
    public readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface PlatformOpts {
  /** Commerce adapter used for tag writes and cancellations; without it only local state changes. */
  platform?: CommercePlatform;
}

/* ---------- platform tags ---------- */

type TaggableOrder = { id: string; externalId: string | null; platformTags: string[] };

/**
 * Applies the tenant's configured tag changes for an event: platform first (so a refused write
 * changes nothing locally), then the local tag set, a timeline event and a status recompute
 * (a state rule may read the tag just written). No-op when the event has nothing to change.
 */
export async function applyTagEvent(ctx: ServiceContext, platform: CommercePlatform | undefined, order: TaggableOrder, event: TagWriteEvent, settings: CodSettings): Promise<{ added: string[]; removed: string[] } | null> {
  const plan = planTagWrites(settings.tags, event, order.platformTags);
  if (!plan.add.length && !plan.remove.length) return null;
  if (platform && order.externalId) {
    try {
      // synchronous on purpose (recorded in the outbox): the tag drives the warehouse, a refused write must change nothing here
      await runPlatformWriteNow(ctx, platform, { kind: "order.tags", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId, add: plan.add, remove: plan.remove } });
    } catch (e) {
      throw new CodError("platform_error", e instanceof Error ? e.message : String(e));
    }
  }
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.orders).set({ platformTags: plan.next }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, order.id)));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "tags_updated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { platformTags: { from: order.platformTags, to: plan.next } }, metadata: { added: plan.add, removed: plan.remove, source: "cod", event }, createdAt: now });
  await recomputeOrderStatus(ctx, order.id);
  order.platformTags = plan.next;
  return { added: plan.add, removed: plan.remove };
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

/** Candidate orders for the queue: COD, not cancelled, not shipped, inside the cutoff, not in a terminal state. */
function queueCandidateWhere(ctx: ServiceContext, settings: CodSettings, now: Date): SQL {
  return and(
    eq(schema.orders.tenantId, ctx.tenantId),
    eq(schema.orders.paymentMethod, "cod"),
    sql`${schema.orders.cancelledAt} is null`,
    sql`${schema.orders.status} not in ('cancelled','refunded','returned','returned_partial','delivered','shipped','fulfilling')`,
    sql`${schema.orders.placedAt} >= ${new Date(now.getTime() - settings.queueCutoffDays * 864e5)}`,
    sql`not exists (select 1 from shipments s where s.order_id = ${schema.orders.id})`,
  )!;
}

const hasTagConfig = (s: CodSettings) => s.tags.queue.length + s.tags.confirmed.length + s.tags.cancelled.length > 0;

/**
 * Keeps `cod_queue_items` aligned with the orders. An order belongs in the queue when it carries
 * one of the tenant's queue tags, or, without any configured tag, when its canonical status is
 * `new` / `pending_review`. A confirmed tag closes the item and confirms the order; a cancelled tag
 * closes it as cancelled (precedence cancelled > confirmed > queue, as in the reference platform).
 * Idempotent, cheap, run on page load and by the job. Tag writes on entry are best effort.
 */
export async function syncQueue(ctx: ServiceContext, settings?: CodSettings, opts: PlatformOpts = {}): Promise<{ entered: number; closed: number }> {
  const now = ctx.now ?? new Date();
  const s = settings ?? (await getCodSettings(ctx));
  const tagged = hasTagConfig(s);
  const candidates = await ctx.tx.select({ id: schema.orders.id, status: schema.orders.status, platformTags: schema.orders.platformTags, externalId: schema.orders.externalId }).from(schema.orders).where(queueCandidateWhere(ctx, s, now));
  const eligible = new Map<string, { entryTag: string | null; order: (typeof candidates)[number] }>();
  const closeByTag = new Map<string, { kind: "confirmed" | "cancelled"; tag: string; order: (typeof candidates)[number] }>();
  for (const o of candidates) {
    const cls = tagged ? classifyTags(s.tags, o.platformTags) : null;
    if (cls?.kind === "queue") eligible.set(o.id, { entryTag: cls.tag, order: o });
    else if (cls?.kind === "confirmed" || cls?.kind === "cancelled") closeByTag.set(o.id, { kind: cls.kind, tag: cls.tag, order: o });
    else if (!cls && (o.status === "new" || o.status === "pending_review")) eligible.set(o.id, { entryTag: null, order: o });
  }
  const open = await ctx.tx.select({ id: schema.codQueueItems.id, orderId: schema.codQueueItems.orderId, status: schema.codQueueItems.status, entryTag: schema.codQueueItems.entryTag, assignedTo: schema.codQueueItems.assignedTo }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const openByOrder = new Map(open.map((o) => [o.orderId, o]));
  let entered = 0;
  const toEnter = [...eligible.keys()].filter((id) => !openByOrder.has(id));
  if (toEnter.length) {
    const existing = await ctx.tx.select({ id: schema.codQueueItems.id, orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(inArray(schema.codQueueItems.orderId, toEnter));
    const existingByOrder = new Map(existing.map((e) => [e.orderId, e.id]));
    for (const orderId of toEnter) {
      const { entryTag, order } = eligible.get(orderId)!;
      const prev = existingByOrder.get(orderId);
      if (prev) await ctx.tx.update(schema.codQueueItems).set({ status: "pending", closedAt: null, enteredAt: now, entryTag, callBackAt: null, scheduledConfirmOn: null, scheduledConfirmTriedOn: null, scheduledConfirmError: null, escalatedAt: null, escalatedBy: null, escalationReason: null, updatedAt: now }).where(eq(schema.codQueueItems.id, prev));
      // two page loads may sync at once: the second insert of the same order is a no-op
      else await ctx.tx.insert(schema.codQueueItems).values({ tenantId: ctx.tenantId, orderId, status: "pending", entryTag, enteredAt: now }).onConflictDoNothing();
      entered++;
      // a queue tag on an already confirmed order means "back to confirmation" (the reference "Da chiamare")
      if (entryTag && order.status === "confirmed") await setManualStatus(ctx, orderId, "pending_review", `cod_tag:${entryTag}`);
      try {
        await applyTagEvent(ctx, opts.platform, { id: order.id, externalId: order.externalId, platformTags: [...order.platformTags] }, "entered", s);
      } catch (e) {
        if (!(e instanceof CodError && e.code === "platform_error")) throw e;
      }
    }
  }
  // entry tag changed on an open item: refresh it and drop an operator who may not handle it
  for (const o of open) {
    const el = eligible.get(o.orderId);
    if (!el || (el.entryTag ?? null) === (o.entryTag ?? null)) continue;
    await ctx.tx.update(schema.codQueueItems).set({ entryTag: el.entryTag, updatedAt: now }).where(eq(schema.codQueueItems.id, o.id));
    if (o.assignedTo && el.entryTag) {
      const [cap] = await ctx.tx.select({ allowedTags: schema.codOperatorCapacity.allowedTags }).from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.userId, o.assignedTo))).limit(1);
      if (cap && !operatorAllowed(cap.allowedTags as string[], el.entryTag)) {
        await ctx.tx.update(schema.codQueueItems).set({ assignedTo: null, assignedAt: null, updatedAt: now }).where(eq(schema.codQueueItems.id, o.id));
        await ctx.tx.update(schema.orders).set({ assignedTo: null }).where(eq(schema.orders.id, o.orderId));
        await ctx.tx.insert(schema.codAssignmentLog).values({ tenantId: ctx.tenantId, orderId: o.orderId, assignedTo: null, source: "cron", reason: "reassign_tag_change", actorUserId: ctx.actor.userId, assignedAt: now });
      }
    }
  }
  let closed = 0;
  // confirmed / cancelled tags: close the item (if any) and align the order
  for (const [orderId, c] of closeByTag) {
    const item = openByOrder.get(orderId);
    if (item) {
      await ctx.tx.update(schema.codQueueItems).set({ status: c.kind, closedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
      await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "cod_attempt", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { queueStatus: { from: item.status, to: c.kind } }, metadata: { outcome: c.kind, source: "tag", tag: c.tag }, createdAt: now });
      closed++;
    }
    if (c.kind === "confirmed" && (c.order.status === "new" || c.order.status === "pending_review")) await setManualStatus(ctx, orderId, "confirmed", `cod_tag:${c.tag}`);
  }
  const stale = open.filter((o) => !eligible.has(o.orderId) && !closeByTag.has(o.orderId));
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
export async function scoreQueueItem(ctx: ServiceContext, orderId: string, opts: { settings?: CodSettings; timezone?: string; addressProvider?: AddressProvider; preview?: boolean } = {}): Promise<ScoreResult> {
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
  // address provider (C.18): checked once per address, the verdict is kept in the breakdown and reused while the address is unchanged
  const addressKeyValue = addr ? [addr.address1, addr.zip ?? order.shippingZip, addr.city ?? order.shippingCity, addr.country ?? order.shippingCountry].map((x) => (x ?? "").trim().toLowerCase()).join("|") : null;
  const cached = (item?.scoreBreakdown as { addressCheck?: { key: string; valid: boolean; issues: string[] } } | undefined)?.addressCheck;
  let addressCheck: { key: string; valid: boolean; issues: string[] } | null = cached && cached.key === addressKeyValue ? cached : null;
  if (!addressCheck && addr && addressKeyValue && opts.addressProvider) {
    try {
      const v = await opts.addressProvider.validate({ name: order.customerName, address1: addr.address1 ?? null, address2: null, city: addr.city ?? order.shippingCity, province: addr.province ?? null, zip: addr.zip ?? order.shippingZip, country: addr.country ?? order.shippingCountry });
      addressCheck = { key: addressKeyValue, valid: v.valid, issues: v.issues.map((x) => `${x.field}_${x.code}`) };
    } catch {
      addressCheck = null; // a provider outage never blocks scoring: the format checks still apply
    }
  }
  const result = computeDeliveryScore(
    {
      customerOrders,
      prepaidDelivered,
      attempts: item?.attemptsCount ?? 0,
      hoursSinceOrder: (now.getTime() - order.placedAt.getTime()) / 3600e3,
      closed: !["new", "pending_review"].includes(order.status),
      lines,
      address: addr ? { phone: order.phone ?? addr.phone ?? null, address1: addr.address1 ?? null, zip: addr.zip ?? order.shippingZip, city: addr.city ?? order.shippingCity, province: addr.province ?? null, country: addr.country ?? order.shippingCountry } : null,
      addressCheck,
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
  if (item && !opts.preview) await ctx.tx.update(schema.codQueueItems).set({ score: result.score, scoreBreakdown: { base: result.base, factors: result.factors, computedAt: now.toISOString(), attempts: item.attemptsCount, ...(addressCheck ? { addressCheck } : {}) }, riskTier: result.riskTier, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  return result;
}

/** Scores open items missing a score (or all, when `force`), oldest first, bounded. */
export async function scorePendingItems(ctx: ServiceContext, opts: { limit?: number; force?: boolean; timezone?: string; addressProvider?: AddressProvider } = {}): Promise<number> {
  const settings = await getCodSettings(ctx);
  const conds = [eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])];
  if (!opts.force) conds.push(sql`${schema.codQueueItems.score} is null`);
  const items = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(...conds)).orderBy(schema.codQueueItems.enteredAt).limit(opts.limit ?? 100);
  for (const i of items) await scoreQueueItem(ctx, i.orderId, { settings, timezone: opts.timezone, addressProvider: opts.addressProvider });
  return items.length;
}

/* ---------- attempts and outcomes ---------- */

export interface AttemptInput {
  orderId: string;
  outcome: AttemptOutcome;
  note?: string | null;
  callBackAt?: Date | null;
  /** `confirm_scheduled`: the tenant-local day (YYYY-MM-DD) the order is to be confirmed. */
  confirmOn?: string | null;
  channel?: string;
}

/**
 * Records a contact attempt and applies the outcome machine. `confirmed` sets the canonical
 * manual status, `cancelled` only closes the queue item (the order cancellation is the core action).
 */
export async function recordAttempt(ctx: ServiceContext, input: AttemptInput, settings?: CodSettings, opts: PlatformOpts = {}): Promise<{ status: QueueStatus; attemptNumber: number; tags: { added: string[]; removed: string[] } | null }> {
  const now = ctx.now ?? new Date();
  const s = settings ?? (await getCodSettings(ctx));
  if (!ATTEMPT_OUTCOMES.includes(input.outcome)) throw new CodError("invalid_outcome");
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, input.orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) throw new CodError("not_in_queue");
  if (input.outcome === "call_back" && !input.callBackAt) throw new CodError("invalid_input");
  if (input.outcome === "confirm_scheduled" && !/^\d{4}-\d{2}-\d{2}$/.test(input.confirmOn ?? "")) throw new CodError("invalid_input");
  const next = applyOutcome({ status: item.status as QueueStatus, noAnswerCount: item.noAnswerCount }, input.outcome, s, input.callBackAt ?? null);
  const attemptNumber = item.attemptsCount + 1;
  const [order] = await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId, platformTags: schema.orders.platformTags, cancelledAt: schema.orders.cancelledAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, input.orderId))).limit(1);
  if (!order) throw new CodError("not_found");
  // platform first: a refused cancellation or tag write records nothing locally
  if (input.outcome === "cancelled" && opts.platform && order.externalId && !order.cancelledAt) {
    try {
      await runPlatformWriteNow(ctx, opts.platform, { kind: "order.cancel", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId, reason: "customer", restock: s.cancelRestock, refund: false } });
    } catch (e) {
      throw new CodError("platform_error", e instanceof Error ? e.message : String(e));
    }
  }
  const tagEvent: TagWriteEvent = next.status === "unreachable" ? "unreachable" : input.outcome;
  const tags = await applyTagEvent(ctx, opts.platform, { id: order.id, externalId: order.externalId, platformTags: [...order.platformTags] }, tagEvent, s);
  await ctx.tx.insert(schema.codAttempts).values({ tenantId: ctx.tenantId, queueItemId: item.id, orderId: input.orderId, operatorId: ctx.actor.userId, attemptNumber, outcome: input.outcome, channel: input.channel ?? "phone", note: input.note ?? null, callBackAt: input.callBackAt ?? null });
  const closing = next.status === "confirmed" || next.status === "cancelled";
  const confirmOn = input.outcome === "confirm_scheduled" ? input.confirmOn! : null;
  await ctx.tx.update(schema.codQueueItems).set({ status: next.status, noAnswerCount: next.noAnswerCount, callBackAt: next.callBackAt, attemptsCount: attemptNumber, lastAttemptAt: now, closedAt: closing ? now : null, assignedTo: item.assignedTo ?? ctx.actor.userId, assignedAt: item.assignedAt ?? (ctx.actor.userId ? now : null), scheduledConfirmOn: confirmOn, scheduledConfirmTriedOn: null, scheduledConfirmError: null, ...(closing ? { escalatedAt: null, escalatedBy: null, escalationReason: null } : {}), updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "cod_attempt", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { queueStatus: { from: item.status, to: next.status } }, metadata: { attemptNumber, outcome: input.outcome, callBackAt: input.callBackAt?.toISOString() ?? null, ...(confirmOn ? { confirmOn } : {}), ...(input.channel && input.channel !== "phone" ? { channel: input.channel } : {}), note: input.note ?? null }, createdAt: now });
  if (input.outcome === "confirmed") await setManualStatus(ctx, input.orderId, "confirmed", "cod_confirmed");
  else if (input.outcome === "cancelled") await applyCancellation(ctx, input.orderId, { reason: "cod_refused", restock: s.cancelRestock, refund: false, source: "cod" });
  else if (input.outcome === "no_answer" && next.status === "unreachable") await setManualStatus(ctx, input.orderId, "on_hold", "cod_unreachable");
  else if (!item.assignedTo && ctx.actor.userId) await ctx.tx.update(schema.orders).set({ assignedTo: ctx.actor.userId }).where(eq(schema.orders.id, input.orderId));
  // re-score with the new attempt count (not for closed items)
  if (!closing) await scoreQueueItem(ctx, input.orderId, { settings: s }).catch(() => undefined);
  return { status: next.status, attemptNumber, tags };
}

/* ---------- assignment ---------- */

async function availableOperators(ctx: ServiceContext, timezone: string, now: Date) {
  const { dow, date } = localDay(now, timezone);
  const caps = await ctx.tx.select().from(schema.codOperatorCapacity).where(and(eq(schema.codOperatorCapacity.tenantId, ctx.tenantId), eq(schema.codOperatorCapacity.isActive, 1)));
  if (!caps.length) return { date, operators: [] as { userId: string; hoursToday: number; assignedToday: number; allowedTags: string[] }[] };
  const exceptions = await ctx.tx.select().from(schema.codCapacityExceptions).where(and(eq(schema.codCapacityExceptions.tenantId, ctx.tenantId), eq(schema.codCapacityExceptions.date, date)));
  const members = await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true)));
  const active = new Set(members.map((m) => m.userId));
  const dayStart = new Date(`${date}T00:00:00Z`);
  const counts = await ctx.tx.select({ userId: schema.codAssignmentLog.assignedTo, n: sql<number>`count(*)::int` }).from(schema.codAssignmentLog).where(and(eq(schema.codAssignmentLog.tenantId, ctx.tenantId), sql`${schema.codAssignmentLog.assignedAt} >= ${new Date(dayStart.getTime() - 12 * 3600e3)}`, sql`${schema.codAssignmentLog.assignedTo} is not null`)).groupBy(schema.codAssignmentLog.assignedTo);
  const operators = caps
    .filter((c) => active.has(c.userId))
    .map((c) => {
      const ex = exceptions.find((e) => e.userId === c.userId);
      return { userId: c.userId, hoursToday: hoursFor(c.dailyHours as number[], dow, ex ? { kind: ex.kind as "off" | "extra", hours: ex.hours } : null), assignedToday: counts.find((x) => x.userId === c.userId)?.n ?? 0, allowedTags: (c.allowedTags as string[]) ?? [] };
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
    // skill routing: an operator with allowed tags only receives items that entered with one of them
    target = nextOperator(operators.filter((o) => operatorAllowed(o.allowedTags, item.entryTag)));
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
  return { operators: rows.map((r) => ({ ...r.cap, dailyHours: r.cap.dailyHours as number[], allowedTags: (r.cap.allowedTags as string[]) ?? [], email: r.email, name: r.name })), exceptions };
}

export async function saveCapacity(ctx: ServiceContext, input: { userId: string; dailyHours: number[]; isActive: boolean; allowedTags?: string[] }): Promise<void> {
  const hours = Array.from({ length: 7 }, (_, i) => Math.max(0, Math.min(24, Math.round(input.dailyHours[i] ?? 0))));
  const allowedTags = (input.allowedTags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 30);
  const set = { dailyHours: hours, isActive: input.isActive ? 1 : 0, ...(input.allowedTags !== undefined ? { allowedTags } : {}), updatedAt: new Date() };
  await ctx.tx.insert(schema.codOperatorCapacity).values({ tenantId: ctx.tenantId, userId: input.userId, dailyHours: hours, isActive: input.isActive ? 1 : 0, allowedTags }).onConflictDoUpdate({ target: [schema.codOperatorCapacity.tenantId, schema.codOperatorCapacity.userId], set });
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
  // carrier outcomes imported from billing files (C.19) win over what the order says
  const rows = await ctx.tx.execute<{ phone: string | null; ship_phone: string | null; email: string | null; country: string | null; outcome: string; at: Date | string }>(sql`
    select o.phone, o.shipping_address->>'phone' as ship_phone, o.email_normalized as email, o.shipping_country as country,
      case when co.outcome = 'delivered' then 'delivered' when co.outcome = 'refused' then 'returned'
           when o.status = 'delivered' or sh.status = 'delivered' then 'delivered'
           when o.status in ('returned','refunded') or sh.status in ('returned','failed') then 'returned' end as outcome,
      coalesce(co.occurred_at, sh.delivered_at, sh.last_event_at, o.placed_at) as at
    from orders o left join lateral (select s.status, s.delivered_at, s.last_event_at from shipments s where s.order_id = o.id order by s.created_at desc limit 1) sh on true
      left join lateral (select c.outcome, c.occurred_at from cod_carrier_outcomes c where c.order_id = o.id order by c.created_at desc limit 1) co on true
    where o.tenant_id = ${ctx.tenantId} and o.payment_method = 'cod'
      and (co.outcome is not null or o.status in ('delivered','returned','refunded') or sh.status in ('delivered','returned','failed'))`);
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

export const QUEUE_VIEWS = ["all", "mine", "unassigned", "scheduled", "planned", "unreachable", "escalated"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export interface QueueFilters {
  view?: QueueView;
  userId?: string | null;
  q?: string;
  /** Only items that entered with this queue tag. */
  tag?: string;
  limit?: number;
}

export async function queueItems(ctx: ServiceContext, f: QueueFilters = {}) {
  const now = ctx.now ?? new Date();
  const conds: SQL[] = [eq(schema.codQueueItems.tenantId, ctx.tenantId)];
  if (f.view === "unreachable") conds.push(eq(schema.codQueueItems.status, "unreachable"));
  else if (f.view === "scheduled") conds.push(eq(schema.codQueueItems.status, "scheduled"));
  else if (f.view === "planned") conds.push(eq(schema.codQueueItems.status, "confirm_scheduled"));
  else if (f.view === "escalated") conds.push(inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]), sql`${schema.codQueueItems.escalatedAt} is not null`);
  else conds.push(inArray(schema.codQueueItems.status, [...TO_CALL_STATUSES]));
  if (f.view === "mine" && f.userId) conds.push(eq(schema.codQueueItems.assignedTo, f.userId));
  if (f.view === "unassigned") conds.push(sql`${schema.codQueueItems.assignedTo} is null`);
  if (f.tag) conds.push(eq(schema.codQueueItems.entryTag, normTag(f.tag)));
  if (f.q) conds.push(sql`(${schema.orders.name} ilike ${"%" + f.q + "%"} or ${schema.orders.customerName} ilike ${"%" + f.q + "%"} or ${schema.orders.phone} ilike ${"%" + f.q + "%"})`);
  const rows = await ctx.tx.select({ item: schema.codQueueItems, order: { id: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, phone: schema.orders.phone, email: schema.orders.email, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, placedAt: schema.orders.placedAt, status: schema.orders.status, shippingCity: schema.orders.shippingCity, shippingCountry: schema.orders.shippingCountry } }).from(schema.codQueueItems).innerJoin(schema.orders, eq(schema.orders.id, schema.codQueueItems.orderId)).where(and(...conds)).orderBy(schema.codQueueItems.enteredAt).limit(f.limit ?? 300);
  const sorted = rows.sort((a, b) => compareQueue({ status: a.item.status as QueueStatus, callBackAt: a.item.callBackAt, attemptsCount: a.item.attemptsCount, enteredAt: a.item.enteredAt }, { status: b.item.status as QueueStatus, callBackAt: b.item.callBackAt, attemptsCount: b.item.attemptsCount, enteredAt: b.item.enteredAt }, now));
  return { rows: sorted, counts: await queueCounts(ctx, f.userId ?? null) };
}

/** Open items per view (the view tabs and the sidebar badge). */
export async function queueCounts(ctx: ServiceContext, userId: string | null): Promise<Record<QueueView, number>> {
  const counts = await ctx.tx.select({ status: schema.codQueueItems.status, assigned: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} is not null)::int`, n: sql<number>`count(*)::int`, mine: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} = ${userId ?? "00000000-0000-0000-0000-000000000000"}::uuid)::int`, escalated: sql<number>`count(*) filter (where ${schema.codQueueItems.escalatedAt} is not null)::int` }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]))).groupBy(schema.codQueueItems.status);
  const sum = (fn: (c: (typeof counts)[number]) => number, statuses?: readonly string[]) => counts.filter((c) => !statuses || statuses.includes(c.status)).reduce((s, c) => s + fn(c), 0);
  return { all: sum((c) => c.n, TO_CALL_STATUSES), mine: sum((c) => c.mine, TO_CALL_STATUSES), unassigned: sum((c) => c.n - c.assigned, TO_CALL_STATUSES), scheduled: sum((c) => c.n, ["scheduled"]), planned: sum((c) => c.n, ["confirm_scheduled"]), unreachable: sum((c) => c.n, ["unreachable"]), escalated: sum((c) => c.escalated) };
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

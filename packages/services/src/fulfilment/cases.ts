import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, recordAudit, schema, sql, type SQL } from "@keel/db";
import { RETURN_TO_SENDER_STATUSES, EXCEPTION_LIKE, planShipmentCases, suggestRtsFollowUps, validateResolution, type CaseKind, type ExceptionResolution, type InstructionChannel, type ResolutionIssue, type RtsFollowUp, type ShipmentStatus } from "@keel/core";
import type { Address, CarrierProvider } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { queueEmail } from "../email/mailer";
import { TRANSACTIONAL_EMAIL } from "../email/suppressions";

/**
 * Delivery-exception work queue and return-to-sender review (issue #28). Cases open by themselves
 * from the resolved shipment status (on import and in the hourly sweep), one person claims a case,
 * the delivery instruction goes out once (carrier connector or email), and an exception case closes
 * by itself when the shipment moves on. Returns to sender stay open until a person closes the review.
 */

export type CaseRow = typeof schema.shipmentCases.$inferSelect;
/** New exceptions older than this are not queued (the history of the seed or of a first sync). */
export const DELIVERY_CASE_WINDOW_DAYS = 30;

export type CaseErrorCode = "not_found" | "closed" | "claimed_by_other" | "not_claimed" | "already_sent" | "invalid_input" | "no_channel" | "send_failed" | "wrong_kind";
export class CaseError extends Error {
  constructor(public readonly code: CaseErrorCode, message?: string, public readonly issues?: ResolutionIssue[]) {
    super(message ?? code);
    this.name = "CaseError";
  }
}

const sysActor = (ctx: ServiceContext) => ({ actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? ("user" as const) : ("system" as const) });

/* ---------- opening and closing ---------- */

/**
 * Opens and closes cases for the given shipments, or for every candidate (exception or back-to-sender
 * shipments that changed within the window, plus every open case) when no ids are given.
 */
export async function syncShipmentCases(ctx: ServiceContext, opts: { shipmentIds?: string[]; windowDays?: number } = {}): Promise<{ opened: number; closed: number }> {
  const now = ctx.now ?? new Date();
  const since = new Date(now.getTime() - (opts.windowDays ?? DELIVERY_CASE_WINDOW_DAYS) * 864e5);
  const cols = { id: schema.shipments.id, orderId: schema.shipments.orderId, status: schema.shipments.status, exceptionReason: schema.shipments.exceptionReason, exceptionSince: schema.shipments.exceptionSince, lastEventAt: schema.shipments.lastEventAt, shippedAt: schema.shipments.shippedAt };
  let shipments: { id: string; orderId: string; status: string; exceptionReason: string | null; exceptionSince: Date | null; lastEventAt: Date | null; shippedAt: Date | null }[];
  let openCases: Pick<CaseRow, "id" | "shipmentId" | "kind">[];
  if (opts.shipmentIds) {
    if (!opts.shipmentIds.length) return { opened: 0, closed: 0 };
    shipments = await ctx.tx.select(cols).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), inArray(schema.shipments.id, opts.shipmentIds)));
    openCases = await ctx.tx.select({ id: schema.shipmentCases.id, shipmentId: schema.shipmentCases.shipmentId, kind: schema.shipmentCases.kind }).from(schema.shipmentCases).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), inArray(schema.shipmentCases.shipmentId, opts.shipmentIds), isNull(schema.shipmentCases.closedAt)));
  } else {
    openCases = await ctx.tx.select({ id: schema.shipmentCases.id, shipmentId: schema.shipmentCases.shipmentId, kind: schema.shipmentCases.kind }).from(schema.shipmentCases).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), isNull(schema.shipmentCases.closedAt)));
    const candidates = await ctx.tx.select(cols).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), inArray(schema.shipments.status, [...EXCEPTION_LIKE, ...RETURN_TO_SENDER_STATUSES]), gte(sql`coalesce(${schema.shipments.exceptionSince}, ${schema.shipments.lastEventAt}, ${schema.shipments.shippedAt})`, since)));
    const missing = [...new Set(openCases.map((c) => c.shipmentId))].filter((id) => !candidates.some((s) => s.id === id));
    shipments = missing.length ? [...candidates, ...(await ctx.tx.select(cols).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), inArray(schema.shipments.id, missing))))] : candidates;
  }
  const ids = shipments.map((s) => s.id);
  const closedCases = ids.length ? await ctx.tx.select({ shipmentId: schema.shipmentCases.shipmentId, kind: schema.shipmentCases.kind, closedAt: schema.shipmentCases.closedAt }).from(schema.shipmentCases).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), inArray(schema.shipmentCases.shipmentId, ids), isNotNull(schema.shipmentCases.closedAt))) : [];
  const plan = planShipmentCases(
    shipments.map((s) => ({ id: s.id, status: s.status as ShipmentStatus, changedAt: s.exceptionSince ?? s.lastEventAt ?? s.shippedAt })),
    openCases.map((c) => ({ id: c.id, shipmentId: c.shipmentId, kind: c.kind as CaseKind })),
    closedCases.map((c) => ({ shipmentId: c.shipmentId, kind: c.kind as CaseKind, closedAt: c.closedAt! })),
  );
  let opened = 0;
  for (const o of plan.open) {
    const s = shipments.find((x) => x.id === o.shipmentId)!;
    const changedAt = s.exceptionSince ?? s.lastEventAt ?? s.shippedAt ?? now;
    if (changedAt < since) continue;
    const [row] = await ctx.tx.insert(schema.shipmentCases).values({ tenantId: ctx.tenantId, kind: o.kind, shipmentId: s.id, orderId: s.orderId, status: "open", shipmentStatus: s.status, reason: s.exceptionReason, openedAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ id: schema.shipmentCases.id });
    if (row) {
      opened++;
      await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.opened", entityType: "shipment_case", entityId: row.id, diff: { status: { from: null, to: "open" } }, metadata: { kind: o.kind, shipmentId: s.id, shipmentStatus: s.status } });
    }
  }
  for (const c of plan.close) {
    const s = shipments.find((x) => x.id === openCases.find((oc) => oc.id === c.caseId)?.shipmentId);
    const [row] = await ctx.tx.update(schema.shipmentCases).set({ status: "closed", closedAt: now, closeReason: c.reason, updatedAt: now }).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.id, c.caseId), isNull(schema.shipmentCases.closedAt))).returning({ id: schema.shipmentCases.id, status: schema.shipmentCases.status });
    if (row) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.closed", entityType: "shipment_case", entityId: c.caseId, diff: { status: { from: "open", to: "closed" } }, metadata: { reason: c.reason, shipmentStatus: s?.status ?? null } });
  }
  return { opened, closed: plan.close.length };
}

/* ---------- claiming ---------- */

async function loadCase(ctx: ServiceContext, caseId: string): Promise<CaseRow> {
  const [row] = await ctx.tx.select().from(schema.shipmentCases).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.id, caseId))).limit(1);
  if (!row) throw new CaseError("not_found");
  return row;
}

/**
 * Claims an open case for the acting user. Exclusive: the conditional update only matches an
 * unclaimed row, so of two people claiming at once exactly one wins (the other waits on the row
 * lock, then finds it claimed). Claiming one's own case again is a no-op.
 */
export async function claimCase(ctx: ServiceContext, caseId: string): Promise<CaseRow> {
  const me = ctx.actor.userId;
  if (!me) throw new CaseError("not_claimed");
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx.update(schema.shipmentCases).set({ claimedBy: me, claimedAt: now, status: sql`case when ${schema.shipmentCases.status} = 'open' then 'claimed' else ${schema.shipmentCases.status} end`, updatedAt: now }).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.id, caseId), isNull(schema.shipmentCases.claimedBy), isNull(schema.shipmentCases.closedAt))).returning();
  if (row) {
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.claimed", entityType: "shipment_case", entityId: caseId, diff: { claimedBy: { from: null, to: me } } });
    return row;
  }
  const cur = await loadCase(ctx, caseId);
  if (cur.closedAt) throw new CaseError("closed");
  if (cur.claimedBy === me) return cur;
  throw new CaseError("claimed_by_other");
}

/** Gives a case back to the queue (the claimer, or a manager with `force`). */
export async function releaseCase(ctx: ServiceContext, caseId: string, opts: { force?: boolean } = {}): Promise<CaseRow> {
  const cur = await loadCase(ctx, caseId);
  if (cur.closedAt) throw new CaseError("closed");
  if (!cur.claimedBy) return cur;
  if (cur.claimedBy !== ctx.actor.userId && !opts.force) throw new CaseError("claimed_by_other");
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx.update(schema.shipmentCases).set({ claimedBy: null, claimedAt: null, status: cur.status === "claimed" ? "open" : cur.status, updatedAt: now }).where(eq(schema.shipmentCases.id, caseId)).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.released", entityType: "shipment_case", entityId: caseId, diff: { claimedBy: { from: cur.claimedBy, to: null } }, metadata: { forced: Boolean(opts.force && cur.claimedBy !== ctx.actor.userId) } });
  return row!;
}

/** Acting on a case needs it open and claimed by the actor; an unclaimed case is claimed on the way. */
async function ensureMine(ctx: ServiceContext, caseId: string): Promise<CaseRow> {
  const cur = await loadCase(ctx, caseId);
  if (cur.closedAt) throw new CaseError("closed");
  if (cur.claimedBy && cur.claimedBy !== ctx.actor.userId) throw new CaseError("claimed_by_other");
  return cur.claimedBy ? cur : claimCase(ctx, caseId);
}

/* ---------- delivery instruction ---------- */

export interface InstructionInput {
  resolution: ExceptionResolution;
  address?: Address | null;
  pickupPoint?: string | null;
  note?: string | null;
  channel: InstructionChannel;
  /** Email channel: the carrier's customer-service address (defaults to the tenant setting). */
  emailTo?: string | null;
}
export interface InstructionDeps {
  carrier: CarrierProvider | null;
  companyName: string;
  locale: string | null | undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends the delivery instruction of an exception case, once. The guard is a conditional update
 * (`instruction_sent_at is null`, claimed by the actor) taken before the call: a second send — a
 * double click, another tab, a retry — finds the row already marked and is refused. If the carrier
 * or the mail provider fails, the transaction rolls back and the case can be sent again.
 */
export async function sendCaseInstruction(ctx: ServiceContext, caseId: string, input: InstructionInput, deps: InstructionDeps): Promise<CaseRow> {
  const me = ctx.actor.userId;
  if (!me) throw new CaseError("not_claimed");
  const issues = validateResolution({ resolution: input.resolution, address: input.address, pickupPoint: input.pickupPoint, note: input.note });
  if (issues.length) throw new CaseError("invalid_input", undefined, issues);
  const emailTo = input.emailTo?.trim().toLowerCase() || null;
  if (input.channel === "carrier" && !deps.carrier) throw new CaseError("no_channel");
  if (input.channel === "email" && (!emailTo || !EMAIL_RE.test(emailTo))) throw new CaseError("invalid_input", undefined, []);
  const now = ctx.now ?? new Date();
  const detail = { address: input.resolution === "new_address" ? (input.address ?? null) : null, pickupPoint: input.resolution === "pickup_point" ? (input.pickupPoint?.trim() ?? null) : null, note: input.note?.trim() || null };
  const [row] = await ctx.tx
    .update(schema.shipmentCases)
    .set({ status: "instructed", resolution: input.resolution, resolutionDetail: detail, instructionChannel: input.channel, instructionTo: input.channel === "email" ? emailTo : (deps.carrier?.provider ?? null), instructionSentAt: now, instructionSentBy: me, updatedAt: now })
    .where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.id, caseId), eq(schema.shipmentCases.kind, "exception"), isNull(schema.shipmentCases.closedAt), eq(schema.shipmentCases.claimedBy, me), isNull(schema.shipmentCases.instructionSentAt)))
    .returning();
  if (!row) {
    const cur = await loadCase(ctx, caseId);
    if (cur.kind !== "exception") throw new CaseError("wrong_kind");
    if (cur.instructionSentAt) throw new CaseError("already_sent");
    if (cur.closedAt) throw new CaseError("closed");
    if (cur.claimedBy !== me) throw new CaseError(cur.claimedBy ? "claimed_by_other" : "not_claimed");
    throw new CaseError("not_found");
  }
  const [ship] = await ctx.tx.select({ trackingNumber: schema.shipments.trackingNumber, carrier: schema.shipments.carrier, orderName: schema.orders.name }).from(schema.shipments).innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId)).where(eq(schema.shipments.id, row.shipmentId)).limit(1);
  let reference: string | null = null;
  if (input.channel === "carrier") {
    try {
      reference = (await deps.carrier!.sendInstruction({ reference: `case:${row.id}`, trackingNumber: ship?.trackingNumber ?? "", carrier: ship?.carrier ?? null, resolution: input.resolution, address: detail.address, pickupPoint: detail.pickupPoint, note: detail.note })).reference;
    } catch (e) {
      throw new CaseError("send_failed", e instanceof Error ? e.message : String(e));
    }
  } else {
    // queued with the case as the event: the email job retries delivery, and the same case never queues it twice
    const r = await queueEmail(ctx, { to: emailTo!, template: "carrier_instruction", data: { companyName: deps.companyName, carrier: ship?.carrier ?? null, trackingNumber: ship?.trackingNumber ?? "", orderName: ship?.orderName ?? "", resolution: input.resolution, address: detail.address, pickupPoint: detail.pickupPoint, note: detail.note }, locale: deps.locale, event: `shipment_case:${row.id}`, category: TRANSACTIONAL_EMAIL });
    if (r.outcome === "suppressed" || r.outcome === "invalid") throw new CaseError("send_failed", r.outcome);
    reference = `email:${r.id}`;
  }
  const [done] = await ctx.tx.update(schema.shipmentCases).set({ instructionRef: reference }).where(eq(schema.shipmentCases.id, row.id)).returning();
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: row.orderId, type: "delivery_instruction_sent", actorType: ctx.actor.type, actorUserId: me, diff: { deliveryResolution: { from: null, to: input.resolution } }, metadata: { caseId: row.id, channel: input.channel, to: done!.instructionTo, reference, trackingNumber: ship?.trackingNumber ?? null, ...(detail.pickupPoint ? { pickupPoint: detail.pickupPoint } : {}) }, createdAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.instruction_sent", entityType: "shipment_case", entityId: row.id, diff: { resolution: { from: null, to: input.resolution }, instructionSentAt: { from: null, to: now.toISOString() } }, metadata: { channel: input.channel, to: done!.instructionTo, reference } });
  return done!;
}

/* ---------- return-to-sender follow-ups and closing ---------- */

export async function recordFollowUp(ctx: ServiceContext, caseId: string, kind: RtsFollowUp, outcome: "done" | "skipped" | null): Promise<CaseRow> {
  const cur = await ensureMine(ctx, caseId);
  if (cur.kind !== "return_to_sender") throw new CaseError("wrong_kind");
  const now = ctx.now ?? new Date();
  const prev = (cur.followUps ?? {}) as Record<string, { outcome: string; at: string; by: string | null }>;
  const next = { ...prev };
  if (outcome) next[kind] = { outcome, at: now.toISOString(), by: ctx.actor.userId };
  else delete next[kind];
  const [row] = await ctx.tx.update(schema.shipmentCases).set({ followUps: next, updatedAt: now }).where(eq(schema.shipmentCases.id, caseId)).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.follow_up", entityType: "shipment_case", entityId: caseId, diff: { [`followUps.${kind}`]: { from: prev[kind]?.outcome ?? null, to: outcome } } });
  return row!;
}

/** Closes a case by hand: a reviewed return to sender, or an exception handled outside Keel. */
export async function closeCase(ctx: ServiceContext, caseId: string, input: { reason: "resolved" | "dismissed"; note?: string | null }): Promise<CaseRow> {
  const cur = await ensureMine(ctx, caseId);
  const now = ctx.now ?? new Date();
  const note = input.note?.trim().slice(0, 1000) || null;
  const [row] = await ctx.tx.update(schema.shipmentCases).set({ status: "closed", closedAt: now, closeReason: input.reason, closedBy: ctx.actor.userId, note: note ?? cur.note, updatedAt: now }).where(and(eq(schema.shipmentCases.id, caseId), isNull(schema.shipmentCases.closedAt))).returning();
  if (!row) throw new CaseError("closed");
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...sysActor(ctx), action: "shipment_case.closed", entityType: "shipment_case", entityId: caseId, diff: { status: { from: cur.status, to: "closed" } }, metadata: { reason: input.reason, note } });
  return row;
}

/* ---------- read models ---------- */

export type CaseScope = "open" | "mine" | "unclaimed" | "closed";
export interface CaseListFilters {
  kind: CaseKind;
  scope: CaseScope;
  q?: string;
  page?: number;
}

export async function listShipmentCases(ctx: ServiceContext, f: CaseListFilters, pageSize = 50) {
  const claimer = schema.users;
  const conds: SQL[] = [eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.kind, f.kind)];
  if (f.scope === "closed") conds.push(isNotNull(schema.shipmentCases.closedAt));
  else conds.push(isNull(schema.shipmentCases.closedAt));
  if (f.scope === "mine" && ctx.actor.userId) conds.push(eq(schema.shipmentCases.claimedBy, ctx.actor.userId));
  if (f.scope === "unclaimed") conds.push(isNull(schema.shipmentCases.claimedBy));
  if (f.q) conds.push(or(sql`${schema.shipments.trackingNumber} ilike ${`%${f.q}%`}`, sql`${schema.orders.searchBlob} like ${`%${f.q.toLowerCase()}%`}`)!);
  const where = and(...conds)!;
  const page = Math.max(1, f.page ?? 1);
  const rows = await ctx.tx
    .select({ id: schema.shipmentCases.id, kind: schema.shipmentCases.kind, status: schema.shipmentCases.status, openedAt: schema.shipmentCases.openedAt, claimedBy: schema.shipmentCases.claimedBy, claimedByName: sql<string | null>`coalesce(${claimer.preferredName}, ${claimer.name}, ${claimer.email})`, resolution: schema.shipmentCases.resolution, instructionSentAt: schema.shipmentCases.instructionSentAt, closedAt: schema.shipmentCases.closedAt, closeReason: schema.shipmentCases.closeReason, followUps: schema.shipmentCases.followUps, reason: schema.shipmentCases.reason, shipmentId: schema.shipments.id, shipmentStatus: schema.shipments.status, carrier: schema.shipments.carrier, trackingNumber: schema.shipments.trackingNumber, trackingUrl: schema.shipments.trackingUrl, lastEventAt: schema.shipments.lastEventAt, orderId: schema.orders.id, orderName: schema.orders.name, customerName: schema.orders.customerName, country: schema.orders.shippingCountry })
    .from(schema.shipmentCases)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.shipmentCases.shipmentId))
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipmentCases.orderId))
    .leftJoin(claimer, eq(claimer.id, schema.shipmentCases.claimedBy))
    .where(where)
    .orderBy(f.scope === "closed" ? desc(schema.shipmentCases.closedAt) : asc(schema.shipmentCases.openedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ total }] = (await ctx.tx.select({ total: sql<number>`count(*)::int` }).from(schema.shipmentCases).innerJoin(schema.shipments, eq(schema.shipments.id, schema.shipmentCases.shipmentId)).innerJoin(schema.orders, eq(schema.orders.id, schema.shipmentCases.orderId)).where(where)) as [{ total: number }];
  return { rows, total, page, pageSize };
}

export async function shipmentCaseCounts(ctx: ServiceContext): Promise<{ exceptionsOpen: number; exceptionsUnclaimed: number; exceptionsMine: number; rtsOpen: number }> {
  const me = ctx.actor.userId;
  const [r] = await ctx.tx
    .select({
      exceptionsOpen: sql<number>`count(*) filter (where ${schema.shipmentCases.kind} = 'exception')::int`,
      exceptionsUnclaimed: sql<number>`count(*) filter (where ${schema.shipmentCases.kind} = 'exception' and ${schema.shipmentCases.claimedBy} is null)::int`,
      exceptionsMine: me ? sql<number>`count(*) filter (where ${schema.shipmentCases.kind} = 'exception' and ${schema.shipmentCases.claimedBy} = ${me})::int` : sql<number>`0`,
      rtsOpen: sql<number>`count(*) filter (where ${schema.shipmentCases.kind} = 'return_to_sender')::int`,
    })
    .from(schema.shipmentCases)
    .where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), isNull(schema.shipmentCases.closedAt)));
  return r ?? { exceptionsOpen: 0, exceptionsUnclaimed: 0, exceptionsMine: 0, rtsOpen: 0 };
}

export async function shipmentCaseDetail(ctx: ServiceContext, caseId: string) {
  const [c] = await ctx.tx.select().from(schema.shipmentCases).where(and(eq(schema.shipmentCases.tenantId, ctx.tenantId), eq(schema.shipmentCases.id, caseId))).limit(1);
  if (!c) return null;
  const [shipment] = await ctx.tx.select().from(schema.shipments).where(eq(schema.shipments.id, c.shipmentId)).limit(1);
  const [order] = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, email: schema.orders.email, phone: schema.orders.phone, shippingAddress: schema.orders.shippingAddress, paymentMethod: schema.orders.paymentMethod, paymentStatus: schema.orders.paymentStatus, totalMinor: schema.orders.totalMinor, refundedMinor: schema.orders.refundedMinor, currency: schema.orders.currency, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, c.orderId)).limit(1);
  const events = await ctx.tx.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, c.shipmentId)).orderBy(desc(schema.shipmentEvents.occurredAt)).limit(30);
  const userIds = [c.claimedBy, c.instructionSentBy, c.closedBy].filter((x): x is string => Boolean(x));
  const people = userIds.length ? await ctx.tx.select({ id: schema.users.id, name: sql<string>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  // units already back in stock for this order (a received return with restock)
  const [restock] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnLines).innerJoin(schema.returnRequests, eq(schema.returnRequests.id, schema.returnLines.returnId)).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.orderId, c.orderId), eq(schema.returnLines.restocked, true)));
  const suggestions = c.kind === "return_to_sender" && order ? suggestRtsFollowUps({ paymentStatus: order.paymentStatus, totalMinor: order.totalMinor, refundedMinor: order.refundedMinor, restocked: (restock?.n ?? 0) > 0, hasContact: Boolean(order.email || order.phone) }) : [];
  return { case: c, shipment: shipment ?? null, order: order ?? null, events, suggestions, names: { claimedBy: nameOf(c.claimedBy), instructionSentBy: nameOf(c.instructionSentBy), closedBy: nameOf(c.closedBy) } };
}

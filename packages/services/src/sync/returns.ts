import { and, eq, isNull, ne, schema, sql } from "@keel/db";
import { RETURN_CLOSED_STATUSES, RETURN_GOODS_BACK_STATUSES, matchReturnReason, nextReturnStatusFromPlatform, platformReturnTarget, returnableLines, type ReturnStatus } from "@keel/core";
import type { NormalizedReturn } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { applyReturnToOrder } from "../returns/effects";
import { syncRecordTasks } from "../tasks";

export interface ReturnImportOutcome {
  id: string | null;
  /** `linked`: a return Keel had pushed to the platform got its platform id from this import. */
  outcome: "created" | "updated" | "linked" | "unchanged" | "skipped";
  reason?: "order_not_found" | "no_lines";
}

const goodsBack = (s: string) => (RETURN_GOODS_BACK_STATUSES as readonly string[]).includes(s);
const closed = (s: string) => (RETURN_CLOSED_STATUSES as readonly string[]).includes(s);
/** Marks a refund made on the platform: Keel's write-back never issues it again. */
const PLATFORM_RANK: Record<string, number> = { requested: 0, approved: 1, declined: 2, closed: 2 };
const platformRefundMarker = (externalId: string) => `platform:${externalId}`;

/**
 * Idempotent upsert of a platform return (webhook or reconcile) into `return_requests` with `source =
 * platform`, linked to its order and lines. Matching, in order: the platform id; then a Keel return on the
 * same order with the same lines that has no platform id yet (Keel pushed it and the push is still
 * committing, or its answer was lost), which is adopted instead of duplicated. Status changes only move a
 * return forward. Money is never taken from the platform return: refunds come with the order import, so the
 * P/L counts them once.
 */
export async function importPlatformReturn(ctx: ServiceContext, r: NormalizedReturn, opts: { source: string }): Promise<ReturnImportOutcome> {
  const now = ctx.now ?? new Date();
  // one import of a platform return at a time: two webhooks, or a webhook and the reconcile, never both insert it
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`return:${ctx.tenantId}:${r.externalId}`}))`);
  const [order] = await ctx.tx.select({ id: schema.orders.id, refundedMinor: schema.orders.refundedMinor, discountMinor: schema.orders.discountMinor }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.externalId, r.orderExternalId))).limit(1);
  if (!order) return { id: null, outcome: "skipped", reason: "order_not_found" };
  const orderLines = await ctx.tx.select({ id: schema.orderLines.id, externalId: schema.orderLines.externalId, quantity: schema.orderLines.quantity, unitPriceMinor: schema.orderLines.unitPriceMinor, totalMinor: schema.orderLines.totalMinor, isAncillary: schema.orderLines.isAncillary }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, order.id)));
  const byExternal = new Map(orderLines.filter((l) => l.externalId).map((l) => [l.externalId!, l]));
  const wanted = r.lines.flatMap((l) => {
    const line = byExternal.get(l.orderLineExternalId);
    return line && l.quantity > 0 ? [{ ...l, orderLineId: line.id, quantity: Math.min(l.quantity, line.quantity) }] : [];
  });
  const target = platformReturnTarget(r.status, { orderRefunded: order.refundedMinor > 0 });

  let [existing] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.externalId, r.externalId))).limit(1);
  let linked = false;
  if (!existing && wanted.length) {
    const key = (ls: { orderLineId: string; quantity: number }[]) => ls.map((l) => `${l.orderLineId}:${l.quantity}`).sort().join(",");
    const wantedKey = key(wanted);
    const candidates = await ctx.tx.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.orderId, order.id), isNull(schema.returnRequests.externalId), ne(schema.returnRequests.source, "platform"), ne(schema.returnRequests.status, "rejected")));
    for (const c of candidates) {
      const lines = await ctx.tx.select({ orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity }).from(schema.returnLines).where(eq(schema.returnLines.returnId, c.id));
      if (key(lines) !== wantedKey) continue;
      // conditional: when Keel's own push commits first (it holds the row), this matches nothing and the id is read back below
      const [adopted] = await ctx.tx.update(schema.returnRequests).set({ externalId: r.externalId, updatedAt: now }).where(and(eq(schema.returnRequests.id, c.id), isNull(schema.returnRequests.externalId))).returning();
      [existing] = adopted ? [adopted] : await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.externalId, r.externalId))).limit(1);
      linked = Boolean(adopted);
      break;
    }
  }

  if (!existing) {
    if (!wanted.length) return { id: null, outcome: "skipped", reason: "no_lines" };
    const reasons = await ctx.tx.select({ code: schema.returnReasons.code, platformReason: schema.returnReasons.platformReason, isActive: schema.returnReasons.isActive, defaultFault: schema.returnReasons.defaultFault }).from(schema.returnReasons).where(eq(schema.returnReasons.tenantId, ctx.tenantId));
    const reasonCode = matchReturnReason(wanted[0]!.reason, reasons);
    const unitNet = new Map(returnableLines(orderLines.map((l) => ({ id: l.id, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.totalMinor, productType: null, isAncillary: l.isAncillary })), order.discountMinor, {}).map((l) => [l.id, l.unitNetMinor]));
    const [maxRow] = await ctx.tx.select({ n: sql<number>`coalesce(max(${schema.returnRequests.number}), 0)::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId));
    const number = (maxRow?.n ?? 0) + 1;
    const status = target.status;
    const endedAt = r.closedAt ?? now;
    const [row] = await ctx.tx
      .insert(schema.returnRequests)
      .values({
        tenantId: ctx.tenantId,
        orderId: order.id,
        number,
        externalId: r.externalId,
        status,
        reasonCode,
        resolution: "refund",
        fault: (reasons.find((x) => x.code === reasonCode)?.defaultFault as string | undefined) ?? "undetermined",
        customerNote: r.note ?? null,
        proposedAmountMinor: wanted.reduce((s, l) => s + l.quantity * (unitNet.get(l.orderLineId) ?? 0), 0),
        source: "platform",
        platformSyncStatus: "synced",
        platformStatus: target.platformStatus,
        platformSyncedAt: now,
        platformRefundId: status === "refunded" ? platformRefundMarker(r.externalId) : null,
        needsReview: target.needsReview,
        requestedAt: r.requestedAt,
        approvedAt: status === "requested" || status === "rejected" ? null : r.requestedAt,
        receivedAt: goodsBack(status) ? endedAt : null,
        closedAt: closed(status) ? endedAt : null,
        createdBy: null,
      })
      .returning({ id: schema.returnRequests.id });
    await ctx.tx.insert(schema.returnLines).values(wanted.map((l) => ({ tenantId: ctx.tenantId, returnId: row!.id, orderLineId: l.orderLineId, quantity: l.quantity, unitAmountMinor: unitNet.get(l.orderLineId) ?? 0, externalId: l.externalId ?? null })));
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "return_requested", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { returnId: row!.id, number, reason: reasonCode, resolution: "refund", source: "platform", externalId: r.externalId, via: opts.source }, createdAt: now });
    if (status !== "requested") await applyReturnToOrder(ctx, order.id, { returnId: row!.id, number, from: null, to: status }, { source: "platform", via: opts.source });
    await syncRecordTasks(ctx, "return", [row!.id]);
    return { id: row!.id, outcome: "created" };
  }

  // known return: fill the platform line ids, follow the platform's status forward
  for (const l of wanted) if (l.externalId) await ctx.tx.update(schema.returnLines).set({ externalId: l.externalId }).where(and(eq(schema.returnLines.returnId, existing.id), eq(schema.returnLines.orderLineId, l.orderLineId), isNull(schema.returnLines.externalId)));
  const next = nextReturnStatusFromPlatform(existing.status, target.status);
  const patch: Partial<typeof schema.returnRequests.$inferInsert> = {};
  // the platform state Keel remembers only moves forward too: a late webhook never makes the write-back repeat a step
  if ((PLATFORM_RANK[target.platformStatus] ?? 0) > (existing.platformStatus ? (PLATFORM_RANK[existing.platformStatus] ?? 0) : -1)) patch.platformStatus = target.platformStatus;
  if (next) {
    const endedAt = r.closedAt ?? now;
    patch.status = next;
    if (next !== "rejected" && !existing.approvedAt) patch.approvedAt = now;
    if (goodsBack(next) && !existing.receivedAt) patch.receivedAt = endedAt;
    if (closed(next)) patch.closedAt = endedAt;
    if (target.needsReview) patch.needsReview = true;
    if (next === "refunded" && !existing.platformRefundId) patch.platformRefundId = platformRefundMarker(r.externalId);
  }
  if (!Object.keys(patch).length) return { id: existing.id, outcome: linked ? "linked" : "unchanged" };
  await ctx.tx.update(schema.returnRequests).set({ ...patch, platformSyncedAt: now, updatedAt: now }).where(eq(schema.returnRequests.id, existing.id));
  if (next) {
    await applyReturnToOrder(ctx, existing.orderId, { returnId: existing.id, number: existing.number, from: existing.status, to: next as ReturnStatus }, { source: "platform", via: opts.source });
    await syncRecordTasks(ctx, "return", [existing.id]);
  }
  return { id: existing.id, outcome: linked ? "linked" : "updated" };
}

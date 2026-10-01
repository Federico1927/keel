import { and, eq, schema } from "@keel/db";
import { planTagChange } from "@keel/core";
import type { CommercePlatform } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { applyCancellation, recomputeOrderStatus, type RecomputeResult } from "./state";

/**
 * Order writes that reach the commerce platform, as services: platform first (a refused write
 * changes nothing locally), then the local row, the timeline event and the status recompute.
 * Bulk actions use them; single-record actions can move onto them too.
 */

export type CancelOutcome = { kind: "not_found" } | { kind: "already_cancelled"; name: string } | { kind: "cancelled"; name: string; result: RecomputeResult | null };

export async function cancelOrderWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, orderId: string, input: { reason: string; restock: boolean; refund: boolean; source?: string; eventMetadata?: Record<string, unknown> }): Promise<CancelOutcome> {
  const [order] = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, externalId: schema.orders.externalId, cancelledAt: schema.orders.cancelledAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return { kind: "not_found" };
  if (order.cancelledAt) return { kind: "already_cancelled", name: order.name };
  if (platform && order.externalId) await platform.cancelOrder(order.externalId, { reason: input.reason, restock: input.restock, refund: input.refund });
  const result = await applyCancellation(ctx, orderId, input);
  return { kind: "cancelled", name: order.name, result };
}

export type TagOutcome = { kind: "not_found" } | { kind: "unchanged"; name: string } | { kind: "updated"; name: string; added: string[]; removed: string[]; from: string[]; to: string[] };

/** Adds and removes order tags (they feed the tenant's state rules, so the status is recomputed). */
export async function updateOrderTagsWithPlatform(ctx: ServiceContext, platform: CommercePlatform | undefined, orderId: string, input: { add: string[]; remove: string[]; source?: string; eventMetadata?: Record<string, unknown> }): Promise<TagOutcome> {
  const [order] = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, externalId: schema.orders.externalId, platformTags: schema.orders.platformTags }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return { kind: "not_found" };
  const plan = planTagChange(order.platformTags, input.add, input.remove);
  if (!plan.add.length && !plan.remove.length) return { kind: "unchanged", name: order.name };
  if (platform && order.externalId) await platform.updateOrderTags(order.externalId, plan.add, plan.remove);
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.orders).set({ platformTags: plan.next }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "tags_updated", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { platformTags: { from: order.platformTags, to: plan.next } }, metadata: { added: plan.add, removed: plan.remove, source: input.source ?? null, ...(input.eventMetadata ?? {}) }, createdAt: now });
  await recomputeOrderStatus(ctx, orderId);
  return { kind: "updated", name: order.name, added: plan.add, removed: plan.remove, from: order.platformTags, to: plan.next };
}

export type AssignOutcome = { kind: "not_found" } | { kind: "unchanged"; name: string } | { kind: "assigned"; name: string; previous: string | null };

/** Local only (assignment is a Keel concept). The caller checks that the user is an active member. */
export async function assignOrderTo(ctx: ServiceContext, orderId: string, userId: string | null, opts: { eventMetadata?: Record<string, unknown> } = {}): Promise<AssignOutcome> {
  const [order] = await ctx.tx.select({ name: schema.orders.name, assignedTo: schema.orders.assignedTo }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return { kind: "not_found" };
  if ((order.assignedTo ?? null) === userId) return { kind: "unchanged", name: order.name };
  await ctx.tx.update(schema.orders).set({ assignedTo: userId }).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId)));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "assigned", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { assignedTo: { from: order.assignedTo ?? null, to: userId } }, metadata: { ...(opts.eventMetadata ?? {}) }, createdAt: ctx.now ?? new Date() });
  return { kind: "assigned", name: order.name, previous: order.assignedTo ?? null };
}

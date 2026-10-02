import { and, eq, inArray, schema } from "@hullwise/db";
import type { Address, CommercePlatform } from "@hullwise/integrations";
import { OrderEditError, editOrderDetails, orderMergeCandidates, replaceOrder, type ContactPatch, type DesiredLine, type MergeCandidate, type ServiceContext } from "@hullwise/services";
import { OPEN_QUEUE_STATUSES } from "../queue";
import { classifyTags, tagMatches } from "../tags";
import type { CodSettings } from "../settings";
import { CodError, applyTagEvent, getCodSettings, recordAttempt } from "./index";

/**
 * Pre-confirmation changes agreed on the phone. The edit itself is the core order-edit service
 * (`@hullwise/services` orders/edit, issue #22): contact changes in place, line changes and merges as
 * cancel-and-recreate with lineage. This module only adds the COD extras: the order must be in
 * the confirmation queue, the call is registered as a `modified` attempt, queue tags are written,
 * and the replacement takes the queue item over with the same operator.
 */
export interface ModifyOrderInput {
  orderId: string;
  contact?: { customerName?: string | null; phone?: string | null; email?: string | null; shippingAddress?: Address | null; note?: string | null; noteMode?: "replace" | "append" };
  /** Desired lines after the change; omit to keep them. Either an existing line (by id) or a variant to add. */
  lines?: DesiredLine[];
  /** Other open COD orders of the same customer folded into the replacement. */
  mergeOrderIds?: string[];
  attemptNote?: string | null;
  /** Also register a `modified` call outcome (default true). */
  registerAttempt?: boolean;
  /** Switch the payment method on the replacement (C.13): the order leaves the COD flow and the COD fee lines are dropped. */
  paymentMethod?: "card" | "bank_transfer" | "other" | null;
}

/** Lines matching the tenant's COD fee patterns (SKU or title). */
export function isFeeLine(patterns: readonly string[], line: { sku: string | null; title: string }): boolean {
  return patterns.some((p) => (line.sku ? tagMatches(p, line.sku) : false) || tagMatches(p, line.title));
}
export type ModifyOrderResult = { kind: "updated"; orderId: string; changed: string[] } | { kind: "replaced"; orderId: string; newOrderId: string; newOrderName: string; merged: number; warning: "old_order_not_cancelled" | null; paymentMethod?: string };

async function requireOpenItem(ctx: ServiceContext, orderId: string) {
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as never)) throw new CodError("not_in_queue");
  return item;
}

/** Core edit errors keep the add-on's error vocabulary (`cod_*` messages in the UI). */
async function core<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof OrderEditError)) throw e;
    if (e.code === "not_found") throw new CodError("not_found");
    if (e.code === "platform_error") throw new CodError("platform_error", e.message);
    throw new CodError("invalid_input", e.detail?.block ?? e.detail?.field ?? e.code);
  }
}

const tagSafe = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CodError && e.code === "platform_error")) throw e;
  }
};

export async function modifyCodOrder(ctx: ServiceContext, platform: CommercePlatform | undefined, input: ModifyOrderInput, opts: { country: string; settings?: CodSettings }): Promise<ModifyOrderResult> {
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const now = ctx.now ?? new Date();
  const item = await requireOpenItem(ctx, input.orderId);
  const contact: ContactPatch | undefined = input.contact;
  const mergeIds = [...new Set((input.mergeOrderIds ?? []).filter((id) => id !== input.orderId))];
  const sourceItems: Awaited<ReturnType<typeof requireOpenItem>>[] = [];
  for (const id of mergeIds) sourceItems.push(await requireOpenItem(ctx, id));
  const attempt = async () => {
    if (input.registerAttempt !== false) await recordAttempt(ctx, { orderId: input.orderId, outcome: "modified", note: input.attemptNote ?? null }, settings, { platform });
  };

  // decide the path the same way the core does: lines that differ or merges → replacement
  const lines = await ctx.tx.select({ id: schema.orderLines.id, variantId: schema.orderLines.variantId, quantity: schema.orderLines.currentQuantity, sku: schema.orderLines.sku, title: schema.orderLines.title }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, input.orderId)));
  const current = lines.filter((l) => l.quantity > 0);
  const switching = Boolean(input.paymentMethod);
  if (switching) {
    // the COD fee does not survive a switch to a prepaid method: drop its lines from what is kept
    const desired = input.lines ?? current.map((l) => ({ lineId: l.id, quantity: l.quantity }));
    input = { ...input, lines: desired.map((d) => (d.lineId && isFeeLine(settings.feeLineMatch, current.find((c) => c.id === d.lineId) ?? { sku: null, title: "" }) ? { ...d, quantity: 0 } : d)) };
  }
  const key = (xs: { variantId: string | null; quantity: number }[]) => JSON.stringify(xs.filter((x) => x.quantity > 0).map((x) => [x.variantId, x.quantity]).sort());
  const linesChanged = Boolean(input.lines) && key(current) !== key(input.lines!.map((l) => ({ variantId: l.lineId ? (current.find((c) => c.id === l.lineId)?.variantId ?? `missing:${l.lineId}`) : (l.variantId ?? null), quantity: l.quantity })));

  if (!linesChanged && !mergeIds.length && !switching) {
    const r = await core(() => editOrderDetails(ctx, platform, { orderId: input.orderId, contact: contact ?? {} }, { country: opts.country, source: "cod" }));
    await attempt();
    return { kind: "updated", orderId: input.orderId, changed: r.changed };
  }

  if (!platform) throw new CodError("platform_error", "no commerce platform");
  await attempt();
  const items = new Map([[input.orderId, item], ...mergeIds.map((id, i) => [id, sourceItems[i]!] as const)]);
  const r = await core(() =>
    replaceOrder(ctx, platform, { orderId: input.orderId, lines: input.lines, mergeOrderIds: mergeIds, contact }, {
      country: opts.country,
      source: "cod",
      hooks: {
        force: switching,
        createInput: switching ? (ci) => ({ ...ci, payment: { method: input.paymentMethod!, status: "pending", gateways: [input.paymentMethod === "bank_transfer" ? "bank_deposit" : "manual"] } }) : undefined,
        // queue / confirmation tags describe the old order's state, not the new one's
        inheritTags: (tags) => tags.filter((t) => !classifyTags(settings.tags, [t])),
        afterCreated: async (c, { newOrder }) => {
          await c.tx.update(schema.orders).set({ assignedTo: item.assignedTo }).where(eq(schema.orders.id, newOrder.id));
          // a prepaid replacement leaves the COD flow: no queue item, no queue tag
          if (switching) {
            await c.tx.insert(schema.orderEvents).values({ tenantId: c.tenantId, orderId: newOrder.id, type: "payment_method_changed", actorType: c.actor.type, actorUserId: c.actor.userId, diff: { paymentMethod: { from: "cod", to: input.paymentMethod } }, metadata: { source: "cod", feeLinesDropped: current.filter((l) => isFeeLine(settings.feeLineMatch, l)).length }, createdAt: now });
            return;
          }
          // the replacement enters the queue immediately with the same operator; attempts start again
          await c.tx.insert(schema.codQueueItems).values({ tenantId: c.tenantId, orderId: newOrder.id, status: "pending", assignedTo: item.assignedTo, assignedAt: item.assignedTo ? now : null, enteredAt: now }).onConflictDoNothing();
          await tagSafe(() => applyTagEvent(c, platform, { id: newOrder.id, externalId: newOrder.externalId, platformTags: newOrder.platformTags }, "entered", settings));
        },
        afterReplaced: async (c, { order }) => {
          await tagSafe(() => applyTagEvent(c, platform, { id: order.id, externalId: order.externalId, platformTags: [...order.platformTags] }, "replaced", settings));
          const it = items.get(order.id);
          if (it) await c.tx.update(schema.codQueueItems).set({ status: "left", closedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, it.id));
        },
      },
    }),
  );
  return { kind: "replaced", orderId: r.orderId, newOrderId: r.newOrderId, newOrderName: r.newOrderName, merged: r.merged, warning: r.warning, ...(switching ? { paymentMethod: input.paymentMethod! } : {}) };
}

/** Open COD orders of the same customer that could be merged into this one: the core candidates still in the queue. */
export async function mergeCandidates(ctx: ServiceContext, orderId: string): Promise<(MergeCandidate & { lines: { title: string; variantTitle: string | null; quantity: number }[] })[]> {
  const open = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const ids = open.map((o) => o.orderId).filter((id) => id !== orderId);
  if (!ids.length) return [];
  return orderMergeCandidates(ctx, orderId, { restrictTo: ids });
}

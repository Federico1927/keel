import { and, eq, gte, inArray, isNull, lte, ne, or, schema } from "@keel/db";
import { findDuplicateOrders, type DuplicateMatch } from "@keel/core";
import type { ServiceContext } from "../context";

/** Loads sibling candidates from the database and delegates the decision to core. */
export async function duplicateSiblings(ctx: ServiceContext, orderId: string, windowDays: number): Promise<(DuplicateMatch & { name: string; placedAt: Date; status: string })[]> {
  const [target] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!target) return [];
  const identity = [];
  if (target.customerId) identity.push(eq(schema.orders.customerId, target.customerId));
  if (target.emailNormalized) identity.push(eq(schema.orders.emailNormalized, target.emailNormalized));
  if (target.phoneE164) identity.push(eq(schema.orders.phoneE164, target.phoneE164));
  if (!identity.length) return [];
  const from = new Date(target.placedAt.getTime() - windowDays * 864e5);
  const to = new Date(target.placedAt.getTime() + windowDays * 864e5);
  const candidates = await ctx.tx
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), ne(schema.orders.id, target.id), or(...identity), gte(schema.orders.placedAt, from), lte(schema.orders.placedAt, to), isNull(schema.orders.cancelledAt), isNull(schema.orders.replacedByOrderId)))
    .limit(50);
  const ids = [target.id, ...candidates.map((c) => c.id)];
  const lines = await ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), inArray(schema.orderLines.orderId, ids)));
  const linesFor = (id: string) => lines.filter((l) => l.orderId === id).map((l) => ({ variantId: l.variantId, productId: l.productId, sku: l.sku, title: l.title, isAncillary: l.isAncillary }));
  const toCandidate = (o: typeof target) => ({ id: o.id, placedAt: o.placedAt, customerId: o.customerId, emailNormalized: o.emailNormalized, phoneE164: o.phoneE164, cancelledAt: o.cancelledAt, status: o.status, replacesOrderId: o.replacesOrderId, replacedByOrderId: o.replacedByOrderId, lines: linesFor(o.id) });
  const matches = findDuplicateOrders(toCandidate(target), candidates.map(toCandidate), windowDays);
  return matches.map((m) => {
    const c = candidates.find((x) => x.id === m.orderId)!;
    return { ...m, name: c.name, placedAt: c.placedAt, status: c.status };
  });
}

import { and, eq, inArray, schema, sql } from "@hullwise/db";
import { parseTenantSettings } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { serializeOrder, serializeProduct, serializeReturn, serializeShipment } from "../api/serialize";
import { emitWebhookEvent, hasWebhookSubscribers } from "./emit";

/**
 * Event payloads of the outgoing webhooks (#81), built where the services change things. They use
 * the REST API's resource shapes without personal data (no names, emails, phones or addresses:
 * receivers fetch the resource with a token that may see them). Each helper is a no-op when no
 * endpoint of the tenant subscribes to the event type.
 */

type OrderRow = typeof schema.orders.$inferSelect;

async function orderRow(ctx: ServiceContext, orderId: string): Promise<OrderRow | null> {
  const [o] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  return o ?? null;
}

/** `order.created` / `order.updated` with the order as it is now (`changes`: the fields that moved). */
export async function emitOrderWebhook(ctx: ServiceContext, type: "order.created" | "order.updated", orderId: string, extra: { changes?: string[]; source?: string } = {}): Promise<void> {
  if (!(await hasWebhookSubscribers(ctx, type))) return;
  const o = await orderRow(ctx, orderId);
  if (o) await emitWebhookEvent(ctx, type, { order: serializeOrder(o, "omit"), ...(extra.changes ? { changes: extra.changes } : {}), ...(extra.source ? { source: extra.source } : {}) });
}

/** `order.status_changed` from the status engine (the only writer of `orders.status`). */
export async function emitOrderStatusWebhook(ctx: ServiceContext, order: OrderRow, change: { previous: string; status: string; reason: string }): Promise<void> {
  if (!(await hasWebhookSubscribers(ctx, "order.status_changed"))) return;
  await emitWebhookEvent(ctx, "order.status_changed", { order: serializeOrder({ ...order, status: change.status, statusReason: change.reason }, "omit"), previousStatus: change.previous, status: change.status, reason: change.reason });
}

/** `shipment.updated`: a new shipment, or a resolved status that changed. */
export async function emitShipmentWebhook(ctx: ServiceContext, shipmentId: string, previousStatus: string | null): Promise<void> {
  if (!(await hasWebhookSubscribers(ctx, "shipment.updated"))) return;
  const [s] = await ctx.tx.select().from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.id, shipmentId))).limit(1);
  if (s) await emitWebhookEvent(ctx, "shipment.updated", { shipment: serializeShipment(s), previousStatus });
}

/** `return.updated`: a return created (previous null) or moved to another status. */
export async function emitReturnWebhook(ctx: ServiceContext, returnId: string, previousStatus: string | null): Promise<void> {
  if (!(await hasWebhookSubscribers(ctx, "return.updated"))) return;
  const [r] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (r) await emitWebhookEvent(ctx, "return.updated", { return: serializeReturn(r, "omit"), previousStatus });
}

/** `product.updated` with the product and its variants as they are now. */
export async function emitProductWebhook(ctx: ServiceContext, productId: string, extra: { source?: string } = {}): Promise<void> {
  if (!(await hasWebhookSubscribers(ctx, "product.updated"))) return;
  const [p] = await ctx.tx.select().from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId))).limit(1);
  if (!p) return;
  const variants = await ctx.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.productId, productId))).orderBy(schema.productVariants.createdAt);
  await emitWebhookEvent(ctx, "product.updated", { product: serializeProduct(p, variants), ...(extra.source ? { source: extra.source } : {}) });
}

async function availableTotals(ctx: ServiceContext, variantIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, total: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, [...variantIds]))).groupBy(schema.inventoryLevels.variantId);
  return new Map(rows.map((r) => [r.variantId, r.total]));
}

/**
 * Call before a stock write, run the returned check after it: `inventory.low_stock` fires for each
 * variant whose available units across locations fall to the tenant's low-stock threshold or below
 * (from above it), so a variant that stays low does not fire again on every change.
 */
export async function lowStockProbe(ctx: ServiceContext, variantIds: readonly string[]): Promise<(() => Promise<void>) | null> {
  const ids = [...new Set(variantIds)];
  if (!ids.length || !(await hasWebhookSubscribers(ctx, "inventory.low_stock"))) return null;
  const before = await availableTotals(ctx, ids);
  return async () => {
    const after = await availableTotals(ctx, ids);
    const [t] = await ctx.tx.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
    const threshold = parseTenantSettings(t?.settings).lowStockThreshold;
    const crossed = ids.filter((id) => (before.get(id) ?? 0) > threshold && (after.get(id) ?? 0) <= threshold);
    if (!crossed.length) return;
    const variants = await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, sku: schema.productVariants.sku, title: schema.productVariants.title, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, crossed)));
    const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, locationId: schema.inventoryLevels.locationId, available: schema.inventoryLevels.available }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, crossed)));
    for (const id of crossed) {
      const v = variants.find((x) => x.id === id);
      await emitWebhookEvent(ctx, "inventory.low_stock", { variantId: id, productId: v?.productId ?? null, sku: v?.sku ?? null, title: v ? `${v.product} · ${v.title}` : null, available: after.get(id) ?? 0, previousAvailable: before.get(id) ?? 0, threshold, levels: levels.filter((l) => l.variantId === id).map(({ locationId, available }) => ({ locationId, available })) });
    }
  };
}

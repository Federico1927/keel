import { and, asc, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { PAGE_SIZE, isPageEnabled } from "@hullwise/config";
import { catalogThumbnails, orderLineage, orderListWhere, orderMergeCandidates, type OrderFilters } from "@hullwise/services";
import { OPEN_QUEUE_STATUSES } from "@hullwise/addon-cod";
import type { TenantContext } from "@/server/tenant";

export { parseOrderFilters, utmParam, type OrderFilters } from "@hullwise/services";

const buildWhere = (ctx: TenantContext, f: OrderFilters): SQL => orderListWhere({ tenantId: ctx.tenant.id, userId: ctx.user.id, orderNumberPrefix: ctx.tenant.orderNumberPrefix }, f);

/** Label of the product / variant drill-down filter (`?product=` / `?variant=`), for the filter chip. */
export async function orderDrillLabel(ctx: TenantContext, f: OrderFilters): Promise<{ kind: "product" | "variant"; label: string } | null> {
  if (!f.product && !f.variant) return null;
  return ctx.run(async (tx) => {
    if (f.variant) {
      const [v] = await tx.select({ title: schema.productVariants.title, sku: schema.productVariants.sku, product: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.id, f.variant))).limit(1);
      return { kind: "variant" as const, label: v ? `${v.product} · ${v.title}${v.sku ? ` (${v.sku})` : ""}` : "—" };
    }
    const [p] = await tx.select({ title: schema.products.title }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, f.product!))).limit(1);
    return { kind: "product" as const, label: p?.title ?? "—" };
  });
}

export async function listOrders(ctx: TenantContext, f: OrderFilters) {
  const where = buildWhere(ctx, f);
  const order = f.sort === "placed_asc" ? asc(schema.orders.placedAt) : f.sort === "total_desc" ? desc(schema.orders.totalMinor) : desc(schema.orders.placedAt);
  const page = f.page ?? 1;
  return ctx.run(async (tx) => {
    const rows = await tx
      .select({
        id: schema.orders.id,
        name: schema.orders.name,
        placedAt: schema.orders.placedAt,
        customerName: schema.orders.customerName,
        email: schema.orders.email,
        status: schema.orders.status,
        statusSource: schema.orders.statusSource,
        paymentMethod: schema.orders.paymentMethod,
        paymentStatus: schema.orders.paymentStatus,
        totalMinor: schema.orders.totalMinor,
        currency: schema.orders.currency,
        shippingCountry: schema.orders.shippingCountry,
        platformTags: schema.orders.platformTags,
        assignedTo: schema.orders.assignedTo,
        sourceChannel: schema.orders.sourceChannel,
        fulfillmentStatusRaw: schema.orders.fulfillmentStatusRaw,
      })
      .from(schema.orders)
      .where(where)
      .orderBy(order, desc(schema.orders.orderNumber))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(schema.orders).where(where)) as [{ total: number }];
    const counts = await tx.select({ status: schema.orders.status, n: sql<number>`count(*)::int` }).from(schema.orders).where(buildWhere(ctx, { ...f, status: [] })).groupBy(schema.orders.status);
    // backorder views: how many orders each would show with the other filters kept
    const stockCount = async (stock: "awaiting" | "ready") => ((await tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(buildWhere(ctx, { ...f, status: [], stock }))) as [{ n: number }])[0].n;
    const stockViews = { awaiting: await stockCount("awaiting"), ready: await stockCount("ready") };
    return { rows, total, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, stockViews, page, pageSize: PAGE_SIZE };
  });
}

export async function getOrderDetail(ctx: TenantContext, id: string) {
  return ctx.run(async (tx) => {
    const [order] = await tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, id))).limit(1);
    if (!order) return null;
    const [lines, events, notes, shipments, attribution, discounts, returns] = await Promise.all([
      tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, id)).orderBy(asc(schema.orderLines.createdAt)),
      tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, id)).orderBy(desc(schema.orderEvents.createdAt)).limit(200),
      tx.select().from(schema.orderNotes).where(eq(schema.orderNotes.orderId, id)).orderBy(desc(schema.orderNotes.createdAt)),
      tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, id)).orderBy(asc(schema.shipments.createdAt)),
      tx.select().from(schema.orderAttribution).where(eq(schema.orderAttribution.orderId, id)).limit(1),
      tx.select().from(schema.orderDiscounts).where(eq(schema.orderDiscounts.orderId, id)),
      tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.orderId, id)).orderBy(desc(schema.returnRequests.requestedAt)),
    ]);
    const shipmentIds = shipments.map((s) => s.id);
    const [sourceStates, shipmentEvents] = shipmentIds.length
      ? await Promise.all([
          tx.select().from(schema.shipmentSourceStates).where(inArray(schema.shipmentSourceStates.shipmentId, shipmentIds)),
          tx.select().from(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, shipmentIds)).orderBy(desc(schema.shipmentEvents.occurredAt)),
        ])
      : [[], []];
    const campaign = attribution[0]?.campaignId ? (await tx.select({ id: schema.campaigns.id, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.id, attribution[0].campaignId)).limit(1))[0] ?? null : null;
    const thumbs = await catalogThumbnails({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { variantIds: lines.map((l) => l.variantId), productIds: lines.map((l) => l.productId) });
    const lineImages = Object.fromEntries(lines.map((l) => [l.id, (l.variantId && thumbs.variants.get(l.variantId)) || (l.productId && thumbs.products.get(l.productId)) || null]));
    return { order, lines, lineImages, events, notes, shipments, sourceStates, shipmentEvents, attribution: attribution[0] ?? null, campaign, discounts, returns };
  });
}

/** Neighbouring orders in placed_at order, for prev/next on the detail page. */
export async function adjacentOrders(ctx: TenantContext, placedAt: Date, id: string) {
  return ctx.run(async (tx) => {
    const [prev] = await tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), sql`(${schema.orders.placedAt}, ${schema.orders.id}) > (${placedAt}, ${id}::uuid)`)).orderBy(asc(schema.orders.placedAt), asc(schema.orders.id)).limit(1);
    const [next] = await tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), sql`(${schema.orders.placedAt}, ${schema.orders.id}) < (${placedAt}, ${id}::uuid)`)).orderBy(desc(schema.orders.placedAt), desc(schema.orders.id)).limit(1);
    return { newer: prev ?? null, older: next ?? null };
  });
}

/**
 * What the order page needs to offer editing: lineage (always), and when the order is editable the
 * catalog for added lines, merge candidates, and whether the COD card owns the edit (an open
 * confirmation-queue item, so the call attempt and queue hand-over happen in the add-on).
 */
export async function getOrderEditData(ctx: TenantContext, order: { id: string; paymentMethod: string }, opts: { editable: boolean }) {
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const lineage = await orderLineage(s, order.id);
    if (!opts.editable) return { lineage, catalog: [], candidates: [], codOwnsEdit: false };
    const [catalog, candidates, queue] = await Promise.all([
      tx.select({ id: schema.productVariants.id, sku: schema.productVariants.sku, title: schema.productVariants.title, product: schema.products.title, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.isActive, true), eq(schema.products.status, "active"))).orderBy(schema.products.title).limit(600),
      orderMergeCandidates(s, order.id),
      order.paymentMethod === "cod" && isPageEnabled("cod_queue", ctx.activeAddons) ? tx.select({ status: schema.codQueueItems.status }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenant.id), eq(schema.codQueueItems.orderId, order.id))).limit(1) : Promise.resolve([]),
    ]);
    const codOwnsEdit = queue.some((q) => (OPEN_QUEUE_STATUSES as readonly string[]).includes(q.status));
    return { lineage, catalog, candidates, codOwnsEdit };
  });
}

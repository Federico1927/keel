import { and, asc, desc, eq, gte, inArray, lte, schema, sql, type SQL } from "@keel/db";
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from "@keel/core";
import { PAGE_SIZE, isPageEnabled } from "@keel/config";
import { orderLineage, orderMergeCandidates } from "@keel/services";
import { OPEN_QUEUE_STATUSES } from "@keel/addon-cod";
import type { TenantContext } from "@/server/tenant";

export interface OrderFilters {
  q?: string;
  status?: string[];
  payment?: string[];
  paymentStatus?: string[];
  channel?: string[];
  tag?: string;
  from?: string;
  to?: string;
  assigned?: string;
  campaign?: string;
  customer?: string;
  sort?: "placed_desc" | "placed_asc" | "total_desc";
  page?: number;
}

export function parseOrderFilters(sp: Record<string, string | string[] | undefined>): OrderFilters {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
  const sort = one(sp.sort);
  return {
    q: one(sp.q)?.trim() || undefined,
    status: list(sp.status).filter((s) => (ORDER_STATUSES as readonly string[]).includes(s)),
    payment: list(sp.payment).filter((s) => (PAYMENT_METHODS as readonly string[]).includes(s)),
    paymentStatus: list(sp.paymentStatus).filter((s) => (PAYMENT_STATUSES as readonly string[]).includes(s)),
    channel: list(sp.channel),
    tag: one(sp.tag)?.trim() || undefined,
    from: one(sp.from) || undefined,
    to: one(sp.to) || undefined,
    assigned: one(sp.assigned) || undefined,
    campaign: /^[0-9a-f-]{36}$/i.test(one(sp.campaign) ?? "") ? one(sp.campaign) : undefined,
    customer: /^[0-9a-f-]{36}$/i.test(one(sp.customer) ?? "") ? one(sp.customer) : undefined,
    sort: sort === "placed_asc" || sort === "total_desc" ? sort : "placed_desc",
    page: Math.max(1, Number(one(sp.page) ?? 1) || 1),
  };
}

function buildWhere(ctx: TenantContext, f: OrderFilters): SQL {
  const conds: SQL[] = [eq(schema.orders.tenantId, ctx.tenant.id)];
  if (f.q) {
    const numeric = f.q.replace(/^#/, "").replace(new RegExp(`^${ctx.tenant.orderNumberPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), "");
    if (/^\d{2,}$/.test(numeric)) conds.push(eq(schema.orders.orderNumber, Number(numeric)));
    else conds.push(sql`${schema.orders.searchBlob} ilike ${"%" + f.q.toLowerCase() + "%"}`);
  }
  if (f.status?.length) conds.push(inArray(schema.orders.status, f.status));
  if (f.payment?.length) conds.push(inArray(schema.orders.paymentMethod, f.payment));
  if (f.paymentStatus?.length) conds.push(inArray(schema.orders.paymentStatus, f.paymentStatus));
  if (f.channel?.length) conds.push(inArray(schema.orders.sourceChannel, f.channel));
  if (f.tag) conds.push(sql`${f.tag.toLowerCase()} = any(${schema.orders.platformTags})`);
  if (f.from) conds.push(gte(schema.orders.placedAt, new Date(f.from)));
  if (f.to) conds.push(lte(schema.orders.placedAt, new Date(new Date(f.to).getTime() + 864e5)));
  if (f.assigned === "me") conds.push(eq(schema.orders.assignedTo, ctx.user.id));
  else if (f.assigned === "none") conds.push(sql`${schema.orders.assignedTo} is null`);
  else if (f.assigned) conds.push(eq(schema.orders.assignedTo, f.assigned));
  if (f.customer) conds.push(eq(schema.orders.customerId, f.customer));
  if (f.campaign) conds.push(sql`exists (select 1 from order_attribution a where a.order_id = ${schema.orders.id} and a.campaign_id = ${f.campaign})`);
  return and(...conds)!;
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
    return { rows, total, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, page, pageSize: PAGE_SIZE };
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
    return { order, lines, events, notes, shipments, sourceStates, shipmentEvents, attribution: attribution[0] ?? null, campaign, discounts, returns };
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

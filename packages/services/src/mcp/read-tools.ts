import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, or, schema, sql } from "@keel/db";
import { MCP_LIMITS } from "@keel/config";
import { ORDER_STATUSES, PAYMENT_METHODS, PURCHASE_ORDER_STATUSES, RETURN_STATUSES, sanitizeFreeText, sanitizeSearch } from "@keel/core";
import { orderListWhere } from "../lists/filters";
import { customerOrderHistory } from "../orders/history";
import { customerDetail, listCustomers, listSegments } from "../crm";
import { listRetentionCampaigns } from "../crm/campaigns";
import { variantStock, summarizeByProduct } from "../inventory";
import { listReturns } from "../returns";
import { integrationOverview } from "../sync";
import { ToolError, keelLink, localDate, localDateTime, majorUnits, roundTo, type KeelTool, type ToolRuntime } from "../tools";

/**
 * Read tools of the MCP server (#21) beyond the assistant's analytics: orders, customers, products,
 * purchasing, returns, segments and integration health. Amounts are in major units with their
 * currency, dates in the store's time zone. Customer PII is returned as stored; the MCP server masks
 * it unless the tenant enabled full PII and the role may see it.
 */

const uuid = z.string().uuid();
const page = z.number().int().min(1).max(10_000).default(1).describe("Page number, from 1");
const pageSize = (fallback = 20) => z.number().int().min(1).max(MCP_LIMITS.maxPageSize).default(fallback).describe(`Rows per page, 1 to ${MCP_LIMITS.maxPageSize}`);
const search = z.string().max(200).optional().describe(`Free-text search (at most ${MCP_LIMITS.searchMaxChars} characters are used)`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const read = { scope: "read", effect: "read" } as const;

const isUuid = (v: string) => uuid.safeParse(v).success;

/** An order by id, by name (`NW-1042`) or by number (`1042`), in this tenant only. */
export async function resolveOrderRef(rt: ToolRuntime, ref: string) {
  const o = schema.orders;
  const clean = sanitizeFreeText(ref, 60).replace(/\s+/g, " ").trim();
  if (!clean) throw new ToolError("invalid_input", "Give an order id, name or number.");
  const prefix = (rt.tenant.orderNumberPrefix ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numeric = clean.replace(/^#/, "").replace(new RegExp(`^${prefix}`, "i"), "");
  const cond = isUuid(clean) ? eq(o.id, clean) : /^\d{1,9}$/.test(numeric) ? or(eq(o.orderNumber, Number(numeric)), eq(sql`lower(${o.name})`, clean.toLowerCase())) : eq(sql`lower(${o.name})`, clean.toLowerCase());
  const [row] = await rt.ctx.tx.select().from(o).where(and(eq(o.tenantId, rt.ctx.tenantId), cond)).orderBy(desc(o.placedAt)).limit(1);
  if (!row) throw new ToolError("not_found", `No order "${clean}" in this store.`);
  return row;
}

/** Display names of members of this tenant (memberships are tenant data under RLS). */
async function memberNames(rt: ToolRuntime, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await rt.ctx.tx.select({ id: schema.users.id, name: schema.users.name, preferred: schema.users.preferredName, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, rt.ctx.tenantId), inArray(schema.tenantMemberships.userId, unique)));
  return new Map(rows.map((r) => [r.id, r.name || r.preferred || r.email]));
}

/* ---------- orders ---------- */

const searchOrdersInput = z.object({
  query: search.describe("Order number or name, customer name, email or phone"),
  status: z.array(z.enum(ORDER_STATUSES)).max(11).optional().describe("Canonical order statuses"),
  paymentMethod: z.array(z.enum(PAYMENT_METHODS)).max(6).optional(),
  from: day.optional().describe("Placed on or after this day (YYYY-MM-DD)"),
  to: day.optional().describe("Placed on or before this day (YYYY-MM-DD)"),
  assignedToMe: z.boolean().optional().describe("Only orders assigned to the connected user"),
  sort: z.enum(["newest", "oldest", "highest_total"]).default("newest"),
  page,
  pageSize: pageSize(),
});
const searchOrders: KeelTool<typeof searchOrdersInput> = {
  name: "search_orders",
  title: "Search orders",
  page: "orders",
  ...read,
  description: "Finds orders by number, customer name, email or phone, with filters on canonical status (new, pending_review, confirmed, fulfilling, shipped, delivered, on_hold, cancelled, returned_partial, returned, refunded), payment method and date. Returns one page with status, payment, total and a link to each order. Example: { \"query\": \"rossi\", \"status\": [\"on_hold\"] }. Use get_order for the full detail and timeline.",
  input: searchOrdersInput,
  async run(rt, input) {
    const o = schema.orders;
    const where = orderListWhere({ tenantId: rt.ctx.tenantId, userId: rt.userId, orderNumberPrefix: rt.tenant.orderNumberPrefix ?? "" }, { q: sanitizeSearch(input.query) || undefined, status: input.status, payment: input.paymentMethod, from: input.from, to: input.to, assigned: input.assignedToMe ? "me" : undefined });
    const order = input.sort === "oldest" ? asc(o.placedAt) : input.sort === "highest_total" ? desc(o.totalMinor) : desc(o.placedAt);
    const rows = await rt.ctx.tx.select({ id: o.id, name: o.name, placedAt: o.placedAt, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, totalMinor: o.totalMinor, currency: o.currency, customerName: o.customerName, email: o.email, phone: o.phone, shippingCountry: o.shippingCountry, channel: o.sourceChannel, tags: o.platformTags, assignedTo: o.assignedTo }).from(o).where(where).orderBy(order, desc(o.orderNumber)).limit(input.pageSize).offset((input.page - 1) * input.pageSize);
    const [{ total }] = (await rt.ctx.tx.select({ total: sql<number>`count(*)::int` }).from(o).where(where)) as [{ total: number }];
    const names = await memberNames(rt, rows.map((r) => r.assignedTo));
    const tz = rt.tenant.timezone;
    return {
      data: {
        timezone: tz,
        total,
        page: input.page,
        pageSize: input.pageSize,
        orders: rows.map((r) => ({ id: r.id, name: r.name, placedAt: localDateTime(r.placedAt, tz), status: r.status, paymentMethod: r.paymentMethod, paymentStatus: r.paymentStatus, total: majorUnits(r.totalMinor, r.currency), currency: r.currency, customerName: r.customerName, email: r.email, phone: r.phone, shippingCountry: r.shippingCountry, channel: r.channel, tags: r.tags, assignedTo: r.assignedTo ? (names.get(r.assignedTo) ?? null) : null, link: keelLink(rt, `/orders/${r.id}`) })),
      },
    };
  },
};

const getOrderInput = z.object({ order: z.string().min(1).max(80).describe("Order id, name (e.g. NW-1042) or number") });
const getOrder: KeelTool<typeof getOrderInput> = {
  name: "get_order",
  title: "Order detail and timeline",
  page: "orders",
  ...read,
  description: "Full detail of one order: status and why, payment, lines, totals, refunds, shipments with tracking, returns, internal notes, assignee, the customer's history (previous orders, returns, cancellations, total spent) and the timeline of changes with author and field diff. Example: { \"order\": \"NW-1042\" }.",
  input: getOrderInput,
  async run(rt, input) {
    const order = await resolveOrderRef(rt, input.order);
    const tx = rt.ctx.tx;
    // one connection per transaction: queries run one after the other
    const lines = await tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, order.id)).orderBy(asc(schema.orderLines.createdAt));
    const events = await tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, order.id)).orderBy(desc(schema.orderEvents.createdAt)).limit(30);
    const notes = await tx.select().from(schema.orderNotes).where(eq(schema.orderNotes.orderId, order.id)).orderBy(desc(schema.orderNotes.createdAt)).limit(10);
    const shipments = await tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id)).orderBy(asc(schema.shipments.createdAt));
    const returns = await tx.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, status: schema.returnRequests.status, reasonCode: schema.returnRequests.reasonCode, resolution: schema.returnRequests.resolution, requestedAt: schema.returnRequests.requestedAt }).from(schema.returnRequests).where(eq(schema.returnRequests.orderId, order.id));
    const history = await customerOrderHistory(rt.ctx, order.id);
    const names = await memberNames(rt, [order.assignedTo, ...events.map((e) => e.actorUserId), ...notes.map((n) => n.authorId)]);
    const tz = rt.tenant.timezone;
    const cur = order.currency;
    const actor = (e: (typeof events)[number]) => (e.actorUserId ? (names.get(e.actorUserId) ?? "former member") : e.actorType) + (e.actorType === "mcp" && typeof (e.metadata as Record<string, unknown>).mcpClient === "string" ? ` via ${(e.metadata as Record<string, unknown>).mcpClient}` : "");
    return {
      data: {
        timezone: tz,
        id: order.id,
        name: order.name,
        link: keelLink(rt, `/orders/${order.id}`),
        placedAt: localDateTime(order.placedAt, tz),
        status: order.status,
        statusReason: order.statusReason,
        statusSource: order.statusSource,
        holdReason: order.holdReason,
        cancelledAt: localDateTime(order.cancelledAt, tz),
        cancelReason: order.cancelReason,
        payment: { method: order.paymentMethod, status: order.paymentStatus, gateways: order.paymentGateways },
        currency: cur,
        totals: { subtotal: majorUnits(order.subtotalMinor, cur), discount: majorUnits(order.discountMinor, cur), shipping: majorUnits(order.shippingMinor, cur), tax: majorUnits(order.taxMinor, cur), total: majorUnits(order.totalMinor, cur), refunded: majorUnits(order.refundedMinor, cur) },
        customerName: order.customerName,
        email: order.email,
        phone: order.phone,
        shippingAddress: order.shippingAddress,
        channel: order.sourceChannel,
        tags: order.platformTags,
        note: order.note,
        assignedTo: order.assignedTo ? (names.get(order.assignedTo) ?? null) : null,
        lines: lines.map((l) => ({ title: l.title, variant: l.variantTitle, sku: l.sku, quantity: l.quantity, currentQuantity: l.currentQuantity, unitPrice: majorUnits(l.unitPriceMinor, cur), total: majorUnits(l.totalMinor, cur) })),
        shipments: shipments.map((s) => ({ status: s.status, carrier: s.carrier, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl, shippedAt: localDateTime(s.shippedAt, tz), deliveredAt: localDateTime(s.deliveredAt, tz), exception: s.exceptionReason })),
        returns: returns.map((r) => ({ number: `R-${r.number}`, status: r.status, reason: r.reasonCode, resolution: r.resolution, requestedAt: localDate(r.requestedAt, tz), link: keelLink(rt, `/returns/${r.id}`) })),
        notes: notes.map((n) => ({ author: n.authorId ? (names.get(n.authorId) ?? null) : null, at: localDateTime(n.createdAt, tz), body: n.body })),
        customerHistory: { identified: history.identified, ...history.stats, totalSpent: majorUnits(history.stats.totalSpentMinor, cur), totalSpentMinor: undefined, previousOrders: history.orders.slice(0, 5).map((h) => ({ name: h.name, placedAt: localDate(h.placedAt, tz), status: h.status, total: majorUnits(h.totalMinor, h.currency), matchedVia: h.matchedVia })) },
        timeline: events.map((e) => ({ at: localDateTime(e.createdAt, tz), type: e.type, by: actor(e), diff: e.diff, note: typeof (e.metadata as Record<string, unknown>).note === "string" ? (e.metadata as Record<string, unknown>).note : undefined })),
      },
    };
  },
};

/* ---------- customers ---------- */

const lookupCustomersInput = z.object({ query: search.describe("Name, email or phone"), country: z.string().length(2).optional().describe("ISO country code"), sort: z.enum(["last_order", "total_spent", "orders"]).default("last_order"), page, pageSize: pageSize() });
const lookupCustomers: KeelTool<typeof lookupCustomersInput> = {
  name: "lookup_customers",
  title: "Look up customers",
  page: "customers",
  ...read,
  description: "Finds customers by name, email or phone (or lists them by recency, value or frequency), with orders, total spent, average order value, last order, RFM tier and churn risk. Example: { \"query\": \"bianchi\" }. Use get_customer for one customer's orders and segments.",
  input: lookupCustomersInput,
  async run(rt, input) {
    const r = await listCustomers(rt.ctx, { q: sanitizeSearch(input.query) || undefined, country: input.country?.toUpperCase(), sort: input.sort, page: input.page, pageSize: input.pageSize });
    const cur = rt.tenant.currency;
    const tz = rt.tenant.timezone;
    return { data: { currency: cur, total: r.total, page: r.page, pageSize: r.pageSize, customers: r.rows.map((c) => ({ id: c.customerId, customerName: [c.firstName, c.lastName].filter(Boolean).join(" ") || null, email: c.email, phone: c.phone, city: c.city, country: c.country, orders: c.ordersCount, cancelled: c.cancelledCount, returns: c.returnsCount, totalSpent: majorUnits(c.totalSpentMinor, cur), averageOrderValue: majorUnits(c.aovMinor, cur), lastOrderAt: localDate(c.lastOrderAt, tz), rfmTier: c.tier, churnRisk: c.churnRisk, link: keelLink(rt, `/customers/${c.customerId}`) })) } };
  },
};

const getCustomerInput = z.object({ customerId: uuid.describe("Customer id from lookup_customers") });
const getCustomer: KeelTool<typeof getCustomerInput> = {
  name: "get_customer",
  title: "Customer profile and history",
  page: "customers",
  ...read,
  description: "One customer's profile and history: orders (latest 20) with status and total, returns, segments, RFM tier, and the purchase prediction (probability still active, expected next order, predicted value). Example: { \"customerId\": \"…\" }.",
  input: getCustomerInput,
  async run(rt, input) {
    const d = await customerDetail(rt.ctx, input.customerId);
    if (!d) throw new ToolError("not_found", "No such customer in this store.");
    const c = d.customer;
    const cur = rt.tenant.currency;
    const tz = rt.tenant.timezone;
    return {
      data: {
        id: c.customerId,
        link: keelLink(rt, `/customers/${c.customerId}`),
        customerName: [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
        email: c.email,
        phone: c.phone,
        city: c.city,
        country: c.country,
        acceptsMarketing: c.acceptsMarketing,
        tags: c.tags,
        currency: cur,
        orders: c.ordersCount,
        cancelled: c.cancelledCount,
        returns: d.returns,
        totalSpent: majorUnits(c.totalSpentMinor, cur),
        averageOrderValue: majorUnits(c.aovMinor, cur),
        firstOrderAt: localDate(c.firstOrderAt, tz),
        lastOrderAt: localDate(c.lastOrderAt, tz),
        rfmTier: c.tier,
        prediction: d.prediction ? { churnRisk: c.churnRisk, probabilityActive: c.pAlivePct === null || c.pAlivePct === undefined ? null : roundTo(c.pAlivePct / 100, 3), daysToNextOrder: c.daysToNextOrder, predictedValue365: majorUnits(c.predictedValueMinor, cur) } : null,
        segments: d.segments.map((s) => s.name),
        recentOrders: d.orders.slice(0, 20).map((o) => ({ name: o.name, placedAt: localDate(o.placedAt, tz), status: o.status, paymentMethod: o.paymentMethod, total: majorUnits(o.totalMinor, o.currency), link: keelLink(rt, `/orders/${o.id}`) })),
      },
    };
  },
};

/* ---------- products and stock ---------- */

const listProductsInput = z.object({ query: search.describe("Product title, SKU or product type"), risk: z.enum(["critical", "warning", "ok", "no_sales"]).optional().describe("Stock-out risk"), sort: z.enum(["days_of_cover", "velocity", "available"]).default("days_of_cover"), page, pageSize: pageSize() });
const listProducts: KeelTool<typeof listProductsInput> = {
  name: "list_products",
  title: "Products with stock, velocity and cover",
  page: "products",
  ...read,
  description: "Products with units available and incoming (open purchase orders), units sold in the store's velocity window, sales per day, days of cover, stock-out risk (critical, warning, ok, no_sales) and the suggested reorder quantity, with the variants most at risk. Example: { \"risk\": \"critical\" } or { \"query\": \"linen\" }.",
  input: listProductsInput,
  async run(rt, input) {
    const p = schema.products;
    const q = sanitizeSearch(input.query);
    const conds = [eq(p.tenantId, rt.ctx.tenantId), eq(p.isAncillary, false)];
    if (q) conds.push(or(ilike(p.title, `%${q}%`), ilike(p.productType, `%${q}%`), sql`exists (select 1 from product_variants v where v.product_id = ${p.id} and v.sku ilike ${"%" + q + "%"})`)!);
    const products = await rt.ctx.tx.select({ id: p.id, title: p.title, status: p.status, productType: p.productType }).from(p).where(and(...conds)).limit(1000);
    if (!products.length) return { data: { total: 0, page: input.page, pageSize: input.pageSize, products: [] } };
    const stock = await variantStock(rt.ctx, rt.tenant.settings, { productIds: products.map((x) => x.id) });
    const summary = summarizeByProduct(stock);
    const velocityOf = (id: string) => stock.filter((s) => s.productId === id).reduce((a, s) => a + s.velocityPerDay, 0);
    let rows = products.map((x) => ({ product: x, s: summary.get(x.id) }));
    if (input.risk) rows = rows.filter((r) => r.s?.risk === input.risk);
    const key = { days_of_cover: (r: (typeof rows)[number]) => r.s?.worstDaysOfCover ?? Number.MAX_SAFE_INTEGER, velocity: (r: (typeof rows)[number]) => -velocityOf(r.product.id), available: (r: (typeof rows)[number]) => r.s?.available ?? 0 }[input.sort];
    rows.sort((a, b) => key(a) - key(b));
    const slice = rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
    const cur = rt.tenant.currency;
    return {
      data: {
        currency: cur,
        velocityWindowDays: rt.tenant.settings.salesVelocityLookbackDays,
        total: rows.length,
        page: input.page,
        pageSize: input.pageSize,
        products: slice.map(({ product, s }) => {
          const variants = stock.filter((v) => v.productId === product.id);
          return {
            id: product.id,
            title: product.title,
            type: product.productType,
            status: product.status,
            variants: variants.length,
            available: s?.available ?? 0,
            incoming: s?.incoming ?? 0,
            unitsSold: s?.unitsSold ?? 0,
            salesPerDay: roundTo(velocityOf(product.id), 2),
            worstDaysOfCover: s?.worstDaysOfCover === null || s?.worstDaysOfCover === undefined ? null : Math.round(s.worstDaysOfCover),
            risk: s?.risk ?? "no_sales",
            suggestedReorder: s?.suggestedReorder ?? 0,
            price: variants.length ? majorUnits(Math.min(...variants.map((v) => v.priceMinor)), cur) : null,
            variantsAtRisk: [...variants].sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity)).slice(0, 5).map((v) => ({ variant: v.variantTitle, sku: v.sku, available: v.available, incoming: v.incoming, daysOfCover: v.daysOfCover === null ? null : Math.round(v.daysOfCover), risk: v.risk, suggestedReorder: v.suggestedReorder })),
            link: keelLink(rt, `/products/${product.id}`),
          };
        }),
      },
    };
  },
};

/* ---------- purchasing ---------- */

const INCOMING = ["sent", "confirmed", "in_transit", "partially_received"] as const;
const incomingInput = z.object({ status: z.array(z.enum(PURCHASE_ORDER_STATUSES)).max(7).optional().describe(`Default: incoming ones (${INCOMING.join(", ")})`), query: search.describe("PO number, supplier, SKU or product"), pageSize: pageSize() });
const listIncomingPurchaseOrders: KeelTool<typeof incomingInput> = {
  name: "list_incoming_purchase_orders",
  title: "Incoming purchase orders",
  page: "purchasing",
  ...read,
  description: "Purchase orders still to arrive (sent, confirmed, in transit, partially received) or with the statuses you pass: supplier, expected date, total, units ordered and received, the main lines and how many customer orders wait for them (backorders). Example: {} or { \"query\": \"linen\" }.",
  input: incomingInput,
  async run(rt, input) {
    const po = schema.purchaseOrders;
    const q = sanitizeSearch(input.query);
    const conds = [eq(po.tenantId, rt.ctx.tenantId), inArray(po.status, input.status?.length ? input.status : [...INCOMING])];
    if (q) conds.push(or(ilike(po.number, `%${q}%`), ilike(schema.suppliers.name, `%${q}%`), sql`exists (select 1 from purchase_order_lines l left join product_variants v on v.id = l.variant_id left join products p on p.id = v.product_id where l.purchase_order_id = ${po.id} and (v.sku ilike ${"%" + q + "%"} or p.title ilike ${"%" + q + "%"} or l.description ilike ${"%" + q + "%"}))`)!);
    const rows = await rt.ctx.tx
      .select({ id: po.id, number: po.number, status: po.status, supplier: schema.suppliers.name, expectedAt: po.expectedAt, orderedAt: po.orderedAt, totalMinor: po.totalMinor, currency: po.currency, units: sql<number>`(select coalesce(sum(l.quantity),0) from purchase_order_lines l where l.purchase_order_id = ${po.id})::int`, receivedUnits: sql<number>`(select coalesce(sum(l.received_quantity),0) from purchase_order_lines l where l.purchase_order_id = ${po.id})::int`, waitingOrders: sql<number>`(select count(distinct b.order_id) from backorders b join purchase_order_lines l on l.id = b.purchase_order_line_id where l.purchase_order_id = ${po.id} and b.status in ('pending','covered'))::int` })
      .from(po)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, po.supplierId))
      .where(and(...conds))
      .orderBy(asc(sql`coalesce(${po.expectedAt}, ${po.createdAt})`))
      .limit(input.pageSize);
    const lines = rows.length ? await rt.ctx.tx.select({ poId: schema.purchaseOrderLines.purchaseOrderId, quantity: schema.purchaseOrderLines.quantity, received: schema.purchaseOrderLines.receivedQuantity, description: schema.purchaseOrderLines.description, sku: schema.productVariants.sku, variant: schema.productVariants.title, product: schema.products.title }).from(schema.purchaseOrderLines).leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.purchaseOrderLines.variantId)).leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(inArray(schema.purchaseOrderLines.purchaseOrderId, rows.map((r) => r.id))) : [];
    const tz = rt.tenant.timezone;
    return { data: { timezone: tz, count: rows.length, purchaseOrders: rows.map((r) => ({ number: r.number, status: r.status, supplier: r.supplier, orderedAt: localDate(r.orderedAt, tz), expectedAt: localDate(r.expectedAt, tz), total: majorUnits(r.totalMinor, r.currency), currency: r.currency, unitsOrdered: r.units, unitsReceived: r.receivedUnits, customerOrdersWaiting: r.waitingOrders, lines: lines.filter((l) => l.poId === r.id).sort((a, b) => b.quantity - a.quantity).slice(0, 8).map((l) => ({ item: l.product ? `${l.product}${l.variant ? ` · ${l.variant}` : ""}` : l.description, sku: l.sku, quantity: l.quantity, received: l.received })), link: keelLink(rt, `/purchasing/${r.id}`) })) } };
  },
};

/* ---------- returns ---------- */

const listReturnsInput = z.object({ status: z.union([z.literal("open"), z.enum(RETURN_STATUSES)]).optional().describe("open = not closed yet, or one return status"), reason: z.string().max(60).optional().describe("Return reason code"), query: search.describe("Order name, customer name or email, or return number"), page, pageSize: pageSize() });
const listReturnsTool: KeelTool<typeof listReturnsInput> = {
  name: "list_returns",
  title: "Return requests",
  page: "returns",
  ...read,
  description: "Return requests with status, reason, resolution (refund, exchange, store credit), proposed and refunded amounts, the order and the customer, newest first. Example: { \"status\": \"open\" }. Use get_returns_summary for rates and reasons over a period.",
  input: listReturnsInput,
  async run(rt, input) {
    const r = await listReturns(rt.ctx, { status: input.status, reason: input.reason ? sanitizeSearch(input.reason, 60) : undefined, q: sanitizeSearch(input.query) || undefined, page: input.page, pageSize: input.pageSize });
    const tz = rt.tenant.timezone;
    return { data: { timezone: tz, total: r.total, page: r.page, pageSize: r.pageSize, countsByStatus: r.counts, returns: r.rows.map((x) => ({ number: `R-${x.number}`, status: x.status, reason: x.reasonCode, resolution: x.resolution, fault: x.fault, items: x.items, proposed: majorUnits(x.proposedAmountMinor, x.currency), refunded: majorUnits(x.refundedAmountMinor, x.currency), currency: x.currency, requestedAt: localDate(x.requestedAt, tz), closedAt: localDate(x.closedAt, tz), outOfWindow: x.outOfWindow, order: x.orderName, customerName: x.customerName, link: keelLink(rt, `/returns/${x.id}`) })) } };
  },
};

/* ---------- segments ---------- */

const listSegmentsInput = z.object({});
const listSegmentsTool: KeelTool<typeof listSegmentsInput> = {
  name: "list_segments",
  title: "Customer segments and size",
  page: "segments",
  ...read,
  description: "The store's customer segments with their current size (members) and when they were last evaluated; with the customer campaigns add-on, also the control group share and the treated/control split. Example: {}.",
  input: listSegmentsInput,
  async run(rt) {
    const segments = await listSegments(rt.ctx);
    const campaigns = rt.activeAddons.includes("addon.customer_campaigns");
    const counts = segments.length ? await rt.ctx.tx.select({ segmentId: schema.segmentMemberships.segmentId, members: sql<number>`count(*)::int`, holdout: sql<number>`count(*) filter (where ${schema.segmentMemberships.groupName} = 'holdout')::int` }).from(schema.segmentMemberships).where(and(eq(schema.segmentMemberships.tenantId, rt.ctx.tenantId), inArray(schema.segmentMemberships.segmentId, segments.map((s) => s.id)))).groupBy(schema.segmentMemberships.segmentId) : [];
    const by = new Map(counts.map((c) => [c.segmentId, c]));
    const tz = rt.tenant.timezone;
    return { data: { segments: segments.map((s) => ({ id: s.id, name: s.name, description: s.description, members: by.get(s.id)?.members ?? s.lastCount ?? 0, liveUpdates: s.liveUpdates, lastEvaluatedAt: localDateTime(s.lastEvaluatedAt, tz), ...(campaigns ? { controlGroupPercent: s.holdoutPercentage, controlGroupMembers: by.get(s.id)?.holdout ?? 0 } : {}), link: keelLink(rt, `/segments/${s.id}`) })) } };
  },
};

/* ---------- customer campaigns (add-on) ---------- */

const customerCampaignsInput = z.object({ limit: z.number().int().min(1).max(MCP_LIMITS.maxPageSize).default(10) });
const listCustomerCampaigns: KeelTool<typeof customerCampaignsInput> = {
  name: "list_customer_campaigns",
  title: "Customer campaigns and their measured effect",
  page: "customer_campaigns",
  module: "addon.customer_campaigns",
  ...read,
  description: "Email, SMS or WhatsApp campaigns sent to segments, with the treated and control groups and the measured effect (conversion of treated vs control, uplift, incremental revenue). Example: {}.",
  input: customerCampaignsInput,
  async run(rt, input) {
    const rows = (await listRetentionCampaigns(rt.ctx, rt.tenant)).slice(0, input.limit);
    const tz = rt.tenant.timezone;
    return { data: { currency: rt.tenant.currency, campaigns: rows.map((c) => ({ name: c.name, segment: c.segmentName, channel: c.channel, status: c.status, sentAt: localDate(c.sentAt, tz), treated: c.treatedCount, control: c.holdoutCount, results: c.results, link: keelLink(rt, `/segments/campaigns/${c.id}`) })) } };
  },
};

/* ---------- integrations ---------- */

const healthInput = z.object({});
const getIntegrationHealth: KeelTool<typeof healthInput> = {
  name: "get_integration_health",
  title: "Integration health",
  page: "integrations",
  ...read,
  description: "Status of the store's connections (Shopify, Meta, Google, …): connected or not, mock or live, last successful sync, last error in plain words, freshness of each data source, and failed or pending webhooks. Example: {}.",
  input: healthInput,
  async run(rt) {
    const o = await integrationOverview(rt.ctx);
    const tz = rt.tenant.timezone;
    return { data: { timezone: tz, integrations: o.integrations.map((i) => ({ provider: i.provider, status: i.status, mode: i.mode, account: i.externalAccountName, lastSuccessAt: localDateTime(i.lastSuccessAt, tz), lastError: i.lastError })), sources: o.health.map((h) => ({ source: h.source, status: h.status, lastSuccessAt: localDateTime(h.lastSuccessAt, tz), consecutiveFailures: h.consecutiveFailures, freshnessMinutes: h.freshnessMinutes, lastError: h.lastError })), webhooks: o.webhookCounts, link: keelLink(rt, "/integrations") } };
  },
};

export const MCP_READ_TOOLS: readonly KeelTool[] = [searchOrders, getOrder, lookupCustomers, getCustomer, listProducts, listIncomingPurchaseOrders, listReturnsTool, listSegmentsTool, listCustomerCampaigns, getIntegrationHealth] as unknown as KeelTool[];



import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, or, recordAudit, schema, sql, type SQL } from "@hullwise/db";
import { API_LIMITS, WEBHOOK_EVENT_TYPES, type ActionKey, type ApiScope, type PageKey } from "@hullwise/config";
import { ADJUSTMENT_REASONS, MCP_ORDER_TRANSITIONS, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, canMcpSetOrderStatus, decodeCursor, encodeCursor, pageOf, sanitizeFreeText, sanitizeSearch, type ApiErrorCode, type OrderStatus, type WebhookUrlPolicy } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { orderListWhere } from "../lists/filters";
import { addOrderNote } from "../orders/notes";
import { setManualStatus } from "../orders/state";
import { adjustStock } from "../inventory/control";
import type { PlatformWriteRow } from "../writes";
import { createWebhookEndpoint, deleteWebhookEndpoint, listWebhookEndpoints } from "../webhooks/endpoints";
import type { ApiPrincipal } from "./auth";
import { serializeCustomer, serializeDiscount, serializeInventoryLevel, serializeOrder, serializeOrderEvent, serializeOrderLine, serializeProduct, serializePurchaseOrder, serializePurchaseOrderLine, serializeReturn, serializeShipment, serializeVariant } from "./serialize";

/**
 * Route registry of the public REST API (#81). Each route declares its method, path, scope, the
 * page (reads) or action (writes) the token's person needs, its query and body schemas (zod) and
 * runs inside the token's tenant transaction. The router, the docs page and the docs coverage test
 * all read this list, so a route cannot exist without its documentation.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRuntime {
  ctx: ServiceContext;
  principal: ApiPrincipal;
  /** Platform writes the request enqueued: the caller dispatches them once the transaction commits. */
  platformWrites: PlatformWriteRow[];
  webhookPolicy: WebhookUrlPolicy;
  resolveHost?: (host: string) => Promise<string[] | null>;
}

type QueryShape = Record<string, z.ZodType<unknown, string | undefined>>;
type Infer<S> = S extends Record<string, z.ZodType> ? { [K in keyof S]: z.output<S[K]> } : Record<string, never>;

export interface ApiRoute<Q extends QueryShape | undefined = QueryShape | undefined, B extends z.ZodType | undefined = z.ZodType | undefined> {
  /** Stable id, letters and underscores: the docs message key (`api_docs.routes.items.<id>`). */
  id: string;
  method: "GET" | "POST" | "DELETE";
  /** `/v1/orders/{id}`: served at `apiEndpoint(path)`. */
  path: string;
  /** null: any valid token (`/v1/me`). */
  scope: ApiScope | null;
  /** Reads: the page the person must be able to view. */
  page: PageKey | null;
  /** Writes: the permission matrix action (else write access to `page`). */
  action?: ActionKey;
  /** Query parameters (strings in, parsed values out); paginated routes add `limit` and `cursor`. */
  query?: Q;
  body?: B;
  paginated?: boolean;
  /** Writes accept `Idempotency-Key`. */
  write?: boolean;
  status?: number;
  run(rt: ApiRuntime, input: { params: Record<string, string>; query: Infer<Q>; body: B extends z.ZodType ? z.output<B> : undefined; limit: number; cursor: string | null }): Promise<unknown>;
}

function route<Q extends QueryShape | undefined, B extends z.ZodType | undefined>(r: ApiRoute<Q, B>): ApiRoute {
  return r as unknown as ApiRoute;
}

/* ---------- parameter schemas ---------- */

const text = (max = 200) => z.string().trim().max(max).optional();
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(500)
    .optional()
    .transform((v, c) => {
      if (!v) return undefined;
      const items = v.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = items.filter((s) => !(values as readonly string[]).includes(s));
      if (bad.length) c.addIssue({ code: "custom", message: `unknown value: ${bad.slice(0, 3).join(", ")}` });
      return items as T[number][];
    });
const uuidParam = z.string().uuid().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional();
const timestampParam = z
  .string()
  .max(40)
  .optional()
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "expected an ISO 8601 date-time")
  .transform((v) => (v ? new Date(v) : undefined));
const bool = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true"));

const isUuid = (v: string | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v ?? "");
const notFound = (what: string) => new ApiError("not_found", `No ${what} with this id in this store.`);
function idParam(params: Record<string, string>, what: string): string {
  const id = params.id ?? "";
  if (!isUuid(id)) throw notFound(what);
  return id;
}

/* ---------- keyset pagination ---------- */

type Col = Parameters<typeof eq>[0];

/** `(created_at, id) < cursor` for newest-first lists; the timestamp travels as Postgres text (microseconds kept). */
function after(list: string, cursor: string | null, ts: Col, id: Col): SQL | undefined {
  if (!cursor) return undefined;
  const k = decodeCursor(list, cursor, 2);
  if (!k || typeof k[0] !== "string" || typeof k[1] !== "string" || !isUuid(k[1])) throw new ApiError("invalid_cursor", "The cursor is not valid for this list (use nextCursor from the previous page, with the same filters).");
  return sql`(${ts}, ${id}) < (${k[0]}::timestamptz, ${k[1]}::uuid)`;
}

function listOf<T extends { key: string; id: string }, R>(list: string, rows: T[], limit: number, map: (r: T) => R) {
  const p = pageOf(rows, limit, (r) => encodeCursor(list, [r.key, r.id]));
  return { object: "list" as const, data: p.data.map(map), hasMore: p.hasMore, nextCursor: p.nextCursor };
}

const since = (col: Col, d: Date | undefined) => (d ? gte(col, d) : undefined);

/* ---------- write metadata ---------- */

function apiMeta(rt: ApiRuntime): Record<string, unknown> {
  return { apiTokenId: rt.principal.tokenId, apiClient: rt.principal.tokenName };
}
function audit(rt: ApiRuntime, input: { action: string; entityType: string; entityId: string; diff: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  return recordAudit(rt.ctx.tx, { tenantId: rt.ctx.tenantId, actorUserId: rt.principal.userId, actorType: "api", action: input.action, entityType: input.entityType, entityId: input.entityId, diff: input.diff, metadata: { ...(input.metadata ?? {}), ...apiMeta(rt) } });
}

async function loadOrder(rt: ApiRuntime, params: Record<string, string>) {
  const id = idParam(params, "order");
  const [o] = await rt.ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, rt.ctx.tenantId), eq(schema.orders.id, id))).limit(1);
  if (!o) throw notFound("order");
  return o;
}

/* ---------- routes ---------- */

const me = route({
  id: "me",
  method: "GET",
  path: "/v1/me",
  scope: null,
  page: null,
  async run(rt) {
    const p = rt.principal;
    return { object: "token", token: { id: p.tokenId, name: p.tokenName, scopes: p.scopes }, user: { id: p.userId, role: p.role }, tenant: { id: p.tenant.id, slug: p.tenant.slug, name: p.tenant.name, country: p.tenant.country, currency: p.tenant.currency, timezone: p.tenant.timezone }, pii: p.pii, rateLimits: { perTokenPerMinute: API_LIMITS.perTokenPerMinute, perTenantPerMinute: API_LIMITS.perTenantPerMinute } };
  },
});

const ordersQuery = { q: text(80), status: csv(ORDER_STATUSES), paymentMethod: csv(PAYMENT_METHODS), paymentStatus: csv(PAYMENT_STATUSES), channel: text(60), tag: text(80), customerId: uuidParam, from: day, to: day, updatedSince: timestampParam };
const listOrders = route({
  id: "orders_list",
  method: "GET",
  path: "/v1/orders",
  scope: "orders:read",
  page: "orders",
  query: ordersQuery,
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const o = schema.orders;
    const where = orderListWhere({ tenantId: rt.ctx.tenantId, userId: rt.principal.userId, orderNumberPrefix: rt.principal.tenant.orderNumberPrefix, country: rt.principal.tenant.country }, { q: sanitizeSearch(query.q) || undefined, status: query.status, payment: query.paymentMethod, paymentStatus: query.paymentStatus, channel: query.channel ? [query.channel] : undefined, tag: query.tag, customer: query.customerId, from: query.from, to: query.to });
    const rows = await rt.ctx.tx.select({ row: o, id: o.id, key: sql<string>`${o.placedAt}::text` }).from(o).where(and(where, since(o.updatedAt, query.updatedSince), after("orders", cursor, o.placedAt, o.id))).orderBy(desc(o.placedAt), desc(o.id)).limit(limit + 1);
    return listOf("orders", rows, limit, (r) => serializeOrder(r.row));
  },
});

const getOrder = route({
  id: "orders_get",
  method: "GET",
  path: "/v1/orders/{id}",
  scope: "orders:read",
  page: "orders",
  async run(rt, { params }) {
    const o = await loadOrder(rt, params);
    const lines = await rt.ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, rt.ctx.tenantId), eq(schema.orderLines.orderId, o.id))).orderBy(asc(schema.orderLines.createdAt));
    return { ...serializeOrder(o), lines: lines.map(serializeOrderLine) };
  },
});

const orderEvents = route({
  id: "orders_events",
  method: "GET",
  path: "/v1/orders/{id}/events",
  scope: "orders:read",
  page: "orders",
  paginated: true,
  async run(rt, { params, limit, cursor }) {
    const o = await loadOrder(rt, params);
    const e = schema.orderEvents;
    const rows = await rt.ctx.tx.select({ row: e, id: e.id, key: sql<string>`${e.createdAt}::text` }).from(e).where(and(eq(e.tenantId, rt.ctx.tenantId), eq(e.orderId, o.id), after("order_events", cursor, e.createdAt, e.id))).orderBy(desc(e.createdAt), desc(e.id)).limit(limit + 1);
    return listOf("order_events", rows, limit, (r) => serializeOrderEvent(r.row, rt.principal.pii === "full" ? "include" : "omit"));
  },
});

const addNote = route({
  id: "orders_notes_create",
  method: "POST",
  path: "/v1/orders/{id}/notes",
  scope: "orders:write",
  page: "orders",
  action: "add_note",
  write: true,
  status: 201,
  body: z.object({ body: z.string().min(1).max(4000) }).strict(),
  async run(rt, { params, body }) {
    const o = await loadOrder(rt, params);
    const text = sanitizeFreeText(body.body, 4000);
    if (!text) throw new ApiError("unprocessable", "The note is empty.");
    const r = await addOrderNote(rt.ctx, { orderId: o.id, body: text, allowedMentionIds: [], link: `/t/${rt.principal.tenant.slug}/orders/${o.id}`, orderName: o.name, authorName: rt.principal.tokenName, eventMetadata: apiMeta(rt) });
    await audit(rt, { action: "order.note_added", entityType: "order", entityId: o.id, diff: { noteId: { from: null, to: r.noteId } }, metadata: { length: text.length } });
    return { object: "order_note", id: r.noteId, orderId: o.id, createdAt: (rt.ctx.now ?? new Date()).toISOString() };
  },
});

const STATUS_TARGETS = [...new Set(Object.values(MCP_ORDER_TRANSITIONS).flat())] as [OrderStatus, ...OrderStatus[]];
const setStatus = route({
  id: "orders_status_update",
  method: "POST",
  path: "/v1/orders/{id}/status",
  scope: "orders:write",
  page: "orders",
  action: "change_order_state",
  write: true,
  body: z.object({ status: z.enum(STATUS_TARGETS), note: z.string().max(500).optional() }).strict(),
  async run(rt, { params, body }) {
    const o = await loadOrder(rt, params);
    if (!canMcpSetOrderStatus(o.status, body.status)) throw new ApiError("conflict", `The order is ${o.status}; through the API it can move to: ${(MCP_ORDER_TRANSITIONS[o.status as OrderStatus] ?? []).join(", ") || "nothing"}. Cancelling and refunding stay in the app.`, { status: o.status, allowed: MCP_ORDER_TRANSITIONS[o.status as OrderStatus] ?? [] });
    const note = sanitizeFreeText(body.note ?? "", 500) || undefined;
    const r = await setManualStatus(rt.ctx, o.id, body.status, note, { eventMetadata: apiMeta(rt) });
    await audit(rt, { action: "order.status_changed", entityType: "order", entityId: o.id, diff: { status: { from: r.previous, to: r.next } }, metadata: { note: note ?? null } });
    const [fresh] = await rt.ctx.tx.select().from(schema.orders).where(eq(schema.orders.id, o.id)).limit(1);
    return { ...serializeOrder(fresh!), previousStatus: r.previous, requestedStatus: body.status };
  },
});

const listCustomers = route({
  id: "customers_list",
  method: "GET",
  path: "/v1/customers",
  scope: "customers:read",
  page: "customers",
  query: { q: text(80), country: z.string().regex(/^[A-Za-z]{2}$/).optional(), acceptsMarketing: bool, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const c = schema.customers;
    const q = sanitizeSearch(query.q);
    const like = `%${q.toLowerCase()}%`;
    const rows = await rt.ctx.tx
      .select({ row: c, id: c.id, key: sql<string>`${c.createdAt}::text` })
      .from(c)
      .where(and(eq(c.tenantId, rt.ctx.tenantId), q ? or(ilike(c.emailNormalized, like), ilike(c.firstName, like), ilike(c.lastName, like), eq(c.externalId, q)) : undefined, query.country ? eq(c.country, query.country.toUpperCase()) : undefined, query.acceptsMarketing === undefined ? undefined : eq(c.acceptsMarketing, query.acceptsMarketing), since(c.updatedAt, query.updatedSince), after("customers", cursor, c.createdAt, c.id)))
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(limit + 1);
    return listOf("customers", rows, limit, (r) => serializeCustomer(r.row));
  },
});

const getCustomer = route({
  id: "customers_get",
  method: "GET",
  path: "/v1/customers/{id}",
  scope: "customers:read",
  page: "customers",
  async run(rt, { params }) {
    const id = idParam(params, "customer");
    const [c] = await rt.ctx.tx.select().from(schema.customers).where(and(eq(schema.customers.tenantId, rt.ctx.tenantId), eq(schema.customers.id, id))).limit(1);
    if (!c) throw notFound("customer");
    return serializeCustomer(c);
  },
});

async function variantsOf(rt: ApiRuntime, productIds: string[]) {
  if (!productIds.length) return [];
  return rt.ctx.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, rt.ctx.tenantId), inArray(schema.productVariants.productId, productIds))).orderBy(asc(schema.productVariants.createdAt), asc(schema.productVariants.id));
}

const listProducts = route({
  id: "products_list",
  method: "GET",
  path: "/v1/products",
  scope: "products:read",
  page: "products",
  query: { q: text(80), status: z.enum(["active", "draft", "archived"]).optional(), productType: text(120), updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const p = schema.products;
    const q = sanitizeSearch(query.q);
    const rows = await rt.ctx.tx
      .select({ row: p, id: p.id, key: sql<string>`${p.createdAt}::text` })
      .from(p)
      .where(and(eq(p.tenantId, rt.ctx.tenantId), q ? sql`(${p.title} ilike ${`%${q}%`} or exists (select 1 from product_variants v where v.product_id = ${p.id} and v.sku ilike ${`%${q}%`}))` : undefined, query.status ? eq(p.status, query.status) : undefined, query.productType ? eq(p.productType, query.productType) : undefined, since(p.updatedAt, query.updatedSince), after("products", cursor, p.createdAt, p.id)))
      .orderBy(desc(p.createdAt), desc(p.id))
      .limit(limit + 1);
    const variants = await variantsOf(rt, rows.slice(0, limit).map((r) => r.id));
    return listOf("products", rows, limit, (r) => serializeProduct(r.row, variants.filter((v) => v.productId === r.id)));
  },
});

const getProduct = route({
  id: "products_get",
  method: "GET",
  path: "/v1/products/{id}",
  scope: "products:read",
  page: "products",
  async run(rt, { params }) {
    const id = idParam(params, "product");
    const [p] = await rt.ctx.tx.select().from(schema.products).where(and(eq(schema.products.tenantId, rt.ctx.tenantId), eq(schema.products.id, id))).limit(1);
    if (!p) throw notFound("product");
    return serializeProduct(p, await variantsOf(rt, [p.id]));
  },
});

const listVariants = route({
  id: "variants_list",
  method: "GET",
  path: "/v1/variants",
  scope: "products:read",
  page: "products",
  query: { sku: text(80), barcode: text(80), productId: uuidParam, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const v = schema.productVariants;
    const rows = await rt.ctx.tx
      .select({ row: v, id: v.id, key: sql<string>`${v.createdAt}::text` })
      .from(v)
      .where(and(eq(v.tenantId, rt.ctx.tenantId), query.sku ? eq(v.sku, query.sku) : undefined, query.barcode ? eq(v.barcode, query.barcode) : undefined, query.productId ? eq(v.productId, query.productId) : undefined, since(v.updatedAt, query.updatedSince), after("variants", cursor, v.createdAt, v.id)))
      .orderBy(desc(v.createdAt), desc(v.id))
      .limit(limit + 1);
    return listOf("variants", rows, limit, (r) => serializeVariant(r.row));
  },
});

const listLocations = route({
  id: "locations_list",
  method: "GET",
  path: "/v1/locations",
  scope: "inventory:read",
  page: "inventory",
  paginated: true,
  async run(rt, { limit, cursor }) {
    const l = schema.locations;
    const rows = await rt.ctx.tx.select({ row: l, id: l.id, key: sql<string>`${l.createdAt}::text` }).from(l).where(and(eq(l.tenantId, rt.ctx.tenantId), after("locations", cursor, l.createdAt, l.id))).orderBy(desc(l.createdAt), desc(l.id)).limit(limit + 1);
    return listOf("locations", rows, limit, (r) => ({ id: r.row.id, object: "location", externalId: r.row.externalId, name: r.row.name, country: r.row.country, isDefault: r.row.isDefault, isActive: r.row.isActive }));
  },
});

const listInventory = route({
  id: "inventory_list",
  method: "GET",
  path: "/v1/inventory-levels",
  scope: "inventory:read",
  page: "inventory",
  query: { variantId: uuidParam, locationId: uuidParam, sku: text(80), updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const l = schema.inventoryLevels;
    let afterId: SQL | undefined;
    if (cursor) {
      const k = decodeCursor("inventory_levels", cursor, 1);
      if (!k || typeof k[0] !== "string" || !isUuid(k[0])) throw new ApiError("invalid_cursor", "The cursor is not valid for this list (use nextCursor from the previous page, with the same filters).");
      afterId = sql`${l.id} > ${k[0]}::uuid`;
    }
    // levels have no creation date: pages follow the id
    const rows = await rt.ctx.tx
      .select({ row: l, sku: schema.productVariants.sku, locationName: schema.locations.name })
      .from(l)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, l.variantId))
      .innerJoin(schema.locations, eq(schema.locations.id, l.locationId))
      .where(and(eq(l.tenantId, rt.ctx.tenantId), query.variantId ? eq(l.variantId, query.variantId) : undefined, query.locationId ? eq(l.locationId, query.locationId) : undefined, query.sku ? eq(schema.productVariants.sku, query.sku) : undefined, since(l.updatedAt, query.updatedSince), afterId))
      .orderBy(asc(l.id))
      .limit(limit + 1);
    const p = pageOf(rows, limit, (r) => encodeCursor("inventory_levels", [r.row.id]));
    return { object: "list" as const, data: p.data.map((r) => serializeInventoryLevel(r.row, { sku: r.sku, locationName: r.locationName })), hasMore: p.hasMore, nextCursor: p.nextCursor };
  },
});

const adjustInventory = route({
  id: "inventory_adjust",
  method: "POST",
  path: "/v1/inventory-levels/adjust",
  scope: "inventory:write",
  page: "inventory",
  write: true,
  body: z.object({ variantId: z.string().uuid(), locationId: z.string().uuid(), delta: z.number().int().min(-1_000_000).max(1_000_000), reason: z.enum(ADJUSTMENT_REASONS), note: z.string().max(500).optional() }).strict(),
  async run(rt, { body }) {
    const r = await adjustStock(rt.ctx, { variantId: body.variantId, locationId: body.locationId, delta: body.delta, reason: body.reason, note: body.note ? sanitizeFreeText(body.note, 500) : null }, { audit: { actorUserId: rt.principal.userId, actorType: "api", impersonatedBy: null } });
    rt.platformWrites.push(...[r.write, ...r.coverage.writes].filter((w): w is PlatformWriteRow => Boolean(w)));
    return { object: "inventory_adjustment", movementId: r.movementId, variantId: body.variantId, locationId: body.locationId, before: r.before, after: r.after, releasedOrders: r.coverage.releasedOrders.length };
  },
});

const listShipments = route({
  id: "shipments_list",
  method: "GET",
  path: "/v1/shipments",
  scope: "shipments:read",
  page: "shipments",
  query: { status: text(40), orderId: uuidParam, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const s = schema.shipments;
    const rows = await rt.ctx.tx.select({ row: s, id: s.id, key: sql<string>`${s.createdAt}::text` }).from(s).where(and(eq(s.tenantId, rt.ctx.tenantId), query.status ? eq(s.status, query.status) : undefined, query.orderId ? eq(s.orderId, query.orderId) : undefined, since(s.updatedAt, query.updatedSince), after("shipments", cursor, s.createdAt, s.id))).orderBy(desc(s.createdAt), desc(s.id)).limit(limit + 1);
    return listOf("shipments", rows, limit, (r) => serializeShipment(r.row));
  },
});

const getShipment = route({
  id: "shipments_get",
  method: "GET",
  path: "/v1/shipments/{id}",
  scope: "shipments:read",
  page: "shipments",
  async run(rt, { params }) {
    const id = idParam(params, "shipment");
    const [s] = await rt.ctx.tx.select().from(schema.shipments).where(and(eq(schema.shipments.tenantId, rt.ctx.tenantId), eq(schema.shipments.id, id))).limit(1);
    if (!s) throw notFound("shipment");
    const events = await rt.ctx.tx.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.tenantId, rt.ctx.tenantId), eq(schema.shipmentEvents.shipmentId, s.id))).orderBy(desc(schema.shipmentEvents.occurredAt)).limit(100);
    return { ...serializeShipment(s), events: events.map((e) => ({ id: e.id, source: e.source, status: e.status, description: e.description, location: e.location, occurredAt: e.occurredAt.toISOString() })) };
  },
});

const listReturns = route({
  id: "returns_list",
  method: "GET",
  path: "/v1/returns",
  scope: "returns:read",
  page: "returns",
  query: { status: text(40), orderId: uuidParam, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const r = schema.returnRequests;
    const rows = await rt.ctx.tx.select({ row: r, id: r.id, key: sql<string>`${r.createdAt}::text` }).from(r).where(and(eq(r.tenantId, rt.ctx.tenantId), query.status ? eq(r.status, query.status) : undefined, query.orderId ? eq(r.orderId, query.orderId) : undefined, since(r.updatedAt, query.updatedSince), after("returns", cursor, r.createdAt, r.id))).orderBy(desc(r.createdAt), desc(r.id)).limit(limit + 1);
    return listOf("returns", rows, limit, (x) => serializeReturn(x.row));
  },
});

const getReturn = route({
  id: "returns_get",
  method: "GET",
  path: "/v1/returns/{id}",
  scope: "returns:read",
  page: "returns",
  async run(rt, { params }) {
    const id = idParam(params, "return");
    const [r] = await rt.ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, rt.ctx.tenantId), eq(schema.returnRequests.id, id))).limit(1);
    if (!r) throw notFound("return");
    const lines = await rt.ctx.tx.select({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, inspectionOutcome: schema.returnLines.inspectionOutcome, restocked: schema.returnLines.restocked }).from(schema.returnLines).where(and(eq(schema.returnLines.tenantId, rt.ctx.tenantId), eq(schema.returnLines.returnId, r.id)));
    return { ...serializeReturn(r), lines };
  },
});

const listDiscounts = route({
  id: "discounts_list",
  method: "GET",
  path: "/v1/discounts",
  scope: "discounts:read",
  page: "discounts",
  query: { code: text(80), active: bool, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const d = schema.discounts;
    const rows = await rt.ctx.tx.select({ row: d, id: d.id, key: sql<string>`${d.createdAt}::text` }).from(d).where(and(eq(d.tenantId, rt.ctx.tenantId), query.code ? eq(sql`lower(${d.code})`, query.code.toLowerCase()) : undefined, query.active === undefined ? undefined : eq(d.isActive, query.active), since(d.updatedAt, query.updatedSince), after("discounts", cursor, d.createdAt, d.id))).orderBy(desc(d.createdAt), desc(d.id)).limit(limit + 1);
    return listOf("discounts", rows, limit, (r) => serializeDiscount(r.row));
  },
});

const getDiscount = route({
  id: "discounts_get",
  method: "GET",
  path: "/v1/discounts/{id}",
  scope: "discounts:read",
  page: "discounts",
  async run(rt, { params }) {
    const id = idParam(params, "discount");
    const [d] = await rt.ctx.tx.select().from(schema.discounts).where(and(eq(schema.discounts.tenantId, rt.ctx.tenantId), eq(schema.discounts.id, id))).limit(1);
    if (!d) throw notFound("discount");
    return serializeDiscount(d);
  },
});

const listPurchaseOrders = route({
  id: "purchase_orders_list",
  method: "GET",
  path: "/v1/purchase-orders",
  scope: "purchasing:read",
  page: "purchasing",
  query: { status: text(40), supplierId: uuidParam, updatedSince: timestampParam },
  paginated: true,
  async run(rt, { query, limit, cursor }) {
    const p = schema.purchaseOrders;
    const rows = await rt.ctx.tx.select({ row: p, id: p.id, key: sql<string>`${p.createdAt}::text`, supplierName: schema.suppliers.name }).from(p).leftJoin(schema.suppliers, eq(schema.suppliers.id, p.supplierId)).where(and(eq(p.tenantId, rt.ctx.tenantId), query.status ? eq(p.status, query.status) : undefined, query.supplierId ? eq(p.supplierId, query.supplierId) : undefined, since(p.updatedAt, query.updatedSince), after("purchase_orders", cursor, p.createdAt, p.id))).orderBy(desc(p.createdAt), desc(p.id)).limit(limit + 1);
    return listOf("purchase_orders", rows, limit, (r) => serializePurchaseOrder(r.row, { supplierName: r.supplierName }));
  },
});

const getPurchaseOrder = route({
  id: "purchase_orders_get",
  method: "GET",
  path: "/v1/purchase-orders/{id}",
  scope: "purchasing:read",
  page: "purchasing",
  async run(rt, { params }) {
    const id = idParam(params, "purchase order");
    const [row] = await rt.ctx.tx.select({ po: schema.purchaseOrders, supplierName: schema.suppliers.name }).from(schema.purchaseOrders).leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId)).where(and(eq(schema.purchaseOrders.tenantId, rt.ctx.tenantId), eq(schema.purchaseOrders.id, id))).limit(1);
    if (!row) throw notFound("purchase order");
    const lines = await rt.ctx.tx.select().from(schema.purchaseOrderLines).where(and(eq(schema.purchaseOrderLines.tenantId, rt.ctx.tenantId), eq(schema.purchaseOrderLines.purchaseOrderId, id))).orderBy(asc(schema.purchaseOrderLines.createdAt));
    return { ...serializePurchaseOrder(row.po, { supplierName: row.supplierName }), lines: lines.map(serializePurchaseOrderLine) };
  },
});

const endpointView = (e: Awaited<ReturnType<typeof listWebhookEndpoints>>[number] | Omit<Awaited<ReturnType<typeof listWebhookEndpoints>>[number], "succeeded24h" | "failed24h">) => ({ id: e.id, object: "webhook_endpoint", url: e.url, description: e.description, eventTypes: e.eventTypes, isActive: e.isActive, secretPrefix: e.secretPrefix, createdAt: e.createdAt.toISOString(), lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null, lastFailureAt: e.lastFailureAt?.toISOString() ?? null });

const listEndpoints = route({
  id: "webhook_endpoints_list",
  method: "GET",
  path: "/v1/webhook-endpoints",
  scope: "webhooks:manage",
  page: "integrations",
  action: "manage_integrations",
  async run(rt) {
    const rows = await listWebhookEndpoints(rt.ctx);
    return { object: "list", data: rows.map(endpointView), hasMore: false, nextCursor: null };
  },
});

const createEndpoint = route({
  id: "webhook_endpoints_create",
  method: "POST",
  path: "/v1/webhook-endpoints",
  scope: "webhooks:manage",
  page: "integrations",
  action: "manage_integrations",
  write: true,
  status: 201,
  body: z.object({ url: z.string().min(1).max(2000), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length), description: z.string().max(200).optional() }).strict(),
  async run(rt, { body }) {
    const r = await createWebhookEndpoint(rt.ctx, body, { policy: rt.webhookPolicy, resolve: rt.resolveHost, audit: { actorUserId: rt.principal.userId, actorType: "api", impersonatedBy: null }, auditMetadata: apiMeta(rt) });
    return { ...endpointView(r.endpoint), secret: r.secret };
  },
});

const deleteEndpoint = route({
  id: "webhook_endpoints_delete",
  method: "DELETE",
  path: "/v1/webhook-endpoints/{id}",
  scope: "webhooks:manage",
  page: "integrations",
  action: "manage_integrations",
  write: true,
  async run(rt, { params }) {
    const id = idParam(params, "webhook endpoint");
    await deleteWebhookEndpoint(rt.ctx, id, { audit: { actorUserId: rt.principal.userId, actorType: "api", impersonatedBy: null }, auditMetadata: apiMeta(rt) });
    return { object: "webhook_endpoint", id, deleted: true };
  },
});

/** Every route of the API, in documentation order. */
export const API_ROUTES: readonly ApiRoute[] = [me, listOrders, getOrder, orderEvents, addNote, setStatus, listCustomers, getCustomer, listProducts, getProduct, listVariants, listLocations, listInventory, adjustInventory, listShipments, getShipment, listReturns, getReturn, listDiscounts, getDiscount, listPurchaseOrders, getPurchaseOrder, listEndpoints, createEndpoint, deleteEndpoint];

/** Matches a concrete path (`/v1/orders/abc`) to a route pattern; null when no pattern fits. */
export function matchApiPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.replace(/\/+$/, "").split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const m = /^\{(\w+)\}$/.exec(a[i]!);
    if (m) {
      if (!b[i]) return null;
      params[m[1]!] = decodeURIComponent(b[i]!);
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** Route metadata for the docs page: query parameter names (with `limit`/`cursor` for lists) and body fields. */
export function apiRouteCatalog() {
  return API_ROUTES.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    scope: r.scope,
    write: Boolean(r.write),
    paginated: Boolean(r.paginated),
    query: [...Object.keys(r.query ?? {}), ...(r.paginated ? ["limit", "cursor"] : [])],
    body: r.body instanceof z.ZodObject ? Object.keys((r.body as z.ZodObject).shape) : [],
  }));
}

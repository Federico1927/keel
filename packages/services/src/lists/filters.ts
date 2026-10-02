import { and, eq, gte, inArray, lte, or, schema, sql, type SQL } from "@hullwise/db";
import { CHURN_RISKS, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, UTM_DIMENSIONS, UTM_NONE, parseSearchTerms, type QueryParams, type UtmDimension } from "@hullwise/core";
import type { CustomerFilters } from "../crm";
import type { ReturnFilters } from "../returns";
import { awaitingStockSql, readyToReleaseSql } from "../backorders";
import { landingPathSql } from "../traffic";

/**
 * List filters parsed from the URL query, shared by the list pages, the CSV export (direct and in
 * the background) and saved views, so a view or an export always means exactly what the page shows.
 */
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);
const isUuid = (v: string | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v ?? "");

/* ---------- orders ---------- */

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
  /** Orders with at least one line of this product / variant (drill-down from the product page and product performance). */
  product?: string;
  variant?: string;
  /** Orders with at least one product line without a cost (the P/L warning links here). */
  missingCost?: boolean;
  /** Attribution channel and UTM values (analytics drill-down); "(none)" matches orders without the value. */
  attrChannel?: string;
  utm?: Partial<Record<UtmDimension, string>>;
  /** Landing path of the order's first visit, normalised like GA4 rows (`normalizeLandingPath`): conversion by landing page (#86). */
  landing?: string;
  /** Backorder views: orders waiting for stock, or ready to release (stock covers them / released, not shipped yet). */
  stock?: OrderStockView;
  /** Shipping country (tax report drill-down). */
  country?: string;
  /** Payment fee from a payout (`actual`) or still the tenant's estimate (`estimated`): P/L and payment-method drill-downs. */
  feeSource?: OrderFeeSource;
  /** Orders with a balance transaction in this payout (payouts page drill-down). */
  payout?: string;
  /** addon.subscriptions (#67): orders created by a subscription (any, first orders, renewals) or by one contract. */
  subscription?: OrderSubscriptionView;
  subscriptionContract?: string;
  sort?: "placed_desc" | "placed_asc" | "total_desc";
  page?: number;
}

export const ORDER_FEE_SOURCES = ["actual", "estimated"] as const;
export type OrderFeeSource = (typeof ORDER_FEE_SOURCES)[number];

export const ORDER_SUBSCRIPTION_VIEWS = ["any", "first", "renewal"] as const;
export type OrderSubscriptionView = (typeof ORDER_SUBSCRIPTION_VIEWS)[number];

export const ORDER_STOCK_VIEWS = ["awaiting", "ready"] as const;
export type OrderStockView = (typeof ORDER_STOCK_VIEWS)[number];

export function parseOrderFilters(sp: QueryParams): OrderFilters {
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
    campaign: isUuid(one(sp.campaign)) ? one(sp.campaign) : undefined,
    customer: isUuid(one(sp.customer)) ? one(sp.customer) : undefined,
    product: isUuid(one(sp.product)) ? one(sp.product) : undefined,
    variant: isUuid(one(sp.variant)) ? one(sp.variant) : undefined,
    missingCost: one(sp.missingCost) === "1" || undefined,
    attrChannel: one(sp.attrChannel)?.trim() || undefined,
    landing: one(sp.landing)?.trim().slice(0, 500) || undefined,
    utm: Object.fromEntries(UTM_DIMENSIONS.map((d) => [d, one(sp[utmParam(d)])?.trim() || undefined]).filter(([, v]) => v)),
    stock: ORDER_STOCK_VIEWS.find((v) => v === one(sp.stock)),
    country: /^[A-Za-z]{2}$/.test(one(sp.country) ?? "") ? one(sp.country)!.toUpperCase() : undefined,
    feeSource: ORDER_FEE_SOURCES.find((v) => v === one(sp.feeSource)),
    payout: isUuid(one(sp.payout)) ? one(sp.payout) : undefined,
    subscription: ORDER_SUBSCRIPTION_VIEWS.find((v) => v === one(sp.subscription)),
    subscriptionContract: isUuid(one(sp.subscriptionContract)) ? one(sp.subscriptionContract) : undefined,
    sort: sort === "placed_asc" || sort === "total_desc" ? sort : "placed_desc",
    page: Math.max(1, Number(one(sp.page) ?? 1) || 1),
  };
}

/** URL parameter of a UTM dimension: utmSource, utmMedium, … */
export const utmParam = (d: UtmDimension) => `utm${d[0]!.toUpperCase()}${d.slice(1)}`;
const UTM_COLUMN: Record<UtmDimension, string> = { source: "utm_source", medium: "utm_medium", campaign: "utm_campaign", content: "utm_content", term: "utm_term" };

/** Who is looking: `assigned=me` and the order number prefix depend on it. */
export interface OrderFilterScope {
  tenantId: string;
  userId: string | null;
  orderNumberPrefix: string;
  /** Tenant country: a phone typed without its prefix is read in this country (E.164 match). */
  country?: string;
}

export function orderListWhere(scope: OrderFilterScope, f: OrderFilters): SQL {
  const conds: SQL[] = [eq(schema.orders.tenantId, scope.tenantId)];
  if (f.q) {
    const numeric = f.q.replace(/^#/, "").replace(new RegExp(`^${scope.orderNumberPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), "");
    // a phone in any format matches on E.164 (#49: find an order by the number the customer calls from)
    const phone = scope.country ? parseSearchTerms(f.q, { country: scope.country, orderNumberPrefix: scope.orderNumberPrefix }).phoneE164 : null;
    const byPhone = phone ? [eq(schema.orders.phoneE164, phone)] : [];
    // up to 9 digits fits the integer column; a longer run of digits is a phone or text
    if (/^\d{2,9}$/.test(numeric)) conds.push(or(eq(schema.orders.orderNumber, Number(numeric)), ...byPhone)!);
    else conds.push(or(sql`${schema.orders.searchBlob} ilike ${"%" + f.q.toLowerCase() + "%"}`, ...byPhone)!);
  }
  if (f.status?.length) conds.push(inArray(schema.orders.status, f.status));
  if (f.payment?.length) conds.push(inArray(schema.orders.paymentMethod, f.payment));
  if (f.paymentStatus?.length) conds.push(inArray(schema.orders.paymentStatus, f.paymentStatus));
  if (f.channel?.length) conds.push(inArray(schema.orders.sourceChannel, f.channel));
  if (f.tag) conds.push(sql`${f.tag.toLowerCase()} = any(${schema.orders.platformTags})`);
  if (f.from) conds.push(gte(schema.orders.placedAt, new Date(f.from)));
  if (f.to) conds.push(lte(schema.orders.placedAt, new Date(new Date(f.to).getTime() + 864e5)));
  if (f.assigned === "me") conds.push(scope.userId ? eq(schema.orders.assignedTo, scope.userId) : sql`false`);
  else if (f.assigned === "none") conds.push(sql`${schema.orders.assignedTo} is null`);
  else if (f.assigned) conds.push(isUuid(f.assigned) ? eq(schema.orders.assignedTo, f.assigned) : sql`false`);
  if (f.customer) conds.push(eq(schema.orders.customerId, f.customer));
  if (f.campaign) conds.push(sql`exists (select 1 from order_attribution a where a.order_id = ${schema.orders.id} and a.campaign_id = ${f.campaign})`);
  if (f.product) conds.push(sql`exists (select 1 from order_lines l where l.order_id = ${schema.orders.id} and l.tenant_id = ${scope.tenantId} and l.product_id = ${f.product} and l.current_quantity > 0)`);
  if (f.variant) conds.push(sql`exists (select 1 from order_lines l where l.order_id = ${schema.orders.id} and l.tenant_id = ${scope.tenantId} and l.variant_id = ${f.variant} and l.current_quantity > 0)`);
  if (f.stock === "awaiting") conds.push(awaitingStockSql(schema.orders.id));
  if (f.stock === "ready") conds.push(readyToReleaseSql(schema.orders.id, schema.orders.status));
  if (f.country) conds.push(eq(schema.orders.shippingCountry, f.country));
  // same rule as the P/L: the fee is actual once a charge of the order was imported from a payout
  if (f.feeSource) conds.push(sql`${sql.raw(f.feeSource === "actual" ? "" : "not ")}exists (select 1 from balance_transactions b where b.order_id = ${schema.orders.id} and b.tenant_id = ${scope.tenantId} and b.type = 'charge')`);
  if (f.payout) conds.push(sql`exists (select 1 from balance_transactions b where b.order_id = ${schema.orders.id} and b.tenant_id = ${scope.tenantId} and b.payout_id = ${f.payout})`);
  if (f.subscription) conds.push(f.subscription === "first" ? sql`${schema.orders.isFirstSubscriptionOrder}` : f.subscription === "renewal" ? sql`${schema.orders.renewalNumber} > 0` : sql`${schema.orders.subscriptionContractId} is not null`);
  if (f.subscriptionContract) conds.push(eq(schema.orders.subscriptionContractId, f.subscriptionContract));
  if (f.missingCost) conds.push(sql`exists (select 1 from order_lines l where l.order_id = ${schema.orders.id} and l.unit_cost_minor is null and not l.is_ancillary)`);
  if (f.attrChannel) conds.push(f.attrChannel === "unknown" ? sql`not exists (select 1 from order_attribution a where a.order_id = ${schema.orders.id} and a.channel <> 'unknown')` : sql`exists (select 1 from order_attribution a where a.order_id = ${schema.orders.id} and a.channel = ${f.attrChannel})`);
  if (f.landing) conds.push(sql`${landingPathSql(sql`${schema.orders.landingSite}`)} = ${f.landing.toLowerCase()}`);
  const utm = Object.entries(f.utm ?? {}) as [UtmDimension, string][];
  // same normalisation as the drill-down: trimmed, case-insensitive, empty = (none)
  if (utm.length) conds.push(sql`coalesce((select ${sql.join(utm.map(([d, v]) => sql`lower(coalesce(nullif(trim(${sql.raw(`a.${UTM_COLUMN[d]}`)}), ''), ${UTM_NONE})) = ${v.toLowerCase()}`), sql` and `)} from order_attribution a where a.order_id = ${schema.orders.id}), ${sql.raw(utm.every(([, v]) => v === UTM_NONE) ? "true" : "false")})`);
  return and(...conds)!;
}

/* ---------- products ---------- */

export interface ProductFilters { q?: string; type?: string; status?: string; risk?: string; page?: number }

export function parseProductFilters(sp: QueryParams): ProductFilters {
  return { q: one(sp.q)?.trim(), type: one(sp.type), status: one(sp.status), risk: one(sp.risk), page: Math.max(1, Number(one(sp.page) ?? 1) || 1) };
}

/** SQL part of the product filters; `risk` is applied after the stock computation. */
export function productListWhere(tenantId: string, f: ProductFilters): SQL {
  const conds: SQL[] = [eq(schema.products.tenantId, tenantId)];
  // a scanned barcode finds its product too (#49 product lookup)
  if (f.q) conds.push(sql`(${schema.products.title} ilike ${"%" + f.q + "%"} or exists (select 1 from product_variants v where v.product_id = ${schema.products.id} and (v.sku ilike ${"%" + f.q + "%"} or v.barcode = ${f.q.trim()})))`);
  if (f.type) conds.push(eq(schema.products.productType, f.type));
  if (f.status) conds.push(eq(schema.products.status, f.status));
  return and(...conds)!;
}

/* ---------- customers and returns ---------- */

const CUSTOMER_SORTS = ["last_order", "total_spent", "orders", "name", "predicted_value"] as const;

export function parseCustomerFilters(sp: QueryParams): CustomerFilters {
  const segment = one(sp.segment);
  const churn = one(sp.churn);
  return {
    q: one(sp.q)?.trim() || undefined,
    country: one(sp.country),
    tier: one(sp.tier),
    acceptsMarketing: one(sp.marketing) === "1" ? true : undefined,
    segmentId: isUuid(segment) ? segment : undefined,
    churnRisk: (CHURN_RISKS as readonly string[]).includes(churn ?? "") ? churn : undefined,
    sort: CUSTOMER_SORTS.find((s) => s === one(sp.sort)) ?? "last_order",
    page: Math.max(1, Number(one(sp.page) ?? 1) || 1),
  };
}

export function parseReturnFilters(sp: QueryParams): ReturnFilters {
  const source = one(sp.source);
  return {
    q: one(sp.q)?.trim() || undefined,
    status: one(sp.status),
    reason: one(sp.reason),
    source: source === "portal" || source === "staff" || source === "platform" ? source : undefined,
    sync: one(sp.sync) === "error" ? "error" : undefined,
    review: one(sp.review) === "1" ? "1" : undefined,
    page: Math.max(1, Number(one(sp.page) ?? 1) || 1),
  };
}

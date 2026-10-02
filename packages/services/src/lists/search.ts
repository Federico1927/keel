import { and, desc, eq, or, schema, sql, type SQL } from "@hullwise/db";
import { parseSearchTerms } from "@hullwise/core";
import type { ServiceContext } from "../context";

export type SearchArea = "orders" | "customers" | "products" | "purchasing";

export interface GlobalSearchResult {
  orders: { id: string; name: string; customerName: string | null; email: string | null; status: string; totalMinor: number; currency: string; placedAt: Date }[];
  customers: { id: string; name: string; email: string | null; phone: string | null; ordersCount: number }[];
  products: { id: string; title: string; status: string; sku: string | null }[];
  purchaseOrders: { id: string; number: string; status: string; supplier: string }[];
}

/** Same expression as the `customers_search_trgm_idx` index, so the planner can use it. */
const customerSearchExpr = sql`lower(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '') || ' ' || coalesce(${schema.customers.email}, ''))`;
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * ⌘K search across orders (number, name, email, phone), customers (name, email, phone), products
 * (title, SKU) and purchase orders (number, supplier). Runs in the caller's tenant transaction:
 * a handful of small indexed queries, `limit` rows per area, only the areas the role can open.
 * Phones are matched on E.164, so the international and the local format find the same records.
 */
export async function globalSearch(ctx: ServiceContext, query: string, opts: { country: string; orderNumberPrefix: string; areas: readonly SearchArea[]; limit?: number }): Promise<GlobalSearchResult> {
  const empty: GlobalSearchResult = { orders: [], customers: [], products: [], purchaseOrders: [] };
  const terms = parseSearchTerms(query, opts);
  if (terms.text.length < 2) return empty;
  const limit = opts.limit ?? 5;
  const text = like(terms.text);
  const has = (a: SearchArea) => opts.areas.includes(a);
  const out = { ...empty };

  if (has("orders")) {
    const conds: SQL[] = [sql`${schema.orders.searchBlob} like ${text}`];
    if (terms.orderNumber !== null) conds.push(eq(schema.orders.orderNumber, terms.orderNumber));
    if (terms.phoneE164) conds.push(eq(schema.orders.phoneE164, terms.phoneE164));
    if (terms.email) conds.push(eq(schema.orders.emailNormalized, terms.email));
    out.orders = await ctx.tx
      .select({ id: schema.orders.id, name: schema.orders.name, customerName: schema.orders.customerName, email: schema.orders.email, status: schema.orders.status, totalMinor: schema.orders.totalMinor, currency: schema.orders.currency, placedAt: schema.orders.placedAt })
      .from(schema.orders)
      .where(and(eq(schema.orders.tenantId, ctx.tenantId), or(...conds)))
      .orderBy(...(terms.orderNumber !== null ? [sql`(${schema.orders.orderNumber} = ${terms.orderNumber}) desc`] : []), desc(schema.orders.placedAt))
      .limit(limit);
  }
  if (has("customers")) {
    const conds: SQL[] = [sql`${customerSearchExpr} like ${text}`];
    if (terms.phoneE164) conds.push(eq(schema.customers.phoneE164, terms.phoneE164));
    if (terms.email) conds.push(eq(schema.customers.emailNormalized, terms.email));
    const rows = await ctx.tx
      .select({ id: schema.customers.id, firstName: schema.customers.firstName, lastName: schema.customers.lastName, email: schema.customers.email, phone: schema.customers.phone, ordersCount: schema.customers.ordersCount })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, ctx.tenantId), or(...conds)))
      .orderBy(desc(schema.customers.lastOrderAt))
      .limit(limit);
    out.customers = rows.map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "—", email: r.email, phone: r.phone, ordersCount: r.ordersCount }));
  }
  if (has("products")) {
    out.products = await ctx.tx
      .select({ id: schema.products.id, title: schema.products.title, status: schema.products.status, sku: sql<string | null>`(select v.sku from product_variants v where v.product_id = ${schema.products.id} and lower(v.sku) like ${text} order by v.sku limit 1)` })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, ctx.tenantId), or(sql`lower(${schema.products.title}) like ${text}`, sql`exists (select 1 from product_variants v where v.tenant_id = ${ctx.tenantId} and v.product_id = ${schema.products.id} and lower(v.sku) like ${text})`)))
      .orderBy(schema.products.title)
      .limit(limit);
  }
  if (has("purchasing")) {
    out.purchaseOrders = await ctx.tx
      .select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, supplier: schema.suppliers.name })
      .from(schema.purchaseOrders)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
      .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), or(sql`lower(${schema.purchaseOrders.number}) like ${text}`, sql`lower(${schema.suppliers.name}) like ${text}`)))
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(limit);
  }
  return out;
}

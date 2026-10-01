import { and, asc, desc, eq, recordAudit, schema, sql } from "@keel/db";
import { EXPORT_MAX_ROWS, type ExportListKey } from "@keel/config";
import { csvAmount, csvLine, parseTenantSettings, queryParams, type QueryParams, type TenantSettings } from "@keel/core";
import type { ServiceContext } from "../context";
import { listCustomers } from "../crm";
import { listReturns } from "../returns";
import { summarizeByProduct, variantStock } from "../inventory";
import { notifyUsers } from "../notifications";
import { orderListWhere, parseCustomerFilters, parseOrderFilters, parseProductFilters, parseReturnFilters, productListWhere } from "./filters";

/** What an export needs to read a list exactly like its page. */
export interface ExportScope {
  tenantId: string;
  userId: string | null;
  orderNumberPrefix: string;
  settings: TenantSettings;
}

const CHUNK = 2000;
const BOM = String.fromCharCode(0xfeff);

/** Rows the export of this list and filters would contain (to choose direct download or background job). */
export async function countListExport(ctx: ServiceContext, list: ExportListKey, params: QueryParams, scope: ExportScope): Promise<number> {
  if (list === "orders") {
    const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(orderListWhere(scope, parseOrderFilters(params)));
    return r?.n ?? 0;
  }
  if (list === "customers") return (await listCustomers(ctx, { ...parseCustomerFilters(params), page: 1, pageSize: 1 })).total;
  if (list === "returns") return (await listReturns(ctx, { ...parseReturnFilters(params), page: 1, pageSize: 1 })).total;
  return (await productRows(ctx, params, scope)).length;
}

async function productRows(ctx: ServiceContext, params: QueryParams, scope: ExportScope) {
  const f = parseProductFilters(params);
  const products = await ctx.tx.select({ id: schema.products.id, title: schema.products.title, productType: schema.products.productType, vendor: schema.products.vendor, status: schema.products.status, tags: schema.products.tags, handle: schema.products.handle }).from(schema.products).where(productListWhere(scope.tenantId, f)).orderBy(asc(schema.products.title));
  if (!products.length) return [];
  const stock = await variantStock(ctx, scope.settings, { productIds: products.map((p) => p.id) });
  const summary = summarizeByProduct(stock);
  const prices = new Map<string, { min: number; max: number; variants: number; skus: string[] }>();
  for (const v of stock) {
    const p = prices.get(v.productId) ?? { min: v.priceMinor, max: v.priceMinor, variants: 0, skus: [] };
    p.min = Math.min(p.min, v.priceMinor);
    p.max = Math.max(p.max, v.priceMinor);
    p.variants++;
    if (v.sku) p.skus.push(v.sku);
    prices.set(v.productId, p);
  }
  return products.map((p) => ({ ...p, stock: summary.get(p.id) ?? null, prices: prices.get(p.id) ?? null })).filter((r) => !f.risk || r.stock?.risk === f.risk);
}

/** Header and lines of a list export, read in chunks inside the caller's transaction. */
async function* exportLines(ctx: ServiceContext, list: ExportListKey, params: QueryParams, scope: ExportScope, maxRows: number): AsyncGenerator<string> {
  if (list === "orders") {
    const f = parseOrderFilters(params);
    const where = orderListWhere(scope, f);
    const order = f.sort === "placed_asc" ? asc(schema.orders.placedAt) : f.sort === "total_desc" ? desc(schema.orders.totalMinor) : desc(schema.orders.placedAt);
    yield csvLine(["order", "placed_at", "status", "payment_method", "payment_status", "channel", "customer", "email", "phone", "country", "city", "currency", "subtotal", "discount", "shipping", "tax", "total", "refunded", "tags", "assigned_to", "cancelled_at", "order_id"]);
    for (let offset = 0; offset < maxRows; offset += CHUNK) {
      const rows = await ctx.tx
        .select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, status: schema.orders.status, paymentMethod: schema.orders.paymentMethod, paymentStatus: schema.orders.paymentStatus, channel: schema.orders.sourceChannel, customerName: schema.orders.customerName, email: schema.orders.email, phone: schema.orders.phone, country: schema.orders.shippingCountry, city: schema.orders.shippingCity, currency: schema.orders.currency, subtotal: schema.orders.subtotalMinor, discount: schema.orders.discountMinor, shipping: schema.orders.shippingMinor, tax: schema.orders.taxMinor, total: schema.orders.totalMinor, refunded: schema.orders.refundedMinor, tags: schema.orders.platformTags, assignee: schema.users.email, cancelledAt: schema.orders.cancelledAt })
        .from(schema.orders)
        .leftJoin(schema.users, eq(schema.users.id, schema.orders.assignedTo))
        .where(where)
        .orderBy(order, desc(schema.orders.orderNumber))
        .limit(Math.min(CHUNK, maxRows - offset))
        .offset(offset);
      for (const r of rows) yield csvLine([r.name, r.placedAt, r.status, r.paymentMethod, r.paymentStatus, r.channel, r.customerName, r.email, r.phone, r.country, r.city, r.currency, csvAmount(r.subtotal), csvAmount(r.discount), csvAmount(r.shipping), csvAmount(r.tax), csvAmount(r.total), csvAmount(r.refunded), r.tags.join("|"), r.assignee, r.cancelledAt, r.id]);
      if (rows.length < CHUNK) return;
    }
    return;
  }
  if (list === "customers") {
    const f = parseCustomerFilters(params);
    yield csvLine(["customer_id", "first_name", "last_name", "email", "phone", "country", "city", "accepts_marketing", "orders_count", "total_spent", "aov", "first_order_at", "last_order_at", "days_since_last_order", "rfm_tier", "churn_risk", "tags"]);
    for (let page = 1; (page - 1) * CHUNK < maxRows; page++) {
      const { rows } = await listCustomers(ctx, { ...f, page, pageSize: CHUNK });
      for (const r of rows.slice(0, maxRows - (page - 1) * CHUNK)) yield csvLine([r.customerId, r.firstName, r.lastName, r.email, r.phone, r.country, r.city, r.acceptsMarketing, r.ordersCount, csvAmount(r.totalSpentMinor), csvAmount(r.aovMinor), r.firstOrderAt, r.lastOrderAt, r.daysSinceLastOrder, r.tier, r.churnRisk ?? null, r.tags.join("|")]);
      if (rows.length < CHUNK) return;
    }
    return;
  }
  if (list === "returns") {
    const f = parseReturnFilters(params);
    yield csvLine(["return", "requested_at", "status", "order", "customer", "reason", "resolution", "fault", "items", "currency", "proposed_amount", "refunded_amount", "source", "platform_sync", "needs_review", "closed_at", "return_id"]);
    for (let page = 1; (page - 1) * CHUNK < maxRows; page++) {
      const { rows } = await listReturns(ctx, { ...f, page, pageSize: CHUNK });
      for (const r of rows.slice(0, maxRows - (page - 1) * CHUNK)) yield csvLine([`R-${r.number}`, r.requestedAt, r.status, r.orderName, r.customerName, r.reasonCode, r.resolution, r.fault, r.items, r.currency, csvAmount(r.proposedAmountMinor), csvAmount(r.refundedAmountMinor), r.source, r.platformSyncStatus, r.needsReview, r.closedAt, r.id]);
      if (rows.length < CHUNK) return;
    }
    return;
  }
  yield csvLine(["product_id", "title", "handle", "type", "vendor", "status", "tags", "variants", "skus", "price_min", "price_max", "available", "incoming", `units_sold_${scope.settings.salesVelocityLookbackDays}d`, "days_of_cover", "risk", "suggested_reorder"]);
  for (const r of (await productRows(ctx, params, scope)).slice(0, maxRows)) yield csvLine([r.id, r.title, r.handle, r.productType, r.vendor, r.status, r.tags.join("|"), r.prices?.variants ?? 0, r.prices?.skus.join("|") ?? null, csvAmount(r.prices?.min), csvAmount(r.prices?.max), r.stock?.available ?? 0, r.stock?.incoming ?? 0, r.stock?.unitsSold ?? 0, r.stock?.worstDaysOfCover === null || r.stock?.worstDaysOfCover === undefined ? null : Math.round(r.stock.worstDaysOfCover), r.stock?.risk ?? null, r.stock?.suggestedReorder ?? 0]);
}

export function exportFileName(list: ExportListKey, now = new Date()): string {
  return `${list}-${now.toISOString().slice(0, 10)}.csv`;
}

/** The CSV (UTF-8 with BOM, so spreadsheets open accents correctly) and its data row count. */
export async function buildListCsv(ctx: ServiceContext, list: ExportListKey, params: QueryParams, scope: ExportScope, maxRows = EXPORT_MAX_ROWS): Promise<{ csv: string; rows: number }> {
  const lines: string[] = [];
  for await (const line of exportLines(ctx, list, params, scope, maxRows)) lines.push(line);
  return { csv: `${BOM}${lines.join("\n")}\n`, rows: Math.max(0, lines.length - 1) };
}

/* ---------- background exports ---------- */

/** Queues a large export for the user; the caller enqueues `list.export` (or runs `runListExport` inline). */
export async function requestListExport(ctx: ServiceContext, input: { list: ExportListKey; query: string; userId: string; expectedRows: number }): Promise<string> {
  const [row] = await ctx.tx.insert(schema.listExports).values({ tenantId: ctx.tenantId, userId: input.userId, list: input.list, query: input.query, status: "pending", rowCount: input.expectedRows, createdAt: ctx.now ?? new Date() }).returning({ id: schema.listExports.id });
  return row!.id;
}

/**
 * Builds a queued export with the tenant's current settings, stores the file and notifies the user
 * (bell, and email if they asked for it). Idempotent: an export already done is left alone.
 */
export async function runListExport(ctx: ServiceContext, exportId: string): Promise<{ status: "done" | "failed" | "skipped"; rows: number }> {
  const [job] = await ctx.tx.select().from(schema.listExports).where(and(eq(schema.listExports.tenantId, ctx.tenantId), eq(schema.listExports.id, exportId))).limit(1);
  if (!job || job.status === "done") return { status: "skipped", rows: job?.rowCount ?? 0 };
  const [tenant] = await ctx.tx.select({ orderNumberPrefix: schema.tenants.orderNumberPrefix, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const now = ctx.now ?? new Date();
  const list = job.list as ExportListKey;
  try {
    const { csv, rows } = await buildListCsv(ctx, list, queryParams(job.query), { tenantId: ctx.tenantId, userId: job.userId, orderNumberPrefix: tenant?.orderNumberPrefix ?? "", settings: parseTenantSettings(tenant?.settings) });
    await ctx.tx.update(schema.listExports).set({ status: "done", content: csv, rowCount: rows, fileName: exportFileName(list, now), completedAt: now, error: null }).where(eq(schema.listExports.id, exportId));
    await notifyUsers(ctx, { userIds: [job.userId], type: "export_ready", title: String(rows), body: list, link: "/exports", severity: "success", metadata: { exportId, list } });
    return { status: "done", rows };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await ctx.tx.update(schema.listExports).set({ status: "failed", error, completedAt: now }).where(eq(schema.listExports.id, exportId));
    await notifyUsers(ctx, { userIds: [job.userId], type: "export_ready", title: "failed", body: list, link: "/exports", severity: "warning", metadata: { exportId, list } });
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorType: "system", action: "export.failed", entityType: "list_export", entityId: exportId, metadata: { list, error } });
    return { status: "failed", rows: 0 };
  }
}

/** The user's recent exports (newest first), without the file contents. */
export async function listMyExports(ctx: ServiceContext, userId: string, limit = 20) {
  return ctx.tx.select({ id: schema.listExports.id, list: schema.listExports.list, query: schema.listExports.query, status: schema.listExports.status, rowCount: schema.listExports.rowCount, fileName: schema.listExports.fileName, error: schema.listExports.error, createdAt: schema.listExports.createdAt, completedAt: schema.listExports.completedAt, downloadedAt: schema.listExports.downloadedAt }).from(schema.listExports).where(and(eq(schema.listExports.tenantId, ctx.tenantId), eq(schema.listExports.userId, userId))).orderBy(desc(schema.listExports.createdAt)).limit(limit);
}

/** The file of a finished export, only for the user who asked for it; marks it downloaded. */
export async function takeExportFile(ctx: ServiceContext, exportId: string, userId: string): Promise<{ fileName: string; content: string; list: string; rows: number } | null> {
  const [row] = await ctx.tx.select().from(schema.listExports).where(and(eq(schema.listExports.tenantId, ctx.tenantId), eq(schema.listExports.id, exportId), eq(schema.listExports.userId, userId))).limit(1);
  if (!row || row.status !== "done" || row.content === null) return null;
  await ctx.tx.update(schema.listExports).set({ downloadedAt: ctx.now ?? new Date() }).where(eq(schema.listExports.id, exportId));
  return { fileName: row.fileName ?? exportFileName(row.list as ExportListKey), content: row.content, list: row.list, rows: row.rowCount ?? 0 };
}

import { and, asc, desc, eq, gte, inArray, schema, sql, type SQL } from "@keel/db";
import { PAGE_SIZE } from "@keel/config";
import { summarizeByProduct, variantStock } from "@keel/services";
import type { TenantContext } from "@/server/tenant";

export interface ProductFilters { q?: string; type?: string; status?: string; risk?: string; page?: number }

export function parseProductFilters(sp: Record<string, string | string[] | undefined>): ProductFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  return { q: one(sp.q)?.trim(), type: one(sp.type), status: one(sp.status), risk: one(sp.risk), page: Math.max(1, Number(one(sp.page) ?? 1) || 1) };
}

export async function listProducts(ctx: TenantContext, f: ProductFilters) {
  const conds: SQL[] = [eq(schema.products.tenantId, ctx.tenant.id)];
  if (f.q) conds.push(sql`(${schema.products.title} ilike ${"%" + f.q + "%"} or exists (select 1 from product_variants v where v.product_id = ${schema.products.id} and v.sku ilike ${"%" + f.q + "%"}))`);
  if (f.type) conds.push(eq(schema.products.productType, f.type));
  if (f.status) conds.push(eq(schema.products.status, f.status));
  const where = and(...conds)!;
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const all = await tx.select({ id: schema.products.id, title: schema.products.title, productType: schema.products.productType, status: schema.products.status, vendor: schema.products.vendor, imageUrl: schema.products.imageUrl, options: schema.products.options, isRepurchasable: schema.products.isRepurchasable }).from(schema.products).where(where).orderBy(asc(schema.products.title));
    const stock = await variantStock(s, ctx.settings, { productIds: all.map((p) => p.id) });
    const summary = summarizeByProduct(stock);
    const variantCount = new Map<string, number>();
    for (const r of stock) variantCount.set(r.productId, (variantCount.get(r.productId) ?? 0) + 1);
    let rows = all.map((p) => ({ ...p, variants: variantCount.get(p.id) ?? 0, stock: summary.get(p.id) ?? null }));
    if (f.risk) rows = rows.filter((r) => r.stock?.risk === f.risk);
    rows.sort((a, b) => (f.risk ? (a.stock?.worstDaysOfCover ?? 1e9) - (b.stock?.worstDaysOfCover ?? 1e9) : 0));
    const total = rows.length;
    const page = f.page ?? 1;
    const riskCounts = { critical: 0, warning: 0, ok: 0, no_sales: 0 };
    for (const r of all.map((p) => summary.get(p.id))) if (r) riskCounts[r.risk]++;
    const types = await tx.select({ t: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, ctx.tenant.id)).groupBy(schema.products.productType);
    return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total, page, pageSize: PAGE_SIZE, riskCounts, types: types.map((t) => t.t).filter((t): t is string => Boolean(t)).sort() };
  });
}

export async function getProductDetail(ctx: TenantContext, id: string) {
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [product] = await tx.select().from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenant.id), eq(schema.products.id, id))).limit(1);
    if (!product) return null;
    const variants = await tx.select().from(schema.productVariants).where(eq(schema.productVariants.productId, id)).orderBy(asc(schema.productVariants.title));
    const stock = await variantStock(s, ctx.settings, { productIds: [id] });
    const locations = await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)).orderBy(desc(schema.locations.isDefault), asc(schema.locations.name));
    const since = new Date(Date.now() - 90 * 864e5);
    const daily = await tx
      .select({ day: sql<string>`to_char(date_trunc('day', ${schema.orders.placedAt} at time zone ${ctx.tenant.timezone}), 'YYYY-MM-DD')`, units: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity}), 0)::int`, revenue: sql<number>`coalesce(sum(${schema.orderLines.totalMinor}), 0)::int` })
      .from(schema.orderLines)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
      .where(and(eq(schema.orderLines.productId, id), gte(schema.orders.placedAt, since), sql`${schema.orders.status} not in ('cancelled','refunded')`))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const incomingPos = await tx
      .select({ poId: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, expectedAt: schema.purchaseOrders.expectedAt, variantId: schema.purchaseOrderLines.variantId, quantity: sql<number>`${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity}` })
      .from(schema.purchaseOrderLines)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId))
      .where(and(inArray(schema.purchaseOrderLines.variantId, variants.map((v) => v.id)), inArray(schema.purchaseOrders.status, ["confirmed", "in_transit", "partially_received", "sent"])));
    const movements = await tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.tenantId, ctx.tenant.id), inArray(schema.inventoryMovements.variantId, variants.map((v) => v.id)))).orderBy(desc(schema.inventoryMovements.createdAt)).limit(30);
    const campaigns = await tx.select({ id: schema.campaigns.id, name: schema.campaigns.name, platform: schema.campaigns.platform, status: schema.campaigns.status }).from(schema.campaignProductLinks).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignProductLinks.campaignId)).where(eq(schema.campaignProductLinks.productId, id));
    return { product, variants, stock, locations, daily, incomingPos, movements, campaigns };
  });
}

export interface InventoryFilters { q?: string; risk?: string; location?: string; page?: number; lookback?: number }
export function parseInventoryFilters(sp: Record<string, string | string[] | undefined>): InventoryFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const lb = Number(one(sp.lookback));
  return { q: one(sp.q)?.trim(), risk: one(sp.risk), location: one(sp.location), page: Math.max(1, Number(one(sp.page) ?? 1) || 1), lookback: [7, 14, 30, 60, 90].includes(lb) ? lb : undefined };
}

export async function listInventory(ctx: TenantContext, f: InventoryFilters) {
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    let rows = await variantStock(s, ctx.settings, { lookbackDays: f.lookback });
    if (f.q) {
      const q = f.q.toLowerCase();
      rows = rows.filter((r) => r.productTitle.toLowerCase().includes(q) || r.variantTitle.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q));
    }
    if (f.risk) rows = rows.filter((r) => r.risk === f.risk);
    if (f.location) rows = rows.map((r) => ({ ...r, available: r.byLocation.find((l) => l.locationId === f.location)?.available ?? 0 }));
    const riskOrder = { critical: 0, warning: 1, ok: 2, no_sales: 3 } as const;
    rows.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
    const counts = { critical: 0, warning: 0, ok: 0, no_sales: 0 };
    const all = await variantStock(s, ctx.settings, { lookbackDays: f.lookback });
    for (const r of all) counts[r.risk]++;
    const locations = await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)).orderBy(desc(schema.locations.isDefault));
    const page = f.page ?? 1;
    const totalUnits = all.reduce((sum, r) => sum + r.available, 0);
    const stockValue = all.reduce((sum, r) => sum + r.available * (r.costMinor ?? 0), 0);
    return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE, counts, locations, totalUnits, stockValue, suggestedReorderTotal: all.reduce((sum, r) => sum + r.suggestedReorder, 0) };
  });
}

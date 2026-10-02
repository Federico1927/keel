import { and, asc, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { PAGE_SIZE } from "@hullwise/config";
import { listSupplierLinks, supplierBalances, variantStock } from "@hullwise/services";
import type { TenantContext } from "@/server/tenant";

export interface PoListFilters {
  status?: string;
  supplier?: string;
  destination?: string;
  /** Number, supplier, notes, line SKU or description. */
  q?: string;
  /** YYYY-MM-DD, inclusive, on the order date (creation date for drafts), tenant timezone. */
  from?: string;
  to?: string;
  page?: number;
}

const isDay = (d?: string) => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d));

function poWhere(ctx: TenantContext, f: PoListFilters): SQL {
  const conds: SQL[] = [eq(schema.purchaseOrders.tenantId, ctx.tenant.id)];
  if (f.status) conds.push(eq(schema.purchaseOrders.status, f.status));
  if (f.supplier && /^[0-9a-f-]{36}$/.test(f.supplier)) conds.push(eq(schema.purchaseOrders.supplierId, f.supplier));
  if (f.destination && /^[0-9a-f-]{36}$/.test(f.destination)) conds.push(eq(schema.purchaseOrders.destinationLocationId, f.destination));
  const day = sql`(coalesce(${schema.purchaseOrders.orderedAt}, ${schema.purchaseOrders.createdAt}) at time zone ${ctx.tenant.timezone})::date`;
  if (isDay(f.from)) conds.push(sql`${day} >= ${f.from}::date`);
  if (isDay(f.to)) conds.push(sql`${day} <= ${f.to}::date`);
  const q = f.q?.trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(${schema.purchaseOrders.number} ilike ${like} or ${schema.purchaseOrders.notes} ilike ${like} or ${schema.suppliers.name} ilike ${like} or exists (select 1 from purchase_order_lines l left join product_variants v on v.id = l.variant_id left join products p on p.id = v.product_id where l.purchase_order_id = ${schema.purchaseOrders.id} and (v.sku ilike ${like} or l.description ilike ${like} or p.title ilike ${like})))`);
  }
  return and(...conds)!;
}

const poColumns = { id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, supplierName: schema.suppliers.name, supplierId: schema.suppliers.id, destinationName: schema.locations.name, createdAt: schema.purchaseOrders.createdAt, orderedAt: schema.purchaseOrders.orderedAt, expectedAt: schema.purchaseOrders.expectedAt, receivedAt: schema.purchaseOrders.receivedAt, totalMinor: schema.purchaseOrders.totalMinor, currency: schema.purchaseOrders.currency, source: schema.purchaseOrders.source, lines: sql<number>`(select count(*) from purchase_order_lines l where l.purchase_order_id = ${schema.purchaseOrders.id})::int`, units: sql<number>`(select coalesce(sum(l.quantity),0) from purchase_order_lines l where l.purchase_order_id = ${schema.purchaseOrders.id})::int`, receivedUnits: sql<number>`(select coalesce(sum(l.received_quantity - l.damaged_quantity - l.rejected_quantity),0) from purchase_order_lines l where l.purchase_order_id = ${schema.purchaseOrders.id})::int`, backorders: sql<number>`(select count(distinct b.order_id) from backorders b join purchase_order_lines l on l.id = b.purchase_order_line_id where l.purchase_order_id = ${schema.purchaseOrders.id} and b.status in ('pending','covered'))::int` };

export async function listPurchaseOrders(ctx: TenantContext, f: PoListFilters) {
  const where = poWhere(ctx, f);
  const page = f.page ?? 1;
  return ctx.run(async (tx) => {
    const rows = await tx
      .select(poColumns)
      .from(schema.purchaseOrders)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.destinationLocationId))
      .where(where)
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(schema.purchaseOrders).innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId)).where(where)) as [{ total: number }];
    const counts = await tx.select({ status: schema.purchaseOrders.status, n: sql<number>`count(*)::int` }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, ctx.tenant.id)).groupBy(schema.purchaseOrders.status);
    const suppliers = await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(asc(schema.suppliers.name));
    const locations = await tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)).orderBy(asc(schema.locations.name));
    return { rows, total, page, pageSize: PAGE_SIZE, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, suppliers, locations };
  });
}

/** Every PO matching the filters (CSV export), capped. */
export async function exportPurchaseOrders(ctx: TenantContext, f: PoListFilters, cap = 10_000) {
  return ctx.run((tx) =>
    tx
      .select(poColumns)
      .from(schema.purchaseOrders)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
      .leftJoin(schema.locations, eq(schema.locations.id, schema.purchaseOrders.destinationLocationId))
      .where(poWhere(ctx, f))
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(cap),
  );
}

export async function getPurchaseOrder(ctx: TenantContext, id: string) {
  return ctx.run(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenant.id), eq(schema.purchaseOrders.id, id))).limit(1);
    if (!po) return null;
    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId)).limit(1);
    const lines = await tx
      .select({ id: schema.purchaseOrderLines.id, variantId: schema.purchaseOrderLines.variantId, quantity: schema.purchaseOrderLines.quantity, receivedQuantity: schema.purchaseOrderLines.receivedQuantity, damagedQuantity: schema.purchaseOrderLines.damagedQuantity, rejectedQuantity: schema.purchaseOrderLines.rejectedQuantity, unitCostMinor: schema.purchaseOrderLines.unitCostMinor, landedUnitCostMinor: schema.purchaseOrderLines.landedUnitCostMinor, description: schema.purchaseOrderLines.description, sku: schema.productVariants.sku, variantTitle: schema.productVariants.title, productTitle: schema.products.title, productId: schema.products.id })
      .from(schema.purchaseOrderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.purchaseOrderLines.variantId))
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(schema.products.title));
    const backorders = await tx
      .select({ orderId: schema.backorders.orderId, orderName: schema.orders.name, quantity: schema.backorders.quantity, status: schema.backorders.status, variantId: schema.backorders.variantId })
      .from(schema.backorders)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.backorders.orderId))
      .where(and(eq(schema.backorders.tenantId, ctx.tenant.id), inArray(schema.backorders.purchaseOrderLineId, lines.map((l) => l.id))));
    const payments = await tx.select().from(schema.supplierPayments).where(eq(schema.supplierPayments.purchaseOrderId, id)).orderBy(desc(schema.supplierPayments.paidAt));
    const locations = await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)).orderBy(desc(schema.locations.isDefault));
    const charges = await tx.select().from(schema.purchaseOrderCharges).where(and(eq(schema.purchaseOrderCharges.tenantId, ctx.tenant.id), eq(schema.purchaseOrderCharges.purchaseOrderId, id))).orderBy(asc(schema.purchaseOrderCharges.createdAt));
    const svc = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const links = await listSupplierLinks(svc, id);
    const history = await tx.select({ id: schema.auditLogs.id, action: schema.auditLogs.action, actorType: schema.auditLogs.actorType, actorName: schema.users.name, actorEmail: schema.users.email, diff: schema.auditLogs.diff, metadata: schema.auditLogs.metadata, createdAt: schema.auditLogs.createdAt }).from(schema.auditLogs).leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId)).where(and(eq(schema.auditLogs.tenantId, ctx.tenant.id), eq(schema.auditLogs.entityType, "purchase_order"), eq(schema.auditLogs.entityId, id))).orderBy(desc(schema.auditLogs.createdAt)).limit(30);
    return { po, supplier: supplier!, lines, backorders, payments, locations, charges, links, history };
  });
}

export async function listSuppliers(ctx: TenantContext) {
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const suppliers = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(asc(schema.suppliers.name));
    const balances = await supplierBalances(s);
    return suppliers.map((sup) => ({ ...sup, balance: balances.get(sup.id) ?? { owedMinor: 0, paidMinor: 0, balanceMinor: 0, openPos: 0 } }));
  });
}

/** Variants to pick from when creating a PO: suggested reorders first. */
export async function reorderCandidates(ctx: TenantContext) {
  return ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const rows = await variantStock(s, ctx.settings, {});
    return rows.sort((a, b) => b.suggestedReorder - a.suggestedReorder || a.productTitle.localeCompare(b.productTitle));
  });
}

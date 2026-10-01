import { and, asc, desc, eq, inArray, schema, sql, type SQL } from "@keel/db";
import { PAGE_SIZE } from "@keel/config";
import { supplierBalances, variantStock } from "@keel/services";
import type { TenantContext } from "@/server/tenant";

export async function listPurchaseOrders(ctx: TenantContext, f: { status?: string; supplier?: string; page?: number }) {
  const conds: SQL[] = [eq(schema.purchaseOrders.tenantId, ctx.tenant.id)];
  if (f.status) conds.push(eq(schema.purchaseOrders.status, f.status));
  if (f.supplier) conds.push(eq(schema.purchaseOrders.supplierId, f.supplier));
  const where = and(...conds)!;
  const page = f.page ?? 1;
  return ctx.run(async (tx) => {
    const rows = await tx
      .select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, supplierName: schema.suppliers.name, supplierId: schema.suppliers.id, orderedAt: schema.purchaseOrders.orderedAt, expectedAt: schema.purchaseOrders.expectedAt, receivedAt: schema.purchaseOrders.receivedAt, totalMinor: schema.purchaseOrders.totalMinor, currency: schema.purchaseOrders.currency, lines: sql<number>`(select count(*) from purchase_order_lines l where l.purchase_order_id = ${schema.purchaseOrders.id})::int`, units: sql<number>`(select coalesce(sum(l.quantity),0) from purchase_order_lines l where l.purchase_order_id = ${schema.purchaseOrders.id})::int`, backorders: sql<number>`(select count(distinct b.order_id) from backorders b join purchase_order_lines l on l.id = b.purchase_order_line_id where l.purchase_order_id = ${schema.purchaseOrders.id} and b.status in ('pending','covered'))::int` })
      .from(schema.purchaseOrders)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
      .where(where)
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(schema.purchaseOrders).where(where)) as [{ total: number }];
    const counts = await tx.select({ status: schema.purchaseOrders.status, n: sql<number>`count(*)::int` }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.tenantId, ctx.tenant.id)).groupBy(schema.purchaseOrders.status);
    const suppliers = await tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(asc(schema.suppliers.name));
    return { rows, total, page, pageSize: PAGE_SIZE, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, suppliers };
  });
}

export async function getPurchaseOrder(ctx: TenantContext, id: string) {
  return ctx.run(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenant.id), eq(schema.purchaseOrders.id, id))).limit(1);
    if (!po) return null;
    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId)).limit(1);
    const lines = await tx
      .select({ id: schema.purchaseOrderLines.id, variantId: schema.purchaseOrderLines.variantId, quantity: schema.purchaseOrderLines.quantity, receivedQuantity: schema.purchaseOrderLines.receivedQuantity, unitCostMinor: schema.purchaseOrderLines.unitCostMinor, landedUnitCostMinor: schema.purchaseOrderLines.landedUnitCostMinor, description: schema.purchaseOrderLines.description, sku: schema.productVariants.sku, variantTitle: schema.productVariants.title, productTitle: schema.products.title, productId: schema.products.id })
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
    return { po, supplier: supplier!, lines, backorders, payments, locations, charges };
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

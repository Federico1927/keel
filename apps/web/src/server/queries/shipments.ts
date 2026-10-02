import { and, desc, eq, inArray, schema, sql, type SQL } from "@hullwise/db";
import { SHIPMENT_FINAL_STATUSES, SHIPMENT_STATUSES } from "@hullwise/core";
import { PAGE_SIZE } from "@hullwise/config";
import type { TenantContext } from "@/server/tenant";

export interface ShipmentFilters {
  status?: string[];
  carrier?: string;
  view?: "all" | "stuck" | "exceptions" | "open";
  q?: string;
  page?: number;
}

export function parseShipmentFilters(sp: Record<string, string | string[] | undefined>): ShipmentFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
  const status = (one(sp.status) ?? "").split(",").map((s) => s.trim()).filter((s) => (SHIPMENT_STATUSES as readonly string[]).includes(s));
  const view = one(sp.view);
  return { status, carrier: one(sp.carrier) || undefined, view: view === "stuck" || view === "exceptions" || view === "open" ? view : "all", q: one(sp.q)?.trim() || undefined, page: Math.max(1, Number(one(sp.page) ?? 1) || 1) };
}

export async function listShipments(ctx: TenantContext, f: ShipmentFilters) {
  const stuckCutoff = new Date(Date.now() - ctx.settings.shipmentStuckDays * 864e5);
  const conds: SQL[] = [eq(schema.shipments.tenantId, ctx.tenant.id)];
  if (f.status?.length) conds.push(inArray(schema.shipments.status, f.status));
  if (f.carrier) conds.push(eq(schema.shipments.carrier, f.carrier));
  if (f.q) conds.push(sql`(${schema.shipments.trackingNumber} ilike ${"%" + f.q + "%"} or ${schema.orders.searchBlob} ilike ${"%" + f.q.toLowerCase() + "%"})`);
  if (f.view === "stuck") conds.push(sql`${schema.shipments.status} not in ('delivered','returned','failed') and ${schema.shipments.shippedAt} < ${stuckCutoff}`);
  if (f.view === "exceptions") conds.push(inArray(schema.shipments.status, ["exception", "attempted", "failed"]));
  if (f.view === "open") conds.push(sql`${schema.shipments.status} not in ('delivered','returned','failed')`);
  const where = and(...conds)!;
  const page = f.page ?? 1;
  return ctx.run(async (tx) => {
    const rows = await tx
      .select({ id: schema.shipments.id, orderId: schema.shipments.orderId, orderName: schema.orders.name, customerName: schema.orders.customerName, country: schema.orders.shippingCountry, carrier: schema.shipments.carrier, trackingNumber: schema.shipments.trackingNumber, trackingUrl: schema.shipments.trackingUrl, status: schema.shipments.status, sourceOfTruth: schema.shipments.sourceOfTruth, shippedAt: schema.shipments.shippedAt, deliveredAt: schema.shipments.deliveredAt, lastEventAt: schema.shipments.lastEventAt, exceptionReason: schema.shipments.exceptionReason })
      .from(schema.shipments)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
      .where(where)
      .orderBy(desc(schema.shipments.shippedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(schema.shipments).innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId)).where(where)) as [{ total: number }];
    const base = eq(schema.shipments.tenantId, ctx.tenant.id);
    const [summary] = await tx
      .select({
        inTransit: sql<number>`count(*) filter (where ${schema.shipments.status} in ('label_created','in_transit'))::int`,
        outForDelivery: sql<number>`count(*) filter (where ${schema.shipments.status} = 'out_for_delivery')::int`,
        exceptions: sql<number>`count(*) filter (where ${schema.shipments.status} in ('exception','attempted','failed'))::int`,
        stuck: sql<number>`count(*) filter (where ${schema.shipments.status} not in ('delivered','returned','failed') and ${schema.shipments.shippedAt} < ${stuckCutoff})::int`,
        delivered7d: sql<number>`count(*) filter (where ${schema.shipments.status} = 'delivered' and ${schema.shipments.deliveredAt} >= ${new Date(Date.now() - 7 * 864e5)})::int`,
        returned30d: sql<number>`count(*) filter (where ${schema.shipments.status} = 'returned' and ${schema.shipments.lastEventAt} >= ${new Date(Date.now() - 30 * 864e5)})::int`,
      })
      .from(schema.shipments)
      .where(base);
    const carriers = await tx.select({ carrier: schema.shipments.carrier }).from(schema.shipments).where(base).groupBy(schema.shipments.carrier);
    return { rows, total, page, pageSize: PAGE_SIZE, summary: summary!, carriers: carriers.map((c) => c.carrier).filter((c): c is string => Boolean(c)).sort(), finals: SHIPMENT_FINAL_STATUSES };
  });
}

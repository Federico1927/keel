import { and, eq, schema } from "@hullwise/db";
import type { ServiceContext } from "../context";
import { queueEmail, type QueueOutcome } from "../email/mailer";

/** The purchase order email to the supplier, in the tenant's language, with the confirmation link. */
export async function sendSupplierPoEmail(ctx: ServiceContext, input: { poId: string; to: string; url: string }): Promise<QueueOutcome | "not_found"> {
  const [row] = await ctx.tx
    .select({ number: schema.purchaseOrders.number, expectedAt: schema.purchaseOrders.expectedAt, supplierName: schema.suppliers.name, companyName: schema.tenants.name, locale: schema.tenants.defaultLocale, timezone: schema.tenants.timezone })
    .from(schema.purchaseOrders)
    .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.purchaseOrders.tenantId))
    .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, input.poId)))
    .limit(1);
  if (!row) return "not_found";
  // every send is its own email (the team may send the PO again on purpose); retries of one send reuse its row
  const r = await queueEmail(ctx, { to: input.to, template: "supplier_po", data: { companyName: row.companyName, supplierName: row.supplierName, poNumber: row.number, url: input.url, expectedAt: row.expectedAt, timezone: row.timezone }, locale: row.locale, event: `po:${input.poId}:${(ctx.now ?? new Date()).toISOString()}` });
  return r.outcome;
}

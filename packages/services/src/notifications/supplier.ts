import { and, eq, schema } from "@keel/db";
import type { ServiceContext } from "../context";
import { sendTenantEmail, type EmailOutcome } from "./mailer";

/** The purchase order email to the supplier, in the tenant's language, with the confirmation link. */
export async function sendSupplierPoEmail(ctx: ServiceContext, input: { poId: string; to: string; url: string }): Promise<EmailOutcome> {
  const [row] = await ctx.tx
    .select({ number: schema.purchaseOrders.number, expectedAt: schema.purchaseOrders.expectedAt, supplierName: schema.suppliers.name, companyName: schema.tenants.name, locale: schema.tenants.defaultLocale, timezone: schema.tenants.timezone })
    .from(schema.purchaseOrders)
    .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.purchaseOrders.tenantId))
    .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, input.poId)))
    .limit(1);
  if (!row) return "error";
  const r = await sendTenantEmail(ctx, { to: input.to, template: "supplier_po", data: { companyName: row.companyName, supplierName: row.supplierName, poNumber: row.number, url: input.url, expectedAt: row.expectedAt, timezone: row.timezone }, locale: row.locale, category: "supplier_po" });
  return r.outcome;
}

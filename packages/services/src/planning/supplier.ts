import { adminDb, and, eq, recordAudit, schema, type Database } from "@keel/db";
import { tablePdf } from "@keel/core";
import type { ServiceContext } from "../context";
import { notifyUsers } from "../notifications";
import { transitionPurchaseOrder } from "../purchasing";

/**
 * Resolves the tenant of a supplier confirmation token. This is the only cross-tenant read of
 * the flow (the public page has no session); everything after it runs inside `withTenant`.
 */
export async function tenantForSupplierToken(token: string, db?: Database): Promise<{ tenantId: string; poId: string } | null> {
  if (!token || token.length < 16) return null;
  const [row] = await (db ?? adminDb()).select({ tenantId: schema.purchaseOrders.tenantId, poId: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.supplierToken, token)).limit(1);
  return row ?? null;
}

export interface SupplierPoView {
  id: string;
  number: string;
  status: string;
  currency: string;
  expectedAt: Date | null;
  notes: string | null;
  supplierName: string;
  companyName: string;
  ackAt: Date | null;
  ackNote: string | null;
  totalMinor: number;
  lines: { sku: string | null; supplierSku: string | null; label: string; quantity: number; unitCostMinor: number; totalMinor: number }[];
}

/** What the supplier sees: the order, no internal costs beyond the agreed unit price. */
export async function supplierPoView(ctx: ServiceContext, poId: string): Promise<SupplierPoView | null> {
  const [po] = await ctx.tx
    .select({ po: schema.purchaseOrders, supplierName: schema.suppliers.name, companyName: schema.tenants.name })
    .from(schema.purchaseOrders)
    .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.purchaseOrders.tenantId))
    .where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId)))
    .limit(1);
  if (!po) return null;
  const lines = await ctx.tx
    .select({ sku: schema.productVariants.sku, title: schema.productVariants.title, product: schema.products.title, quantity: schema.purchaseOrderLines.quantity, unitCostMinor: schema.purchaseOrderLines.unitCostMinor, supplierSku: schema.supplierVariants.supplierSku })
    .from(schema.purchaseOrderLines)
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.purchaseOrderLines.variantId))
    .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .leftJoin(schema.supplierVariants, and(eq(schema.supplierVariants.variantId, schema.purchaseOrderLines.variantId), eq(schema.supplierVariants.supplierId, po.po.supplierId)))
    .where(eq(schema.purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(schema.productVariants.sku);
  return {
    id: po.po.id,
    number: po.po.number,
    status: po.po.status,
    currency: po.po.currency,
    expectedAt: po.po.expectedAt,
    notes: po.po.notes,
    supplierName: po.supplierName,
    companyName: po.companyName,
    ackAt: po.po.supplierAckAt,
    ackNote: po.po.supplierAckNote,
    totalMinor: po.po.totalMinor,
    lines: lines.map((l) => ({ sku: l.sku, supplierSku: l.supplierSku, label: `${l.product ?? ""} ${l.title ?? ""}`.trim(), quantity: l.quantity, unitCostMinor: l.unitCostMinor, totalMinor: l.quantity * l.unitCostMinor })),
  };
}

export class SupplierAckError extends Error {}

/**
 * The supplier confirms (optionally with a new delivery date) or flags a problem with a note.
 * Confirming moves a sent PO to confirmed (incoming stock then counts for backorders); a
 * problem only stores the note and notifies the team. Both are audited as system actions.
 */
export async function supplierAcknowledge(ctx: ServiceContext, poId: string, input: { decision: "confirm" | "problem"; expectedAt?: Date | null; note?: string | null }): Promise<{ status: string }> {
  const [po] = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId))).limit(1);
  if (!po) throw new SupplierAckError("not_found");
  if (!["sent", "confirmed"].includes(po.status)) throw new SupplierAckError("closed");
  if (input.decision === "problem" && !input.note?.trim()) throw new SupplierAckError("note_required");
  const now = ctx.now ?? new Date();
  const note = input.note?.trim().slice(0, 2000) || null;
  let status = po.status;
  if (input.decision === "confirm" && po.status === "sent") status = (await transitionPurchaseOrder(ctx, poId, "confirmed")).to;
  const expectedAt = input.decision === "confirm" && input.expectedAt ? input.expectedAt : po.expectedAt;
  await ctx.tx.update(schema.purchaseOrders).set({ supplierAckAt: now, supplierAckNote: note, expectedAt }).where(eq(schema.purchaseOrders.id, poId));
  await recordAudit(ctx.tx, {
    tenantId: ctx.tenantId,
    actorType: "system",
    action: input.decision === "confirm" ? "purchase_order.supplier_confirmed" : "purchase_order.supplier_problem",
    entityType: "purchase_order",
    entityId: poId,
    diff: { status: { from: po.status, to: status }, ...(expectedAt?.getTime() !== po.expectedAt?.getTime() ? { expectedAt: { from: po.expectedAt, to: expectedAt } } : {}) },
    metadata: { note },
  });
  if (po.createdBy) await notifyUsers(ctx, { userIds: [po.createdBy], type: input.decision === "confirm" ? "po_supplier_confirmed" : "po_supplier_problem", severity: input.decision === "confirm" ? "success" : "warning", title: po.number, body: note, link: `/purchasing/${poId}` });
  return { status };
}

export interface PoPdfLabels {
  title: string;
  supplier: string;
  expected: string;
  sku: string;
  item: string;
  quantity: string;
  unitPrice: string;
  total: string;
  confirmAt: string;
  notes: string;
}

/** The purchase order as a PDF for the supplier (agreed prices only, no landed cost). */
export async function purchaseOrderPdf(ctx: ServiceContext, poId: string, labels: PoPdfLabels, format: { money: (minor: number) => string; date: (d: Date) => string }, confirmUrl?: string | null): Promise<{ filename: string; bytes: Uint8Array } | null> {
  const view = await supplierPoView(ctx, poId);
  if (!view) return null;
  const bytes = tablePdf({
    title: `${labels.title} ${view.number}`,
    header: [view.companyName, `${labels.supplier}: ${view.supplierName}`, ...(view.expectedAt ? [`${labels.expected}: ${format.date(view.expectedAt)}`] : [])],
    columns: [
      { label: labels.sku, width: 110 },
      { label: labels.item, width: 200 },
      { label: labels.quantity, width: 50, align: "right" },
      { label: labels.unitPrice, width: 70, align: "right" },
      { label: labels.total, width: 69, align: "right" },
    ],
    rows: view.lines.map((l) => [l.supplierSku ?? l.sku ?? "", l.label, String(l.quantity), format.money(l.unitCostMinor), format.money(l.totalMinor)]),
    totals: [[labels.total, format.money(view.totalMinor)]],
    footer: [...(view.notes ? [`${labels.notes}: ${view.notes}`] : []), ...(confirmUrl ? [`${labels.confirmAt}: ${confirmUrl}`] : [])],
  });
  return { filename: `${view.number}.pdf`, bytes };
}

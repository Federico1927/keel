import { and, eq, inArray, schema } from "@keel/db";
import { canDeletePo, canEditPo, diffRecords, poLinesDiff, type Diff } from "@keel/core";
import type { ServiceContext } from "../context";
import { recomputeLandedCost } from "../planning";
import { PurchasingError, insertPoLines, nextPoNumber, normalizePoInput, recomputePoTotal, refreshBackorders, type PoLineInput } from "./index";

export interface UpdatePoInput {
  supplierId: string;
  destinationLocationId: string | null;
  expectedAt: Date | null;
  notes: string | null;
  lines: PoLineInput[];
}

async function loadPo(ctx: ServiceContext, poId: string) {
  const [po] = await ctx.tx.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.tenantId, ctx.tenantId), eq(schema.purchaseOrders.id, poId))).limit(1);
  if (!po) throw new PurchasingError("not_found");
  return po;
}

/**
 * Edits a draft or sent PO: header fields and lines (replaced as a whole). Backorders that waited
 * on a replaced line move to the new line of the same variant; landed cost is reallocated. The
 * supplier of a sent PO is fixed (the supplier already has it). Returns the diff for the audit.
 */
export async function updatePurchaseOrder(ctx: ServiceContext, poId: string, input: UpdatePoInput): Promise<{ diff: Diff; lines: ReturnType<typeof poLinesDiff> }> {
  const po = await loadPo(ctx, poId);
  if (!canEditPo(po.status)) throw new PurchasingError("invalid_transition");
  if (po.status !== "draft" && input.supplierId !== po.supplierId) throw new PurchasingError("invalid_transition");
  const lines = await normalizePoInput(ctx, input);
  const before = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
  const header = { supplierId: input.supplierId, destinationLocationId: input.destinationLocationId, expectedAt: input.expectedAt, notes: input.notes?.trim() || null };
  const diff = diffRecords({ supplierId: po.supplierId, destinationLocationId: po.destinationLocationId, expectedAt: po.expectedAt, notes: po.notes }, header);
  const linesDiff = poLinesDiff(before, lines.map((l) => ({ variantId: l.variantId, description: l.description ?? null, quantity: l.quantity, unitCostMinor: l.unitCostMinor })));
  await ctx.tx.update(schema.purchaseOrders).set(header).where(eq(schema.purchaseOrders.id, poId));
  const waiting = before.length ? await ctx.tx.select({ id: schema.backorders.id, variantId: schema.backorders.variantId }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.purchaseOrderLineId, before.map((l) => l.id)))) : [];
  await ctx.tx.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
  const inserted = await insertPoLines(ctx, poId, lines);
  for (const b of waiting) {
    const target = inserted.find((l) => l.variantId === b.variantId);
    await ctx.tx.update(schema.backorders).set({ purchaseOrderLineId: target?.id ?? null }).where(eq(schema.backorders.id, b.id));
  }
  await recomputePoTotal(ctx, poId);
  await recomputeLandedCost(ctx, poId);
  await refreshBackorders(ctx, [...new Set([...before, ...inserted].map((l) => l.variantId).filter((v): v is string => Boolean(v)))]);
  return { diff, lines: linesDiff };
}

/** Copies any PO (header and lines, no receipts, charges or supplier answers) into a new draft. */
export async function duplicatePurchaseOrder(ctx: ServiceContext, poId: string): Promise<{ id: string; number: string }> {
  const po = await loadPo(ctx, poId);
  const lines = await ctx.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId));
  if (!lines.length) throw new PurchasingError("invalid_quantity");
  const number = await nextPoNumber(ctx);
  const [copy] = await ctx.tx.insert(schema.purchaseOrders).values({ tenantId: ctx.tenantId, supplierId: po.supplierId, number, status: "draft", currency: po.currency, destinationLocationId: po.destinationLocationId, expectedAt: null, notes: po.notes, source: "manual", createdBy: ctx.actor.userId }).returning({ id: schema.purchaseOrders.id });
  await insertPoLines(ctx, copy!.id, lines.map((l) => ({ variantId: l.variantId, description: l.description, quantity: l.quantity, unitCostMinor: l.unitCostMinor })));
  await recomputePoTotal(ctx, copy!.id);
  return { id: copy!.id, number };
}

/** Deletes a draft or cancelled PO with its lines, charges and supplier links. */
export async function deletePurchaseOrder(ctx: ServiceContext, poId: string): Promise<{ number: string; status: string; totalMinor: number; supplierId: string }> {
  const po = await loadPo(ctx, poId);
  if (!canDeletePo(po.status)) throw new PurchasingError("invalid_transition");
  const variants = (await ctx.tx.select({ v: schema.purchaseOrderLines.variantId }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, poId))).map((r) => r.v).filter((v): v is string => Boolean(v));
  await ctx.tx.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  await refreshBackorders(ctx, variants);
  return { number: po.number, status: po.status, totalMinor: po.totalMinor, supplierId: po.supplierId };
}

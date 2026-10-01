import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, schema } from "@keel/db";
import { A4, renderPdf, type PdfItem } from "@keel/core";
import type { Address, ReturnLabelProvider } from "@keel/integrations";
import type { ServiceContext } from "../context";

/* ---------- order tracking for the end customer ---------- */

export interface CustomerTracking {
  orderName: string;
  status: string;
  placedAt: Date;
  shipments: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; status: string; shippedAt: Date | null; deliveredAt: Date | null; estimatedDelivery: Date | null; events: { status: string; description: string | null; location: string | null; occurredAt: Date }[] }[];
}

/** What the customer may see about their order: status, parcels and carrier events. No prices, no notes. */
export async function customerTracking(ctx: ServiceContext, orderId: string): Promise<CustomerTracking | null> {
  const [o] = await ctx.tx.select({ name: schema.orders.name, status: schema.orders.status, placedAt: schema.orders.placedAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o) return null;
  const shipments = await ctx.tx.select().from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(asc(schema.shipments.createdAt));
  const events = shipments.length ? await ctx.tx.select().from(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, shipments.map((s) => s.id))).orderBy(desc(schema.shipmentEvents.occurredAt)) : [];
  return {
    orderName: o.name,
    status: o.status,
    placedAt: o.placedAt,
    shipments: shipments.map((s) => ({
      carrier: s.carrier,
      trackingNumber: s.trackingNumber,
      trackingUrl: s.trackingUrl,
      status: s.status,
      shippedAt: s.shippedAt,
      deliveredAt: s.deliveredAt,
      estimatedDelivery: s.estimatedDelivery,
      events: events.filter((e) => e.shipmentId === s.id).map((e) => ({ status: e.status, description: e.description, location: e.location, occurredAt: e.occurredAt })),
    })),
  };
}

/* ---------- return labels ---------- */

function linkSecret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.APP_ENCRYPTION_KEY;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return `return-label:${s}`;
}

/** Long-lived signed link to a return's label (the customer opens it from the confirmation or an email). */
export function signReturnLink(tenantId: string, returnId: string): string {
  return createHmac("sha256", linkSecret()).update(`${tenantId}:${returnId}`).digest("base64url").slice(0, 32);
}
export function verifyReturnLink(tenantId: string, returnId: string, sig: string): boolean {
  const expected = Buffer.from(signReturnLink(tenantId, returnId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Issues the return label through the provider and stores carrier and tracking on the return. */
export async function createReturnLabel(ctx: ServiceContext, provider: ReturnLabelProvider, returnId: string, destination: string): Promise<{ carrier: string; trackingCode: string }> {
  const [r] = await ctx.tx.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, orderId: schema.returnRequests.orderId }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!r) throw new Error("not_found");
  const [o] = await ctx.tx.select({ shippingAddress: schema.orders.shippingAddress }).from(schema.orders).where(eq(schema.orders.id, r.orderId)).limit(1);
  const label = await provider.createLabel({ reference: `R-${r.number}-${r.id}`, from: (o?.shippingAddress as Address | null) ?? null, to: destination, weightGrams: null });
  await ctx.tx.update(schema.returnRequests).set({ trackingCode: label.trackingCode, trackingCarrier: label.carrier, labelProvider: provider.provider, labelCreatedAt: ctx.now ?? new Date() }).where(eq(schema.returnRequests.id, r.id));
  return { carrier: label.carrier, trackingCode: label.trackingCode };
}

/** The label as a printable A4 PDF: sender, destination, return number, carrier and tracking code. */
export async function returnLabelPdf(ctx: ServiceContext, returnId: string, labels: { title: string; from: string; to: string; reference: string; carrier: string; tracking: string; instructions: string }, destination: string): Promise<{ filename: string; bytes: Uint8Array } | null> {
  const [r] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!r?.labelProvider || !r.trackingCode) return null;
  const [o] = await ctx.tx.select({ name: schema.orders.name, customerName: schema.orders.customerName, shippingAddress: schema.orders.shippingAddress }).from(schema.orders).where(eq(schema.orders.id, r.orderId)).limit(1);
  const a = (o?.shippingAddress as Address | null) ?? null;
  const fromLines = [o?.customerName ?? a?.name ?? "", a?.address1 ?? "", a?.address2 ?? "", [a?.zip, a?.city].filter(Boolean).join(" "), a?.country ?? ""].filter(Boolean);
  const m = 56;
  let y = A4.height - m;
  const items: PdfItem[] = [{ x: m, y, text: labels.title, size: 22, bold: true }];
  y -= 40;
  items.push({ x: m, y, text: labels.from, size: 10, bold: true });
  for (const l of fromLines) items.push({ x: m, y: (y -= 14), text: l, size: 11 });
  y -= 30;
  items.push({ x: m, y, text: labels.to, size: 10, bold: true });
  for (const l of destination.split(/\r?\n/).filter(Boolean)) items.push({ x: m, y: (y -= 20), text: l, size: 16, bold: true });
  y -= 30;
  items.push({ kind: "rule", x1: m, x2: A4.width - m, y });
  items.push({ x: m, y: (y -= 28), text: `${labels.reference}: R-${r.number} · ${o?.name ?? ""}`, size: 13 });
  items.push({ x: m, y: (y -= 24), text: `${labels.carrier}: ${r.trackingCarrier ?? ""}`, size: 13 });
  items.push({ x: m, y: (y -= 34), text: `${labels.tracking}: ${r.trackingCode}`, size: 20, bold: true });
  items.push({ kind: "rule", x1: m, x2: A4.width - m, y: (y -= 16) });
  for (const l of labels.instructions.split(/\r?\n/).filter(Boolean)) items.push({ x: m, y: (y -= 16), text: l, size: 10 });
  return { filename: `return-R-${r.number}.pdf`, bytes: renderPdf([items], { title: `R-${r.number}` }) };
}

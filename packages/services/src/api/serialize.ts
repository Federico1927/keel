import type { schema } from "@hullwise/db";

/**
 * Resource shapes of the public REST API (#81), shared by the API responses and the webhook
 * payloads. Amounts are integers in minor units next to their `currency`; dates are ISO 8601 UTC.
 * `pii: "omit"` (webhooks) leaves personal data out entirely; the API returns it and masks it
 * afterwards unless the token may see it (`maskPii`, the MCP rules).
 */

export type PiiOutput = "include" | "omit";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type OrderRow = typeof schema.orders.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type VariantRow = typeof schema.productVariants.$inferSelect;
type ShipmentRow = typeof schema.shipments.$inferSelect;
type ReturnRow = typeof schema.returnRequests.$inferSelect;
type DiscountRow = typeof schema.discounts.$inferSelect;
type PurchaseOrderRow = typeof schema.purchaseOrders.$inferSelect;

export function serializeOrder(o: OrderRow, pii: PiiOutput = "include") {
  return {
    id: o.id,
    object: "order" as const,
    name: o.name,
    number: o.orderNumber,
    externalId: o.externalId,
    status: o.status,
    statusReason: o.statusReason,
    statusChangedAt: iso(o.statusChangedAt),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    shippingMinor: o.shippingMinor,
    taxMinor: o.taxMinor,
    totalMinor: o.totalMinor,
    refundedMinor: o.refundedMinor,
    customerId: o.customerId,
    ...(pii === "include" ? { customerName: o.customerName, email: o.email, phone: o.phone, shippingAddress: (o.shippingAddress as Record<string, unknown> | null) ?? null } : {}),
    shippingCountry: o.shippingCountry,
    channel: o.sourceChannel,
    tags: o.platformTags,
    assignedTo: o.assignedTo,
    placedAt: iso(o.placedAt),
    cancelledAt: iso(o.cancelledAt),
    cancelReason: o.cancelReason,
    updatedAt: iso(o.updatedAt),
  };
}

export function serializeOrderLine(l: typeof schema.orderLines.$inferSelect) {
  return { id: l.id, productId: l.productId, variantId: l.variantId, sku: l.sku, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, currentQuantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, discountMinor: l.discountMinor, totalMinor: l.totalMinor };
}

/** Diff keys that hold personal data: dropped from timeline entries when the caller may not see PII. */
const PII_DIFF_KEYS = new Set(["email", "phone", "customerName", "shippingAddress", "billingAddress", "note", "firstName", "lastName"]);

export function serializeOrderEvent(e: typeof schema.orderEvents.$inferSelect, pii: PiiOutput = "include") {
  const meta = (e.metadata ?? {}) as Record<string, unknown>;
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  // the timeline's own fields; free text in metadata (notes, reasons) stays inside Hullwise
  return { id: e.id, orderId: e.orderId, type: e.type, actorType: e.actorType, actorUserId: e.actorUserId, diff: pii === "include" ? diff : Object.fromEntries(Object.entries(diff).filter(([k]) => !PII_DIFF_KEYS.has(k))), source: typeof meta.source === "string" ? meta.source : null, createdAt: iso(e.createdAt) };
}

export function serializeCustomer(c: CustomerRow, pii: PiiOutput = "include") {
  return {
    id: c.id,
    object: "customer" as const,
    externalId: c.externalId,
    ...(pii === "include" ? { firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, zip: c.zip } : {}),
    city: c.city,
    country: c.country,
    acceptsMarketing: c.acceptsMarketing,
    tags: c.tags,
    ordersCount: c.ordersCount,
    totalSpentMinor: c.totalSpentMinor,
    firstOrderAt: iso(c.firstOrderAt),
    lastOrderAt: iso(c.lastOrderAt),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export function serializeVariant(v: VariantRow) {
  return { id: v.id, object: "variant" as const, productId: v.productId, externalId: v.externalId, sku: v.sku, barcode: v.barcode, title: v.title, options: v.optionValues, priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, costMinor: v.costMinor, weightGrams: v.weightGrams, isActive: v.isActive, updatedAt: iso(v.updatedAt) };
}

export function serializeProduct(p: ProductRow, variants: readonly VariantRow[]) {
  return { id: p.id, object: "product" as const, externalId: p.externalId, title: p.title, handle: p.handle, vendor: p.vendor, productType: p.productType, status: p.status, tags: p.tags, options: p.options, imageUrl: p.imageUrl, variants: variants.map(serializeVariant), createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) };
}

export function serializeInventoryLevel(l: typeof schema.inventoryLevels.$inferSelect, extra: { sku: string | null; locationName: string | null }) {
  return { id: l.id, object: "inventory_level" as const, variantId: l.variantId, sku: extra.sku, locationId: l.locationId, locationName: extra.locationName, available: l.available, committed: l.committed, onHand: l.onHand, updatedAt: iso(l.updatedAt) };
}

export function serializeShipment(s: ShipmentRow) {
  return { id: s.id, object: "shipment" as const, orderId: s.orderId, externalId: s.externalId, status: s.status, carrier: s.carrier, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl, exceptionReason: s.exceptionReason, shippedAt: iso(s.shippedAt), deliveredAt: iso(s.deliveredAt), estimatedDelivery: iso(s.estimatedDelivery), lastEventAt: iso(s.lastEventAt), createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) };
}

export function serializeReturn(r: ReturnRow, pii: PiiOutput = "include") {
  return {
    id: r.id,
    object: "return" as const,
    orderId: r.orderId,
    number: r.number,
    externalId: r.externalId,
    status: r.status,
    reasonCode: r.reasonCode,
    resolution: r.resolution,
    source: r.source,
    proposedAmountMinor: r.proposedAmountMinor,
    refundedAmountMinor: r.refundedAmountMinor,
    ...(pii === "include" ? { customerNote: r.customerNote } : {}),
    requestedAt: iso(r.requestedAt),
    approvedAt: iso(r.approvedAt),
    receivedAt: iso(r.receivedAt),
    closedAt: iso(r.closedAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function serializeDiscount(d: DiscountRow) {
  return { id: d.id, object: "discount" as const, code: d.code, title: d.title, type: d.type, value: d.value, minimumAmountMinor: d.minimumAmountMinor, usageLimit: d.usageLimit, usedCount: d.usedCount, isActive: d.isActive, source: d.source, poolId: d.poolId, startsAt: iso(d.startsAt), endsAt: iso(d.endsAt), createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt) };
}

export function serializePurchaseOrder(p: PurchaseOrderRow, extra: { supplierName: string | null }) {
  return { id: p.id, object: "purchase_order" as const, number: p.number, status: p.status, supplierId: p.supplierId, supplierName: extra.supplierName, currency: p.currency, totalMinor: p.totalMinor, destinationLocationId: p.destinationLocationId, orderedAt: iso(p.orderedAt), expectedAt: iso(p.expectedAt), receivedAt: iso(p.receivedAt), cancelledAt: iso(p.cancelledAt), createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) };
}

export function serializePurchaseOrderLine(l: typeof schema.purchaseOrderLines.$inferSelect) {
  return { id: l.id, variantId: l.variantId, description: l.description, quantity: l.quantity, receivedQuantity: l.receivedQuantity, unitCostMinor: l.unitCostMinor };
}

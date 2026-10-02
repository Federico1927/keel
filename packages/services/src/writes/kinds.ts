import { and, eq, schema } from "@keel/db";
import { IntegrationError, type NormalizedFulfillment, type NormalizedOrder } from "@keel/integrations";
import { defineAdsWrite, defineCommerceWrite } from "./registry";

/* The platform writes Keel makes today. Each is one registration: provider, target, execution, optional follow-up. */

const date = (v: string | null | undefined) => (v ? new Date(v) : null);
const d = (v: unknown) => (v ? new Date(v as string) : null);

/** A `NormalizedOrder` read back from JSON (dates were serialized). */
export function reviveOrder(raw: unknown): NormalizedOrder {
  const o = raw as NormalizedOrder;
  return { ...o, customer: o.customer ? { ...o.customer, platformCreatedAt: d(o.customer.platformCreatedAt) } : null, placedAt: new Date(o.placedAt), platformUpdatedAt: new Date(o.platformUpdatedAt), cancelledAt: d(o.cancelledAt), closedAt: d(o.closedAt), fulfillments: o.fulfillments.map((f) => ({ ...f, createdAt: new Date(f.createdAt), updatedAt: new Date(f.updatedAt), deliveredAt: d(f.deliveredAt) })) };
}

defineCommerceWrite("variant.update", {
  target: (p) => `variant:${p.variantExternalId}:price`,
  supersedes: true,
  execute: (platform, p) => platform.updateVariant(p.variantExternalId, { priceMinor: p.priceMinor }),
});

defineCommerceWrite("variant.prices", {
  // the fields written are part of the target: a newer price + compare-at patch replaces an older one with the same fields
  target: (p) => `variant:${p.variantExternalId}:prices:${Object.keys(p.patch).sort().join("+")}`,
  supersedes: true,
  execute: (platform, p) => platform.updateVariant(p.variantExternalId, p.patch),
});

defineCommerceWrite("variant.cost", {
  target: (p) => `variant:${p.variantExternalId}:cost`,
  supersedes: true,
  execute: (platform, p) => platform.updateVariantCost({ variantExternalId: p.variantExternalId, inventoryItemExternalId: p.inventoryItemExternalId }, p.costMinor),
});

defineCommerceWrite("product.status", {
  target: (p) => `product:${p.productExternalId}:status`,
  supersedes: true,
  execute: (platform, p) => platform.updateProductStatus(p.productExternalId, p.status),
});

defineCommerceWrite("product.tags", {
  target: (p) => `product:${p.productExternalId}:tags`,
  execute: (platform, p) => platform.updateProductTags(p.productExternalId, p.add, p.remove),
});

defineCommerceWrite("inventory.set", {
  target: (p) => `inventory:${p.inventoryItemExternalId}@${p.locationExternalId}`,
  supersedes: true,
  execute: (platform, p) => platform.setInventory(p.inventoryItemExternalId, p.locationExternalId, p.available),
});

defineCommerceWrite("inventory.restock", {
  target: (p) => `inventory:restock:${p.lines.map((l) => `${l.inventoryItemExternalId}@${l.locationExternalId}`).sort().join(",")}`,
  execute: (platform, p) => platform.restockInventory(p.lines),
});

defineCommerceWrite("order.cancel", {
  target: (p) => `order:${p.orderExternalId}:cancel`,
  execute: (platform, p) => platform.cancelOrder(p.orderExternalId, { reason: p.reason, restock: p.restock, refund: p.refund }),
});

defineCommerceWrite("order.update_details", {
  target: (p) => `order:${p.orderExternalId}:details`,
  execute: (platform, p) => platform.updateOrderDetails(p.orderExternalId, p.patch),
});

defineCommerceWrite("order.discount", {
  target: (p) => `order:${p.orderExternalId}:discount:${p.discount.code}`,
  execute: (platform, p) => platform.applyOrderDiscount(p.orderExternalId, p.discount),
});

defineCommerceWrite("order.tags", {
  target: (p) => `order:${p.orderExternalId}:tags`,
  execute: (platform, p) => platform.updateOrderTags(p.orderExternalId, p.add, p.remove),
});

// backorders: callers key each hold by its episode and each release by the hold it lifts, so hold → release → hold is three writes
defineCommerceWrite("order.fulfillment_hold", {
  target: (p) => `order:${p.orderExternalId}:fulfillment_hold`,
  execute: (platform, p) => platform.holdFulfillment(p.orderExternalId, p.hold),
});
defineCommerceWrite("order.fulfillment_release", {
  target: (p) => `order:${p.orderExternalId}:fulfillment_release`,
  execute: (platform, p) => platform.releaseFulfillment(p.orderExternalId),
});

// payments (issue #27): each manual payment and each refund is one-shot, keyed by the caller
defineCommerceWrite("order.mark_paid", {
  target: (p) => `order:${p.orderExternalId}:payment`,
  execute: (platform, p) => platform.markOrderPaid(p.orderExternalId, { amountMinor: p.amountMinor, currency: p.currency, method: p.method, fullBalance: p.fullBalance, note: p.note ?? null }),
});
defineCommerceWrite("order.refund", {
  target: (p) => `order:${p.orderExternalId}:refund`,
  execute: (platform, p) => platform.refundOrder(p.orderExternalId, { lines: p.lines, locationExternalId: p.locationExternalId ?? null, amountMinor: p.amountMinor, currency: p.currency, note: p.note ?? null, notify: p.notify }),
});

defineCommerceWrite("order.create", {
  target: (p) => `order:create:${p.input.replacesOrderName ?? p.input.noteAttributes.find((a) => a.name === "keel_return_id")?.value ?? "new"}`,
  execute: (platform, p) => platform.createOrder(p.input),
  revive: reviveOrder,
});

defineCommerceWrite("order.create_invoice", {
  target: (p) => `draft:create:${p.input.noteAttributes.find((a) => a.name === "keel_return_id")?.value ?? "new"}`,
  execute: (platform, p) => platform.createInvoiceOrder(p.input),
});

defineCommerceWrite("discount.create", {
  target: (p) => `discount:${p.code}`,
  execute: (platform, p) => platform.createDiscountCode({ code: p.code, title: p.title, type: p.type, value: p.value, startsAt: date(p.startsAt), endsAt: date(p.endsAt), usageLimit: p.usageLimit ?? null, minimumAmountMinor: p.minimumAmountMinor ?? null }),
  onSuccess: async (ctx, write, result) => {
    if (write.entityType === "discount" && write.entityId) await ctx.tx.update(schema.discounts).set({ externalId: result.externalId, syncedAt: ctx.now ?? new Date() }).where(and(eq(schema.discounts.tenantId, ctx.tenantId), eq(schema.discounts.id, write.entityId)));
  },
});

defineCommerceWrite("discount.pool", {
  target: (p) => `discount_pool:${p.poolExternalId ?? p.title}:${p.codes[0] ?? ""}:${p.codes.length}`,
  execute: async (platform, p) => (p.poolExternalId ? { externalId: p.poolExternalId, ...(await platform.addDiscountPoolCodes(p.poolExternalId, p.codes)) } : platform.createDiscountPool({ title: p.title, codes: p.codes, type: p.type, value: p.value, startsAt: date(p.startsAt), endsAt: date(p.endsAt) })),
});

// on/off is an absolute value: a newer switch on the same code or pool replaces an older one still waiting
defineCommerceWrite("discount.status", {
  target: (p) => `discount:${p.code}:status`,
  supersedes: true,
  execute: (platform, p) => platform.setDiscountActive({ externalId: p.discountExternalId, code: p.code, poolExternalId: p.poolExternalId }, p.active),
  onSuccess: async (ctx, write) => {
    if (write.entityType === "discount" && write.entityId) await ctx.tx.update(schema.discounts).set({ syncedAt: ctx.now ?? new Date() }).where(and(eq(schema.discounts.tenantId, ctx.tenantId), eq(schema.discounts.id, write.entityId)));
  },
});
defineCommerceWrite("discount_pool.status", {
  target: (p) => `discount_pool:${p.poolExternalId}:status`,
  supersedes: true,
  execute: (platform, p) => platform.setDiscountPoolActive(p.poolExternalId, p.active),
});

defineCommerceWrite("return.request", {
  target: (p) => `return:${p.orderExternalId}:request:${p.lines.map((l) => l.orderLineExternalId).sort().join(",")}`,
  execute: (platform, p) => platform.requestReturn(p.orderExternalId, { lines: p.lines, note: p.note }),
});
defineCommerceWrite("return.approve", { target: (p) => `return:${p.returnExternalId}:approve`, execute: (platform, p) => platform.approveReturn(p.returnExternalId) });
defineCommerceWrite("return.decline", { target: (p) => `return:${p.returnExternalId}:decline`, execute: (platform, p) => platform.declineReturn(p.returnExternalId, p.note) });
defineCommerceWrite("return.refund", { target: (p) => `order:${p.orderExternalId}:refund`, execute: (platform, p) => platform.refundReturn(p.orderExternalId, { lines: p.lines, amountMinor: p.amountMinor, currency: p.currency, note: p.note, notify: p.notify }) });
defineCommerceWrite("return.close", { target: (p) => `return:${p.returnExternalId}:close`, execute: (platform, p) => platform.closeReturn(p.returnExternalId) });

/** A `NormalizedFulfillment` read back from JSON. */
export function reviveFulfillment(raw: unknown): NormalizedFulfillment {
  const f = raw as NormalizedFulfillment;
  return { ...f, createdAt: new Date(f.createdAt), updatedAt: new Date(f.updatedAt), deliveredAt: d(f.deliveredAt) };
}

// ship from Keel (issue #28): one fulfilment per order and tracking number; executed synchronously, the shipment is imported from the answer
defineCommerceWrite("fulfillment.create", {
  target: (p) => `order:${p.input.orderExternalId}:fulfillment:${p.input.trackingNumber}`,
  execute: (platform, p) => platform.createFulfillment(p.input),
  revive: reviveFulfillment,
});

defineAdsWrite("campaign.status", {
  provider: (p) => p.provider,
  target: (p) => `campaign:${p.provider}:${p.campaignExternalId}:status`,
  supersedes: true,
  execute: (platform, p) => platform.setCampaignStatus(p.campaignExternalId, p.status),
  onSuccess: async (ctx, write) => {
    if (write.entityType === "campaign" && write.entityId) await ctx.tx.update(schema.campaigns).set({ syncedAt: ctx.now ?? new Date() }).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.id, write.entityId)));
  },
});

// ads below the campaign (issue #40): pausing an ad is an absolute value; a negative keyword is one-shot
defineAdsWrite("ad.status", {
  provider: (p) => p.provider,
  target: (p) => `ad:${p.provider}:${p.adExternalId}:status`,
  supersedes: true,
  execute: async (platform, p) => {
    if (!platform.setAdStatus) throw new IntegrationError("unsupported", `${platform.provider} cannot pause ads`);
    await platform.setAdStatus({ adExternalId: p.adExternalId, adSetExternalId: p.adSetExternalId }, p.status);
  },
  onSuccess: async (ctx, write) => {
    if (write.entityType === "ad" && write.entityId) await ctx.tx.update(schema.adCreatives).set({ syncedAt: ctx.now ?? new Date() }).where(and(eq(schema.adCreatives.tenantId, ctx.tenantId), eq(schema.adCreatives.id, write.entityId)));
  },
});

defineAdsWrite("keyword.negative", {
  provider: (p) => p.provider,
  target: (p) => `negative:${p.provider}:${p.campaignExternalId}:${p.adSetExternalId ?? "-"}:${p.matchType}:${p.text}`,
  execute: async (platform, p) => {
    if (!platform.addNegativeKeywords) throw new IntegrationError("unsupported", `${platform.provider} has no keywords`);
    return platform.addNegativeKeywords([{ campaignExternalId: p.campaignExternalId, adSetExternalId: p.adSetExternalId, text: p.text, matchType: p.matchType }]);
  },
});

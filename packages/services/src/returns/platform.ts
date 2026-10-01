import { and, eq, inArray, schema, sql } from "@keel/db";
import { RETURN_CLOSED_STATUSES, RETURN_GOODS_BACK_STATUSES, type TenantSettings } from "@keel/core";
import type { Address, CommercePlatform, PaymentGuarantee } from "@keel/integrations";
import { getPaymentGuaranteeFor } from "../integrations/factory";
import { importOrder } from "../sync";
import { getReturnPolicy } from "./policy";
import type { ServiceContext } from "../context";

export interface ReturnSyncResult {
  status: "synced" | "not_required" | "error";
  steps: string[];
  error?: string;
}

/**
 * Brings the platform in line with the return as Keel sees it, one idempotent step at a time:
 * request → approve (or decline) → restock → refund → close, plus the tenant's order tags for the
 * current status. Each step is saved as soon as it succeeds, so a failure halfway is resumed by
 * the next call (the retry button or the background job) without repeating what already happened.
 * Runs outside the transaction that changed the return: a platform outage never blocks the team.
 */
export async function syncReturnToPlatform(ctx: ServiceContext, platform: CommercePlatform, settings: TenantSettings, returnId: string, opts: { guarantee?: PaymentGuarantee; country?: string } = {}): Promise<ReturnSyncResult> {
  const now = ctx.now ?? new Date();
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!req) throw new Error("not_found");
  const [order] = await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId, currency: schema.orders.currency, email: schema.orders.email, phone: schema.orders.phone, name: schema.orders.name, shippingAddress: schema.orders.shippingAddress, shippingCountry: schema.orders.shippingCountry, customerExternalId: schema.customers.externalId }).from(schema.orders).leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId)).where(eq(schema.orders.id, req.orderId)).limit(1);
  const save = (patch: Partial<typeof schema.returnRequests.$inferInsert>) => ctx.tx.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, req.id));
  if (!settings.returnsWriteBack || !order?.externalId) {
    await save({ platformSyncStatus: "not_required", platformError: null });
    return { status: "not_required", steps: [] };
  }
  const steps: string[] = [];
  let state = { externalId: req.externalId, platformStatus: req.platformStatus, platformRefundId: req.platformRefundId };
  const policy = await getReturnPolicy(ctx);
  const guarantee = opts.guarantee ?? getPaymentGuaranteeFor(ctx.tenantId);
  try {
    const lines = await ctx.tx
      .select({ id: schema.returnLines.id, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, restocked: schema.returnLines.restocked, platformRestocked: schema.returnLines.platformRestocked, orderLineExternalId: schema.orderLines.externalId, inventoryItemExternalId: schema.productVariants.inventoryItemExternalId })
      .from(schema.returnLines)
      .innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId))
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(eq(schema.returnLines.returnId, req.id));
    const [reason] = await ctx.tx.select({ platformReason: schema.returnReasons.platformReason }).from(schema.returnReasons).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.code, req.reasonCode))).limit(1);
    const withExt = lines.filter((l) => l.orderLineExternalId);

    // 1. request (returns that came from the platform already exist there)
    if (!state.externalId && req.status !== "rejected" && withExt.length) {
      const r = await platform.requestReturn(order.externalId, { lines: withExt.map((l) => ({ orderLineExternalId: l.orderLineExternalId!, quantity: l.quantity, reason: reason?.platformReason ?? null, note: req.customerNote })), note: req.customerNote });
      state = { ...state, externalId: r.externalId, platformStatus: "requested" };
      await save({ externalId: r.externalId, platformStatus: "requested" });
      for (const rl of r.lines) {
        const line = withExt.find((l) => l.orderLineExternalId === rl.orderLineExternalId);
        if (line) await ctx.tx.update(schema.returnLines).set({ externalId: rl.externalId }).where(eq(schema.returnLines.id, line.id));
      }
      steps.push("requested");
    }
    // 2. approve or decline
    if (state.externalId && req.status === "rejected" && state.platformStatus === "requested") {
      await platform.declineReturn(state.externalId, req.staffNote);
      state.platformStatus = "declined";
      await save({ platformStatus: "declined" });
      steps.push("declined");
    }
    if (state.externalId && !["requested", "rejected"].includes(req.status) && state.platformStatus === "requested") {
      await platform.approveReturn(state.externalId);
      state.platformStatus = "approved";
      await save({ platformStatus: "approved" });
      steps.push("approved");
    }
    // 3. restock what was put back on the shelf in Keel
    const toRestock = lines.filter((l) => l.restocked && !l.platformRestocked && l.inventoryItemExternalId);
    if (toRestock.length && req.restockLocationId) {
      const [loc] = await ctx.tx.select({ externalId: schema.locations.externalId }).from(schema.locations).where(eq(schema.locations.id, req.restockLocationId)).limit(1);
      if (loc?.externalId) {
        await platform.restockInventory(toRestock.map((l) => ({ inventoryItemExternalId: l.inventoryItemExternalId!, locationExternalId: loc.externalId!, quantity: l.quantity })));
        await ctx.tx.update(schema.returnLines).set({ platformRestocked: true }).where(inArray(schema.returnLines.id, toRestock.map((l) => l.id)));
        steps.push("restocked");
      }
    }
    // 4. refund (vouchers and exchanges move no money on the original payment)
    if (req.status === "refunded" && !state.platformRefundId && withExt.length) {
      const r = await platform.refundReturn(order.externalId, { lines: withExt.map((l) => ({ orderLineExternalId: l.orderLineExternalId!, quantity: l.quantity })), amountMinor: req.refundedAmountMinor ?? 0, currency: order.currency, note: `R-${req.number}`, notify: true });
      state.platformRefundId = r.externalId;
      await save({ platformRefundId: r.externalId });
      steps.push("refunded");
    }
    // 4b. voucher: a one-use code on the store for the credit (with the bonus)
    if (req.status === "voucher_issued" && req.voucherCode && !req.voucherPlatformId && (req.refundedAmountMinor ?? 0) > 0) {
      const v = await platform.createDiscountCode({ code: req.voucherCode, title: `Return R-${req.number}`, type: "fixed_amount", value: req.refundedAmountMinor!, usageLimit: 1 });
      await save({ voucherPlatformId: v.externalId });
      steps.push("voucher");
    }
    // 4c. exchange: the replacement order once the goods are checked, or at approval for an instant exchange
    const instant = policy.instantExchange.enabled && req.resolution === "exchange";
    const exchangeLines = await ctx.tx.select({ quantity: schema.returnExchangeLines.quantity, unitPriceMinor: schema.returnExchangeLines.unitPriceMinor, title: schema.returnExchangeLines.title, variantExternalId: schema.productVariants.externalId, sku: schema.productVariants.sku }).from(schema.returnExchangeLines).innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.returnExchangeLines.variantId)).where(eq(schema.returnExchangeLines.returnId, req.id));
    if (instant && exchangeLines.length && req.status === "approved" && !req.guaranteeAuthId) {
      const value = lines.reduce((sum, l) => sum + l.quantity * l.unitAmountMinor, 0);
      const auth = await guarantee.authorize({ amountMinor: value, currency: order.currency, customerEmail: order.email, reference: `R-${req.number}` });
      const expires = new Date(now.getTime() + policy.instantExchange.days * 864e5);
      await save({ guaranteeAuthId: auth.authId, guaranteeStatus: auth.status === "authorized" ? "authorized" : "failed", guaranteeAmountMinor: value, guaranteeExpiresAt: expires, ...(auth.status !== "authorized" ? { needsReview: true } : {}) });
      req.guaranteeAuthId = auth.authId;
      req.guaranteeStatus = auth.status === "authorized" ? "authorized" : "failed";
      steps.push(`guarantee_${req.guaranteeStatus}`);
    }
    const exchangeDue = exchangeLines.length > 0 && !req.exchangeOrderId && !req.exchangeDraftId && (req.status === "exchanged" || (instant && req.status === "approved" && req.guaranteeStatus === "authorized"));
    if (exchangeDue && exchangeLines.every((l) => l.variantExternalId)) {
      const newItems = exchangeLines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
      const credit = newItems - (req.exchangeDifferenceMinor ?? 0);
      const input = {
        lines: exchangeLines.map((l) => ({ variantExternalId: l.variantExternalId, sku: l.sku, title: l.title, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
        currency: order.currency,
        email: order.email,
        phone: order.phone,
        customerExternalId: order.customerExternalId ?? null,
        shippingAddress: (order.shippingAddress as Address | null) ?? null,
        billingAddress: null,
        shippingMinor: 0,
        discountMinor: Math.max(0, Math.min(newItems, credit)),
        note: `Exchange for return R-${req.number} (${order.name})`,
        tags: ["exchange"],
        noteAttributes: [{ name: "keel_return_id", value: req.id }],
        replacesOrderName: null,
      };
      if ((req.exchangeDifferenceMinor ?? 0) > 0) {
        const d = await platform.createInvoiceOrder(input);
        await save({ exchangeDraftId: d.draftExternalId, exchangeInvoiceUrl: d.invoiceUrl });
        steps.push("exchange_invoice");
      } else {
        const created = await platform.createOrder(input);
        const imported = await importOrder(ctx, created, { country: opts.country ?? order.shippingCountry ?? "US", source: "sync" });
        await save({ exchangeOrderId: imported.id });
        steps.push("exchange_order");
        const leftover = -(req.exchangeDifferenceMinor ?? 0);
        if (leftover > 0 && policy.exchanges.refundDifference && !state.platformRefundId && withExt.length) {
          const r = await platform.refundReturn(order.externalId, { lines: [], amountMinor: leftover, currency: order.currency, note: `R-${req.number} exchange difference`, notify: true });
          state.platformRefundId = r.externalId;
          await save({ platformRefundId: r.externalId });
          steps.push("difference_refunded");
        }
      }
    }
    // 4d. the goods came back: release the instant-exchange hold
    if (req.guaranteeStatus === "authorized" && req.guaranteeAuthId && (RETURN_GOODS_BACK_STATUSES as readonly string[]).includes(req.status)) {
      await guarantee.void(req.guaranteeAuthId);
      await save({ guaranteeStatus: "voided" });
      steps.push("guarantee_voided");
    }
    // 5. close
    if (state.externalId && (RETURN_CLOSED_STATUSES as readonly string[]).includes(req.status) && req.status !== "rejected" && state.platformStatus === "approved") {
      await platform.closeReturn(state.externalId);
      state.platformStatus = "closed";
      await save({ platformStatus: "closed" });
      steps.push("closed");
    }
    // 6. tags configured for this status (adding a tag twice is harmless)
    const tags = settings.returnPlatformTags[req.status] ?? [];
    if (tags.length) {
      await platform.updateOrderTags(order.externalId, tags, []);
      steps.push("tagged");
    }
    await save({ platformSyncStatus: "synced", platformError: null, platformSyncedAt: now });
    if (steps.length) await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "return_updated", actorType: "system", actorUserId: null, diff: {}, metadata: { returnId: req.id, number: req.number, platform: steps }, createdAt: now });
    return { status: "synced", steps };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await save({ platformSyncStatus: "error", platformError: message });
    return { status: "error", steps, error: message };
  }
}

/** Returns waiting for the platform or that failed, oldest first (background retry). */
export async function returnsToSync(ctx: ServiceContext, limit = 50): Promise<string[]> {
  const rows = await ctx.tx.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), inArray(schema.returnRequests.platformSyncStatus, ["pending", "error"]), sql`${schema.returnRequests.updatedAt} < now() - interval '1 minute'`)).orderBy(schema.returnRequests.updatedAt).limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Instant exchanges whose goods never came back: capture the hold, flag the return for review.
 * Runs from the returns job.
 */
export async function captureOverdueGuarantees(ctx: ServiceContext, guarantee?: PaymentGuarantee): Promise<number> {
  const g = guarantee ?? getPaymentGuaranteeFor(ctx.tenantId);
  const now = ctx.now ?? new Date();
  const due = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.guaranteeStatus, "authorized"), sql`${schema.returnRequests.guaranteeExpiresAt} < ${now}`, inArray(schema.returnRequests.status, ["requested", "approved"])));
  for (const r of due) {
    await g.capture(r.guaranteeAuthId!, r.guaranteeAmountMinor ?? undefined);
    await ctx.tx.update(schema.returnRequests).set({ guaranteeStatus: "captured", needsReview: true, staffNote: [r.staffNote, "Instant exchange: goods not received in time, guarantee captured."].filter(Boolean).join("\n") }).where(eq(schema.returnRequests.id, r.id));
  }
  return due.length;
}

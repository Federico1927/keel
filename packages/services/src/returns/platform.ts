import { and, eq, inArray, schema, sql } from "@keel/db";
import { RETURN_CLOSED_STATUSES, type TenantSettings } from "@keel/core";
import type { CommercePlatform } from "@keel/integrations";
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
export async function syncReturnToPlatform(ctx: ServiceContext, platform: CommercePlatform, settings: TenantSettings, returnId: string): Promise<ReturnSyncResult> {
  const now = ctx.now ?? new Date();
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!req) throw new Error("not_found");
  const [order] = await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId, currency: schema.orders.currency }).from(schema.orders).where(eq(schema.orders.id, req.orderId)).limit(1);
  const save = (patch: Partial<typeof schema.returnRequests.$inferInsert>) => ctx.tx.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, req.id));
  if (!settings.returnsWriteBack || !order?.externalId) {
    await save({ platformSyncStatus: "not_required", platformError: null });
    return { status: "not_required", steps: [] };
  }
  const steps: string[] = [];
  let state = { externalId: req.externalId, platformStatus: req.platformStatus, platformRefundId: req.platformRefundId };
  try {
    const lines = await ctx.tx
      .select({ id: schema.returnLines.id, quantity: schema.returnLines.quantity, restocked: schema.returnLines.restocked, platformRestocked: schema.returnLines.platformRestocked, orderLineExternalId: schema.orderLines.externalId, inventoryItemExternalId: schema.productVariants.inventoryItemExternalId })
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

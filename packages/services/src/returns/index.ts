import { and, desc, eq, gte, inArray, lt, schema, sql, type SQL } from "@keel/db";
import { SALE_STATUSES, canTransitionReturn, isReturnStatus, creditWithBonus, customerLimitReached, exchangeQuote, lineBlock, optionReturnRates, returnCostsOfPeriod, lineWindowDays, proposedReturnAmount, returnEligibility, returnableLines, type LineBlock, type Eligibility, type Period, type ReturnStatus, type ReturnableLine, type TenantSettings, returnsAgeing, type ReturnsAgeing } from "@keel/core";
import { syncRecordTasks } from "../tasks";
import type { ServiceContext } from "../context";
import { applyReturnToOrder } from "./effects";
import { notifyReturnCustomer, returnEmailEventFor } from "./notify";

import { ReturnError } from "./errors";
import { applyReturnAutomations, customerReturnStats, getReturnPolicy } from "./policy";

export { ReturnError };

/* ---------- reasons ---------- */

export async function listReturnReasons(ctx: ServiceContext, onlyActive = false) {
  const conds = [eq(schema.returnReasons.tenantId, ctx.tenantId)];
  if (onlyActive) conds.push(eq(schema.returnReasons.isActive, true));
  return ctx.tx.select().from(schema.returnReasons).where(and(...conds)).orderBy(schema.returnReasons.sortOrder, schema.returnReasons.label);
}

export async function saveReturnReason(ctx: ServiceContext, input: { code: string; label: string; defaultFault: "merchant" | "customer" | "undetermined"; sortOrder?: number; platformReason?: string | null; labels?: Record<string, string> }, reasonId?: string): Promise<string> {
  const code = input.code.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40);
  if (!code || !input.label.trim()) throw new ReturnError("invalid_input");
  if (reasonId) {
    await ctx.tx.update(schema.returnReasons).set({ label: input.label.trim(), defaultFault: input.defaultFault, sortOrder: input.sortOrder ?? 0, ...(input.platformReason !== undefined ? { platformReason: input.platformReason } : {}), ...(input.labels ? { labels: input.labels } : {}) }).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.id, reasonId)));
    return reasonId;
  }
  const [row] = await ctx.tx.insert(schema.returnReasons).values({ tenantId: ctx.tenantId, code, label: input.label.trim(), defaultFault: input.defaultFault, sortOrder: input.sortOrder ?? 0, platformReason: input.platformReason ?? null, labels: input.labels ?? {} }).onConflictDoUpdate({ target: [schema.returnReasons.tenantId, schema.returnReasons.code], set: { label: input.label.trim(), defaultFault: input.defaultFault, isActive: true, platformReason: input.platformReason ?? null, labels: input.labels ?? {} } }).returning({ id: schema.returnReasons.id });
  return row!.id;
}

export async function setReturnReasonActive(ctx: ServiceContext, reasonId: string, isActive: boolean): Promise<void> {
  await ctx.tx.update(schema.returnReasons).set({ isActive }).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.id, reasonId)));
}

/* ---------- eligibility and creation ---------- */

export type LineReturnBlock = LineBlock | "expired";

export interface OrderReturnContext {
  order: typeof schema.orders.$inferSelect;
  /** Order-level view: eligible when at least one line can be returned now. */
  eligibility: Omit<Eligibility, "reason"> & { reason: Eligibility["reason"] | "customer_limit" | "nothing_returnable" };
  lines: (ReturnableLine & { title: string; variantTitle: string | null; sku: string | null; variantId: string | null; block: LineReturnBlock | null; deadline: Date | null; windowDays: number; maxQuantity: number })[];
  openReturns: number;
  customerLimitReached: boolean;
}

/**
 * What a staff member or the customer sees before opening a return. Each line gets its own
 * window (policy rules by country, product type, tag) and its own block (exclusions, final
 * sale, expired). `returnable` is what can be returned now; `maxQuantity` ignores the policy
 * and is what staff may still return with an override and a note.
 */
export async function orderReturnContext(ctx: ServiceContext, settings: TenantSettings, orderId: string): Promise<OrderReturnContext> {
  const now = ctx.now ?? new Date();
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new ReturnError("order_not_found");
  const policy = await getReturnPolicy(ctx);
  const [shipment] = await ctx.tx.select({ deliveredAt: schema.shipments.deliveredAt, shippedAt: schema.shipments.shippedAt }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(desc(schema.shipments.createdAt)).limit(1);
  const lines = await ctx.tx
    .select({ id: schema.orderLines.id, quantity: schema.orderLines.quantity, unitPriceMinor: schema.orderLines.unitPriceMinor, totalMinor: schema.orderLines.totalMinor, discountMinor: schema.orderLines.discountMinor, isAncillary: schema.orderLines.isAncillary, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, sku: schema.orderLines.sku, variantId: schema.orderLines.variantId, productType: schema.products.productType, tags: schema.products.tags, compareAtMinor: schema.productVariants.compareAtMinor })
    .from(schema.orderLines)
    .leftJoin(schema.products, eq(schema.products.id, schema.orderLines.productId))
    .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
    .where(eq(schema.orderLines.orderId, orderId));
  const previous = await ctx.tx.select({ orderLineId: schema.returnLines.orderLineId, qty: sql<number>`sum(${schema.returnLines.quantity})::int` }).from(schema.returnLines).innerJoin(schema.returnRequests, eq(schema.returnRequests.id, schema.returnLines.returnId)).where(and(eq(schema.returnRequests.orderId, orderId), sql`${schema.returnRequests.status} <> 'rejected'`)).groupBy(schema.returnLines.orderLineId);
  const previouslyReturned = Object.fromEntries(previous.map((p) => [p.orderLineId, p.qty]));
  const base = returnableLines(lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.totalMinor, productType: l.productType, isAncillary: l.isAncillary })), order.discountMinor, previouslyReturned, []);
  // order-level state with the longest line window: cancelled / not delivered apply to every line
  const windows = lines.map((l) => lineWindowDays({ productType: l.productType, tags: l.tags ?? [] }, order.shippingCountry, policy, settings.returnWindowDays));
  const orderLevel = returnEligibility({ orderStatus: order.status, deliveredAt: shipment?.deliveredAt ?? null, shippedAt: shipment?.shippedAt ?? null, now, windowDays: Math.max(settings.returnWindowDays, ...windows), shippingFallbackDays: settings.returnShippingFallbackDays });
  const delivery = orderLevel.deliveryDate;
  const computed = base.map((c, i) => {
    const l = lines[i]!;
    const listMinor = l.unitPriceMinor * l.quantity;
    const lineDiscountBps = listMinor > 0 ? Math.round((l.discountMinor / listMinor) * 10000) : 0;
    const compareBps = l.compareAtMinor && l.compareAtMinor > l.unitPriceMinor ? Math.round(((l.compareAtMinor - l.unitPriceMinor) / l.compareAtMinor) * 10000) : 0;
    const policyBlock = l.isAncillary ? null : lineBlock({ id: l.id, productType: l.productType, sku: l.sku, title: l.title, tags: l.tags ?? [], discountBps: Math.max(lineDiscountBps, compareBps) }, policy, settings.returnExcludedProductTypes);
    const windowDays = windows[i]!;
    const deadline = delivery ? new Date(delivery.getTime() + windowDays * 864e5) : null;
    const expired = Boolean(deadline && deadline.getTime() < now.getTime());
    const block: LineReturnBlock | null = policyBlock ?? (orderLevel.reason === null || orderLevel.reason === "expired" ? (expired ? "expired" : null) : null);
    const maxQuantity = l.isAncillary ? 0 : Math.max(0, l.quantity - c.alreadyReturned);
    const open = orderLevel.reason === null || orderLevel.reason === "expired";
    return { ...c, excluded: c.excluded || policyBlock !== null, returnable: open && !block ? maxQuantity : 0, title: l.title, variantTitle: l.variantTitle, sku: l.sku, variantId: l.variantId, block, deadline, windowDays, maxQuantity };
  });
  const stats = policy.customerLimit ? await customerReturnStats(ctx, policy, orderId) : null;
  const limitReached = stats ? customerLimitReached(policy, stats.returnDates, now) : false;
  const anyReturnable = computed.some((l) => l.returnable > 0);
  const lastDeadline = computed.filter((l) => !l.block || l.block === "expired").reduce<Date | null>((m, l) => (l.deadline && (!m || l.deadline > m) ? l.deadline : m), null);
  const eligibility: OrderReturnContext["eligibility"] =
    orderLevel.reason === "cancelled" || orderLevel.reason === "not_delivered"
      ? orderLevel
      : limitReached
        ? { ...orderLevel, eligible: false, reason: "customer_limit" }
        : anyReturnable
          ? { eligible: true, reason: null, deliveryDate: delivery, deadline: lastDeadline, daysLeft: lastDeadline ? Math.floor((lastDeadline.getTime() - now.getTime()) / 864e5) : null }
          : computed.some((l) => l.block === "expired")
            ? { eligible: false, reason: "expired", deliveryDate: delivery, deadline: lastDeadline, daysLeft: lastDeadline ? Math.floor((lastDeadline.getTime() - now.getTime()) / 864e5) : null }
            : { ...orderLevel, eligible: false, reason: "nothing_returnable" };
  const [open] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.orderId, orderId), sql`${schema.returnRequests.status} not in ('refunded','exchanged','voucher_issued','rejected')`));
  return { order, eligibility, lines: computed, openReturns: open?.n ?? 0, customerLimitReached: limitReached };
}

export interface CreateReturnInput {
  orderId: string;
  reasonCode: string;
  resolution: "refund" | "exchange" | "voucher";
  lines: { orderLineId: string; quantity: number }[];
  customerNote?: string | null;
  staffNote?: string | null;
  /** Staff can open a return outside the window; a note is then mandatory. */
  overrideWindow?: boolean;
  source?: "staff" | "portal" | "platform";
  trackingCode?: string | null;
  trackingCarrier?: string | null;
  exchangeNote?: string | null;
  customFields?: Record<string, string | boolean>;
  bankDetailsEnc?: string | null;
  customerLocale?: string | null;
  idempotencyKey?: string | null;
  /** Exchange: per returned line, the variant (same product) and quantity wanted instead. */
  exchangeLines?: { orderLineId: string; variantId: string; quantity: number }[];
}

/**
 * Exchange lines: each wanted variant must belong to the same product as the returned line and
 * not exceed the returned quantity; the price is the variant's current price. Stores the
 * difference against the credit of the returned units.
 */
async function saveExchangeLines(ctx: ServiceContext, returnId: string, wantedLines: { orderLineId: string; variantId: string; quantity: number }[], inserted: { id: string; orderLineId: string }[], returned: { orderLineId: string; quantity: number }[], context: OrderReturnContext): Promise<void> {
  const policy = await getReturnPolicy(ctx);
  if (!policy.exchanges.enabled) throw new ReturnError("invalid_input");
  const orderLines = await ctx.tx.select({ id: schema.orderLines.id, productId: schema.orderLines.productId }).from(schema.orderLines).where(inArray(schema.orderLines.id, returned.map((r) => r.orderLineId)));
  const variants = await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, title: schema.productVariants.title, productTitle: schema.products.title, priceMinor: schema.productVariants.priceMinor, isActive: schema.productVariants.isActive }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, wantedLines.map((w) => w.variantId))));
  const rows: (typeof schema.returnExchangeLines.$inferInsert)[] = [];
  for (const w of wantedLines.filter((x) => x.quantity > 0)) {
    const back = returned.find((r) => r.orderLineId === w.orderLineId);
    const ol = orderLines.find((o) => o.id === w.orderLineId);
    const v = variants.find((x) => x.id === w.variantId);
    if (!back || !ol || !v || !v.isActive || v.productId !== ol.productId || w.quantity > back.quantity) throw new ReturnError("invalid_input");
    rows.push({ tenantId: ctx.tenantId, returnId, returnLineId: inserted.find((i) => i.orderLineId === w.orderLineId)?.id ?? null, variantId: v.id, title: `${v.productTitle} ${v.title}`.trim(), quantity: w.quantity, unitPriceMinor: v.priceMinor });
  }
  if (!rows.length) return;
  await ctx.tx.insert(schema.returnExchangeLines).values(rows);
  const quote = exchangeQuote(returned.map((r) => ({ quantity: r.quantity, unitNetMinor: context.lines.find((l) => l.id === r.orderLineId)!.unitNetMinor })), rows.map((r) => ({ quantity: r.quantity, unitPriceMinor: r.unitPriceMinor })));
  await ctx.tx.update(schema.returnRequests).set({ exchangeDifferenceMinor: quote.differenceMinor }).where(eq(schema.returnRequests.id, returnId));
}

/** Variants of the same product a customer can exchange each line for: active, in stock, any price. */
export async function exchangeOptions(ctx: ServiceContext, orderLineIds: string[]): Promise<Record<string, { variantId: string; title: string; priceMinor: number; available: number }[]>> {
  if (!orderLineIds.length) return {};
  const rows = await ctx.tx.execute<{ order_line_id: string; variant_id: string; title: string; price_minor: number; available: number }>(sql`
    select ol.id as order_line_id, v.id as variant_id, v.title, v.price_minor, coalesce(sum(il.available), 0)::int as available
    from order_lines ol
    join product_variants v on v.product_id = ol.product_id and v.is_active and v.tenant_id = ${ctx.tenantId}
    left join inventory_levels il on il.variant_id = v.id
    where ol.tenant_id = ${ctx.tenantId} and ol.id = any(${sql.param(orderLineIds)}::uuid[])
    group by 1, 2, 3, 4
    having coalesce(sum(il.available), 0) > 0
    order by 1, 3`);
  const out: Record<string, { variantId: string; title: string; priceMinor: number; available: number }[]> = {};
  for (const r of rows.rows) (out[r.order_line_id] ??= []).push({ variantId: r.variant_id, title: r.title, priceMinor: Number(r.price_minor), available: Number(r.available) });
  return out;
}

export async function createReturn(ctx: ServiceContext, settings: TenantSettings, input: CreateReturnInput): Promise<{ id: string; number: number }> {
  const now = ctx.now ?? new Date();
  const context = await orderReturnContext(ctx, settings, input.orderId);
  const reason = (await listReturnReasons(ctx, true)).find((r) => r.code === input.reasonCode);
  if (!reason) throw new ReturnError("bad_reason");
  // staff may override the window, exclusions and the customer limit with a note; never a cancelled or undelivered order, never the portal
  const override = input.source !== "portal" && input.overrideWindow === true && Boolean(input.staffNote?.trim());
  if (context.eligibility.reason === "cancelled" || context.eligibility.reason === "not_delivered") throw new ReturnError("not_eligible");
  if (context.customerLimitReached && !override) throw new ReturnError("customer_limit");
  const wanted = input.lines.filter((l) => l.quantity > 0);
  if (!wanted.length) throw new ReturnError("no_lines");
  let outOfPolicy = false;
  for (const w of wanted) {
    const line = context.lines.find((l) => l.id === w.orderLineId);
    if (!line || w.quantity > line.maxQuantity) throw new ReturnError("quantity_exceeds");
    if (line.block) {
      if (!override) throw new ReturnError(line.block === "expired" ? "not_eligible" : "line_blocked");
      outOfPolicy = true;
    }
  }
  if (context.customerLimitReached) outOfPolicy = true;
  const [maxRow] = await ctx.tx.select({ n: sql<number>`coalesce(max(${schema.returnRequests.number}), 0)::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId));
  const number = (maxRow?.n ?? 0) + 1;
  const amounts = proposedReturnAmount(wanted.map((w) => ({ quantity: w.quantity, unitNetMinor: context.lines.find((l) => l.id === w.orderLineId)!.unitNetMinor })), reason.defaultFault, settings.returnShippingCostMinor);
  const [row] = await ctx.tx
    .insert(schema.returnRequests)
    .values({
      tenantId: ctx.tenantId,
      orderId: input.orderId,
      number,
      status: "requested",
      reasonCode: reason.code,
      resolution: input.resolution,
      fault: reason.defaultFault,
      customerNote: input.customerNote ?? null,
      staffNote: input.staffNote ?? null,
      proposedAmountMinor: amounts.proposedMinor,
      deductionMinor: amounts.deductionMinor,
      outOfWindow: outOfPolicy,
      requestedAt: now,
      createdBy: ctx.actor.userId,
      source: input.source ?? "staff",
      trackingCode: input.trackingCode ?? null,
      trackingCarrier: input.trackingCarrier ?? null,
      exchangeNote: input.exchangeNote ?? null,
      customFields: input.customFields ?? {},
      bankDetailsEnc: input.bankDetailsEnc ?? null,
      customerLocale: input.customerLocale ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      platformSyncStatus: input.source === "platform" ? "synced" : "pending",
    })
    .returning({ id: schema.returnRequests.id });
  const insertedLines = await ctx.tx.insert(schema.returnLines).values(wanted.map((w) => ({ tenantId: ctx.tenantId, returnId: row!.id, orderLineId: w.orderLineId, quantity: w.quantity, unitAmountMinor: context.lines.find((l) => l.id === w.orderLineId)!.unitNetMinor }))).returning({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId });
  if (input.resolution === "exchange" && input.exchangeLines?.length) await saveExchangeLines(ctx, row!.id, input.exchangeLines, insertedLines, wanted, context);
  else if (input.resolution === "voucher") {
    const policy = await getReturnPolicy(ctx);
    const { bonusMinor } = creditWithBonus(amounts.proposedMinor, policy.creditBonusBps);
    if (bonusMinor) await ctx.tx.update(schema.returnRequests).set({ creditBonusMinor: bonusMinor }).where(eq(schema.returnRequests.id, row!.id));
  }
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "return_requested", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { returnId: row!.id, number, reason: reason.code, resolution: input.resolution, outOfWindow: outOfPolicy, source: input.source ?? "staff" }, createdAt: now });
  // portal returns email the customer after the label is issued (`notifyReturnStatus` in portalSubmit), so the approval carries it
  if (input.source !== "platform") await applyReturnAutomations(ctx, settings, row!.id, (to, note) => transitionReturn({ ...ctx, actor: { type: "system", userId: null } }, { returnId: row!.id, to, note: `auto: ${note}`, notifyCustomer: input.source !== "portal" }));
  await syncRecordTasks(ctx, "return", [row!.id]);
  return { id: row!.id, number };
}

/* ---------- workflow ---------- */

export interface TransitionInput {
  returnId: string;
  to: ReturnStatus;
  note?: string | null;
  /** On `received`: which lines to put back to stock, and where. */
  restock?: { locationId: string; lineIds: string[] } | null;
  /** On `inspected`: per-line outcome and accepted amount. */
  inspection?: { lineId: string; outcome: "intact" | "damaged" | "missing"; amountMinor: number }[];
  /** On `refunded`: amount actually refunded (defaults to the inspected/proposed amount). */
  refundAmountMinor?: number | null;
  voucherCode?: string | null;
  fault?: "merchant" | "customer" | "undetermined";
  /** Status email to the customer when the store switched it on (default true). */
  notifyCustomer?: boolean;
}

export async function transitionReturn(ctx: ServiceContext, input: TransitionInput): Promise<{ previous: string; next: string }> {
  const now = ctx.now ?? new Date();
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, input.returnId))).limit(1);
  if (!req) throw new ReturnError("return_not_found");
  if (!isReturnStatus(input.to) || !canTransitionReturn(req.status, input.to)) throw new ReturnError("bad_transition");
  const lines = await ctx.tx.select({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, restocked: schema.returnLines.restocked, inspectionAmountMinor: schema.returnLines.inspectionAmountMinor, variantId: schema.orderLines.variantId }).from(schema.returnLines).innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId)).where(eq(schema.returnLines.returnId, req.id));
  // every change is written to the commerce platform afterwards (`syncReturnToPlatform`), never inside this transaction
  const patch: Partial<typeof schema.returnRequests.$inferInsert> = { status: input.to, updatedAt: now, platformSyncStatus: "pending" };
  if (input.note?.trim()) patch.staffNote = [req.staffNote, input.note.trim()].filter(Boolean).join("\n");
  if (input.fault) patch.fault = input.fault;
  if (input.to === "approved") patch.approvedAt = now;
  if (input.to === "received") {
    patch.receivedAt = now;
    if (input.restock && input.restock.lineIds.length) {
      if (!input.restock.locationId) throw new ReturnError("location_required");
      patch.restockLocationId = input.restock.locationId;
      const toRestock = lines.filter((l) => input.restock!.lineIds.includes(l.id) && !l.restocked && l.variantId);
      for (const l of toRestock) {
        await ctx.tx.insert(schema.inventoryMovements).values({ tenantId: ctx.tenantId, variantId: l.variantId!, locationId: input.restock.locationId, delta: l.quantity, reason: "return_restock", referenceType: "return", referenceId: req.id, actorUserId: ctx.actor.userId, note: `R-${req.number}`, createdAt: now });
        await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: l.variantId!, locationId: input.restock.locationId, available: l.quantity, updatedAt: now }).onConflictDoUpdate({ target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId], set: { available: sql`${schema.inventoryLevels.available} + ${l.quantity}`, updatedAt: now } });
        await ctx.tx.update(schema.returnLines).set({ restocked: true }).where(eq(schema.returnLines.id, l.id));
      }
    }
  }
  if (input.to === "inspected" && input.inspection) {
    for (const i of input.inspection) {
      if (!lines.some((l) => l.id === i.lineId)) throw new ReturnError("invalid_input");
      await ctx.tx.update(schema.returnLines).set({ inspectionOutcome: i.outcome, inspectionAmountMinor: Math.max(0, Math.round(i.amountMinor)) }).where(eq(schema.returnLines.id, i.lineId));
    }
  }
  const acceptedAmount = lines.reduce((s, l) => s + (l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor), 0);
  const inspectedAmount = input.inspection ? input.inspection.reduce((s, i) => s + Math.max(0, Math.round(i.amountMinor)), 0) : acceptedAmount;
  if (input.to === "refunded") {
    patch.refundedAmountMinor = Math.max(0, Math.round(input.refundAmountMinor ?? inspectedAmount));
    patch.closedAt = now;
  }
  if (input.to === "voucher_issued") {
    patch.voucherCode = input.voucherCode?.trim() || `V-${req.number}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    // the credit bonus applies to the accepted value, not to an amount typed by hand
    const base = Math.max(0, Math.round(input.refundAmountMinor ?? inspectedAmount));
    const bonus = input.refundAmountMinor == null ? creditWithBonus(base, (await getReturnPolicy(ctx)).creditBonusBps).bonusMinor : 0;
    patch.creditBonusMinor = bonus;
    patch.refundedAmountMinor = base + bonus;
    patch.closedAt = now;
  }
  if (input.to === "exchanged" || input.to === "rejected") patch.closedAt = now;
  await ctx.tx.update(schema.returnRequests).set(patch).where(eq(schema.returnRequests.id, req.id));

  // Propagate to the order: returned fraction from goods that came back, refund totals, payment status, canonical status.
  await applyReturnToOrder(ctx, req.orderId, { returnId: req.id, number: req.number, from: req.status, to: input.to });
  await syncRecordTasks(ctx, "return", [req.id]);
  const emailEvent = input.notifyCustomer === false ? null : returnEmailEventFor(input.to);
  if (emailEvent) await notifyReturnCustomer(ctx, req.id, emailEvent);
  return { previous: req.status, next: input.to };
}

/* ---------- lists and analytics ---------- */

export interface ReturnFilters {
  status?: string;
  source?: string;
  /** "error": write to the platform failed. */
  sync?: string;
  /** "1": flagged for review. */
  review?: string;
  reason?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listReturns(ctx: ServiceContext, f: ReturnFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(5000, Math.max(1, f.pageSize ?? 50));
  const conds: SQL[] = [eq(schema.returnRequests.tenantId, ctx.tenantId)];
  if (f.status === "open") conds.push(sql`${schema.returnRequests.status} not in ('refunded','exchanged','voucher_issued','rejected')`);
  else if (f.status) conds.push(eq(schema.returnRequests.status, f.status));
  if (f.reason) conds.push(eq(schema.returnRequests.reasonCode, f.reason));
  if (f.source) conds.push(eq(schema.returnRequests.source, f.source));
  if (f.sync === "error") conds.push(eq(schema.returnRequests.platformSyncStatus, "error"));
  if (f.review === "1") conds.push(eq(schema.returnRequests.needsReview, true));
  if (f.q) conds.push(sql`(${schema.orders.name} ilike ${"%" + f.q + "%"} or ${schema.orders.customerName} ilike ${"%" + f.q + "%"} or ${schema.orders.email} ilike ${"%" + f.q + "%"} or cast(${schema.returnRequests.number} as text) = ${f.q.replace(/^R-/i, "")})`);
  const where = and(...conds);
  const rows = await ctx.tx.select({ id: schema.returnRequests.id, number: schema.returnRequests.number, status: schema.returnRequests.status, reasonCode: schema.returnRequests.reasonCode, resolution: schema.returnRequests.resolution, fault: schema.returnRequests.fault, proposedAmountMinor: schema.returnRequests.proposedAmountMinor, refundedAmountMinor: schema.returnRequests.refundedAmountMinor, requestedAt: schema.returnRequests.requestedAt, closedAt: schema.returnRequests.closedAt, outOfWindow: schema.returnRequests.outOfWindow, source: schema.returnRequests.source, platformSyncStatus: schema.returnRequests.platformSyncStatus, needsReview: schema.returnRequests.needsReview, riskLevel: schema.returnRequests.riskLevel, returnless: schema.returnRequests.returnless, orderId: schema.orders.id, orderName: schema.orders.name, customerName: schema.orders.customerName, currency: schema.orders.currency, items: sql<number>`(select coalesce(sum(l.quantity),0) from return_lines l where l.return_id = ${schema.returnRequests.id})::int` }).from(schema.returnRequests).innerJoin(schema.orders, eq(schema.orders.id, schema.returnRequests.orderId)).where(where).orderBy(desc(schema.returnRequests.requestedAt)).limit(pageSize).offset((page - 1) * pageSize);
  const [count] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).innerJoin(schema.orders, eq(schema.orders.id, schema.returnRequests.orderId)).where(where);
  const counts = await ctx.tx.select({ status: schema.returnRequests.status, n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId)).groupBy(schema.returnRequests.status);
  const [extra] = await ctx.tx.select({ syncErrors: sql<number>`count(*) filter (where ${schema.returnRequests.platformSyncStatus} = 'error')::int`, portal: sql<number>`count(*) filter (where ${schema.returnRequests.source} = 'portal')::int`, platform: sql<number>`count(*) filter (where ${schema.returnRequests.source} = 'platform')::int`, review: sql<number>`count(*) filter (where ${schema.returnRequests.needsReview} and ${schema.returnRequests.status} not in ('refunded','exchanged','voucher_issued','rejected'))::int` }).from(schema.returnRequests).where(eq(schema.returnRequests.tenantId, ctx.tenantId));
  return { rows, total: count?.n ?? 0, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>, syncErrors: extra?.syncErrors ?? 0, portalCount: extra?.portal ?? 0, platformCount: extra?.platform ?? 0, reviewCount: extra?.review ?? 0 };
}

export async function returnDetail(ctx: ServiceContext, returnId: string) {
  const [req] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!req) return null;
  const [order] = await ctx.tx.select().from(schema.orders).where(eq(schema.orders.id, req.orderId)).limit(1);
  const lines = await ctx.tx.select({ id: schema.returnLines.id, orderLineId: schema.returnLines.orderLineId, quantity: schema.returnLines.quantity, unitAmountMinor: schema.returnLines.unitAmountMinor, inspectionOutcome: schema.returnLines.inspectionOutcome, inspectionAmountMinor: schema.returnLines.inspectionAmountMinor, restocked: schema.returnLines.restocked, title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, sku: schema.orderLines.sku, variantId: schema.orderLines.variantId, productId: schema.orderLines.productId }).from(schema.returnLines).innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId)).where(eq(schema.returnLines.returnId, req.id));
  const [reason] = await ctx.tx.select().from(schema.returnReasons).where(and(eq(schema.returnReasons.tenantId, ctx.tenantId), eq(schema.returnReasons.code, req.reasonCode))).limit(1);
  const events = await ctx.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, req.orderId), sql`${schema.orderEvents.metadata}->>'returnId' = ${req.id}`)).orderBy(desc(schema.orderEvents.createdAt));
  const locations = await ctx.tx.select({ id: schema.locations.id, name: schema.locations.name, isDefault: schema.locations.isDefault }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.isActive, true))).orderBy(desc(schema.locations.isDefault), schema.locations.name);
  const exchangeLines = await ctx.tx.select().from(schema.returnExchangeLines).where(and(eq(schema.returnExchangeLines.tenantId, ctx.tenantId), eq(schema.returnExchangeLines.returnId, req.id)));
  const [exchangeOrder] = req.exchangeOrderId ? await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.id, req.exchangeOrderId)).limit(1) : [];
  return { request: req, order: order!, lines, reason: reason ?? null, events, locations, exchangeLines, exchangeOrder: exchangeOrder ?? null };
}

export interface ReturnsAnalytics {
  total: number;
  closed: number;
  refundedMinor: number;
  soldOrders: number;
  returnRate: number | null;
  byReason: { reasonCode: string; label: string; count: number; amountMinor: number; share: number }[];
  byFault: { fault: string; count: number; amountMinor: number }[];
  byProduct: { productId: string | null; title: string; returnedQty: number; soldQty: number; rate: number | null; amountMinor: number }[];
  byResolution: { resolution: string; count: number }[];
  /** Return rate per option value of the variants (size, colour…). */
  byOption: { option: string; value: string; sold: number; returned: number; rate: number }[];
  /** Value kept in the store: returns resolved by exchange or store credit instead of a refund. */
  keptMinor: number;
  creditIssuedMinor: number;
  bonusMinor: number;
  /** Exchange orders created and the extra revenue paid by customers on them. */
  exchanges: number;
  upsellMinor: number;
  /** Labels and handling of the returns received in the period, net of deductions. */
  costs: { labelsMinor: number; handlingMinor: number; recoveredMinor: number; totalMinor: number };
  /** Days spent in each workflow state by the returns of the period, and how old the open ones are. */
  ageing: ReturnsAgeing;
}

export async function returnsAnalytics(ctx: ServiceContext, period: Period, costs: { labelMinor: number; handlingMinor: number } = { labelMinor: 0, handlingMinor: 0 }): Promise<ReturnsAnalytics> {
  const t = ctx.tenantId;
  const inPeriod = and(eq(schema.returnRequests.tenantId, t), gte(schema.returnRequests.requestedAt, period.from), lt(schema.returnRequests.requestedAt, period.to), sql`${schema.returnRequests.status} <> 'rejected'`);
  const [totals] = await ctx.tx.select({ total: sql<number>`count(*)::int`, closed: sql<number>`count(*) filter (where ${schema.returnRequests.closedAt} is not null)::int`, refunded: sql<number>`coalesce(sum(${schema.returnRequests.refundedAmountMinor}), 0)::int` }).from(schema.returnRequests).where(inPeriod);
  const [sold] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(eq(schema.orders.tenantId, t), gte(schema.orders.placedAt, period.from), lt(schema.orders.placedAt, period.to), inArray(schema.orders.status, [...SALE_STATUSES, "returned", "refunded"])));
  const byReason = await ctx.tx.select({ reasonCode: schema.returnRequests.reasonCode, label: sql<string>`coalesce(max(${schema.returnReasons.label}), ${schema.returnRequests.reasonCode})`, count: sql<number>`count(*)::int`, amountMinor: sql<number>`coalesce(sum(coalesce(${schema.returnRequests.refundedAmountMinor}, ${schema.returnRequests.proposedAmountMinor})), 0)::int` }).from(schema.returnRequests).leftJoin(schema.returnReasons, and(eq(schema.returnReasons.tenantId, schema.returnRequests.tenantId), eq(schema.returnReasons.code, schema.returnRequests.reasonCode))).where(inPeriod).groupBy(schema.returnRequests.reasonCode).orderBy(sql`count(*) desc`);
  const byFault = await ctx.tx.select({ fault: schema.returnRequests.fault, count: sql<number>`count(*)::int`, amountMinor: sql<number>`coalesce(sum(coalesce(${schema.returnRequests.refundedAmountMinor}, ${schema.returnRequests.proposedAmountMinor})), 0)::int` }).from(schema.returnRequests).where(inPeriod).groupBy(schema.returnRequests.fault);
  const byResolution = await ctx.tx.select({ resolution: schema.returnRequests.resolution, count: sql<number>`count(*)::int` }).from(schema.returnRequests).where(inPeriod).groupBy(schema.returnRequests.resolution);
  const byProduct = await ctx.tx.execute<{ product_id: string | null; title: string; returned_qty: number; sold_qty: number; amount_minor: number }>(sql`
    with ret as (
      select ol.product_id, max(ol.title) as title, sum(rl.quantity)::int as returned_qty, sum(rl.quantity * rl.unit_amount_minor)::int as amount_minor
      from return_lines rl join return_requests rr on rr.id = rl.return_id join order_lines ol on ol.id = rl.order_line_id
      where rr.tenant_id = ${t} and rr.requested_at >= ${period.from} and rr.requested_at < ${period.to} and rr.status <> 'rejected'
      group by ol.product_id
    ), sold as (
      select ol.product_id, sum(ol.quantity)::int as sold_qty
      from order_lines ol join orders o on o.id = ol.order_id
      where o.tenant_id = ${t} and o.placed_at >= ${period.from} and o.placed_at < ${period.to} and o.status <> 'cancelled' and ol.is_ancillary = false
      group by ol.product_id
    )
    select r.product_id, r.title, r.returned_qty, coalesce(s.sold_qty, 0) as sold_qty, r.amount_minor
    from ret r left join sold s on s.product_id is not distinct from r.product_id
    order by r.returned_qty desc limit 50`);
  const soldOpts = await ctx.tx.execute<{ options: Record<string, string>; quantity: number }>(sql`
    select v.option_values as options, sum(ol.quantity)::int as quantity from order_lines ol join orders o on o.id = ol.order_id join product_variants v on v.id = ol.variant_id
    where o.tenant_id = ${t} and o.placed_at >= ${period.from} and o.placed_at < ${period.to} and o.status <> 'cancelled' and ol.is_ancillary = false group by 1`);
  const returnedOpts = await ctx.tx.execute<{ options: Record<string, string>; quantity: number }>(sql`
    select v.option_values as options, sum(rl.quantity)::int as quantity from return_lines rl join return_requests rr on rr.id = rl.return_id join order_lines ol on ol.id = rl.order_line_id join product_variants v on v.id = ol.variant_id
    where rr.tenant_id = ${t} and rr.requested_at >= ${period.from} and rr.requested_at < ${period.to} and rr.status <> 'rejected' group by 1`);
  const [kept] = await ctx.tx.execute<{ kept: number; credit: number; bonus: number; exchanges: number; upsell: number }>(sql`
    select coalesce(sum(proposed_amount_minor) filter (where resolution in ('exchange','voucher') and status <> 'rejected'), 0)::int as kept,
      coalesce(sum(refunded_amount_minor) filter (where status = 'voucher_issued'), 0)::int as credit,
      coalesce(sum(credit_bonus_minor) filter (where status = 'voucher_issued'), 0)::int as bonus,
      count(*) filter (where exchange_order_id is not null or exchange_draft_id is not null)::int as exchanges,
      coalesce(sum(greatest(exchange_difference_minor, 0)) filter (where exchange_order_id is not null or exchange_draft_id is not null), 0)::int as upsell
    from return_requests where tenant_id = ${t} and requested_at >= ${period.from} and requested_at < ${period.to}`).then((r) => r.rows);
  const total = totals?.total ?? 0;
  // inspections have no column of their own: the timeline event that recorded them dates them
  const timelines = await ctx.tx.execute<{ status: string; requested_at: Date; approved_at: Date | null; received_at: Date | null; closed_at: Date | null; inspected_at: Date | null }>(sql`
    select rr.status, rr.requested_at, rr.approved_at, rr.received_at, rr.closed_at,
      (select min(e.created_at) from order_events e where e.order_id = rr.order_id and e.type = 'return_updated' and e.metadata->>'returnId' = rr.id::text and e.diff->'returnStatus'->>'to' = 'inspected') as inspected_at
    from return_requests rr where rr.tenant_id = ${t} and rr.requested_at >= ${period.from} and rr.requested_at < ${period.to}`);
  const at = (v: Date | string | null) => (v ? new Date(v) : null);
  const ageing = returnsAgeing(timelines.rows.map((r) => ({ status: r.status, requestedAt: new Date(r.requested_at), approvedAt: at(r.approved_at), receivedAt: at(r.received_at), closedAt: at(r.closed_at), inspectedAt: at(r.inspected_at) })), ctx.now ?? new Date());
  return {
    ageing,
    costs: returnCostsOfPeriod(
      (await ctx.tx.select({ returnless: schema.returnRequests.returnless, deductionMinor: schema.returnRequests.deductionMinor }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, t), gte(schema.returnRequests.receivedAt, period.from), lt(schema.returnRequests.receivedAt, period.to)))).map((r) => ({ goodsBack: true, returnless: r.returnless, deductionMinor: r.deductionMinor })),
      costs.labelMinor,
      costs.handlingMinor,
    ),
    byOption: optionReturnRates(soldOpts.rows.map((r) => ({ options: r.options ?? {}, quantity: Number(r.quantity) })), returnedOpts.rows.map((r) => ({ options: r.options ?? {}, quantity: Number(r.quantity) })), 5),
    keptMinor: Number(kept?.kept ?? 0),
    creditIssuedMinor: Number(kept?.credit ?? 0),
    bonusMinor: Number(kept?.bonus ?? 0),
    exchanges: Number(kept?.exchanges ?? 0),
    upsellMinor: Number(kept?.upsell ?? 0),
    total,
    closed: totals?.closed ?? 0,
    refundedMinor: totals?.refunded ?? 0,
    soldOrders: sold?.n ?? 0,
    returnRate: sold?.n ? total / sold.n : null,
    byReason: byReason.map((r) => ({ ...r, share: total ? r.count / total : 0 })),
    byFault,
    byResolution,
    byProduct: byProduct.rows.map((r) => ({ productId: r.product_id, title: r.title, returnedQty: r.returned_qty, soldQty: r.sold_qty, rate: r.sold_qty ? r.returned_qty / r.sold_qty : null, amountMinor: r.amount_minor })),
  };
}

export * from "./platform";
export * from "./effects";
export * from "./portal";
export * from "./policy";
export * from "./errors";
export * from "./customer";
export * from "./notify";

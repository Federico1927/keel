import { and, eq, inArray, schema } from "@keel/db";
import { addressKey, nameZipKey, normalizeEmail, normalizePhone } from "@keel/core";
import type { Address, CommercePlatform, CreateOrderInput } from "@keel/integrations";
import { applyCancellation, importOrder, type ServiceContext } from "@keel/services";
import { OPEN_QUEUE_STATUSES } from "../queue";
import { classifyTags } from "../tags";
import type { CodSettings } from "../settings";
import { CodError, applyTagEvent, getCodSettings, recordAttempt } from "./index";

/**
 * Pre-confirmation changes agreed on the phone. Two paths, as in the reference platform:
 * - contact changes (name, phone, email, address, note) are edited in place on the platform;
 * - line changes and merges replace the order: a new unpaid order is created, the old one(s)
 *   are cancelled with the "replaced" tag and linked both ways. Order editing APIs are avoided
 *   on purpose: a removed line stays visible to the warehouse and gets shipped anyway.
 */
export interface ModifyOrderInput {
  orderId: string;
  contact?: { customerName?: string | null; phone?: string | null; email?: string | null; shippingAddress?: Address | null; note?: string | null; noteMode?: "replace" | "append" };
  /** Desired lines after the change; omit to keep them. Either an existing line (by id) or a variant to add. */
  lines?: { lineId?: string; variantId?: string; quantity: number }[];
  /** Other open COD orders of the same customer folded into the replacement. */
  mergeOrderIds?: string[];
  attemptNote?: string | null;
  /** Also register a `modified` call outcome (default true). */
  registerAttempt?: boolean;
}
export type ModifyOrderResult = { kind: "updated"; orderId: string; changed: string[] } | { kind: "replaced"; orderId: string; newOrderId: string; newOrderName: string; merged: number; warning: "old_order_not_cancelled" | null };

type OrderRow = typeof schema.orders.$inferSelect;
type LineRow = typeof schema.orderLines.$inferSelect;

const sameAddress = (a: Address | null, b: Address | null) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function loadOrder(ctx: ServiceContext, orderId: string): Promise<{ order: OrderRow; lines: LineRow[] }> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new CodError("not_found");
  const lines = await ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)));
  return { order, lines };
}

async function requireOpenItem(ctx: ServiceContext, orderId: string) {
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as never)) throw new CodError("not_in_queue");
  return item;
}

/** Contact and note changes compared with the stored order; empty when nothing differs. */
function contactPatch(order: OrderRow, c: NonNullable<ModifyOrderInput["contact"]>, country: string) {
  const patch: Partial<OrderRow> = {};
  const platform: { shippingAddress?: Address | null; email?: string | null; phone?: string | null; note?: string | null } = {};
  const changed: string[] = [];
  if (c.customerName !== undefined && (c.customerName ?? null) !== order.customerName) {
    patch.customerName = c.customerName ?? null;
    changed.push("customerName");
  }
  if (c.phone !== undefined && (c.phone ?? null) !== order.phone) {
    patch.phone = c.phone ?? null;
    patch.phoneE164 = normalizePhone(c.phone, country);
    platform.phone = c.phone ?? null;
    changed.push("phone");
  }
  if (c.email !== undefined && (c.email ?? null) !== order.email) {
    patch.email = c.email ?? null;
    patch.emailNormalized = normalizeEmail(c.email);
    platform.email = c.email ?? null;
    changed.push("email");
  }
  if (c.shippingAddress !== undefined && !sameAddress(c.shippingAddress, order.shippingAddress as Address | null)) {
    const a = c.shippingAddress;
    patch.shippingAddress = a;
    patch.shippingCity = a?.city ?? null;
    patch.shippingZip = a?.zip ?? null;
    patch.shippingCountry = a?.country ?? null;
    patch.addressKey = addressKey(a);
    patch.nameZipKey = nameZipKey(a?.name ?? patch.customerName ?? order.customerName, a?.zip);
    platform.shippingAddress = a;
    changed.push("shippingAddress");
  }
  if (c.note !== undefined) {
    const next = c.noteMode === "append" && order.note ? `${order.note}\n${c.note ?? ""}`.trim() : (c.note ?? null);
    if ((next ?? null) !== (order.note ?? null)) {
      patch.note = next;
      platform.note = next;
      changed.push("note");
    }
  }
  return { patch, platform, changed };
}

export async function modifyCodOrder(ctx: ServiceContext, platform: CommercePlatform | undefined, input: ModifyOrderInput, opts: { country: string; settings?: CodSettings }): Promise<ModifyOrderResult> {
  const settings = opts.settings ?? (await getCodSettings(ctx));
  const now = ctx.now ?? new Date();
  const { order, lines } = await loadOrder(ctx, input.orderId);
  if (order.cancelledAt) throw new CodError("invalid_input", "order cancelled");
  const item = await requireOpenItem(ctx, input.orderId);
  const contact = input.contact ? contactPatch(order, input.contact, opts.country) : { patch: {}, platform: {}, changed: [] as string[] };

  // desired lines (by variant) and whether they differ from the current ones
  const current = lines.filter((l) => l.currentQuantity > 0);
  let desired: { variantId: string | null; quantity: number; unitPriceMinor: number; title: string; sku: string | null }[] | null = null;
  if (input.lines) {
    desired = [];
    const variantIds = input.lines.map((l) => l.variantId).filter((x): x is string => Boolean(x));
    const variants = variantIds.length ? await ctx.tx.select({ v: schema.productVariants, productTitle: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, variantIds))) : [];
    for (const l of input.lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 0) throw new CodError("invalid_input", "quantity");
      if (l.quantity === 0) continue;
      const existing = l.lineId ? current.find((x) => x.id === l.lineId) : undefined;
      if (existing) desired.push({ variantId: existing.variantId, quantity: l.quantity, unitPriceMinor: existing.unitPriceMinor, title: existing.title, sku: existing.sku });
      else {
        const v = variants.find((x) => x.v.id === l.variantId);
        if (!v) throw new CodError("invalid_input", "variant");
        desired.push({ variantId: v.v.id, quantity: l.quantity, unitPriceMinor: v.v.priceMinor, title: `${v.productTitle} ${v.v.title}`.trim(), sku: v.v.sku });
      }
    }
    if (!desired.length) throw new CodError("invalid_input", "no lines");
  }
  const key = (xs: { variantId: string | null; quantity: number }[]) => JSON.stringify([...xs].map((x) => [x.variantId, x.quantity]).sort());
  const linesChanged = desired !== null && key(desired) !== key(current.map((l) => ({ variantId: l.variantId, quantity: l.currentQuantity })));
  const mergeIds = [...new Set((input.mergeOrderIds ?? []).filter((id) => id !== order.id))];
  const needsReplace = linesChanged || mergeIds.length > 0;

  const platformCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new CodError("platform_error", e instanceof Error ? e.message : String(e));
    }
  };

  if (!needsReplace) {
    if (contact.changed.length) {
      if (platform && order.externalId) await platformCall(() => platform.updateOrderDetails(order.externalId!, contact.platform));
      await ctx.tx.update(schema.orders).set({ ...contact.patch, updatedAt: now }).where(eq(schema.orders.id, order.id));
      const diff = Object.fromEntries(contact.changed.map((k) => [k, { from: (order as Record<string, unknown>)[k] ?? null, to: (contact.patch as Record<string, unknown>)[k] ?? null }]));
      await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "modified", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff, metadata: { source: "cod" }, createdAt: now });
    }
    if (input.registerAttempt !== false) await recordAttempt(ctx, { orderId: order.id, outcome: "modified", note: input.attemptNote ?? null }, settings, { platform });
    return { kind: "updated", orderId: order.id, changed: contact.changed };
  }

  // ---- replacement: new order with the desired lines (+ merged orders), old ones cancelled and linked
  const sources: { order: OrderRow; lines: LineRow[]; item: typeof item }[] = [];
  for (const id of mergeIds) {
    const src = await loadOrder(ctx, id);
    if (src.order.paymentMethod !== "cod" || src.order.cancelledAt) throw new CodError("invalid_input", "merge source");
    const sameCustomer = (src.order.customerId && src.order.customerId === order.customerId) || (src.order.emailNormalized && src.order.emailNormalized === order.emailNormalized) || (src.order.phoneE164 && src.order.phoneE164 === order.phoneE164);
    if (!sameCustomer) throw new CodError("invalid_input", "merge source customer");
    sources.push({ ...src, item: await requireOpenItem(ctx, id) });
  }
  const finalLines = desired ?? current.map((l) => ({ variantId: l.variantId, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, title: l.title, sku: l.sku }));
  for (const s of sources) for (const l of s.lines.filter((x) => x.currentQuantity > 0)) {
    const hit = finalLines.find((x) => x.variantId && x.variantId === l.variantId && x.unitPriceMinor === l.unitPriceMinor);
    if (hit) hit.quantity += l.currentQuantity;
    else finalLines.push({ variantId: l.variantId, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, title: l.title, sku: l.sku });
  }
  const variantRows = await ctx.tx.select({ id: schema.productVariants.id, externalId: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, finalLines.map((l) => l.variantId).filter((x): x is string => Boolean(x)))));
  const [customer] = order.customerId ? await ctx.tx.select({ externalId: schema.customers.externalId }).from(schema.customers).where(eq(schema.customers.id, order.customerId)).limit(1) : [];
  const merged = { ...order, ...contact.patch } as OrderRow;
  const inheritedTags = order.platformTags.filter((t) => !classifyTags(settings.tags, [t]));
  const createInput: CreateOrderInput = {
    lines: finalLines.map((l) => ({ variantExternalId: variantRows.find((v) => v.id === l.variantId)?.externalId ?? null, sku: l.sku, title: l.title, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    currency: order.currency,
    email: merged.email,
    phone: merged.phone,
    customerExternalId: customer?.externalId ?? null,
    shippingAddress: (merged.shippingAddress as Address | null) ?? null,
    billingAddress: (order.billingAddress as Address | null) ?? null,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor + sources.reduce((s, x) => s + x.order.discountMinor, 0),
    note: merged.note ?? null,
    tags: inheritedTags,
    noteAttributes: (order.noteAttributes as { name: string; value: string }[]) ?? [],
    replacesOrderName: order.name,
  };
  if (!platform) throw new CodError("platform_error", "no commerce platform");
  if (input.registerAttempt !== false) await recordAttempt(ctx, { orderId: order.id, outcome: "modified", note: input.attemptNote ?? null }, settings, { platform });
  const created = await platformCall(() => platform.createOrder(createInput));
  const imported = await importOrder(ctx, created, { country: opts.country, source: "sync" });
  const allOld = [{ order, lines, item }, ...sources];
  await ctx.tx.update(schema.orders).set({ replacesOrderId: order.id, assignedTo: item.assignedTo }).where(eq(schema.orders.id, imported.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: imported.id, type: "replaces", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { replaces: allOld.map((o) => ({ id: o.order.id, name: o.order.name })), source: "cod" }, createdAt: now });
  // the replacement enters the queue immediately with the same operator; attempts start again
  await ctx.tx.insert(schema.codQueueItems).values({ tenantId: ctx.tenantId, orderId: imported.id, status: "pending", assignedTo: item.assignedTo, assignedAt: item.assignedTo ? now : null, enteredAt: now }).onConflictDoNothing();
  try {
    await applyTagEvent(ctx, platform, { id: imported.id, externalId: created.externalId, platformTags: created.tags.map((t) => t.toLowerCase()) }, "entered", settings);
  } catch (e) {
    if (!(e instanceof CodError && e.code === "platform_error")) throw e;
  }
  let warning: "old_order_not_cancelled" | null = null;
  for (const o of allOld) {
    let cancelledOnPlatform = !o.order.externalId;
    if (o.order.externalId) {
      try {
        await platform.cancelOrder(o.order.externalId, { reason: "customer", restock: true, refund: false });
        cancelledOnPlatform = true;
      } catch {
        warning = "old_order_not_cancelled";
      }
    }
    await ctx.tx.update(schema.orders).set({ replacedByOrderId: imported.id }).where(eq(schema.orders.id, o.order.id));
    if (cancelledOnPlatform) await applyCancellation(ctx, o.order.id, { reason: "replaced", restock: true, refund: false, source: "cod" });
    try {
      await applyTagEvent(ctx, platform, { id: o.order.id, externalId: o.order.externalId, platformTags: [...o.order.platformTags] }, "replaced", settings);
    } catch (e) {
      if (!(e instanceof CodError && e.code === "platform_error")) throw e;
    }
    await ctx.tx.update(schema.codQueueItems).set({ status: "left", closedAt: now, updatedAt: now }).where(eq(schema.codQueueItems.id, o.item.id));
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: o.order.id, type: "replaced", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { replacedByOrderId: { from: null, to: imported.id } }, metadata: { replacedBy: created.name, cancelledOnPlatform, source: "cod" }, createdAt: now });
  }
  return { kind: "replaced", orderId: order.id, newOrderId: imported.id, newOrderName: created.name, merged: sources.length, warning };
}

/** Open COD orders of the same customer that could be merged into this one. */
export async function mergeCandidates(ctx: ServiceContext, orderId: string): Promise<{ id: string; name: string; placedAt: Date; totalMinor: number; currency: string; lines: { title: string; variantTitle: string | null; quantity: number }[] }[]> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) return [];
  const open = await ctx.tx.select({ orderId: schema.codQueueItems.orderId }).from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES])));
  const ids = open.map((o) => o.orderId).filter((id) => id !== orderId);
  if (!ids.length) return [];
  const rows = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, ids)));
  const same = rows.filter((r) => (order.customerId && r.customerId === order.customerId) || (order.emailNormalized && r.emailNormalized === order.emailNormalized) || (order.phoneE164 && r.phoneE164 === order.phoneE164));
  if (!same.length) return [];
  const lines = await ctx.tx.select().from(schema.orderLines).where(inArray(schema.orderLines.orderId, same.map((s) => s.id)));
  return same.map((s) => ({ id: s.id, name: s.name, placedAt: s.placedAt, totalMinor: s.totalMinor, currency: s.currency, lines: lines.filter((l) => l.orderId === s.id && l.currentQuantity > 0).map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.currentQuantity })) }));
}

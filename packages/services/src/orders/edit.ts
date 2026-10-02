import { and, eq, inArray, isNull, ne, or, schema, sql } from "@hullwise/db";
import { OPEN_STATUSES, addressKey, applyDiscountToAmounts, diffRecords, linesDiffer, mergeBlock, mergeLines, nameZipKey, normalizeAddress, normalizeEmail, normalizePhone, orderDiscountAmount, orderDiscountCode, orderEditBlock, replacementBalance, validateAddressFormat, type AddressIssue, type EditLine, type MergeBlock, type MergeFacts, type OrderDiscountKind, type OrderEditBlock } from "@hullwise/core";
import type { Address, CommercePlatform, CreateOrderInput } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { importOrder } from "../sync";
import { applyCancellation, closeOrderBackorders, recomputeOrderStatus } from "./state";
import { checkOrderStock, type StockCheckResult } from "../backorders";
import { runPlatformWriteNow } from "../writes";

/**
 * Core order editing (issue #22), for every payment method:
 * - contact, address, email, phone and note are edited in place on the platform;
 * - line changes and merges cancel and recreate: a new order is created on the platform with the
 *   desired lines, the old one(s) are cancelled and linked both ways (`replaces` / `replaced_by` /
 *   `lineage_root`). Platform order-edit APIs are avoided on purpose for lines: a removed line can
 *   stay visible to the warehouse and get shipped anyway;
 * - a manual discount goes through `CommercePlatform.applyOrderDiscount`.
 * Every change writes an `order_events` row with the author and the field diff. Add-ons (cash on
 * delivery) call these services and add their own extras through hooks.
 */

export type OrderEditErrorCode = "not_found" | "not_editable" | "invalid_input" | "invalid_address" | "merge_invalid" | "nothing_to_change" | "platform_error";
export class OrderEditError extends Error {
  constructor(
    public readonly code: OrderEditErrorCode,
    message?: string,
    public readonly detail?: { block?: OrderEditBlock | MergeBlock; issues?: AddressIssue[]; field?: string },
  ) {
    super(message ?? code);
    this.name = "OrderEditError";
  }
}

export interface ContactPatch {
  customerName?: string | null;
  phone?: string | null;
  email?: string | null;
  shippingAddress?: Address | null;
  billingAddress?: Address | null;
  note?: string | null;
  noteMode?: "replace" | "append";
}
/** Desired line after the change: an existing line (by id) or a variant to add. Quantity 0 removes it. */
export interface DesiredLine {
  lineId?: string;
  variantId?: string;
  quantity: number;
}
export interface EditOptions {
  /** Tenant country, for phone normalization. */
  country: string;
  /** Who asked for the change, recorded on the events (`core`, `cod`, …). */
  source?: string;
}

type OrderRow = typeof schema.orders.$inferSelect;
type LineRow = typeof schema.orderLines.$inferSelect;

/* ---------- loading and checks ---------- */

export interface EditableOrder {
  order: OrderRow;
  lines: LineRow[];
  shipmentCount: number;
  block: OrderEditBlock | null;
}

export async function loadEditableOrder(ctx: ServiceContext, orderId: string): Promise<EditableOrder> {
  const [order] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!order) throw new OrderEditError("not_found");
  const lines = await ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)));
  const [ship] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId)));
  const shipmentCount = ship?.n ?? 0;
  return { order, lines, shipmentCount, block: orderEditBlock({ ...order, shipmentCount }) };
}

async function requireEditable(ctx: ServiceContext, orderId: string): Promise<EditableOrder> {
  const e = await loadEditableOrder(ctx, orderId);
  if (e.block) throw new OrderEditError("not_editable", e.block, { block: e.block });
  return e;
}

const mergeFacts = (e: EditableOrder): MergeFacts => ({ ...e.order, shipmentCount: e.shipmentCount });
const openLines = (lines: LineRow[]) => lines.filter((l) => l.currentQuantity > 0);

async function platformCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new OrderEditError("platform_error", e instanceof Error ? e.message : String(e));
  }
}

/* ---------- contact, address and note ---------- */

const ADDRESS_FIELDS = ["name", "address1", "address2", "city", "province", "zip", "country", "phone"] as const;
const sameAddress = (a: Address | null | undefined, b: Address | null | undefined) => {
  if (!a || !b) return !a === !b;
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  return ADDRESS_FIELDS.every((k) => (na[k] ?? null) === (nb[k] ?? null));
};
const cleanAddress = (a: Address | null | undefined): Address | null => (a ? normalizeAddress({ ...a }) : null);

/**
 * Contact, address and note changes compared with the stored order; empty when nothing differs.
 * A changed address must pass the format check (required fields, postal code of the country).
 */
export function contactChanges(order: OrderRow, c: ContactPatch, country: string) {
  const patch: Partial<OrderRow> = {};
  const platform: { shippingAddress?: Address | null; billingAddress?: Address | null; email?: string | null; phone?: string | null; note?: string | null } = {};
  const changed: string[] = [];
  const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  if (c.customerName !== undefined && text(c.customerName) !== order.customerName) {
    patch.customerName = text(c.customerName);
    changed.push("customerName");
  }
  if (c.phone !== undefined && text(c.phone) !== order.phone) {
    patch.phone = text(c.phone);
    patch.phoneE164 = normalizePhone(c.phone, country);
    platform.phone = patch.phone;
    changed.push("phone");
  }
  if (c.email !== undefined && text(c.email) !== order.email) {
    const email = text(c.email);
    if (email && !normalizeEmail(email)) throw new OrderEditError("invalid_input", "email", { field: "email" });
    patch.email = email;
    patch.emailNormalized = normalizeEmail(email);
    platform.email = email;
    changed.push("email");
  }
  for (const key of ["shippingAddress", "billingAddress"] as const) {
    const next = c[key];
    if (next === undefined || sameAddress(next, order[key] as Address | null)) continue;
    const a = cleanAddress(next);
    // the shipping address must be deliverable in format; a billing address may be partial
    if (key === "shippingAddress" && a) {
      const issues = validateAddressFormat(a);
      if (issues.length) throw new OrderEditError("invalid_address", key, { issues, field: key });
    }
    patch[key] = a;
    platform[key] = a;
    changed.push(key);
    if (key === "shippingAddress") {
      patch.shippingCity = a?.city ?? null;
      patch.shippingZip = a?.zip ?? null;
      patch.shippingCountry = a?.country ?? null;
      patch.addressKey = addressKey(a);
      patch.nameZipKey = nameZipKey(a?.name ?? patch.customerName ?? order.customerName, a?.zip);
    }
  }
  if (c.note !== undefined) {
    const next = c.noteMode === "append" && order.note ? `${order.note}\n${c.note ?? ""}`.trim() : text(c.note);
    if ((next || null) !== (order.note ?? null)) {
      patch.note = next || null;
      platform.note = next || null;
      changed.push("note");
    }
  }
  return { patch, platform, changed };
}

export interface EditDetailsResult {
  orderId: string;
  changed: string[];
  /** Whether the change was written to the commerce platform (false for orders without an external id). */
  writtenToPlatform: boolean;
}

/** Edits contact, address, email, phone and note of an order not yet fulfilled: platform first, then Hullwise. */
export async function editOrderDetails(ctx: ServiceContext, platform: CommercePlatform | undefined, input: { orderId: string; contact: ContactPatch }, opts: EditOptions): Promise<EditDetailsResult> {
  const { order } = await requireEditable(ctx, input.orderId);
  const now = ctx.now ?? new Date();
  const c = contactChanges(order, input.contact, opts.country);
  if (!c.changed.length) return { orderId: order.id, changed: [], writtenToPlatform: false };
  const writes = Object.keys(c.platform).length > 0 && Boolean(platform && order.externalId);
  // synchronous (recorded in the outbox): the operator is told at once when the platform refuses the change
  if (writes) await platformCall(() => runPlatformWriteNow(ctx, platform!, { kind: "order.update_details", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId!, patch: c.platform } }));
  await ctx.tx.update(schema.orders).set({ ...c.patch, updatedAt: now }).where(eq(schema.orders.id, order.id));
  const diff = Object.fromEntries(c.changed.map((k) => [k, { from: (order as Record<string, unknown>)[k] ?? null, to: (c.patch as Record<string, unknown>)[k] ?? null }]));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "modified", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff, metadata: { source: opts.source ?? "core", platform: writes ? platform!.provider : null }, createdAt: now });
  return { orderId: order.id, changed: c.changed, writtenToPlatform: writes };
}

/* ---------- cancel and recreate (line change, merge) ---------- */

export interface ReplaceHooks {
  /** Platform tags the replacement inherits (default: all of the edited order's tags). */
  inheritTags?: (tags: string[]) => string[];
  /** After the replacement is imported and linked, before the old orders are cancelled. */
  afterCreated?: (ctx: ServiceContext, info: { newOrder: { id: string; externalId: string; name: string; platformTags: string[] }; target: OrderRow }) => Promise<void>;
  /** After each old order is linked and cancelled. */
  afterReplaced?: (ctx: ServiceContext, info: { order: OrderRow; newOrderId: string; cancelledOnPlatform: boolean }) => Promise<void>;
  /** Last change to the platform order before it is created (an add-on switching the payment method). */
  createInput?: (input: CreateOrderInput) => CreateOrderInput;
  /** Recreate even when lines and merges are unchanged (the add-on's own change is in `createInput`). */
  force?: boolean;
}

export interface ReplaceResult {
  kind: "replaced";
  orderId: string;
  newOrderId: string;
  newOrderName: string;
  merged: number;
  /** An old order the platform refused to cancel: it is linked and final in Hullwise, but must be cancelled by hand. */
  warning: "old_order_not_cancelled" | null;
  /** Money to settle on a paid order: positive = customer owes, negative = refund due. 0 when unpaid. */
  balanceMinor: number;
  /** Lines of the replacement stock could not serve (backorders created, order held). */
  backorders?: number;
  /** Platform fulfillment hold enqueued for the replacement (dispatch after the commit). */
  holdWrite?: StockCheckResult["write"];
}
export type EditOrderResult = ({ kind: "updated" } & EditDetailsResult) | ReplaceResult;

async function resolveDesiredLines(ctx: ServiceContext, current: LineRow[], desired: DesiredLine[]): Promise<EditLine[]> {
  const variantIds = desired.map((l) => l.variantId).filter((x): x is string => Boolean(x));
  const variants = variantIds.length ? await ctx.tx.select({ v: schema.productVariants, productTitle: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, variantIds))) : [];
  const out: EditLine[] = [];
  for (const l of desired) {
    if (!Number.isInteger(l.quantity) || l.quantity < 0) throw new OrderEditError("invalid_input", "quantity", { field: "quantity" });
    if (l.quantity === 0) continue;
    const existing = l.lineId ? current.find((x) => x.id === l.lineId) : undefined;
    if (l.lineId && !existing) throw new OrderEditError("invalid_input", "line", { field: "lineId" });
    if (existing) out.push({ variantId: existing.variantId, quantity: l.quantity, unitPriceMinor: existing.unitPriceMinor, title: existing.title, sku: existing.sku });
    else {
      const v = variants.find((x) => x.v.id === l.variantId);
      if (!v) throw new OrderEditError("invalid_input", "variant", { field: "variantId" });
      out.push({ variantId: v.v.id, quantity: l.quantity, unitPriceMinor: v.v.priceMinor, title: `${v.productTitle} ${v.v.title}`.trim(), sku: v.v.sku });
    }
  }
  if (!out.length) throw new OrderEditError("invalid_input", "no lines", { field: "lines" });
  return out;
}

const asEditLines = (lines: LineRow[]): EditLine[] => openLines(lines).map((l) => ({ variantId: l.variantId, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, title: l.title, sku: l.sku }));
const isPaid = (s: string) => s === "paid" || s === "partially_refunded";

/**
 * Cancel-and-recreate: a new order with the desired lines (plus the lines of merged orders of the
 * same customer) is created on the platform and imported; the old orders are cancelled there
 * (restock, no refund) and linked. The replacement inherits creation day, attribution, assignee,
 * payment state and lineage root, so KPIs count one order.
 */
export async function replaceOrder(ctx: ServiceContext, platform: CommercePlatform | undefined, input: { orderId: string; lines?: DesiredLine[]; mergeOrderIds?: string[]; contact?: ContactPatch }, opts: EditOptions & { hooks?: ReplaceHooks }): Promise<ReplaceResult> {
  const now = ctx.now ?? new Date();
  const source = opts.source ?? "core";
  const target = await requireEditable(ctx, input.orderId);
  const { order, lines } = target;
  const contact = input.contact ? contactChanges(order, input.contact, opts.country) : { patch: {} as Partial<OrderRow>, changed: [] as string[] };
  const current = asEditLines(lines);
  const desired = input.lines ? await resolveDesiredLines(ctx, lines, input.lines) : null;
  const linesChanged = desired !== null && linesDiffer(current, desired);
  const mergeIds = [...new Set((input.mergeOrderIds ?? []).filter((id) => id !== order.id))];
  if (!linesChanged && !mergeIds.length && !opts.hooks?.force) throw new OrderEditError("nothing_to_change");
  const sources: EditableOrder[] = [];
  for (const id of mergeIds) {
    const src = await loadEditableOrder(ctx, id);
    const block = mergeBlock(mergeFacts(target), mergeFacts(src));
    if (block) throw new OrderEditError("merge_invalid", block, { block });
    sources.push(src);
  }
  if (!platform) throw new OrderEditError("platform_error", "no commerce platform");
  const finalLines = mergeLines(desired ?? current, sources.flatMap((s) => asEditLines(s.lines)));
  const variantRows = await ctx.tx.select({ id: schema.productVariants.id, externalId: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.id, finalLines.map((l) => l.variantId).filter((x): x is string => Boolean(x)).concat(["00000000-0000-0000-0000-000000000000"]))));
  const [customer] = order.customerId ? await ctx.tx.select({ externalId: schema.customers.externalId }).from(schema.customers).where(eq(schema.customers.id, order.customerId)).limit(1) : [];
  const merged = { ...order, ...contact.patch } as OrderRow;
  const paid = isPaid(order.paymentStatus);
  const createInput: CreateOrderInput = {
    lines: finalLines.map((l) => ({ variantExternalId: variantRows.find((v) => v.id === l.variantId)?.externalId ?? null, sku: l.sku, title: l.title, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    currency: order.currency,
    email: merged.email,
    phone: merged.phone,
    customerExternalId: customer?.externalId ?? null,
    shippingAddress: (merged.shippingAddress as Address | null) ?? null,
    billingAddress: (merged.billingAddress as Address | null) ?? null,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor + sources.reduce((s, x) => s + x.order.discountMinor, 0),
    note: merged.note ?? null,
    tags: opts.hooks?.inheritTags ? opts.hooks.inheritTags([...order.platformTags]) : [...order.platformTags],
    noteAttributes: (order.noteAttributes as { name: string; value: string }[]) ?? [],
    replacesOrderName: order.name,
    payment: { method: order.paymentMethod as NonNullable<CreateOrderInput["payment"]>["method"], status: paid ? "paid" : "pending", gateways: order.paymentGateways },
  };
  // synchronous: the replacement's number and lines are needed right away; keyed so a repeated request reuses the order already created
  const finalInput = opts.hooks?.createInput ? opts.hooks.createInput(createInput) : createInput;
  const created = await platformCall(() => runPlatformWriteNow(ctx, platform, { kind: "order.create", entityType: "order", entityId: order.id, payload: { input: finalInput }, idempotencyKey: `order:replace:${[order.id, ...sources.map((x) => x.order.id).sort()].join(",")}` }));
  const imported = await importOrder(ctx, created, { country: opts.country, source: "sync", stockCheck: false });
  const allOld = [target, ...sources];
  // stock the replaced orders give back (restock on cancel): their open units, less what was waiting for stock anyway
  const credit = await replacedStockCredit(ctx, allOld);
  const rootId = order.lineageRootOrderId ?? order.id;
  // inherit creation day, channel and assignee; attribution is copied below
  await ctx.tx.update(schema.orders).set({ replacesOrderId: order.id, lineageRootOrderId: rootId, placedAt: order.placedAt, assignedTo: order.assignedTo, sourceChannel: order.sourceChannel, landingSite: order.landingSite, referringSite: order.referringSite, customerName: merged.customerName ?? undefined, updatedAt: now }).where(eq(schema.orders.id, imported.id));
  const [attr] = await ctx.tx.select().from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), eq(schema.orderAttribution.orderId, order.id))).limit(1);
  if (attr) {
    const values = { utmSource: attr.utmSource, utmMedium: attr.utmMedium, utmCampaign: attr.utmCampaign, utmContent: attr.utmContent, utmTerm: attr.utmTerm, clickIds: attr.clickIds, campaignId: attr.campaignId, channel: attr.channel, source: attr.source, capturedAt: attr.capturedAt };
    await ctx.tx.insert(schema.orderAttribution).values({ tenantId: ctx.tenantId, orderId: imported.id, ...values }).onConflictDoUpdate({ target: [schema.orderAttribution.orderId], set: values });
  }
  await recomputeOrderStatus(ctx, imported.id, { eventMetadata: { source } });
  const paidTotal = allOld.reduce((s, o) => s + o.order.totalMinor - o.order.refundedMinor, 0);
  const balanceMinor = replacementBalance(paid, paidTotal, created.totalMinor);
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: imported.id, type: "replaces", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: contact.changed.length ? Object.fromEntries(contact.changed.map((k) => [k, { from: (order as Record<string, unknown>)[k] ?? null, to: (contact.patch as Record<string, unknown>)[k] ?? null }])) : {}, metadata: { replaces: allOld.map((o) => ({ id: o.order.id, name: o.order.name })), source, paid, balanceMinor, platform: platform.provider }, createdAt: now });
  await opts.hooks?.afterCreated?.(ctx, { newOrder: { id: imported.id, externalId: created.externalId, name: created.name, platformTags: created.tags.map((t) => t.toLowerCase()) }, target: order });
  let warning: ReplaceResult["warning"] = null;
  for (const o of allOld) {
    let cancelledOnPlatform = !o.order.externalId;
    if (o.order.externalId) {
      try {
        await runPlatformWriteNow(ctx, platform, { kind: "order.cancel", entityType: "order", entityId: o.order.id, payload: { orderExternalId: o.order.externalId, reason: "customer", restock: true, refund: false } });
        cancelledOnPlatform = true;
      } catch {
        warning = "old_order_not_cancelled";
      }
    }
    await ctx.tx.update(schema.orders).set({ replacedByOrderId: imported.id, lineageRootOrderId: o.order.lineageRootOrderId ?? rootId }).where(eq(schema.orders.id, o.order.id));
    if (cancelledOnPlatform) await applyCancellation(ctx, o.order.id, { reason: "replaced", restock: true, refund: false, source });
    else await recomputeOrderStatus(ctx, o.order.id, { eventMetadata: { source } });
    await opts.hooks?.afterReplaced?.(ctx, { order: o.order, newOrderId: imported.id, cancelledOnPlatform });
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: o.order.id, type: "replaced", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: { replacedByOrderId: { from: null, to: imported.id } }, metadata: { replacedBy: created.name, replacedById: imported.id, cancelledOnPlatform, source }, createdAt: now });
    // a replaced order never waits for stock, even when the platform cancel failed
    if (await closeOrderBackorders(ctx, o.order.id, "cancelled", "order_replaced")) await recomputeOrderStatus(ctx, o.order.id, { eventMetadata: { source } });
  }
  // the new lines go through the stock check (backorders, hold) once the old orders gave their stock back
  const stock = await checkOrderStock(ctx, imported.id, { credit, assumeUnreflected: true, source });
  return { kind: "replaced", orderId: order.id, newOrderId: imported.id, newOrderName: created.name, merged: sources.length, warning, balanceMinor, backorders: stock.created.length, holdWrite: stock.write };
}

/**
 * Units per variant the replaced orders give back when cancelled with restock: their open line units,
 * when Hullwise's level already took them out (read after the order was placed), less the units that were
 * waiting for stock (never taken from it).
 */
async function replacedStockCredit(ctx: ServiceContext, orders: EditableOrder[]): Promise<Map<string, number>> {
  const credit = new Map<string, number>();
  const lines = orders.flatMap((o) => openLines(o.lines).filter((l) => l.variantId).map((l) => ({ l, placedAt: o.order.placedAt })));
  if (!lines.length) return credit;
  const variantIds = [...new Set(lines.map((x) => x.l.variantId!))];
  const synced = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, at: sql<Date | null>`max(${schema.inventoryLevels.syncedAt})` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, variantIds))).groupBy(schema.inventoryLevels.variantId);
  const waiting = await ctx.tx.select({ lineId: schema.backorders.orderLineId, n: sql<number>`sum(${schema.backorders.quantity})::int` }).from(schema.backorders).where(and(eq(schema.backorders.tenantId, ctx.tenantId), inArray(schema.backorders.orderLineId, lines.map((x) => x.l.id)), inArray(schema.backorders.status, ["pending", "covered"]))).groupBy(schema.backorders.orderLineId);
  for (const { l, placedAt } of lines) {
    const at = synced.find((s) => s.variantId === l.variantId)?.at;
    if (!at || new Date(at).getTime() < placedAt.getTime()) continue;
    const units = l.currentQuantity - (waiting.find((w) => w.lineId === l.id)?.n ?? 0);
    if (units > 0) credit.set(l.variantId!, (credit.get(l.variantId!) ?? 0) + units);
  }
  return credit;
}

/**
 * One entry point for the edit dialog: in-place edit when only contact fields change, replacement
 * when lines change or orders are merged (contact changes then go on the new order).
 */
export async function editOrder(ctx: ServiceContext, platform: CommercePlatform | undefined, input: { orderId: string; contact?: ContactPatch; lines?: DesiredLine[]; mergeOrderIds?: string[] }, opts: EditOptions & { hooks?: ReplaceHooks }): Promise<EditOrderResult> {
  const { order, lines } = await requireEditable(ctx, input.orderId);
  const current = openLines(lines);
  const linesChanged = Boolean(input.lines) && linesDiffer(current.map((l) => ({ variantId: l.variantId, quantity: l.currentQuantity })), input.lines!.map((l) => ({ variantId: l.lineId ? (current.find((x) => x.id === l.lineId)?.variantId ?? `missing:${l.lineId}`) : (l.variantId ?? null), quantity: l.quantity })));
  if (linesChanged || (input.mergeOrderIds ?? []).some((id) => id !== order.id)) return replaceOrder(ctx, platform, input, opts);
  const r = await editOrderDetails(ctx, platform, { orderId: input.orderId, contact: input.contact ?? {} }, opts);
  return { kind: "updated", ...r };
}

export interface MergeCandidate {
  id: string;
  name: string;
  placedAt: Date;
  totalMinor: number;
  currency: string;
  paymentMethod: string;
  lines: { title: string; variantTitle: string | null; quantity: number }[];
}

/** Other open, unfulfilled orders of the same customer with the same payment state: what can be merged into this one. */
export async function orderMergeCandidates(ctx: ServiceContext, orderId: string, opts: { restrictTo?: string[] } = {}): Promise<MergeCandidate[]> {
  const target = await loadEditableOrder(ctx, orderId).catch(() => null);
  if (!target || target.block) return [];
  const o = target.order;
  const identity = [];
  if (o.customerId) identity.push(eq(schema.orders.customerId, o.customerId));
  if (o.emailNormalized) identity.push(eq(schema.orders.emailNormalized, o.emailNormalized));
  if (o.phoneE164) identity.push(eq(schema.orders.phoneE164, o.phoneE164));
  if (!identity.length) return [];
  const conds = [eq(schema.orders.tenantId, ctx.tenantId), ne(schema.orders.id, o.id), or(...identity), isNull(schema.orders.cancelledAt), isNull(schema.orders.replacedByOrderId), inArray(schema.orders.status, [...OPEN_STATUSES])];
  if (opts.restrictTo) conds.push(inArray(schema.orders.id, opts.restrictTo.length ? opts.restrictTo : ["00000000-0000-0000-0000-000000000000"]));
  const rows = await ctx.tx.select().from(schema.orders).where(and(...conds)).limit(20);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const shipped = await ctx.tx.select({ orderId: schema.shipments.orderId }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), inArray(schema.shipments.orderId, ids)));
  const eligible = rows.filter((r) => !mergeBlock(mergeFacts(target), { ...r, shipmentCount: shipped.filter((s) => s.orderId === r.id).length }));
  if (!eligible.length) return [];
  const lines = await ctx.tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), inArray(schema.orderLines.orderId, eligible.map((s) => s.id))));
  return eligible.map((s) => ({ id: s.id, name: s.name, placedAt: s.placedAt, totalMinor: s.totalMinor, currency: s.currency, paymentMethod: s.paymentMethod, lines: lines.filter((l) => l.orderId === s.id && l.currentQuantity > 0).map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.currentQuantity })) }));
}

/* ---------- discount on an existing order ---------- */

export interface ApplyDiscountResult {
  orderId: string;
  code: string;
  amountMinor: number;
  totalMinor: number;
  /** Paid orders: the amount to refund to the customer from the platform. */
  refundDueMinor: number;
}

/** Applies a preset or custom discount (% or amount) to an open, unfulfilled order: platform first, then Hullwise. */
export async function applyOrderDiscount(ctx: ServiceContext, platform: CommercePlatform | undefined, input: { orderId: string; type: OrderDiscountKind; value: number; code?: string | null; reason?: string | null }, opts: { source?: string } = {}): Promise<ApplyDiscountResult> {
  if (!["percentage", "fixed_amount"].includes(input.type) || !Number.isFinite(input.value) || input.value <= 0 || (input.type === "percentage" && input.value > 10_000)) throw new OrderEditError("invalid_input", "discount", { field: "value" });
  const { order } = await requireEditable(ctx, input.orderId);
  const now = ctx.now ?? new Date();
  const amountMinor = orderDiscountAmount(order, input);
  if (amountMinor <= 0) throw new OrderEditError("invalid_input", "discount amount", { field: "value" });
  const code = orderDiscountCode(input, input.code);
  const writes = Boolean(platform && order.externalId);
  if (writes) await platformCall(() => runPlatformWriteNow(ctx, platform!, { kind: "order.discount", entityType: "order", entityId: order.id, payload: { orderExternalId: order.externalId!, discount: { type: input.type, value: input.value, amountMinor, currency: order.currency, code, reason: input.reason ?? null } } }));
  const next = applyDiscountToAmounts(order, amountMinor);
  await ctx.tx.update(schema.orders).set({ discountMinor: next.discountMinor, totalMinor: next.totalMinor, updatedAt: now }).where(eq(schema.orders.id, order.id));
  await ctx.tx.insert(schema.orderDiscounts).values({ tenantId: ctx.tenantId, orderId: order.id, code, type: input.type, amountMinor });
  const refundDueMinor = isPaid(order.paymentStatus) ? amountMinor : 0;
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "discount_applied", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: diffRecords({ discountMinor: order.discountMinor, totalMinor: order.totalMinor }, { discountMinor: next.discountMinor, totalMinor: next.totalMinor }), metadata: { code, type: input.type, value: input.value, amountMinor, refundDueMinor, reason: input.reason ?? null, source: opts.source ?? "core", platform: writes ? platform!.provider : null }, createdAt: now });
  return { orderId: order.id, code, amountMinor, totalMinor: next.totalMinor, refundDueMinor };
}

/* ---------- lineage ---------- */

export interface LineageEntry {
  id: string;
  name: string;
  status: string;
  placedAt: Date;
  replacesOrderId: string | null;
  replacedByOrderId: string | null;
  cancelledAt: Date | null;
}

/** Every order of the cancel-and-recreate chain this order belongs to, oldest first; empty when it has none. */
export async function orderLineage(ctx: ServiceContext, orderId: string): Promise<LineageEntry[]> {
  const [o] = await ctx.tx.select({ id: schema.orders.id, root: schema.orders.lineageRootOrderId, replaces: schema.orders.replacesOrderId, replacedBy: schema.orders.replacedByOrderId }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o || (!o.root && !o.replaces && !o.replacedBy)) return [];
  const root = o.root ?? o.replaces ?? o.id;
  const rows = await ctx.tx
    .select({ id: schema.orders.id, name: schema.orders.name, status: schema.orders.status, placedAt: schema.orders.placedAt, replacesOrderId: schema.orders.replacesOrderId, replacedByOrderId: schema.orders.replacedByOrderId, cancelledAt: schema.orders.cancelledAt, createdAt: schema.orders.createdAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), or(eq(schema.orders.lineageRootOrderId, root), eq(schema.orders.id, root), eq(schema.orders.id, o.id), o.replacedBy ? eq(schema.orders.id, o.replacedBy) : undefined, o.replaces ? eq(schema.orders.id, o.replaces) : undefined)))
    .orderBy(schema.orders.createdAt, schema.orders.orderNumber)
    .limit(50);
  return rows.map(({ createdAt: _c, ...r }) => r);
}

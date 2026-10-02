import { and, desc, eq, inArray, schema, sql } from "@hullwise/db";
import { formatMoney } from "@hullwise/core";
import type { CommercePlatform, MessagingChannel } from "@hullwise/integrations";
import type { ServiceContext } from "@hullwise/services";
import { classifyCodReply, renderTemplate } from "../messages";
import { OPEN_QUEUE_STATUSES, type QueueStatus } from "../queue";
import type { CodSettings, TemplateVariable } from "../settings";
import { CodError, getCodSettings, recordAttempt } from "./index";
import { escalateQueueItem } from "./operations";

/**
 * Confirmation messages (C.17): tenant templates filled with the order's data, copied by the
 * operator or sent through the tenant's `MessagingChannel` (only the mock exists; a WhatsApp or SMS
 * provider is a per-account connector). Each send is a contact attempt and a timeline event.
 */

export interface MessageContext {
  shopName: string;
  locale: string;
  operatorName?: string | null;
}

/** The template variables of an order. */
export async function orderTemplateVariables(ctx: ServiceContext, orderId: string, mc: MessageContext): Promise<Record<TemplateVariable, string>> {
  const [o] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o) throw new CodError("not_found");
  const lines = await ctx.tx.select({ title: schema.orderLines.title, variantTitle: schema.orderLines.variantTitle, quantity: schema.orderLines.currentQuantity, isAncillary: schema.orderLines.isAncillary }).from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.orderId, orderId)));
  const [item] = await ctx.tx.select({ on: schema.codQueueItems.scheduledConfirmOn }).from(schema.codQueueItems).where(eq(schema.codQueueItems.orderId, orderId)).limit(1);
  const a = (o.shippingAddress ?? {}) as { address1?: string | null; address2?: string | null; zip?: string | null; city?: string | null; province?: string | null };
  const name = o.customerName?.trim() ?? "";
  return {
    customer_name: name,
    first_name: name.split(/\s+/)[0] ?? "",
    order_name: o.name,
    total: formatMoney(o.totalMinor, o.currency, mc.locale),
    items: lines.filter((l) => l.quantity > 0 && !l.isAncillary).map((l) => `${l.quantity}× ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(", "),
    address: [[a.address1, a.address2].filter(Boolean).join(" "), [a.zip ?? o.shippingZip, a.city ?? o.shippingCity, a.province].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    shop_name: mc.shopName,
    operator_name: mc.operatorName ?? "",
    scheduled_date: item?.on ?? "",
  };
}

/** Every template of the tenant rendered for an order: what the card shows and copies. */
export async function renderOrderTemplates(ctx: ServiceContext, orderId: string, mc: MessageContext, settings?: CodSettings): Promise<{ key: string; name: string; text: string }[]> {
  const s = settings ?? (await getCodSettings(ctx));
  if (!s.messageTemplates.length) return [];
  const vars = await orderTemplateVariables(ctx, orderId, mc);
  return s.messageTemplates.map((t) => ({ key: t.key, name: t.name, text: renderTemplate(t.body, vars) }));
}

/** Sends one template to the order's phone through the channel; logged as a message, an attempt and an order event. */
export async function sendCodMessage(ctx: ServiceContext, channel: MessagingChannel, input: { orderId: string; templateKey: string }, mc: MessageContext, settings?: CodSettings): Promise<{ messageId: string; attemptNumber: number }> {
  const s = settings ?? (await getCodSettings(ctx));
  const template = s.messageTemplates.find((t) => t.key === input.templateKey);
  if (!template) throw new CodError("invalid_input", "template");
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, input.orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) throw new CodError("not_in_queue");
  const [order] = await ctx.tx.select({ phone: schema.orders.phone, phoneE164: schema.orders.phoneE164 }).from(schema.orders).where(eq(schema.orders.id, input.orderId)).limit(1);
  const to = order?.phoneE164 ?? order?.phone ?? null;
  if (!to) throw new CodError("invalid_input", "phone");
  const vars = await orderTemplateVariables(ctx, input.orderId, mc);
  const body = renderTemplate(template.body, vars);
  let messageId: string;
  try {
    messageId = (await channel.sendMessage({ to, template: template.key, variables: { ...vars, body } })).messageId;
  } catch (e) {
    throw new CodError("platform_error", e instanceof Error ? e.message : String(e));
  }
  const now = ctx.now ?? new Date();
  const attemptNumber = item.attemptsCount + 1;
  await ctx.tx.insert(schema.codMessages).values({ tenantId: ctx.tenantId, orderId: input.orderId, queueItemId: item.id, templateKey: template.key, provider: channel.provider, recipient: to, body, providerMessageId: messageId, status: "sent", statusAt: now, sentBy: ctx.actor.userId, createdAt: now });
  await ctx.tx.insert(schema.codAttempts).values({ tenantId: ctx.tenantId, queueItemId: item.id, orderId: input.orderId, operatorId: ctx.actor.userId, attemptNumber, outcome: "message_sent", channel: channel.provider, note: template.name, createdAt: now });
  await ctx.tx.update(schema.codQueueItems).set({ attemptsCount: attemptNumber, lastAttemptAt: now, assignedTo: item.assignedTo ?? ctx.actor.userId, assignedAt: item.assignedAt ?? now, updatedAt: now }).where(eq(schema.codQueueItems.id, item.id));
  await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: input.orderId, type: "cod_message", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { template: template.key, templateName: template.name, provider: channel.provider, messageId, attemptNumber }, createdAt: now });
  return { messageId, attemptNumber };
}

const RANK: Record<string, number> = { sent: 0, delivered: 1, read: 2, failed: 3 };

/** Provider delivery receipt: moves the status forward only (sent → delivered → read; failed at any point). */
export async function applyMessageStatus(ctx: ServiceContext, providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at?: Date): Promise<boolean> {
  const [m] = await ctx.tx.select({ id: schema.codMessages.id, status: schema.codMessages.status }).from(schema.codMessages).where(and(eq(schema.codMessages.tenantId, ctx.tenantId), eq(schema.codMessages.providerMessageId, providerMessageId))).limit(1);
  if (!m || (RANK[status] ?? 0) <= (RANK[m.status] ?? 0)) return false;
  await ctx.tx.update(schema.codMessages).set({ status, statusAt: at ?? ctx.now ?? new Date() }).where(eq(schema.codMessages.id, m.id));
  return true;
}

export async function listOrderMessages(ctx: ServiceContext, orderId: string) {
  return ctx.tx.select({ m: schema.codMessages, sender: sql<string | null>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.codMessages).leftJoin(schema.users, eq(schema.users.id, schema.codMessages.sentBy)).where(and(eq(schema.codMessages.tenantId, ctx.tenantId), eq(schema.codMessages.orderId, orderId))).orderBy(desc(schema.codMessages.createdAt)).limit(50);
}

export interface CodReplyInput {
  /** The provider id of the customer's message (idempotency of the attempt note). */
  providerMessageId: string;
  /** The confirmation message the customer answered, when the provider says so. */
  replyToMessageId: string | null;
  phone: string;
  text: string;
  /** The order the channel linked the reply to, if any. */
  orderId: string | null;
}

/**
 * A customer's reply to a confirmation message (WhatsApp channel add-on). The queue item is the one
 * of the answered `cod_messages` row, else the order the channel linked, else the latest open item
 * messaged at that number in the last 7 days. "Confirm" keywords record a `confirmed` attempt by the
 * channel (platform first, like an operator's); "cancel" keywords escalate the item to a person,
 * never cancelling by themselves; anything else is only on the timeline.
 */
export async function applyCodReply(ctx: ServiceContext, input: CodReplyInput, opts: { platform?: CommercePlatform; settings?: CodSettings } = {}): Promise<{ orderId: string; action: "confirmed" | "escalated" } | null> {
  const s = opts.settings ?? (await getCodSettings(ctx));
  const kind = classifyCodReply(input.text, s.messagingReplies);
  if (!kind) return null;
  let orderId: string | null = null;
  if (input.replyToMessageId) {
    const [m] = await ctx.tx.select({ orderId: schema.codMessages.orderId }).from(schema.codMessages).where(and(eq(schema.codMessages.tenantId, ctx.tenantId), eq(schema.codMessages.providerMessageId, input.replyToMessageId))).limit(1);
    orderId = m?.orderId ?? null;
  }
  orderId ??= input.orderId;
  if (!orderId) {
    const digits = input.phone.replace(/\D/g, "");
    const [m] = await ctx.tx.select({ orderId: schema.codMessages.orderId }).from(schema.codMessages).innerJoin(schema.codQueueItems, eq(schema.codQueueItems.orderId, schema.codMessages.orderId)).where(and(eq(schema.codMessages.tenantId, ctx.tenantId), sql`regexp_replace(${schema.codMessages.recipient}, '\\D', '', 'g') = ${digits}`, inArray(schema.codQueueItems.status, [...OPEN_QUEUE_STATUSES]), sql`${schema.codMessages.createdAt} > now() - interval '7 days'`)).orderBy(desc(schema.codMessages.createdAt)).limit(1);
    orderId = m?.orderId ?? null;
  }
  if (!orderId) return null;
  const [item] = await ctx.tx.select().from(schema.codQueueItems).where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), eq(schema.codQueueItems.orderId, orderId))).limit(1);
  if (!item || !OPEN_QUEUE_STATUSES.includes(item.status as QueueStatus)) return null;
  const note = `“${input.text.slice(0, 120)}”`;
  if (kind === "confirm") {
    await recordAttempt(ctx, { orderId, outcome: "confirmed", channel: "whatsapp", note }, s, { platform: opts.platform });
    return { orderId, action: "confirmed" };
  }
  if (!item.escalatedAt) await escalateQueueItem(ctx, orderId, note);
  return { orderId, action: "escalated" };
}

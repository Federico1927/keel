/**
 * Pure rules of messaging channels (WhatsApp first, issue #9): delivery status precedence, template
 * variables, reply keywords and the 24-hour service window. Provider-agnostic: the Spoki add-on uses
 * them, a future SMS or WhatsApp connector can too.
 */

/** Status of one message in a log; inbound messages are `received`. */
export const MESSAGE_STATUSES = ["queued", "sent", "failed", "delivered", "read", "replied", "received"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Forward-only precedence of an outbound message: queued < sent < failed < delivered < read < replied.
 * Providers resend the same message with updated statuses and out of order (a late "sent" after
 * "read"); a failure reported after a delivery is ignored, a delivery after a failure wins (the
 * provider retried). `received` belongs to inbound messages and never changes.
 */
const RANK: Record<MessageStatus, number> = { queued: 0, sent: 1, failed: 2, delivered: 3, read: 4, replied: 5, received: 99 };

export function isMessageStatus(v: unknown): v is MessageStatus {
  return typeof v === "string" && (MESSAGE_STATUSES as readonly string[]).includes(v);
}

/** The status after an update, or null when the update must be ignored (not forward, or inbound). */
export function nextMessageStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus | null {
  if (current === "received" || incoming === "received") return null;
  return RANK[incoming] > RANK[current] ? incoming : null;
}

const VAR = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|%%\s*([a-zA-Z0-9_]+)\s*%%/g;

/**
 * Fills `{{name}}` (internal) and `%%NAME%%` (provider custom fields) placeholders; keys match
 * case-insensitively, unknown or empty ones become "" and the whitespace they leave is tidied.
 */
export function renderMessageTemplate(body: string, vars: Readonly<Record<string, string | null | undefined>>): string {
  const lower = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  return body
    .replace(VAR, (_, a: string | undefined, b: string | undefined) => lower.get((a ?? b ?? "").toLowerCase()) ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Variables a template body uses, in order, without duplicates (lower case). */
export function messageTemplateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(VAR)].map((m) => (m[1] ?? m[2] ?? "").toLowerCase()))];
}

/** Variables the body uses that have no value: a template is not sent while one is missing. */
export function missingTemplateVariables(body: string, vars: Readonly<Record<string, string | null | undefined>>): string[] {
  const have = new Set(Object.entries(vars).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k]) => k.toLowerCase()));
  return messageTemplateVariables(body).filter((k) => !have.has(k));
}

/**
 * Provider custom fields from template variables. `mapping` is field name → variable; without a
 * mapping every variable is sent under its upper-case name (`first_name` → `FIRST_NAME`). Empty
 * values are sent as "" so a template never shows a raw placeholder.
 */
export function customFieldsFor(vars: Readonly<Record<string, string | null | undefined>>, mapping: Readonly<Record<string, string>> = {}): Record<string, string> {
  const entries = Object.entries(mapping);
  if (!entries.length) return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toUpperCase(), v ?? ""]));
  return Object.fromEntries(entries.map(([field, key]) => [field, vars[key] ?? ""]));
}

/** Lower case, accents and punctuation removed, spaces collapsed: "Sì!! " → "si". */
export function normalizeReply(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a reply is one of the keywords: the whole reply, or its first word when the reply is short
 * (≤ 4 words), so "Yes please" matches "yes" but a long message that merely contains "no" does not.
 */
export function replyMatches(text: string | null | undefined, keywords: readonly string[]): boolean {
  const reply = normalizeReply(text);
  if (!reply) return false;
  const words = reply.split(" ");
  for (const k of keywords) {
    const kw = normalizeReply(k);
    if (!kw) continue;
    if (reply === kw) return true;
    const kwWords = kw.split(" ").length;
    if (words.length <= 4 && words.slice(0, kwWords).join(" ") === kw) return true;
  }
  return false;
}

/** WhatsApp: free-form messages only within 24 hours of the customer's last message; outside it, approved templates only. */
export const SERVICE_WINDOW_MS = 24 * 3600e3;
export function isInServiceWindow(lastInboundAt: Date | null | undefined, now: Date): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS && now.getTime() >= lastInboundAt.getTime();
}

/** Order events a store can notify by message, from the canonical status the order moved to. */
export const ORDER_MESSAGE_EVENTS = ["order_confirmed", "order_shipped", "order_delivered"] as const;
export type OrderMessageEvent = (typeof ORDER_MESSAGE_EVENTS)[number];

/** The notification an order status change triggers, if any (moving back or sideways triggers none). */
export function orderMessageEventFor(from: string | null | undefined, to: string | null | undefined): OrderMessageEvent | null {
  if (!to || from === to) return null;
  const order = ["new", "pending_review", "on_hold", "confirmed", "fulfilling", "shipped", "delivered"];
  const fromAt = from ? order.indexOf(from) : -1;
  const toAt = order.indexOf(to);
  if (toAt < 0 || (fromAt >= 0 && fromAt >= toAt)) return null;
  if (to === "confirmed") return "order_confirmed";
  if (to === "shipped") return "order_shipped";
  if (to === "delivered") return "order_delivered";
  return null;
}

/** Provider error codes that mean "never market to this number again" (user stopped marketing messages). */
export function isOptOutErrorCode(code: string | null | undefined): boolean {
  return !!code && /131050/.test(code);
}

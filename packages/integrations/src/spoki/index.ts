import { createHash } from "node:crypto";
import { HttpClient, type HttpOptions } from "../http";
import { FailureScript } from "../mock/failures";
import { IntegrationError, type ConnectionTest, type MessageSendInput, type MessagingChannel } from "../types";

/**
 * Spoki (WhatsApp Business Solution Provider) as a `MessagingChannel` (issue #9, add-on
 * `addon.whatsapp_spoki`). API base `https://api.spoki.com/api/1`, key in the `X-Spoki-Api-Key`
 * header. What the Control Room used: template and free-text sends, approved templates, contact
 * lookup; plus contact upsert, list membership and ticket handoff, marked "to verify" in the guide.
 * Tests run on recorded responses through an injected fetch; nothing here is called in mock mode.
 */
export interface SpokiCredentials {
  apiKey: string;
}

export const SPOKI_API_BASE = "https://api.spoki.com/api/1";

export type SpokiTemplateStatus = "draft" | "pending" | "approved" | "rejected";
export interface SpokiTemplate {
  id: string;
  name: string;
  language: string | null;
  category: string | null;
  status: SpokiTemplateStatus;
  /** Body text with `%%FIELD%%` placeholders, when the provider returns it. */
  body: string | null;
  /** Custom field names the template expects. */
  fields: string[];
}

export interface SpokiContact {
  id: string;
  phone: string;
  chatLink: string | null;
  subscribed: boolean | null;
}

export interface SpokiContactInput {
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  language?: string | null;
  customFields?: Record<string, string>;
}

export type SpokiDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** One webhook delivery, normalized. Spoki resends the same outbound message id with each new status. */
export type SpokiWebhookEvent =
  | { kind: "status"; messageId: string; status: SpokiDeliveryStatus; phone: string | null; templateId: string | null; errorCode: string | null; contactId: string | null; occurredAt: Date | null }
  | { kind: "inbound"; messageId: string; phone: string | null; text: string; contactId: string | null; replyToMessageId: string | null; hasMedia: boolean; occurredAt: Date | null };

/** The provider-specific operations beyond `MessagingChannel`; the live adapter and the mock both implement them. */
export interface SpokiApi extends MessagingChannel {
  sendTemplate(to: string, templateId: string, customFields: Record<string, string>): Promise<{ messageId: string }>;
  sendText(to: string, text: string): Promise<{ messageId: string }>;
  listTemplates(): Promise<SpokiTemplate[]>;
  findContact(phone: string): Promise<SpokiContact | null>;
  upsertContact(input: SpokiContactInput): Promise<SpokiContact>;
  addContactToList(contactId: string, listId: string): Promise<void>;
  openTicket(input: { phone: string; title: string; description: string }): Promise<{ id: string }>;
}

/* ---------- mapping ---------- */

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** `+` and digits; null when there are too few digits to be a phone number. */
export function spokiPhone(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const digits = s.split("@")[0]!.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

/** Digits only, as Spoki's contact search expects them. */
const digitsOf = (phone: string) => phone.replace(/\D/g, "");

const STATUS: Record<string, SpokiDeliveryStatus> = { sent: "sent", delivered: "delivered", read: "read", seen: "read", error: "failed", failed: "failed", undelivered: "failed", rejected: "failed" };

function dateOf(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The provider's error code (`spoki::1029`, `whatsapp::131050`) from a payload or an error message. */
export function spokiErrorCode(v: unknown): string | null {
  const s = typeof v === "string" ? v : v instanceof Error ? v.message : v ? JSON.stringify(v) : "";
  const m = s.match(/\b(spoki|whatsapp)::\d+/i);
  return m ? m[0].toLowerCase() : null;
}

/**
 * A Spoki webhook body → one normalized event, or null when it carries nothing the adapter uses. Envelope
 * `{event|type, data|message|payload|result}`; the phone has many fallbacks (from/to phone, contact,
 * wa_id, chat id before `@`); the first "Sent" of a template may lack the template id.
 */
export function parseSpokiWebhook(body: unknown): SpokiWebhookEvent | null {
  const env = obj(body);
  if (!env) return null;
  const event = (str(env.event) ?? str(env.type) ?? "").toLowerCase();
  const m = obj(env.data) ?? obj(env.message) ?? obj(env.payload) ?? obj(env.result) ?? env;
  const messageId = str(m.uuid) ?? str(m.id) ?? str(m.message_id) ?? str(m.message_uuid);
  if (!messageId) return null;
  const contact = obj(m.contact);
  const dir = (str(m.direction) ?? "").toLowerCase();
  const inbound = event.includes("inbound") || (!event.includes("outbound") && (dir.startsWith("in") || dir === "received"));
  const phoneFallbacks = [contact?.phone, m.wa_id, m.chat_id, m.phone];
  const phone = [...(inbound ? [m.from_phone, m.from] : [m.to_phone, m.to]), ...phoneFallbacks].map(spokiPhone).find(Boolean) ?? null;
  const contactId = str(contact?.id) ?? str(m.contact_id);
  const occurredAt = dateOf(m.created_at ?? m.timestamp ?? env.created_at);
  if (inbound) {
    const media = Array.isArray(m.mediamessage_set) && m.mediamessage_set.length > 0;
    const text = str(m.text) ?? str(m.body) ?? str(m.content) ?? str(m.button_text) ?? str(m.caption) ?? "";
    return { kind: "inbound", messageId, phone, text, contactId, replyToMessageId: str(m.replyToMessageUid) ?? str(m.reply_to_message_uid) ?? str(m.context_id), hasMedia: media, occurredAt };
  }
  const status = STATUS[(str(m.send_status) ?? str(m.status) ?? "").toLowerCase()];
  if (!status) return null;
  return { kind: "status", messageId, status, phone, templateId: str(m.template) ?? str(obj(m.template)?.id), errorCode: str(m.error_code) ? (spokiErrorCode(m.error_code) ?? str(m.error_code)) : null, contactId, occurredAt };
}

/** The webhook idempotency key: one row per message and status (a replayed delivery is a duplicate, a new status is not). */
export function spokiEventKey(e: SpokiWebhookEvent): { topic: string; externalId: string; sourceUpdatedAt: string } {
  return e.kind === "status" ? { topic: "message.status", externalId: e.messageId, sourceUpdatedAt: e.status } : { topic: "message.inbound", externalId: e.messageId, sourceUpdatedAt: "" };
}

const TEMPLATE_STATUS: Record<string, SpokiTemplateStatus> = { "0": "draft", "1": "pending", "2": "approved", "3": "rejected", "4": "approved" };

interface RawTemplate {
  id?: number | string;
  name?: string;
  category?: string | null;
  status?: number | string;
  language?: string | null;
  templatelocalization_set?: { language?: string; body?: string; status?: number | string }[];
  customfield_set?: ({ name?: string; key?: string } | string)[];
}

export function mapSpokiTemplate(t: RawTemplate): SpokiTemplate | null {
  const id = str(t.id);
  if (!id) return null;
  const loc = t.templatelocalization_set?.[0];
  const status = TEMPLATE_STATUS[String(t.status ?? loc?.status ?? "")] ?? "pending";
  const fields = (t.customfield_set ?? []).map((f) => (typeof f === "string" ? f : (f.key ?? f.name ?? ""))).filter(Boolean);
  const body = loc?.body ?? null;
  const fromBody = body ? [...body.matchAll(/%%\s*([A-Za-z0-9_]+)\s*%%/g)].map((x) => x[1]!) : [];
  return { id, name: t.name ?? id, language: loc?.language ?? t.language ?? null, category: t.category ?? null, status, body, fields: [...new Set([...fields, ...fromBody])] };
}

/* ---------- live adapter ---------- */

interface SendResponse {
  id?: number | string;
  uuid?: string;
  error?: unknown;
  error_code?: string;
}

export class SpokiChannel implements SpokiApi {
  readonly provider = "spoki";
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(private readonly creds: SpokiCredentials, opts: HttpOptions & { baseUrl?: string } = {}) {
    this.http = new HttpClient({ minIntervalMs: 100, ...opts });
    this.base = (opts.baseUrl ?? SPOKI_API_BASE).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return { "x-spoki-api-key": this.creds.apiKey, "content-type": "application/json", accept: "application/json" };
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      const r = await this.http.request<T>(path.startsWith("http") ? path : `${this.base}${path}`, { method: init.method, headers: this.headers(), body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return r.json;
    } catch (e) {
      // credit exhausted is not a retryable failure: everything stops until the account is topped up
      if (e instanceof IntegrationError && spokiErrorCode(e.message) === "spoki::1029") throw new IntegrationError("permission", `Spoki credit exhausted (spoki::1029): ${e.message}`);
      throw e;
    }
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const r = await this.call<{ count?: number; results?: unknown[] }>("/templates/?page_size=1");
      return { ok: true, accountName: `Spoki (${r.count ?? r.results?.length ?? 0} templates)` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private messageIdOf(r: SendResponse | null): { messageId: string } {
    const id = str(r?.uuid) ?? str(r?.id);
    // a send is accepted only when the answer carries the message id
    if (!id) throw new IntegrationError("invalid_request", `Spoki did not accept the message${r?.error_code ? ` (${r.error_code})` : ""}: ${JSON.stringify(r?.error ?? r ?? null).slice(0, 200)}`);
    return { messageId: id };
  }

  async sendTemplate(to: string, templateId: string, customFields: Record<string, string>) {
    const template = Number(templateId);
    if (!Number.isInteger(template)) throw new IntegrationError("invalid_request", `Spoki template id must be a number: ${templateId}`);
    return this.messageIdOf(await this.call<SendResponse>("/messages/send/", { method: "POST", body: { type: "Template", phone: to, template, custom_fields: customFields } }));
  }

  async sendText(to: string, text: string) {
    return this.messageIdOf(await this.call<SendResponse>("/messages/send/", { method: "POST", body: { type: "Message", content_type: "Text", phone: to, text } }));
  }

  /**
   * `template` is a Spoki template id (digits) sent with `variables` as custom fields, or anything
   * else for a free-text message (`variables.body`, else the template string itself), which WhatsApp
   * accepts only within 24 hours of the customer's last message. Spoki has no idempotency key: the
   * add-on's message log deduplicates by `idempotencyKey` before calling.
   */
  async sendMessage(input: MessageSendInput) {
    if (/^\d+$/.test(input.template)) return this.sendTemplate(input.to, input.template, input.variables);
    return this.sendText(input.to, input.variables.body ?? input.template);
  }

  async listTemplates(): Promise<SpokiTemplate[]> {
    const out: SpokiTemplate[] = [];
    let next: string | null = "/templates/?page_size=100";
    for (let page = 0; next && page < 20; page++) {
      const r: { results?: RawTemplate[]; next?: string | null } = await this.call(next);
      for (const t of r.results ?? []) {
        const m = mapSpokiTemplate(t);
        if (m) out.push(m);
      }
      next = r.next ?? null;
    }
    return out;
  }

  /** Spoki stores numbers with or without the `+`: both forms are tried. */
  async findContact(phone: string): Promise<SpokiContact | null> {
    const digits = digitsOf(phone);
    for (const q of [digits, `+${digits}`]) {
      const r = await this.call<{ results?: { id?: number | string; phone?: string; chat_link?: string | null; is_subscribed?: boolean; status?: string }[] }>(`/contacts/?phone=${encodeURIComponent(q)}`);
      const c = r.results?.[0];
      if (c && str(c.id)) return { id: str(c.id)!, phone: spokiPhone(c.phone) ?? `+${digits}`, chatLink: c.chat_link ?? null, subscribed: typeof c.is_subscribed === "boolean" ? c.is_subscribed : c.status ? c.status.toLowerCase() !== "unsubscribed" : null };
    }
    return null;
  }

  async upsertContact(input: SpokiContactInput): Promise<SpokiContact> {
    const body = { phone: `+${digitsOf(input.phone)}`, first_name: input.firstName ?? undefined, last_name: input.lastName ?? undefined, email: input.email ?? undefined, language: input.language ?? undefined, custom_fields: input.customFields ?? undefined };
    const existing = await this.findContact(input.phone);
    const r = existing ? await this.call<{ id?: number | string; chat_link?: string | null }>(`/contacts/${existing.id}/`, { method: "PATCH", body }) : await this.call<{ id?: number | string; chat_link?: string | null }>("/contacts/", { method: "POST", body });
    const id = str(r?.id) ?? existing?.id;
    if (!id) throw new IntegrationError("invalid_request", "Spoki did not return the contact id");
    return { id, phone: body.phone, chatLink: r?.chat_link ?? existing?.chatLink ?? null, subscribed: existing?.subscribed ?? null };
  }

  async addContactToList(contactId: string, listId: string): Promise<void> {
    await this.call(`/lists/${encodeURIComponent(listId)}/contacts/`, { method: "POST", body: { contacts: [Number(contactId) || contactId] } });
  }

  async openTicket(input: { phone: string; title: string; description: string }): Promise<{ id: string }> {
    const r = await this.call<{ id?: number | string }>("/tickets/", { method: "POST", body: { contact_phone: `+${digitsOf(input.phone)}`, title: input.title, status: "Open", priority: "Medium", description: input.description } });
    if (!str(r?.id)) throw new IntegrationError("invalid_request", "Spoki did not return the ticket id");
    return { id: str(r.id)! };
  }

  /** Status receipts only (`MessagingChannel` contract); the add-on reads inbound messages with `parseSpokiWebhook`. The URL token is the shared secret. */
  async verifyWebhook(_headers: Record<string, string | undefined>, rawBody: string) {
    const e = parseSpokiWebhook(JSON.parse(rawBody));
    if (!e || e.kind !== "status") throw new IntegrationError("unsupported", "not a Spoki status event");
    return { messageId: e.messageId, status: e.status, raw: e };
  }
}

/* ---------- mock ---------- */

/** Templates of the simulated account (ids as Spoki numbers them). */
export const MOCK_SPOKI_TEMPLATES: SpokiTemplate[] = [
  { id: "40101", name: "cod_confirmation", language: "en", category: "UTILITY", status: "approved", body: "Hi %%FIRST_NAME%%, please confirm your cash-on-delivery order %%ORDER_NAME%% of %%TOTAL%%. Reply YES to confirm or NO to cancel.", fields: ["FIRST_NAME", "ORDER_NAME", "TOTAL"] },
  { id: "40102", name: "order_confirmed", language: "en", category: "UTILITY", status: "approved", body: "Thanks %%FIRST_NAME%%! Order %%ORDER_NAME%% is confirmed.", fields: ["FIRST_NAME", "ORDER_NAME"] },
  { id: "40103", name: "order_shipped", language: "en", category: "UTILITY", status: "approved", body: "%%FIRST_NAME%%, order %%ORDER_NAME%% has shipped: %%TRACKING_URL%%", fields: ["FIRST_NAME", "ORDER_NAME", "TRACKING_URL"] },
  { id: "40104", name: "order_delivered", language: "en", category: "UTILITY", status: "approved", body: "Order %%ORDER_NAME%% was delivered. Enjoy!", fields: ["ORDER_NAME"] },
  { id: "40105", name: "winback_offer", language: "en", category: "MARKETING", status: "approved", body: "%%FIRST_NAME%%, we miss you: %%BODY%%", fields: ["FIRST_NAME", "BODY"] },
  { id: "40106", name: "spring_launch", language: "en", category: "MARKETING", status: "pending", body: "New collection is here, %%FIRST_NAME%%!", fields: ["FIRST_NAME"] },
];

/**
 * Simulated Spoki account: records sends, answers with message ids derived from the idempotency key
 * (a repeated key gets the first id, like a provider honouring it), and builds webhook bodies in
 * Spoki's own shape so the mapper and the whole receipt path run in mock mode too.
 */
export class MockSpokiChannel implements SpokiApi {
  readonly provider = "spoki";
  readonly failures = new FailureScript();
  readonly sent: { to: string; templateId: string | null; text: string | null; customFields: Record<string, string>; messageId: string }[] = [];
  readonly contacts = new Map<string, SpokiContact>();
  readonly lists = new Map<string, Set<string>>();
  readonly tickets: { phone: string; title: string }[] = [];
  templates: SpokiTemplate[] = MOCK_SPOKI_TEMPLATES.map((t) => ({ ...t }));
  private readonly byKey = new Map<string, string>();
  private seq = 0;

  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: "Simulated Spoki account" };
  }

  private nextId(key?: string): string {
    this.seq++;
    return key ? `spk_${createHash("sha256").update(key).digest("hex").slice(0, 20)}` : `spk_${Date.now().toString(36)}${this.seq.toString(36).padStart(4, "0")}`;
  }

  private record(to: string, templateId: string | null, text: string | null, customFields: Record<string, string>, key?: string) {
    this.failures.check();
    const known = key ? this.byKey.get(key) : undefined;
    if (known) return { messageId: known };
    if (!spokiPhone(to)) throw new IntegrationError("invalid_request", "Mock Spoki: whatsapp::131026 recipient is not a valid WhatsApp number");
    if (templateId && !this.templates.some((t) => t.id === templateId && t.status === "approved")) throw new IntegrationError("invalid_request", `Mock Spoki: template ${templateId} is not approved`);
    const messageId = this.nextId(key);
    if (key) this.byKey.set(key, messageId);
    this.sent.push({ to, templateId, text, customFields, messageId });
    return { messageId };
  }

  async sendTemplate(to: string, templateId: string, customFields: Record<string, string>) {
    return this.record(to, templateId, null, customFields);
  }

  async sendText(to: string, text: string) {
    return this.record(to, null, text, {});
  }

  async sendMessage(input: MessageSendInput) {
    return /^\d+$/.test(input.template) ? this.record(input.to, input.template, null, input.variables, input.idempotencyKey) : this.record(input.to, null, input.variables.body ?? input.template, {}, input.idempotencyKey);
  }

  async listTemplates() {
    this.failures.check();
    return this.templates.map((t) => ({ ...t }));
  }

  async findContact(phone: string) {
    return this.contacts.get(spokiPhone(phone) ?? phone) ?? null;
  }

  async upsertContact(input: SpokiContactInput) {
    const phone = spokiPhone(input.phone);
    if (!phone) throw new IntegrationError("invalid_request", "Mock Spoki: invalid phone");
    const c = this.contacts.get(phone) ?? { id: String(900000 + this.contacts.size + 1), phone, chatLink: `https://app.spoki.example/chat/${phone.slice(1)}`, subscribed: true };
    this.contacts.set(phone, c);
    return c;
  }

  async addContactToList(contactId: string, listId: string) {
    const s = this.lists.get(listId) ?? new Set<string>();
    s.add(contactId);
    this.lists.set(listId, s);
  }

  async openTicket(input: { phone: string; title: string; description: string }) {
    this.tickets.push({ phone: input.phone, title: input.title });
    return { id: `mock-ticket-${this.tickets.length}` };
  }

  async verifyWebhook(_headers: Record<string, string | undefined>, rawBody: string) {
    const e = parseSpokiWebhook(JSON.parse(rawBody));
    if (!e || e.kind !== "status") throw new IntegrationError("unsupported", "not a Spoki status event");
    return { messageId: e.messageId, status: e.status, raw: e };
  }

  /** A status receipt as Spoki sends it (`message.outbound`, `send_status` capitalised). */
  static statusBody(messageId: string, status: SpokiDeliveryStatus, opts: { phone?: string; errorCode?: string; at?: Date } = {}): Record<string, unknown> {
    return { event: "message.outbound", data: { uuid: messageId, direction: "outbound", to_phone: opts.phone?.replace(/^\+/, "") ?? null, send_status: status === "failed" ? "Error" : status[0]!.toUpperCase() + status.slice(1), error_code: opts.errorCode ?? null, created_at: (opts.at ?? new Date()).toISOString() } };
  }

  /** An inbound customer message, optionally replying to (or pressing a button of) one of the store's messages. */
  static inboundBody(phone: string, text: string, opts: { messageId?: string; replyTo?: string | null; at?: Date } = {}): Record<string, unknown> {
    const at = opts.at ?? new Date();
    return { event: "message.inbound", data: { uuid: opts.messageId ?? `spk_in_${createHash("sha256").update(`${phone}:${text}:${at.getTime()}`).digest("hex").slice(0, 16)}`, direction: "inbound", from_phone: phone.replace(/^\+/, ""), text, replyToMessageUid: opts.replyTo ?? null, created_at: at.toISOString() } };
  }
}

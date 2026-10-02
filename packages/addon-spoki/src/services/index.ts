import { and, desc, eq, gte, inArray, isNotNull, recordAudit, schema, sql } from "@hullwise/db";
import { customFieldsFor, renderMessageTemplate, diffRecords, formatMoney, isOptOutErrorCode, nextMessageStatus, normalizePhone, orderMessageEventFor, replyMatches, type MessageStatus, type OrderMessageEvent } from "@hullwise/core";
import { IntegrationError, MockSpokiChannel, SpokiChannel, decryptJson, parseSpokiWebhook, spokiErrorCode, spokiEventKey, type MessageSendInput, type MessagingChannel, type SpokiApi, type SpokiCredentials, type SpokiTemplate } from "@hullwise/integrations";
import { addPhoneSuppression, integrationRow, isLive, recordHealth, recordWebhookEvent, type ServiceContext, type WebhookResult } from "@hullwise/services";
import { MARKETING_CATEGORY } from "@hullwise/services";
import { parseSpokiSettings, spokiSettingsSchema, templateFor, type SpokiSettings } from "../settings";

/**
 * Services of the Spoki WhatsApp add-on (issue #9): settings, the provider adapter of a tenant, the
 * message log (a `MessagingChannel` that records and deduplicates every send), order notifications,
 * and inbound webhook processing (receipts, replies, opt-outs). COD and campaign behaviour is not
 * here: COD reply handling lives in `@hullwise/addon-cod` and is passed in as a hook by the job runner,
 * campaigns use this channel through the core send queue.
 */

export class SpokiError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_input" | "not_connected" | "no_phone" | "no_template" | "provider_error",
    public readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Short tenant transactions on demand (the job runner's `runner`, or `(fn) => fn(ctx)` inside one). */
export type TenantRun = <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>;
export const inTx = (ctx: ServiceContext): TenantRun => (fn) => fn(ctx);

const errText = (e: unknown) => (e instanceof Error ? `${e instanceof IntegrationError ? `[${e.code}] ` : ""}${e.message}` : String(e)).slice(0, 500);

/* ---------- settings ---------- */

export interface SpokiState {
  settings: SpokiSettings;
  templates: SpokiTemplate[];
  templatesSyncedAt: Date | null;
  notifiedUntil: Date | null;
}

export async function getSpokiState(ctx: ServiceContext): Promise<SpokiState> {
  const [row] = await ctx.tx.select().from(schema.spokiSettings).where(eq(schema.spokiSettings.tenantId, ctx.tenantId)).limit(1);
  return { settings: parseSpokiSettings(row?.config), templates: (row?.templates as SpokiTemplate[] | undefined) ?? [], templatesSyncedAt: row?.templatesSyncedAt ?? null, notifiedUntil: row?.notifiedUntil ?? null };
}

export async function getSpokiSettings(ctx: ServiceContext): Promise<SpokiSettings> {
  return (await getSpokiState(ctx)).settings;
}

/** The settings row; created with the notification cursor at "now", so turning notifications on never messages past orders. */
async function ensureRow(ctx: ServiceContext) {
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.spokiSettings).values({ tenantId: ctx.tenantId, config: {}, notifiedUntil: now }).onConflictDoNothing();
}

/** Merges a patch (templates and notify merged key by key), validates it and audits the field diff. */
export async function saveSpokiSettings(ctx: ServiceContext, patch: Partial<Record<keyof SpokiSettings, unknown>>): Promise<SpokiSettings> {
  await ensureRow(ctx);
  const before = await getSpokiSettings(ctx);
  const merged = { ...before, ...patch, templates: { ...before.templates, ...((patch.templates as object | undefined) ?? {}) }, notify: { ...before.notify, ...((patch.notify as object | undefined) ?? {}) } };
  // a template key mapped to nothing is removed
  for (const [k, v] of Object.entries(merged.templates)) if (!v || (!(v as { templateId?: unknown }).templateId && !Object.keys((v as { fields?: object }).fields ?? {}).length)) delete (merged.templates as Record<string, unknown>)[k];
  const parsed = spokiSettingsSchema.safeParse(merged);
  if (!parsed.success) throw new SpokiError("invalid_input", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const after = parsed.data;
  await ctx.tx.update(schema.spokiSettings).set({ config: after, updatedAt: ctx.now ?? new Date() }).where(eq(schema.spokiSettings.tenantId, ctx.tenantId));
  const diff = diffRecords(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
  if (Object.keys(diff).length) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" || ctx.actor.type === "mcp" ? ctx.actor.type : "system", action: "spoki.settings_updated", entityType: "spoki_settings", diff });
  return after;
}

/* ---------- adapter ---------- */

const mocks = new Map<string, MockSpokiChannel>();
const lives = new Map<string, { key: string; api: SpokiChannel }>();

/**
 * The tenant's Spoki account: null until the integration is connected; the live adapter with the
 * encrypted API key when connected live (and `HULLWISE_INTEGRATION_MODE=live`); the per-process
 * simulated account otherwise.
 */
export async function getSpokiApiFor(ctx: ServiceContext): Promise<SpokiApi | null> {
  const row = await integrationRow(ctx, "spoki");
  if (!row || row.status === "not_connected") return null;
  if (isLive(row)) {
    const key = row.credentialsEncrypted!;
    const cached = lives.get(ctx.tenantId);
    if (cached && cached.key === key) return cached.api;
    const api = new SpokiChannel(decryptJson<SpokiCredentials>(key));
    lives.set(ctx.tenantId, { key, api });
    return api;
  }
  return mockSpokiFor(ctx.tenantId);
}

export function mockSpokiFor(tenantId: string): MockSpokiChannel {
  let m = mocks.get(tenantId);
  if (!m) {
    m = new MockSpokiChannel();
    mocks.set(tenantId, m);
  }
  return m;
}

/** Reads the account's templates into the settings row ("Resync" on the integration card). */
export async function syncSpokiTemplates(ctx: ServiceContext, api: SpokiApi): Promise<{ templates: number; approved: number }> {
  await ensureRow(ctx);
  try {
    const templates = await api.listTemplates();
    await ctx.tx.update(schema.spokiSettings).set({ templates, templatesSyncedAt: ctx.now ?? new Date(), updatedAt: ctx.now ?? new Date() }).where(eq(schema.spokiSettings.tenantId, ctx.tenantId));
    await recordHealth(ctx, "spoki:templates", true, { rowsWritten: templates.length, freshnessMinutes: 7 * 24 * 60 });
    return { templates: templates.length, approved: templates.filter((t) => t.status === "approved").length };
  } catch (e) {
    await recordHealth(ctx, "spoki:templates", false, { error: errText(e) });
    throw new SpokiError("provider_error", errText(e));
  }
}

/* ---------- message log ---------- */

type MessageRow = typeof schema.spokiMessages.$inferSelect;

async function messageByProviderId(ctx: ServiceContext, providerMessageId: string): Promise<MessageRow | null> {
  const [m] = await ctx.tx.select().from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), eq(schema.spokiMessages.providerMessageId, providerMessageId))).limit(1);
  return m ?? null;
}

async function customerByPhone(ctx: ServiceContext, phone: string): Promise<string | null> {
  const [c] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.phoneE164, phone))).orderBy(desc(schema.customers.lastOrderAt)).limit(1);
  return c?.id ?? null;
}

export interface ChannelDefaults {
  purpose: string;
  orderId?: string | null;
  customerId?: string | null;
  campaignId?: string | null;
  sentBy?: string | null;
  /** Country used to read a phone written without its prefix (the tenant's country). */
  country?: string;
}

/**
 * A `MessagingChannel` over the tenant's Spoki account that keeps the message log: the template is
 * resolved from the settings (`cod:<key>`, the order event, `campaign`), a mapped template is sent
 * with its custom fields and anything else as free text; every send is one `spoki_messages` row.
 * A repeated idempotency key already sent answers with the first message id without calling Spoki
 * (Spoki has no idempotency key of its own); a failed attempt is logged and retried on the same row.
 * Order messages other than COD (which writes its own `cod_message` event) get a timeline event.
 */
export function spokiMessagingChannel(run: TenantRun, api: SpokiApi, settings: SpokiSettings, defaults: ChannelDefaults, opts: { templates?: readonly SpokiTemplate[] } = {}): MessagingChannel {
  return {
    provider: api.provider,
    testConnection: () => api.testConnection(),
    verifyWebhook: (h, raw) => api.verifyWebhook(h, raw),
    async sendMessage(input: MessageSendInput) {
      const meta = { ...defaults, ...Object.fromEntries(Object.entries(input.meta ?? {}).filter(([, v]) => v !== undefined && v !== null)) } as ChannelDefaults;
      const purpose = meta.purpose ?? defaults.purpose;
      const key = input.idempotencyKey ?? null;
      const phone = input.to.startsWith("+") ? input.to.replace(/[^\d+]/g, "") : (normalizePhone(input.to, meta.country ?? "US") ?? input.to);
      if (key) {
        const known = await run(async (ctx) => (await ctx.tx.select({ id: schema.spokiMessages.providerMessageId }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), eq(schema.spokiMessages.idempotencyKey, key), isNotNull(schema.spokiMessages.providerMessageId))).limit(1))[0]);
        if (known?.id) return { messageId: known.id };
      }
      const mapping = templateFor(settings, purpose, input.template);
      const body = input.variables.body ?? input.template;
      const vars = { ...input.variables, body };
      // the log shows what the customer reads: the approved template filled in, when its text is known
      const templateBody = mapping?.templateId ? opts.templates?.find((t) => t.id === mapping.templateId)?.body : null;
      const shown = templateBody ? renderMessageTemplate(templateBody, vars) : body;
      let messageId: string | null = null;
      let failure: unknown = null;
      try {
        messageId = (mapping?.templateId ? await api.sendTemplate(phone, mapping.templateId, customFieldsFor(vars, mapping.fields)) : await api.sendText(phone, body)).messageId;
      } catch (e) {
        failure = e;
      }
      await run(async (ctx) => {
        const now = ctx.now ?? new Date();
        const customerId = meta.customerId ?? (await customerByPhone(ctx, phone));
        const values = { direction: "outbound", purpose, providerMessageId: messageId, idempotencyKey: key, phone, customerId, orderId: meta.orderId ?? null, campaignId: meta.campaignId ?? null, templateId: mapping?.templateId ?? null, templateName: mapping?.templateName ?? (purpose === "cod" ? input.template : null), body: shown.slice(0, 4000), status: messageId ? "sent" : "failed", statusAt: now, errorCode: failure ? spokiErrorCode(failure) : null, errorMessage: failure ? errText(failure) : null, sentBy: meta.sentBy ?? ctx.actor.userId, occurredAt: now, updatedAt: now };
        // a retry of a failed key reuses its row; a receipt that arrived before this commit created the row by provider id
        const [existing] = key ? await ctx.tx.select({ id: schema.spokiMessages.id }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), eq(schema.spokiMessages.idempotencyKey, key))).limit(1) : [];
        const early = !existing && messageId ? await messageByProviderId(ctx, messageId) : null;
        if (existing) await ctx.tx.update(schema.spokiMessages).set(values).where(eq(schema.spokiMessages.id, existing.id));
        else if (early) await ctx.tx.update(schema.spokiMessages).set({ ...values, status: early.status }).where(eq(schema.spokiMessages.id, early.id));
        else await ctx.tx.insert(schema.spokiMessages).values({ tenantId: ctx.tenantId, ...values, createdAt: now });
        if (meta.orderId && purpose !== "cod" && messageId) await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: meta.orderId, type: "whatsapp_message", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { purpose, template: mapping?.templateName ?? mapping?.templateId ?? null, messageId, provider: api.provider }, createdAt: now });
      });
      if (failure) throw failure;
      return { messageId: messageId! };
    },
  };
}

/** Builds the logging channel for code that already holds a tenant transaction (COD card, test sends). */
export async function spokiChannelInTx(ctx: ServiceContext, defaults: ChannelDefaults): Promise<MessagingChannel> {
  const api = await getSpokiApiFor(ctx);
  if (!api) throw new SpokiError("not_connected");
  const state = await getSpokiState(ctx);
  return spokiMessagingChannel(inTx(ctx), api, state.settings, defaults, { templates: state.templates });
}

/* ---------- order notifications ---------- */

export interface NotifyOpts {
  shopName: string;
  locale: string;
  country: string;
}

/** Variables of an order notification: customer, order, total and the latest shipment's tracking. */
export async function orderNotificationVariables(ctx: ServiceContext, orderId: string, opts: NotifyOpts): Promise<{ phone: string | null; customerId: string | null; vars: Record<string, string> } | null> {
  const [o] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o) return null;
  const [s] = await ctx.tx.select({ trackingNumber: schema.shipments.trackingNumber, trackingUrl: schema.shipments.trackingUrl, carrier: schema.shipments.carrier }).from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.orderId, orderId))).orderBy(desc(schema.shipments.createdAt)).limit(1);
  const name = o.customerName?.trim() ?? "";
  return {
    phone: o.phoneE164 ?? normalizePhone(o.phone, opts.country),
    customerId: o.customerId ?? null,
    vars: { first_name: name.split(/\s+/)[0] ?? "", customer_name: name, order_name: o.name, total: formatMoney(o.totalMinor, o.currency, opts.locale), shop_name: opts.shopName, tracking_number: s?.trackingNumber ?? "", tracking_url: s?.trackingUrl ?? "", carrier: s?.carrier ?? "" },
  };
}

export type NotifyOutcome = "sent" | "disabled" | "no_template" | "no_phone" | "duplicate" | "failed";

/** One order notification, at most once per order and event (idempotency key `order:<id>:<event>`). */
export async function sendOrderNotification(run: TenantRun, api: SpokiApi, settings: SpokiSettings, orderId: string, event: OrderMessageEvent, opts: NotifyOpts & { templates?: readonly SpokiTemplate[] }): Promise<NotifyOutcome> {
  if (!settings.notify[event]) return "disabled";
  const mapping = settings.templates[event];
  if (!mapping?.templateId) return "no_template";
  const key = `order:${orderId}:${event}`;
  const prep = await run(async (ctx) => {
    const [dup] = await ctx.tx.select({ id: schema.spokiMessages.id }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), eq(schema.spokiMessages.idempotencyKey, key), isNotNull(schema.spokiMessages.providerMessageId))).limit(1);
    if (dup) return "duplicate" as const;
    return orderNotificationVariables(ctx, orderId, opts);
  });
  if (prep === "duplicate") return "duplicate";
  if (!prep?.phone) return "no_phone";
  try {
    await spokiMessagingChannel(run, api, settings, { purpose: event, orderId, customerId: prep.customerId, country: opts.country }, { templates: opts.templates }).sendMessage({ to: prep.phone, template: event, variables: prep.vars, idempotencyKey: key });
    return "sent";
  } catch {
    return "failed";
  }
}

/**
 * Order notifications from the status changes written since the cursor (the `whatsapp` tick):
 * forward moves to confirmed, shipped or delivered of the events the store switched on. The cursor
 * moves past what was looked at; a failed send stays logged as failed (no automatic resend).
 */
export async function runOrderNotifications(run: TenantRun, api: SpokiApi, opts: NotifyOpts & { now?: Date; limit?: number }): Promise<Record<NotifyOutcome, number>> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const counts: Record<NotifyOutcome, number> = { sent: 0, disabled: 0, no_template: 0, no_phone: 0, duplicate: 0, failed: 0 };
  const batch = await run(async (ctx) => {
    await ensureRow(ctx);
    const state = await getSpokiState(ctx);
    const since = state.notifiedUntil ?? now;
    const rows = await ctx.tx.select({ orderId: schema.orderEvents.orderId, diff: schema.orderEvents.diff, createdAt: schema.orderEvents.createdAt }).from(schema.orderEvents).where(and(eq(schema.orderEvents.tenantId, ctx.tenantId), eq(schema.orderEvents.type, "status_changed"), sql`${schema.orderEvents.createdAt} > ${since}`, sql`${schema.orderEvents.createdAt} <= ${now}`)).orderBy(schema.orderEvents.createdAt).limit(limit);
    return { settings: state.settings, templates: state.templates, rows };
  });
  for (const r of batch.rows) {
    const d = (r.diff as { status?: { from?: string | null; to?: string | null } }).status;
    const event = orderMessageEventFor(d?.from ?? null, d?.to ?? null);
    if (!event) continue;
    counts[await sendOrderNotification(run, api, batch.settings, r.orderId, event, { ...opts, templates: batch.templates })]++;
  }
  const until = batch.rows.length >= limit ? batch.rows.at(-1)!.createdAt : now;
  await run(async (ctx) => {
    await ctx.tx.update(schema.spokiSettings).set({ notifiedUntil: until }).where(eq(schema.spokiSettings.tenantId, ctx.tenantId));
    if (counts.sent + counts.failed > 0) await recordHealth(ctx, "spoki:notifications", counts.failed === 0, { rowsWritten: counts.sent, freshnessMinutes: 7 * 24 * 60, error: counts.failed ? `${counts.failed} notification(s) failed` : null, touchIntegration: false });
  });
  return counts;
}

/* ---------- inbound webhooks ---------- */

export interface SpokiHooks {
  /** A delivery status moved forward on a logged message (COD keeps its own message rows in step). */
  onStatus?(ctx: ServiceContext, e: { providerMessageId: string; status: "sent" | "delivered" | "read" | "failed"; at: Date }): Promise<unknown>;
  /** A customer reply that is not an opt-out (COD turns "confirm" replies into queue outcomes). */
  onReply?(ctx: ServiceContext, e: { providerMessageId: string; replyToMessageId: string | null; phone: string; text: string; orderId: string | null; at: Date }): Promise<unknown>;
}

/** Stores a webhook body once (idempotent on message id + status); null id when it carries nothing the product uses. */
export async function recordSpokiWebhook(ctx: ServiceContext, body: unknown): Promise<{ id: string | null; duplicate: boolean; ignored: boolean }> {
  const e = parseSpokiWebhook(body);
  if (!e) return { id: null, duplicate: false, ignored: true };
  const r = await recordWebhookEvent(ctx, { source: "spoki", ...spokiEventKey(e), payload: body });
  return { ...r, ignored: false };
}

async function applyStatus(ctx: ServiceContext, e: Extract<ReturnType<typeof parseSpokiWebhook>, { kind: "status" }>, hooks: SpokiHooks): Promise<void> {
  const at = e.occurredAt ?? ctx.now ?? new Date();
  const m = await messageByProviderId(ctx, e.messageId);
  if (!m) {
    // not sent from here (yet): the send may still be committing; without a phone there is nothing to log, so retry later
    if (!e.phone) throw new Error(`unknown message ${e.messageId}`);
    await ctx.tx.insert(schema.spokiMessages).values({ tenantId: ctx.tenantId, direction: "outbound", purpose: "external", providerMessageId: e.messageId, phone: e.phone, customerId: await customerByPhone(ctx, e.phone), templateId: e.templateId, status: e.status, statusAt: at, errorCode: e.errorCode, occurredAt: at }).onConflictDoNothing();
  } else {
    const next = nextMessageStatus(m.status as MessageStatus, e.status);
    if (!next && !(e.templateId && !m.templateId)) return;
    await ctx.tx.update(schema.spokiMessages).set({ ...(next ? { status: next, statusAt: at } : {}), ...(e.templateId && !m.templateId ? { templateId: e.templateId } : {}), ...(next === "failed" ? { errorCode: e.errorCode ?? m.errorCode } : {}), updatedAt: ctx.now ?? new Date() }).where(eq(schema.spokiMessages.id, m.id));
    if (!next) return;
  }
  if (e.status === "failed" && isOptOutErrorCode(e.errorCode) && (m?.phone ?? e.phone)) await addPhoneSuppression(ctx, { phone: (m?.phone ?? e.phone)!, reason: "unsubscribe", category: MARKETING_CATEGORY, source: "spoki", note: e.errorCode });
  await hooks.onStatus?.(ctx, { providerMessageId: e.messageId, status: e.status, at });
}

async function applyInbound(ctx: ServiceContext, e: Extract<ReturnType<typeof parseSpokiWebhook>, { kind: "inbound" }>, settings: SpokiSettings, hooks: SpokiHooks): Promise<void> {
  if (await messageByProviderId(ctx, e.messageId)) return;
  const at = e.occurredAt ?? ctx.now ?? new Date();
  const repliedTo = e.replyToMessageId ? await messageByProviderId(ctx, e.replyToMessageId) : null;
  const phone = e.phone ?? repliedTo?.phone ?? null;
  if (!phone) throw new Error(`inbound message ${e.messageId} without a phone`);
  // the message answered: the quoted one, else the last outbound to this number in the last days
  const [lastOut] = repliedTo ? [repliedTo] : await ctx.tx.select().from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), eq(schema.spokiMessages.phone, phone), eq(schema.spokiMessages.direction, "outbound"), gte(schema.spokiMessages.occurredAt, new Date(at.getTime() - settings.linkOrderDays * 864e5)))).orderBy(desc(schema.spokiMessages.occurredAt)).limit(1);
  // campaign messages never link orders
  const orderId = lastOut && lastOut.purpose !== "campaign" ? lastOut.orderId : null;
  const optOut = replyMatches(e.text, settings.optOutKeywords);
  await ctx.tx.insert(schema.spokiMessages).values({ tenantId: ctx.tenantId, direction: "inbound", purpose: "reply", providerMessageId: e.messageId, phone, customerId: lastOut?.customerId ?? (await customerByPhone(ctx, phone)), orderId, campaignId: lastOut?.campaignId ?? null, body: (e.text || (e.hasMedia ? "[media]" : "")).slice(0, 4000), status: "received", statusAt: at, replyToMessageId: e.replyToMessageId ?? lastOut?.providerMessageId ?? null, occurredAt: at }).onConflictDoNothing();
  if (lastOut) {
    const next = nextMessageStatus(lastOut.status as MessageStatus, "replied");
    if (next) await ctx.tx.update(schema.spokiMessages).set({ status: next, statusAt: at, updatedAt: ctx.now ?? new Date() }).where(eq(schema.spokiMessages.id, lastOut.id));
  }
  if (orderId) await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "whatsapp_reply", actorType: "integration", actorUserId: null, diff: {}, metadata: { text: e.text.slice(0, 300), messageId: e.messageId, optOut }, createdAt: at });
  if (optOut) {
    await addPhoneSuppression(ctx, { phone, reason: "unsubscribe", category: MARKETING_CATEGORY, source: "spoki", note: e.text.slice(0, 80) });
    return;
  }
  await hooks.onReply?.(ctx, { providerMessageId: e.messageId, replyToMessageId: e.replyToMessageId ?? lastOut?.providerMessageId ?? null, phone, text: e.text, orderId, at });
}

/**
 * Applies one stored webhook event (queued job, inline after the response, retry tick, replay):
 * receipts move the message status forward, inbound messages are logged, linked, checked for
 * opt-out and handed to the hooks. Runs in a savepoint so a failure is recorded on the event
 * (`failed`, attempts + 1, readable error) and retried; a processed event is skipped.
 */
export async function processSpokiWebhookEvent(ctx: ServiceContext, eventId: string, hooks: SpokiHooks = {}): Promise<WebhookResult> {
  const [ev] = await ctx.tx.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.id, eventId), eq(schema.webhookEvents.source, "spoki"))).limit(1);
  if (!ev) return { status: "skipped", topic: "unknown", error: "event_not_found" };
  if (ev.status === "processed") return { status: "skipped", topic: ev.topic };
  const now = ctx.now ?? new Date();
  try {
    await ctx.tx.transaction(async (sp) => {
      const c = { ...ctx, tx: sp };
      const e = parseSpokiWebhook(ev.payload);
      if (!e) return;
      if (e.kind === "status") await applyStatus(c, e, hooks);
      else await applyInbound(c, e, await getSpokiSettings(c), hooks);
    });
    await ctx.tx.update(schema.webhookEvents).set({ status: "processed", attempts: ev.attempts + 1, lastError: null, processedAt: now }).where(eq(schema.webhookEvents.id, ev.id));
    await recordHealth(ctx, "spoki:webhooks", true, { rowsWritten: 1, freshnessMinutes: 7 * 24 * 60 });
    return { status: "processed", topic: ev.topic };
  } catch (e) {
    const error = errText(e);
    await ctx.tx.update(schema.webhookEvents).set({ status: "failed", attempts: ev.attempts + 1, lastError: error }).where(eq(schema.webhookEvents.id, ev.id));
    await recordHealth(ctx, "spoki:webhooks", false, { error, touchIntegration: false });
    return { status: "failed", topic: ev.topic, error };
  }
}

/** Pending and failed Spoki events under the attempt limit, oldest first (retry tick and "Retry failed"). */
export async function retrySpokiWebhooks(ctx: ServiceContext, hooks: SpokiHooks = {}, opts: { maxAttempts?: number; limit?: number; minAgeMs?: number } = {}): Promise<{ retried: number; processed: number }> {
  const before = new Date((ctx.now ?? new Date()).getTime() - (opts.minAgeMs ?? 0));
  const rows = await ctx.tx.select({ id: schema.webhookEvents.id }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.source, "spoki"), inArray(schema.webhookEvents.status, ["failed", "pending"]), sql`${schema.webhookEvents.attempts} < ${opts.maxAttempts ?? 5}`, sql`${schema.webhookEvents.receivedAt} <= ${before}`)).orderBy(schema.webhookEvents.receivedAt).limit(opts.limit ?? 50);
  let processed = 0;
  for (const r of rows) if ((await processSpokiWebhookEvent(ctx, r.id, hooks)).status === "processed") processed++;
  return { retried: rows.length, processed };
}

/* ---------- reads ---------- */

/** Message log of an order, a customer (their id or their phone) or the whole tenant, newest first. */
export async function listSpokiMessages(ctx: ServiceContext, f: { orderId?: string; customerId?: string; limit?: number } = {}) {
  const where = [eq(schema.spokiMessages.tenantId, ctx.tenantId)];
  if (f.orderId) where.push(eq(schema.spokiMessages.orderId, f.orderId));
  if (f.customerId) {
    const [c] = await ctx.tx.select({ phone: schema.customers.phoneE164 }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, f.customerId))).limit(1);
    where.push(c?.phone ? sql`(${schema.spokiMessages.customerId} = ${f.customerId} or ${schema.spokiMessages.phone} = ${c.phone})` : eq(schema.spokiMessages.customerId, f.customerId));
  }
  return ctx.tx
    .select({ m: schema.spokiMessages, orderName: schema.orders.name, sender: sql<string | null>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` })
    .from(schema.spokiMessages)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.spokiMessages.orderId))
    .leftJoin(schema.users, eq(schema.users.id, schema.spokiMessages.sentBy))
    .where(and(...where))
    .orderBy(desc(schema.spokiMessages.occurredAt))
    .limit(Math.min(f.limit ?? 50, 200));
}

/** Last 7 days by status and purpose, for the settings page. */
export async function spokiStats(ctx: ServiceContext, days = 7) {
  const since = new Date((ctx.now ?? new Date()).getTime() - days * 864e5);
  const rows = await ctx.tx.select({ direction: schema.spokiMessages.direction, status: schema.spokiMessages.status, n: sql<number>`count(*)::int` }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenantId), gte(schema.spokiMessages.occurredAt, since))).groupBy(schema.spokiMessages.direction, schema.spokiMessages.status);
  const outbound = rows.filter((r) => r.direction === "outbound");
  const sum = (pred: (s: string) => boolean) => outbound.filter((r) => pred(r.status)).reduce((a, r) => a + r.n, 0);
  const [suppressed] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.identityType, "phone"), eq(schema.emailSuppressions.source, "spoki")));
  return { sent: sum(() => true), delivered: sum((s) => ["delivered", "read", "replied"].includes(s)), read: sum((s) => ["read", "replied"].includes(s)), replied: sum((s) => s === "replied"), failed: sum((s) => s === "failed"), received: rows.filter((r) => r.direction === "inbound").reduce((a, r) => a + r.n, 0), optOuts: suppressed?.n ?? 0 };
}

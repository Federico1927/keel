import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, lte, or, schema, sql, type DbExecutor } from "@hullwise/db";
import { EmailSendError, decryptJson, emailAddressHash, encryptJson, maskEmail, normalizeEmailAddress, type EmailProvider } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { emailSettings, getEmailProvider, type EmailSettings } from "./provider";
import { SECURITY_EMAIL, TRANSACTIONAL_EMAIL, isAddressSuppressed, isEmailSuppressed } from "./suppressions";
import { EMAIL_TEMPLATES, emailLocale, renderEmail, type EmailKind, type EmailTemplate, type EmailTemplateData } from "./templates";
import { oneClickUnsubscribeUrl, unsubscribeUrl } from "./unsubscribe";

/**
 * The one email code path (issue #51). `queueEmail` renders the template, checks both suppression
 * lists, writes the delivery log row (unique idempotency key per tenant, template, recipient and
 * event, so queueing twice is a no-op) and hands an encrypted job to the dispatcher: pg-boss
 * (`email.send`) when a worker runs, a deferred in-process delivery otherwise, an in-memory list
 * in tests. Nothing is ever sent inside the request. `deliverEmailJob` claims the row, sends with
 * the row's idempotency key (a retry after a timeout is deduplicated by the provider) and decides
 * retries with backoff; security emails are never sent once their link has expired.
 */

/** What travels in the queue: the log row id and the rendered message, AES-GCM encrypted (it carries links). */
export interface EmailJob {
  messageId: string;
  payload: string;
}
interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export type EmailTarget = ServiceContext | { db: DbExecutor; tenantId?: null; now?: Date };

export interface QueueEmailInput<K extends EmailTemplate> {
  to: string;
  template: K;
  data: EmailTemplateData[K];
  locale: string | null | undefined;
  /** What makes this email unique for the template and the recipient: a notification id, a token hash, a day. */
  event: string;
  /** Suppression category; defaults to the template's (notifications pass their type). */
  category?: string;
  /** Required for security emails: the instant their link stops working. */
  expiresAt?: Date | null;
}

export type QueueOutcome = "queued" | "suppressed" | "duplicate" | "invalid";
export interface QueuedEmail {
  id: string;
  status: string;
  outcome: QueueOutcome;
}

export const EMAIL_FINAL_STATUSES = ["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed", "expired"] as const;
const FINAL = new Set<string>(EMAIL_FINAL_STATUSES);
export const MAX_EMAIL_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
/** A `sending` claim older than this is considered abandoned (process died mid-send) and can be taken again. */
const STALE_CLAIM_MS = 2 * 60_000;

export function emailIdempotencyKey(tenantId: string | null, template: string, to: string, event: string): string {
  return createHash("sha256").update(`${tenantId ?? "platform"}|${template}|${normalizeEmailAddress(to)}|${event}`).digest("hex");
}

/** Error text for the log: provider messages can echo addresses or links, neither may be stored. */
export function sanitizeEmailError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g, "[email]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 300);
}

/* ---------- dispatcher ---------- */

export type EmailDispatcher = (job: EmailJob) => void | Promise<void>;
const store = globalThis as typeof globalThis & { __hullwiseEmailQueue?: { dispatcher: EmailDispatcher | null; pending: EmailJob[] } };
const queue = () => (store.__hullwiseEmailQueue ??= { dispatcher: null, pending: [] });

/** Installed once per process: the web app (pg-boss or deferred inline delivery) and the worker (pg-boss). */
export function setEmailDispatcher(dispatcher: EmailDispatcher | null): void {
  queue().dispatcher = dispatcher;
}

async function dispatch(job: EmailJob): Promise<void> {
  const d = queue().dispatcher;
  if (!d) {
    queue().pending.push(job);
    return;
  }
  try {
    await d(job);
  } catch (e) {
    // the log row stays `queued`; the sweep marks it lost if nothing picks it up
    console.warn("[email] dispatch failed:", e instanceof Error ? e.message : e);
  }
}

/** Jobs queued while no dispatcher was installed (tests, scripts), delivered now in order. */
export async function drainEmailJobs(db: DbExecutor, opts: DeliverOptions = {}): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];
  for (let job = queue().pending.shift(); job; job = queue().pending.shift()) out.push(await deliverEmailJob(db, job, opts));
  return out;
}

export function pendingEmailJobs(): readonly EmailJob[] {
  return queue().pending;
}

/* ---------- queue ---------- */

export async function queueEmail<K extends EmailTemplate>(target: EmailTarget, input: QueueEmailInput<K>): Promise<QueuedEmail> {
  const isTenant = "tx" in target;
  const db: DbExecutor = isTenant ? target.tx : target.db;
  const tenantId = isTenant ? target.tenantId : null;
  const now = target.now ?? new Date();
  const def = EMAIL_TEMPLATES[input.template];
  const category = input.category ?? def.category;
  if (def.kind === "security" && !input.expiresAt) throw new Error(`security email ${input.template} needs expiresAt`);
  const to = normalizeEmailAddress(input.to);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) && to.length <= 254;
  const recipientHash = emailAddressHash(to);
  const suppressed = valid && ((await isAddressSuppressed(db, recipientHash, def.kind)) || (isTenant && (await isEmailSuppressed(target, to, def.kind === "security" ? SECURITY_EMAIL : category))));
  const status = !valid ? "failed" : suppressed ? "suppressed" : "queued";
  const unsub = isTenant && def.kind !== "security" && category !== TRANSACTIONAL_EMAIL ? { tenantId: target.tenantId, email: to, category } : null;
  const rendered = status === "queued" ? renderEmail(input.template, input.locale, input.data, { unsubscribeUrl: unsub ? unsubscribeUrl(unsub) : undefined }) : null;
  const idempotencyKey = emailIdempotencyKey(tenantId, input.template, to, input.event);
  const [row] = await db
    .insert(schema.emailMessages)
    .values({ tenantId, template: input.template, category, kind: def.kind, recipientHash, recipientMasked: maskEmail(to), locale: emailLocale(input.locale), idempotencyKey, status, lastErrorCode: valid ? null : "invalid_recipient", expiresAt: input.expiresAt ?? null, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: schema.emailMessages.idempotencyKey })
    .returning({ id: schema.emailMessages.id });
  if (!row) {
    const [existing] = await db.select({ id: schema.emailMessages.id, status: schema.emailMessages.status }).from(schema.emailMessages).where(eq(schema.emailMessages.idempotencyKey, idempotencyKey)).limit(1);
    return { id: existing?.id ?? "", status: existing?.status ?? "queued", outcome: "duplicate" };
  }
  if (!rendered) return { id: row.id, status, outcome: valid ? "suppressed" : "invalid" };
  const headers = unsub ? { "List-Unsubscribe": `<${oneClickUnsubscribeUrl(unsub)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
  const payload: EmailPayload = { to, subject: rendered.subject, html: rendered.html, text: rendered.text, ...(headers ? { headers } : {}) };
  await dispatch({ messageId: row.id, payload: encryptJson(payload) });
  return { id: row.id, status, outcome: "queued" };
}

/* ---------- delivery ---------- */

export interface DeliverOptions {
  provider?: EmailProvider;
  settings?: EmailSettings;
  now?: Date;
}
export interface DeliveryResult {
  messageId: string;
  /** The row's status after this attempt, or `missing` when the row is not visible (not committed yet, or rolled back). */
  status: string;
  /** Set when the caller should run the job again after this delay. */
  retryInMs?: number;
}

/** One delivery attempt for a queued email. Idempotent: a final row is never sent again. */
export async function deliverEmailJob(db: DbExecutor, job: EmailJob, opts: DeliverOptions = {}): Promise<DeliveryResult> {
  const m = schema.emailMessages;
  const now = opts.now ?? new Date();
  const base = { messageId: job.messageId };
  const [row] = await db.select().from(m).where(eq(m.id, job.messageId)).limit(1);
  if (!row) return { ...base, status: "missing", retryInMs: 5_000 };
  if (FINAL.has(row.status)) return { ...base, status: row.status };
  const set = (values: Partial<typeof m.$inferInsert>) => db.update(m).set({ ...values, updatedAt: now }).where(eq(m.id, row.id));
  if (row.expiresAt && row.expiresAt <= now) {
    await set({ status: "expired", claimedAt: null, nextAttemptAt: null });
    return { ...base, status: "expired" };
  }
  const [claimed] = await db
    .update(m)
    .set({ status: "sending", claimedAt: now, attempts: sql`${m.attempts} + 1`, updatedAt: now })
    .where(and(eq(m.id, row.id), or(and(eq(m.status, "queued"), or(isNull(m.nextAttemptAt), lte(m.nextAttemptAt, now))), and(eq(m.status, "sending"), lt(m.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))))))
    .returning();
  if (!claimed) {
    if (row.status === "queued" && row.nextAttemptAt && row.nextAttemptAt > now) return { ...base, status: "queued", retryInMs: row.nextAttemptAt.getTime() - now.getTime() };
    return { ...base, status: row.status };
  }
  // the address may have bounced since the email was queued
  if (await isAddressSuppressed(db, claimed.recipientHash, claimed.kind as EmailKind)) {
    await set({ status: "suppressed", claimedAt: null });
    return { ...base, status: "suppressed" };
  }
  const settings = opts.settings ?? emailSettings();
  const provider = opts.provider ?? getEmailProvider();
  const payload = decryptJson<EmailPayload>(job.payload);
  try {
    const { id } = await provider.send({ from: settings.from, replyTo: settings.replyTo, to: payload.to, subject: payload.subject, html: payload.html, text: payload.text, headers: payload.headers, tags: { template: claimed.template, message_id: claimed.id, ...(claimed.tenantId ? { tenant_id: claimed.tenantId } : {}) }, idempotencyKey: claimed.idempotencyKey });
    await set({ status: "sent", provider: provider.name, providerMessageId: id, sentAt: now, claimedAt: null, nextAttemptAt: null, lastErrorCode: null, lastError: null });
    return { ...base, status: "sent" };
  } catch (e) {
    const err = e instanceof EmailSendError ? e : new EmailSendError("transient", e instanceof Error ? e.message : String(e));
    const lastError = sanitizeEmailError(err.message);
    if (err.retryable && claimed.attempts < MAX_EMAIL_ATTEMPTS) {
      const delay = err.retryAfterMs ?? BACKOFF_MS[Math.min(claimed.attempts - 1, BACKOFF_MS.length - 1)]!;
      const next = new Date(now.getTime() + delay);
      if (claimed.expiresAt && next >= claimed.expiresAt) {
        await set({ status: "expired", provider: provider.name, claimedAt: null, nextAttemptAt: null, lastErrorCode: err.code, lastError });
        return { ...base, status: "expired" };
      }
      await set({ status: "queued", provider: provider.name, claimedAt: null, nextAttemptAt: next, lastErrorCode: err.code, lastError });
      return { ...base, status: "queued", retryInMs: delay };
    }
    await set({ status: "failed", provider: provider.name, claimedAt: null, nextAttemptAt: null, lastErrorCode: err.code, lastError });
    return { ...base, status: "failed" };
  }
}

/* ---------- housekeeping ---------- */

/**
 * Queued rows whose job never ran (the payload lived in a process that stopped before delivery,
 * which only happens without the worker) are closed as failed after a day, so the console never
 * shows them as pending forever.
 */
export async function sweepLostEmails(db: DbExecutor, now = new Date()): Promise<number> {
  const m = schema.emailMessages;
  const rows = await db.update(m).set({ status: "failed", lastErrorCode: "lost", lastError: "The queued job was lost before delivery", updatedAt: now }).where(and(inArray(m.status, ["queued", "sending"]), lt(m.updatedAt, new Date(now.getTime() - 864e5)))).returning({ id: m.id });
  return rows.length;
}

/** Retention: the log keeps at least 30 days (the console shows 7), processed provider events the platform window. */
export async function purgeEmailRows(db: DbExecutor, opts: { days: number; now?: Date }): Promise<{ messages: number; events: number }> {
  const now = opts.now ?? new Date();
  const logCutoff = new Date(now.getTime() - Math.max(opts.days, 30) * 864e5);
  const eventCutoff = new Date(now.getTime() - opts.days * 864e5);
  const messages = await db.delete(schema.emailMessages).where(and(inArray(schema.emailMessages.status, [...EMAIL_FINAL_STATUSES]), lt(schema.emailMessages.updatedAt, logCutoff))).returning({ id: schema.emailMessages.id });
  const events = await db.delete(schema.emailEvents).where(and(inArray(schema.emailEvents.status, ["processed", "ignored"]), lt(schema.emailEvents.receivedAt, eventCutoff))).returning({ id: schema.emailEvents.id });
  return { messages: messages.length, events: events.length };
}

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Platform transactional email (issue #51). One sender owned by the platform: the provider
 * receives fully rendered messages and returns its id. `ResendEmailProvider` speaks Resend's
 * HTTP API; `MockEmailProvider` records messages (dev inbox, tests, CI, demo). The queue,
 * the delivery log and the suppression list live in packages/services.
 */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  /** Provider tags (ASCII letters, digits, `_` and `-`), echoed back on delivery webhooks. */
  tags?: Record<string, string>;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Same key → the provider sends once (Resend keeps keys for 24 hours). */
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly name: "resend" | "mock";
  send(message: EmailMessage): Promise<{ id: string }>;
}

export type EmailErrorCode = "rate_limit" | "invalid_recipient" | "domain_not_verified" | "auth" | "invalid_request" | "transient" | "timeout";

/** A send that failed, with whether trying again later can succeed. */
export class EmailSendError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
  get retryable(): boolean {
    return this.code === "rate_limit" || this.code === "transient" || this.code === "timeout";
  }
}

/* ---------- mock ---------- */

export interface CapturedEmail {
  id: string;
  message: EmailMessage;
  sentAt: Date;
}

/**
 * Records messages instead of sending them. Like Resend, a repeated idempotency key returns the
 * first id and records nothing new. `failNext` makes the next sends throw, to test retries.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock" as const;
  readonly sent: CapturedEmail[] = [];
  private readonly byKey = new Map<string, string>();
  private failures: { code: EmailErrorCode; acceptFirst: boolean }[] = [];
  /** `onCapture` sees every newly recorded message (the e2e outbox writes it to disk). */
  constructor(private readonly opts: { capacity?: number; onCapture?: (captured: CapturedEmail) => void } = {}) {}

  /** The next `times` sends fail with `code`; `acceptFirst` records the message before failing (a timeout after the provider accepted it). */
  failNext(code: EmailErrorCode, times = 1, acceptFirst = false): void {
    for (let i = 0; i < times; i++) this.failures.push({ code, acceptFirst });
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const failure = this.failures.shift();
    if (failure && !failure.acceptFirst) throw new EmailSendError(failure.code, `mock ${failure.code}`);
    const known = this.byKey.get(message.idempotencyKey);
    // unique across processes like a real provider id: the delivery log and provider events are shared
    const id = known ?? `mock_${randomUUID()}`;
    if (!known) {
      this.byKey.set(message.idempotencyKey, id);
      const captured = { id, message, sentAt: new Date() };
      this.sent.push(captured);
      this.opts.onCapture?.(captured);
      const cap = this.opts.capacity ?? 500;
      if (this.sent.length > cap) this.sent.splice(0, this.sent.length - cap);
    }
    if (failure) throw new EmailSendError(failure.code, `mock ${failure.code} after accepting`);
    return { id };
  }

  to(address: string): CapturedEmail[] {
    const a = address.trim().toLowerCase();
    return this.sent.filter((m) => m.message.to === a);
  }

  clear(): void {
    this.sent.length = 0;
    this.byKey.clear();
    this.failures = [];
  }
}

/* ---------- Resend ---------- */

/** The subset of `fetch` the adapter needs; tests inject recorded responses. */
export type EmailFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface ResendConfig {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: EmailFetch;
}

/** Resend error body: `{ statusCode, name, message }`. */
export function mapResendError(status: number, body: string, retryAfter: string | null): EmailSendError {
  let name = "";
  let message = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { name?: unknown; message?: unknown };
    if (typeof j.name === "string") name = j.name;
    if (typeof j.message === "string") message = j.message;
  } catch {
    /* plain-text body */
  }
  const detail = `Resend ${status}${name ? ` ${name}` : ""}: ${message}`.slice(0, 400);
  const retryMs = Number(retryAfter ?? "0") > 0 ? Number(retryAfter) * 1000 : undefined;
  if (status === 429) return new EmailSendError("rate_limit", detail, retryMs ?? (/quota/i.test(name) ? 3_600_000 : 60_000));
  if (status >= 500) return new EmailSendError("transient", detail, retryMs);
  if (status === 409 && name === "concurrent_idempotent_requests") return new EmailSendError("transient", detail, 5_000);
  if (/domain.*not verified|verify (a|your) domain|testing emails to your own/i.test(message)) return new EmailSendError("domain_not_verified", detail);
  if (status === 401 || name === "missing_api_key" || name === "invalid_api_key" || name === "restricted_api_key") return new EmailSendError("auth", detail);
  if ((status === 422 || status === 400) && /`?to`?\b|recipient|email address/i.test(message)) return new EmailSendError("invalid_recipient", detail);
  if (status === 403) return new EmailSendError("auth", detail);
  return new EmailSendError("invalid_request", detail);
}

/** Resend over HTTP (`POST /emails`), with the idempotency header and a timeout. No retries here: the queue owns them. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;
  private readonly fetchImpl: EmailFetch;
  constructor(private readonly cfg: ResendConfig) {
    if (!cfg.apiKey) throw new EmailSendError("auth", "RESEND_API_KEY is empty");
    this.fetchImpl = cfg.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<EmailFetch>);
  }

  async send(m: EmailMessage): Promise<{ id: string }> {
    const body = JSON.stringify({
      from: m.from,
      to: [m.to],
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
      ...(m.tags ? { tags: Object.entries(m.tags).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })) } : {}),
    });
    const timeoutMs = this.cfg.timeoutMs ?? 10_000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new EmailSendError("timeout", `Resend did not answer within ${timeoutMs} ms`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([this.fetchImpl(this.cfg.endpoint ?? "https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey.slice(0, 256) }, body, signal: controller.signal }), timeout]);
      const text = await res.text();
      if (res.status >= 300) throw mapResendError(res.status, text, res.headers.get("retry-after"));
      const id = (JSON.parse(text || "{}") as { id?: unknown }).id;
      if (typeof id !== "string") throw new EmailSendError("transient", "Resend answered without an id");
      return { id };
    } catch (e) {
      if (e instanceof EmailSendError) throw e;
      if (timedOut) throw new EmailSendError("timeout", `Resend did not answer within ${timeoutMs} ms`);
      throw new EmailSendError("transient", `Network error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------- webhooks (Svix-style signatures) ---------- */

/**
 * Verifies a Svix-signed webhook (Resend signs its webhooks with Svix): `svix-id`,
 * `svix-timestamp` and `svix-signature` (space-separated `v1,<base64>` entries) over
 * `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64 part of the `whsec_…` secret,
 * timestamp within five minutes. Returns the event id, or null when anything does not match.
 */
export function verifySvixSignature(headers: Record<string, string | undefined>, rawBody: string, secret: string, now = Date.now()): string | null {
  const id = headers["svix-id"] ?? headers["webhook-id"];
  const ts = headers["svix-timestamp"] ?? headers["webhook-timestamp"];
  const sigs = headers["svix-signature"] ?? headers["webhook-signature"];
  if (!id || !ts || !sigs || !secret) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 5 * 60) return null;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64"));
  for (const part of sigs.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return id;
  }
  return null;
}

/** Signs like Svix does: for tests and for the console's webhook self-check. */
export function signSvixPayload(id: string, timestamp: number, rawBody: string, secret: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
}

export type EmailEventType = "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "other";

export interface EmailDeliveryEvent {
  type: EmailEventType;
  /** The provider's message id (the id `send` returned). */
  providerMessageId: string | null;
  recipients: string[];
  /** `hard` for permanent bounces, `soft` for transient ones. */
  bounce: "hard" | "soft" | null;
  tags: Record<string, string>;
  occurredAt: Date | null;
}

const EVENT_TYPES: Record<string, EmailEventType> = { "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delivery_delayed", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed" };

/** Normalizes a Resend webhook payload (`{ type, created_at, data: { email_id, to, tags, bounce } }`). */
export function parseResendEvent(payload: unknown): EmailDeliveryEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; to?: unknown; tags?: unknown; bounce?: { type?: unknown } } };
  if (typeof p.type !== "string" || !p.data || typeof p.data !== "object") return null;
  const raw = Array.isArray(p.data.to) ? p.data.to : [p.data.to];
  const recipients = raw.filter((e): e is string => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase());
  const tags: Record<string, string> = {};
  const t = p.data.tags;
  if (Array.isArray(t)) for (const x of t as { name?: unknown; value?: unknown }[]) if (typeof x.name === "string" && typeof x.value === "string") tags[x.name] = x.value;
  if (t && typeof t === "object" && !Array.isArray(t)) for (const [k, v] of Object.entries(t)) if (typeof v === "string") tags[k] = v;
  const type = EVENT_TYPES[p.type] ?? "other";
  const bounceType = typeof p.data.bounce?.type === "string" ? p.data.bounce.type.toLowerCase() : "";
  const bounce = type !== "bounced" ? null : bounceType === "transient" || bounceType === "undetermined" ? "soft" : "hard";
  const at = typeof p.created_at === "string" ? new Date(p.created_at) : null;
  return { type, providerMessageId: typeof p.data.email_id === "string" ? p.data.email_id : null, recipients, bounce, tags, occurredAt: at && !Number.isNaN(at.getTime()) ? at : null };
}

import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError } from "../types";

/**
 * Outbound alert delivery outside the app. Slack uses an incoming webhook URL configured per
 * tenant; email goes through a transactional provider (the HTTP shape of Resend / Postmark).
 * Both have a mock that records messages, used whenever `KEEL_INTEGRATION_MODE=mock` or the
 * tenant has no credentials.
 */
export interface OutboundMessage {
  subject: string;
  text: string;
  /** Deep link back into Keel. */
  url?: string;
  /** Rendered HTML body (email only); `text` stays the plain-text part. */
  html?: string;
  /** Extra headers (email only), e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Provider tags, echoed back on bounce webhooks (e.g. the tenant id). */
  tags?: Record<string, string>;
}

export interface NotificationSink {
  readonly kind: "slack" | "email";
  send(to: string[], message: OutboundMessage): Promise<{ id: string | null }>;
}

export class MockNotificationSink implements NotificationSink {
  readonly sent: { to: string[]; message: OutboundMessage }[] = [];
  constructor(readonly kind: "slack" | "email") {}
  async send(to: string[], message: OutboundMessage) {
    this.sent.push({ to, message });
    return { id: `mock-${this.sent.length}` };
  }
}

/** Slack incoming webhook: one URL per channel, no OAuth needed. */
export class SlackWebhookSink implements NotificationSink {
  readonly kind = "slack" as const;
  private readonly http: HttpClient;
  constructor(private readonly webhookUrl: string, opts: HttpOptions = {}) {
    if (!/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) throw new IntegrationError("invalid_request", "Not a Slack incoming webhook URL");
    this.http = new HttpClient(opts);
  }
  async send(_to: string[], message: OutboundMessage) {
    const text = `*${message.subject}*\n${message.text}${message.url ? `\n<${message.url}|Open in Keel>` : ""}`;
    const res = await this.http.request<unknown>(this.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), textOk: true });
    if (res.status >= 300) throw new IntegrationError("invalid_request", `Slack responded ${res.status}`);
    return { id: null };
  }
}

/** Transactional email over a Resend-compatible HTTP API (`POST /emails`). To verify on the chosen provider. */
export class HttpEmailSink implements NotificationSink {
  readonly kind = "email" as const;
  private readonly http: HttpClient;
  constructor(private readonly cfg: { apiKey: string; from: string; endpoint?: string }, opts: HttpOptions = {}) {
    this.http = new HttpClient(opts);
  }
  async send(to: string[], message: OutboundMessage) {
    if (!to.length) return { id: null };
    const res = await this.http.request<{ id?: string }>(this.cfg.endpoint ?? "https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ from: this.cfg.from, to, subject: message.subject, text: `${message.text}${message.url ? `\n\n${message.url}` : ""}`, ...(message.html ? { html: message.html } : {}), ...(message.headers ? { headers: message.headers } : {}), ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}) }) });
    return { id: res.json?.id ?? null };
  }
}

/**
 * Delivery events posted back by the email provider (Resend-style `{ type, data: { to, tags } }`;
 * to verify on the chosen provider). Only what feeds the suppression list is kept: hard bounces and
 * complaints, with the tenant tag the message was sent with.
 */
export function parseEmailDeliveryEvent(payload: unknown): { kind: "bounce" | "complaint"; emails: string[]; tenantId: string | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; data?: { to?: unknown; email?: unknown; tags?: unknown } };
  const kind = p.type === "email.bounced" ? "bounce" : p.type === "email.complained" ? "complaint" : null;
  if (!kind || !p.data) return null;
  const raw = Array.isArray(p.data.to) ? p.data.to : [p.data.to ?? p.data.email];
  const emails = raw.filter((e): e is string => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase());
  if (!emails.length) return null;
  const tags = p.data.tags;
  const tag = Array.isArray(tags) ? (tags as { name?: string; value?: string }[]).find((t) => t.name === "tenant_id")?.value : tags && typeof tags === "object" ? (tags as Record<string, unknown>).tenant_id : undefined;
  return { kind, emails, tenantId: typeof tag === "string" && /^[0-9a-f-]{36}$/i.test(tag) ? tag : null };
}

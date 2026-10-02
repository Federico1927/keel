import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError } from "../types";

/**
 * Outbound alert delivery to chat tools. Slack uses an incoming webhook URL configured per
 * tenant, with a mock that records messages whenever `KEEL_INTEGRATION_MODE=mock` or the tenant
 * has no credentials. Email is not a sink: every email goes through the platform `EmailProvider`
 * (../email) behind the queue, the delivery log and the suppression list in packages/services.
 */
export interface OutboundMessage {
  subject: string;
  text: string;
  /** Deep link back into Keel. */
  url?: string;
}

export interface NotificationSink {
  readonly kind: "slack";
  send(to: string[], message: OutboundMessage): Promise<{ id: string | null }>;
}

export class MockNotificationSink implements NotificationSink {
  readonly sent: { to: string[]; message: OutboundMessage }[] = [];
  constructor(readonly kind: "slack" = "slack") {}
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

import type { AnalyticsPlatform, CarrierInstruction, CarrierProvider, ConnectionTest, MessageSendInput, MessagingChannel, NormalizedOrder, WarehouseProvider } from "../types";
import { FailureScript } from "./failures";

/** Mock implementations of the per-account slots. Real connectors are sold as add-ons. */
export class MockMessagingChannel implements MessagingChannel {
  readonly provider = "messaging-mock";
  readonly sent: MessageSendInput[] = [];
  /** Keys already delivered → message id: a repeated key is answered without sending again, like a provider with idempotency keys. */
  private readonly byKey = new Map<string, string>();
  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Mock messaging" };
  }
  async sendMessage(input: MessageSendInput) {
    const known = input.idempotencyKey ? this.byKey.get(input.idempotencyKey) : undefined;
    if (known) return { messageId: known };
    this.sent.push(input);
    const messageId = `mock-msg-${this.sent.length}`;
    if (input.idempotencyKey) this.byKey.set(input.idempotencyKey, messageId);
    return { messageId };
  }
  async verifyWebhook(_headers: Record<string, string | undefined>, rawBody: string) {
    const p = JSON.parse(rawBody) as { messageId: string; status: "sent" | "delivered" | "read" | "failed" };
    return { messageId: p.messageId, status: p.status, raw: p };
  }
}

export class MockWarehouseProvider implements WarehouseProvider {
  readonly provider = "warehouse-mock";
  readonly pushed: string[] = [];
  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Mock 3PL" };
  }
  async pushOrder(order: NormalizedOrder) {
    this.pushed.push(order.externalId);
    return { externalId: `wh-${order.externalId}` };
  }
  async fetchStock() {
    return [] as { sku: string; available: number }[];
  }
  async fetchShipmentStatus() {
    return null;
  }
}

export class MockCarrierProvider implements CarrierProvider {
  readonly provider = "carrier-mock";
  readonly failures = new FailureScript();
  /** Instructions received, in order (tests and the demo). */
  readonly instructions: CarrierInstruction[] = [];
  async sendInstruction(input: CarrierInstruction) {
    this.failures.check();
    this.instructions.push(input);
    return { reference: `mock-instr-${this.instructions.length}` };
  }
  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Mock carrier" };
  }
  async track(trackingNumber: string) {
    const now = new Date();
    return {
      status: "in_transit" as const,
      externalStatus: "IN_TRANSIT",
      events: [
        { status: "label_created" as const, description: `Label created for ${trackingNumber}`, location: null, at: new Date(now.getTime() - 2 * 864e5) },
        { status: "in_transit" as const, description: "Departed facility", location: "Hub", at: new Date(now.getTime() - 864e5) },
      ],
    };
  }
}

export class MockAnalyticsPlatform implements AnalyticsPlatform {
  readonly provider = "ga4";
  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Mock GA4 property" };
  }
  async fetchDailySessions(window: { since: string; until: string }) {
    const out: { date: string; sessions: number; channel: string }[] = [];
    for (let d = new Date(window.since); d <= new Date(window.until); d.setUTCDate(d.getUTCDate() + 1)) out.push({ date: d.toISOString().slice(0, 10), sessions: 1000, channel: "paid_social" });
    return out;
  }
}

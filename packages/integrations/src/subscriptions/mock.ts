import { addSubscriptionInterval, type SubscriptionCapabilities, type SubscriptionInterval, type SubscriptionPaymentError } from "@hullwise/core";
import { createHmac } from "node:crypto";
import { FailureScript } from "../mock/failures";
import { IntegrationError, type ConnectionTest, type Page, type SyncQuery } from "../types";
import type { NormalizedBillingAttempt, NormalizedSubscriptionContract, SubscriptionProvider, SubscriptionProviderKey, SubscriptionWebhook } from "./types";

/**
 * Simulated subscription app for mock mode and tests. It starts from the contracts and billing
 * attempts Hullwise already holds (so a sync of the untouched mock changes nothing), applies every
 * customer-care action in memory, records each call, and can be told to fail: a rate limit, an
 * expired token, or a renewal charge declined for an expired card or insufficient funds.
 */
export class MockSubscriptionProvider implements SubscriptionProvider {
  readonly provider: SubscriptionProviderKey | "mock";
  readonly capabilities: SubscriptionCapabilities;
  readonly failures = new FailureScript();
  readonly calls: { method: string; contractExternalId: string; input?: unknown }[] = [];
  private readonly contracts = new Map<string, NormalizedSubscriptionContract>();
  private readonly attempts: NormalizedBillingAttempt[];
  private seq = 0;

  constructor(opts: { provider?: SubscriptionProviderKey; contracts?: NormalizedSubscriptionContract[]; attempts?: NormalizedBillingAttempt[]; capabilities?: Partial<SubscriptionCapabilities>; webhookSecret?: string; now?: () => Date } = {}) {
    this.provider = opts.provider ?? "mock";
    this.capabilities = { canPause: true, canResume: true, canSkip: true, canSwap: true, canChangeFrequency: true, canReschedule: true, canCancel: true, canSendPaymentLink: true, ...opts.capabilities };
    for (const c of opts.contracts ?? []) this.contracts.set(c.externalId, structuredClone(c));
    this.attempts = [...(opts.attempts ?? [])];
    this.webhookSecret = opts.webhookSecret ?? "mock-subscriptions-secret";
    this.now = opts.now ?? (() => new Date());
  }
  private readonly webhookSecret: string;
  private readonly now: () => Date;

  async testConnection(): Promise<ConnectionTest> {
    this.failures.check();
    return { ok: true, accountName: "Mock subscriptions", accountId: "mock-subscriptions", scopes: ["read_own_subscription_contracts", "write_own_subscription_contracts"] };
  }

  async fetchContracts(q: SyncQuery): Promise<Page<NormalizedSubscriptionContract>> {
    this.failures.check();
    const all = [...this.contracts.values()].filter((c) => !q.updatedSince || c.updatedAt.getTime() >= q.updatedSince.getTime()).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || (a.externalId < b.externalId ? -1 : 1));
    const start = Number(q.cursor ?? 0);
    const limit = q.limit ?? 100;
    return { items: all.slice(start, start + limit).map((c) => structuredClone(c)), nextCursor: start + limit < all.length ? String(start + limit) : null };
  }

  async fetchContract(externalId: string): Promise<NormalizedSubscriptionContract | null> {
    this.failures.check();
    const c = this.contracts.get(externalId);
    return c ? structuredClone(c) : null;
  }

  async fetchBillingAttempts(q: SyncQuery): Promise<Page<NormalizedBillingAttempt>> {
    this.failures.check();
    const all = this.attempts.filter((a) => !q.createdSince || a.attemptedAt.getTime() >= q.createdSince.getTime()).sort((a, b) => a.attemptedAt.getTime() - b.attemptedAt.getTime() || (a.externalId < b.externalId ? -1 : 1));
    const start = Number(q.cursor ?? 0);
    const limit = q.limit ?? 200;
    return { items: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null };
  }

  /** Signs a payload the way `verifyWebhook` expects (tests, the "simulate" button). */
  signWebhook(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("base64");
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<SubscriptionWebhook> {
    if (headers["x-mock-signature"] !== this.signWebhook(rawBody)) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as { id?: string; contractId?: string; updatedAt?: string };
    return { topic: headers["x-mock-topic"] ?? "subscription/updated", externalId: payload.id ?? `${payload.contractId}:${payload.updatedAt ?? ""}`, sourceUpdatedAt: payload.updatedAt ?? "", payload, contractExternalId: payload.contractId ?? null };
  }

  /** A renewal charge: success creates the order id; a failure carries the decline reason and the provider's next retry. */
  simulateRenewal(externalId: string, outcome: "success" | SubscriptionPaymentError, opts: { orderExternalId?: string; at?: Date; retryInDays?: number | null } = {}): NormalizedBillingAttempt {
    const c = this.contracts.get(externalId);
    if (!c) throw new IntegrationError("not_found", `Mock: contract ${externalId} not found`);
    const at = opts.at ?? this.now();
    const ok = outcome === "success";
    const attempt: NormalizedBillingAttempt = { externalId: `mock-attempt-${externalId}-${++this.seq}-${at.getTime()}`, contractExternalId: externalId, status: ok ? "success" : "failed", errorCode: ok ? null : outcome, errorMessage: ok ? null : outcome === "card_expired" ? "Your card has expired." : outcome === "insufficient_funds" ? "Your card has insufficient funds." : "Your card was declined.", amountMinor: c.priceMinor, currency: c.currency, orderExternalId: ok ? (opts.orderExternalId ?? `mock-order-${externalId}-${this.seq}`) : null, attemptedAt: at, nextRetryAt: ok || opts.retryInDays === null ? null : new Date(at.getTime() + (opts.retryInDays ?? 3) * 864e5), cycleKey: (c.nextBillingAt ?? at).toISOString().slice(0, 10) };
    this.attempts.push(attempt);
    if (ok && c.nextBillingAt) this.update(c, { nextBillingAt: addSubscriptionInterval(c.nextBillingAt, c.intervalUnit, c.intervalCount) });
    return attempt;
  }

  private update(c: NormalizedSubscriptionContract, patch: Partial<NormalizedSubscriptionContract>): NormalizedSubscriptionContract {
    const next = { ...c, ...patch, updatedAt: new Date(Math.max(this.now().getTime(), c.updatedAt.getTime() + 1)) };
    this.contracts.set(c.externalId, next);
    return structuredClone(next);
  }

  private take(method: string, externalId: string, input?: unknown): NormalizedSubscriptionContract {
    this.failures.check();
    const c = this.contracts.get(externalId);
    if (!c) throw new IntegrationError("not_found", `Mock: contract ${externalId} not found`);
    this.calls.push({ method, contractExternalId: externalId, input });
    return c;
  }

  async pause(externalId: string, opts: { resumeAt?: Date | null }) {
    const c = this.take("pause", externalId, opts);
    if (c.status !== "active") throw new IntegrationError("invalid_request", "Mock: only active contracts can be paused");
    return this.update(c, { status: "paused", pausedAt: this.now() });
  }
  async resume(externalId: string) {
    const c = this.take("resume", externalId);
    if (c.status !== "paused") throw new IntegrationError("invalid_request", "Mock: only paused contracts can be resumed");
    let next = c.nextBillingAt ?? this.now();
    while (next.getTime() < this.now().getTime()) next = addSubscriptionInterval(next, c.intervalUnit, c.intervalCount);
    return this.update(c, { status: "active", pausedAt: null, nextBillingAt: next });
  }
  async skipNext(externalId: string) {
    const c = this.take("skip", externalId);
    if (!c.nextBillingAt) throw new IntegrationError("invalid_request", "Mock: no upcoming billing to skip");
    return this.update(c, { nextBillingAt: addSubscriptionInterval(c.nextBillingAt, c.intervalUnit, c.intervalCount) });
  }
  async swapVariant(externalId: string, input: { lineExternalId: string; variantExternalId: string; quantity?: number }) {
    const c = this.take("swap", externalId, input);
    const lines = c.lines.map((l) => (l.externalId === input.lineExternalId ? { ...l, variantExternalId: input.variantExternalId, quantity: input.quantity ?? l.quantity } : l));
    if (!c.lines.some((l) => l.externalId === input.lineExternalId)) throw new IntegrationError("not_found", "Mock: line not found");
    return this.update(c, { lines, priceMinor: lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0) });
  }
  async changeFrequency(externalId: string, input: { unit: SubscriptionInterval; count: number }) {
    const c = this.take("frequency", externalId, input);
    return this.update(c, { intervalUnit: input.unit, intervalCount: input.count });
  }
  async reschedule(externalId: string, nextBillingAt: Date) {
    const c = this.take("reschedule", externalId, { nextBillingAt });
    return this.update(c, { nextBillingAt });
  }
  async cancel(externalId: string, input: { reason: string; note?: string | null }) {
    const c = this.take("cancel", externalId, input);
    return this.update(c, { status: "cancelled", endedAt: this.now(), nextBillingAt: null, cancellationReasonRaw: [input.reason, input.note].filter(Boolean).join(" — ") });
  }
  async sendPaymentUpdateLink(externalId: string) {
    this.take("payment_link", externalId);
    return { sent: true };
  }
}

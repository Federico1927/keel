import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubscriptionCapabilities, SubscriptionInterval, SubscriptionStatus } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type ConnectionTest, type Page, type SyncQuery } from "../types";
import { minorFrom, normalizeInterval, normalizePaymentError, type NormalizedBillingAttempt, type NormalizedSubscriptionContract, type SubscriptionProvider, type SubscriptionWebhook } from "./types";

export interface LoopCredentials {
  apiToken: string;
  webhookSecret: string;
}

type Rec = Record<string, unknown>;
const r = (v: unknown) => (v ?? {}) as Rec;
export const LOOP_API_VERSION = "2023-10";
const STATUS: Record<string, SubscriptionStatus> = { ACTIVE: "active", PAUSED: "paused", CANCELLED: "cancelled", EXPIRED: "expired", FAILED: "failed" };
const epoch = (v: unknown) => (v === null || v === undefined || v === "" ? null : new Date(typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : String(v)));

export function mapLoopSubscription(s: Rec): NormalizedSubscriptionContract {
  const status = STATUS[String(s.status).toUpperCase()] ?? "active";
  const lines = ((s.lines as Rec[] | undefined) ?? []).map((l) => ({ externalId: String(l.id), variantExternalId: l.variantShopifyId ? String(l.variantShopifyId) : null, productExternalId: l.productShopifyId ? String(l.productShopifyId) : null, sku: (l.sku as string | null) ?? null, title: String(l.name ?? l.productTitle ?? ""), variantTitle: (l.variantTitle as string | null) ?? null, quantity: Number(l.quantity ?? 1), unitPriceMinor: minorFrom(l.price as string) }));
  const cust = r(s.customer);
  const policy = r(s.billingPolicy);
  const ended = status === "cancelled" || status === "expired" || status === "failed";
  const updatedAt = epoch(s.updatedAt) ?? new Date();
  return {
    externalId: String(s.id),
    status,
    customer: { externalId: cust.shopifyId ? String(cust.shopifyId) : null, email: (cust.email as string | null) ?? null, firstName: (cust.firstName as string | null) ?? null, lastName: (cust.lastName as string | null) ?? null, phone: (cust.phone as string | null) ?? null },
    currency: String(s.currencyCode ?? "USD"),
    lines,
    intervalUnit: normalizeInterval(policy.interval as string),
    intervalCount: Number(policy.intervalCount ?? 1),
    nextBillingAt: ended ? null : epoch(s.nextBillingDateEpoch),
    priceMinor: lines.reduce((t, l) => t + l.unitPriceMinor * l.quantity, 0) + minorFrom(s.deliveryPrice as string),
    discounts: ((s.discounts as Rec[] | undefined) ?? []).map((d) => ({ code: (d.code as string | null) ?? null, title: (d.title as string | null) ?? null, amountMinor: minorFrom(d.amount as string) })),
    createdAt: epoch(s.createdAt) ?? updatedAt,
    endedAt: ended ? (epoch(s.cancelledAt) ?? updatedAt) : null,
    pausedAt: status === "paused" ? (epoch(s.pausedAt) ?? updatedAt) : null,
    cancellationReasonRaw: (s.cancellationReason as string | null) ?? null,
    cancelledForNonPayment: status === "failed" || /payment|billing/i.test(String(s.cancellationReason ?? "")),
    originOrderExternalId: s.originOrderShopifyId ? String(s.originOrderShopifyId) : null,
    updatedAt,
  };
}

export function mapLoopOrder(o: Rec): NormalizedBillingAttempt {
  const status = String(o.status).toUpperCase();
  const mapped: NormalizedBillingAttempt["status"] = status === "SUCCESS" ? "success" : status === "FAILED" ? "failed" : "pending";
  const at = epoch(o.createdAt) ?? new Date();
  return {
    externalId: String(o.id),
    contractExternalId: String(o.subscriptionId),
    status: mapped,
    errorCode: mapped === "failed" ? normalizePaymentError(o.errorCode as string, o.errorMessage as string) : null,
    errorMessage: (o.errorMessage as string | null) ?? null,
    amountMinor: minorFrom(o.totalPrice as string),
    currency: String(o.currencyCode ?? "USD"),
    orderExternalId: o.shopifyOrderId ? String(o.shopifyOrderId) : null,
    attemptedAt: at,
    nextRetryAt: mapped === "failed" ? epoch(o.nextRetryDateEpoch) : null,
    cycleKey: (epoch(o.billingDateEpoch) ?? at).toISOString().slice(0, 10),
  };
}

/** Loop Subscriptions admin API [to verify]: subscriptions and billing orders, care actions per subscription. */
export class LoopSubscriptionProvider implements SubscriptionProvider {
  readonly provider = "loop" as const;
  readonly capabilities: SubscriptionCapabilities = { canPause: true, canResume: true, canSkip: true, canSwap: true, canChangeFrequency: true, canReschedule: true, canCancel: true, canSendPaymentLink: true };
  readonly http: HttpClient;
  private readonly base = `https://api.loopsubscriptions.com/admin/${LOOP_API_VERSION}`;

  constructor(private readonly creds: LoopCredentials, opts: HttpOptions = {}) {
    this.http = new HttpClient({ minIntervalMs: 300, ...opts });
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http.request<{ success?: boolean; message?: string; data: T }>(`${this.base}${path}`, { method: init.method ?? "GET", headers: { "x-loop-token": this.creds.apiToken, accept: "application/json", "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    if (res.json?.success === false) throw new IntegrationError("invalid_request", res.json.message ?? "Loop refused the request");
    return res.json.data;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const d = await this.call<{ shopifyDomain: string; id: number | string }>("/store");
      return { ok: true, accountName: d.shopifyDomain, accountId: String(d.id) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private page<T>(path: string, q: SyncQuery, since: Date | null | undefined, map: (x: Rec) => T): Promise<Page<T>> {
    const pageNo = Number(q.cursor ?? 1);
    const params = new URLSearchParams({ pageNo: String(pageNo), pageSize: String(Math.min(q.limit ?? 50, 100)) });
    if (since) params.set("updatedAtStart", String(Math.floor(since.getTime() / 1000)));
    return this.call<Rec[] | { items: Rec[]; pageInfo?: { hasNextPage?: boolean } }>(`${path}?${params}`).then((d) => {
      const items = Array.isArray(d) ? d : d.items;
      const more = Array.isArray(d) ? items.length >= Math.min(q.limit ?? 50, 100) : Boolean(d.pageInfo?.hasNextPage);
      return { items: items.map(map), nextCursor: more ? String(pageNo + 1) : null };
    });
  }

  fetchContracts(q: SyncQuery): Promise<Page<NormalizedSubscriptionContract>> {
    return this.page("/subscription", q, q.updatedSince, mapLoopSubscription);
  }
  async fetchContract(externalId: string): Promise<NormalizedSubscriptionContract | null> {
    try {
      return mapLoopSubscription(await this.call<Rec>(`/subscription/${encodeURIComponent(externalId)}`));
    } catch (e) {
      if (e instanceof IntegrationError && e.code === "not_found") return null;
      throw e;
    }
  }
  fetchBillingAttempts(q: SyncQuery): Promise<Page<NormalizedBillingAttempt>> {
    return this.page("/order", q, q.createdSince, mapLoopOrder);
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<SubscriptionWebhook> {
    const expected = createHmac("sha256", this.creds.webhookSecret).update(rawBody, "utf8").digest("base64");
    const got = headers["x-loop-signature"] ?? "";
    if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as Rec;
    const data = r(payload.data ?? payload);
    const contract = data.subscriptionId ?? data.id ?? null;
    return { topic: String(headers["x-loop-topic"] ?? payload.topic ?? "unknown"), externalId: String(payload.eventId ?? `${data.id ?? ""}:${data.updatedAt ?? ""}`), sourceUpdatedAt: String(data.updatedAt ?? ""), payload, contractExternalId: contract ? String(contract) : null };
  }

  private async act(externalId: string, path: string, body: unknown = {}): Promise<NormalizedSubscriptionContract> {
    await this.call(`/subscription/${externalId}${path}`, { method: "POST", body });
    const c = await this.fetchContract(externalId);
    if (!c) throw new IntegrationError("not_found", `Loop subscription ${externalId} not found`);
    return c;
  }
  pause(externalId: string, opts: { resumeAt?: Date | null }) {
    return this.act(externalId, "/pause", opts.resumeAt ? { resumeDate: opts.resumeAt.toISOString().slice(0, 10) } : {});
  }
  resume(externalId: string) {
    return this.act(externalId, "/resume");
  }
  skipNext(externalId: string) {
    return this.act(externalId, "/skip-next-order");
  }
  swapVariant(externalId: string, input: { lineExternalId: string; variantExternalId: string; quantity?: number }) {
    return this.act(externalId, `/line/${input.lineExternalId}/swap`, { variantShopifyId: Number(input.variantExternalId), ...(input.quantity ? { quantity: input.quantity } : {}) });
  }
  changeFrequency(externalId: string, input: { unit: SubscriptionInterval; count: number }) {
    return this.act(externalId, "/frequency", { interval: input.unit.toUpperCase(), intervalCount: input.count });
  }
  reschedule(externalId: string, nextBillingAt: Date) {
    return this.act(externalId, "/reschedule", { nextBillingDate: nextBillingAt.toISOString().slice(0, 10) });
  }
  cancel(externalId: string, input: { reason: string; note?: string | null }) {
    return this.act(externalId, "/cancel", { cancellationReason: input.reason, cancellationComment: input.note ?? undefined });
  }
  async sendPaymentUpdateLink(externalId: string) {
    await this.call(`/subscription/${externalId}/send-payment-update-email`, { method: "POST", body: {} });
    return { sent: true };
  }
}

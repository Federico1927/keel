import { createHash, timingSafeEqual } from "node:crypto";
import type { SubscriptionCapabilities, SubscriptionInterval, SubscriptionStatus } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type ConnectionTest, type Page, type SyncQuery } from "../types";
import { dateOrNull, minorFrom, normalizeInterval, normalizePaymentError, type NormalizedBillingAttempt, type NormalizedSubscriptionContract, type SubscriptionProvider, type SubscriptionWebhook } from "./types";

export interface RechargeCredentials {
  apiToken: string;
  /** API client secret: signs the webhooks. */
  webhookSecret: string;
}

type Rec = Record<string, unknown>;
const r = (v: unknown) => (v ?? {}) as Rec;
export const RECHARGE_API_VERSION = "2021-11";
const STATUS: Record<string, SubscriptionStatus> = { active: "active", cancelled: "cancelled", expired: "expired", paused: "paused" };
const RECHARGE_UNITS: Record<SubscriptionInterval, string> = { day: "day", week: "week", month: "month", year: "month" };

/** One Recharge subscription (one product per subscription) normalized; `customers` resolves e-mail and Shopify id. */
export function mapRechargeSubscription(s: Rec, customers: ReadonlyMap<string, Rec> = new Map()): NormalizedSubscriptionContract {
  const status = STATUS[String(s.status)] ?? "active";
  const qty = Number(s.quantity ?? 1);
  const unitPrice = minorFrom(s.price as string);
  const cust = customers.get(String(s.customer_id));
  const ended = status !== "active" && status !== "paused";
  const reason = [s.cancellation_reason, s.cancellation_reason_comments].filter(Boolean).join(" — ") || null;
  return {
    externalId: String(s.id),
    status,
    customer: { externalId: cust ? String(r(cust.external_customer_id).ecommerce ?? cust.id) : null, email: (cust?.email as string | null) ?? null, firstName: (cust?.first_name as string | null) ?? null, lastName: (cust?.last_name as string | null) ?? null, phone: (cust?.phone as string | null) ?? null },
    currency: String(s.presentment_currency ?? "USD"),
    lines: [{ externalId: String(s.id), variantExternalId: r(s.external_variant_id).ecommerce ? String(r(s.external_variant_id).ecommerce) : null, productExternalId: r(s.external_product_id).ecommerce ? String(r(s.external_product_id).ecommerce) : null, sku: (s.sku as string | null) ?? null, title: String(s.product_title ?? ""), variantTitle: (s.variant_title as string | null) ?? null, quantity: qty, unitPriceMinor: unitPrice }],
    intervalUnit: normalizeInterval(s.charge_interval_unit as string ?? s.order_interval_unit as string),
    intervalCount: Number(s.charge_interval_frequency ?? s.order_interval_frequency ?? 1),
    nextBillingAt: ended ? null : dateOrNull(s.next_charge_scheduled_at),
    priceMinor: unitPrice * qty,
    discounts: [],
    createdAt: new Date(String(s.created_at)),
    endedAt: ended ? dateOrNull(s.cancelled_at) ?? new Date(String(s.updated_at)) : null,
    pausedAt: null,
    cancellationReasonRaw: reason,
    cancelledForNonPayment: /max.*retr|payment|declin/i.test(reason ?? ""),
    originOrderExternalId: null,
    updatedAt: new Date(String(s.updated_at ?? s.created_at)),
  };
}

/** One Recharge charge as billing attempts: one per subscription it renews. */
export function mapRechargeCharge(c: Rec): NormalizedBillingAttempt[] {
  const status = String(c.status).toLowerCase();
  const mapped: NormalizedBillingAttempt["status"] = status === "success" || status === "refunded" || status === "partially_refunded" ? "success" : status === "error" ? "failed" : "pending";
  if (status === "skipped" || status === "queued") return [];
  const subs = ((c.line_items as Rec[] | undefined) ?? []).map((l) => String(l.purchase_item_id ?? l.subscription_id)).filter((x) => x && x !== "undefined");
  const at = new Date(String(c.processed_at ?? c.updated_at ?? c.scheduled_at));
  return [...new Set(subs)].map((sub) => ({
    externalId: `${c.id}:${sub}`,
    contractExternalId: sub,
    status: mapped,
    errorCode: mapped === "failed" ? normalizePaymentError(c.error_type as string, c.error as string) : null,
    errorMessage: (c.error as string | null) ?? null,
    amountMinor: minorFrom(c.total_price as string),
    currency: String(c.currency ?? "USD"),
    orderExternalId: r(c.external_order_id).ecommerce ? String(r(c.external_order_id).ecommerce) : null,
    attemptedAt: at,
    nextRetryAt: mapped === "failed" ? dateOrNull(c.retry_date) : null,
    cycleKey: String(c.scheduled_at ?? at.toISOString()).slice(0, 10),
  }));
}

/** Recharge (API 2021-11) [to verify]: subscriptions, charges, customers; no native pause. */
export class RechargeSubscriptionProvider implements SubscriptionProvider {
  readonly provider = "recharge" as const;
  readonly capabilities: SubscriptionCapabilities = { canPause: false, canResume: true, canSkip: true, canSwap: true, canChangeFrequency: true, canReschedule: true, canCancel: true, canSendPaymentLink: true };
  readonly http: HttpClient;
  private readonly base = "https://api.rechargeapps.com";

  constructor(private readonly creds: RechargeCredentials, opts: HttpOptions = {}) {
    this.http = new HttpClient({ minIntervalMs: 500, ...opts });
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.http.request<T>(`${this.base}${path}`, { method: init.method ?? "GET", headers: { "x-recharge-access-token": this.creds.apiToken, "x-recharge-version": RECHARGE_API_VERSION, accept: "application/json", "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return res.json;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const d = await this.call<{ store: { id: number; name: string } }>("/store");
      return { ok: true, accountName: d.store.name, accountId: String(d.store.id) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async customersFor(subs: Rec[]): Promise<Map<string, Rec>> {
    const ids = [...new Set(subs.map((s) => String(s.customer_id)).filter(Boolean))];
    if (!ids.length) return new Map();
    const d = await this.call<{ customers: Rec[] }>(`/customers?ids=${ids.join(",")}&limit=250`);
    return new Map(d.customers.map((c) => [String(c.id), c]));
  }

  async fetchContracts(q: SyncQuery): Promise<Page<NormalizedSubscriptionContract>> {
    const params = new URLSearchParams({ limit: String(Math.min(q.limit ?? 250, 250)) });
    if (q.cursor) params.set("cursor", q.cursor);
    else if (q.updatedSince) params.set("updated_at_min", q.updatedSince.toISOString().slice(0, 19));
    const d = await this.call<{ subscriptions: Rec[]; next_cursor: string | null }>(`/subscriptions?${params}`);
    const customers = await this.customersFor(d.subscriptions);
    return { items: d.subscriptions.map((s) => mapRechargeSubscription(s, customers)), nextCursor: d.next_cursor ?? null };
  }

  async fetchContract(externalId: string): Promise<NormalizedSubscriptionContract | null> {
    try {
      const d = await this.call<{ subscription: Rec }>(`/subscriptions/${encodeURIComponent(externalId)}`);
      return mapRechargeSubscription(d.subscription, await this.customersFor([d.subscription]));
    } catch (e) {
      if (e instanceof IntegrationError && e.code === "not_found") return null;
      throw e;
    }
  }

  async fetchBillingAttempts(q: SyncQuery): Promise<Page<NormalizedBillingAttempt>> {
    const params = new URLSearchParams({ limit: String(Math.min(q.limit ?? 250, 250)) });
    if (q.cursor) params.set("cursor", q.cursor);
    else if (q.createdSince) params.set("updated_at_min", q.createdSince.toISOString().slice(0, 19));
    const d = await this.call<{ charges: Rec[]; next_cursor: string | null }>(`/charges?${params}`);
    return { items: d.charges.flatMap(mapRechargeCharge), nextCursor: d.next_cursor ?? null };
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<SubscriptionWebhook> {
    const expected = createHash("sha256").update(this.creds.webhookSecret + rawBody, "utf8").digest("hex");
    const got = headers["x-recharge-hmac-sha256"] ?? "";
    if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as Rec;
    const sub = r(payload.subscription);
    const charge = r(payload.charge);
    const contract = sub.id ?? ((charge.line_items as Rec[] | undefined)?.[0]?.purchase_item_id ?? null);
    return { topic: headers["x-recharge-topic"] ?? "unknown", externalId: `${headers["x-recharge-topic"] ?? ""}:${sub.id ?? charge.id ?? ""}:${sub.updated_at ?? charge.updated_at ?? ""}`, sourceUpdatedAt: String(sub.updated_at ?? charge.updated_at ?? ""), payload, contractExternalId: contract ? String(contract) : null };
  }

  private async afterWrite(externalId: string): Promise<NormalizedSubscriptionContract> {
    const c = await this.fetchContract(externalId);
    if (!c) throw new IntegrationError("not_found", `Recharge subscription ${externalId} not found`);
    return c;
  }

  async resume(externalId: string) {
    await this.call(`/subscriptions/${externalId}/activate`, { method: "POST", body: {} });
    return this.afterWrite(externalId);
  }
  async cancel(externalId: string, input: { reason: string; note?: string | null }) {
    await this.call(`/subscriptions/${externalId}/cancel`, { method: "POST", body: { cancellation_reason: input.reason, cancellation_reason_comments: input.note ?? undefined } });
    return this.afterWrite(externalId);
  }
  async skipNext(externalId: string) {
    const q = await this.call<{ charges: Rec[] }>(`/charges?subscription_id=${externalId}&status=queued&limit=1`);
    const charge = q.charges[0];
    if (!charge) throw new IntegrationError("invalid_request", "No upcoming charge to skip");
    await this.call(`/charges/${charge.id}/skip`, { method: "POST", body: { purchase_item_ids: [Number(externalId)] } });
    return this.afterWrite(externalId);
  }
  async swapVariant(externalId: string, input: { lineExternalId: string; variantExternalId: string; quantity?: number }) {
    await this.call(`/subscriptions/${externalId}`, { method: "PUT", body: { external_variant_id: { ecommerce: input.variantExternalId }, ...(input.quantity ? { quantity: input.quantity } : {}) } });
    return this.afterWrite(externalId);
  }
  async changeFrequency(externalId: string, input: { unit: SubscriptionInterval; count: number }) {
    const count = input.unit === "year" ? input.count * 12 : input.count;
    await this.call(`/subscriptions/${externalId}`, { method: "PUT", body: { order_interval_unit: RECHARGE_UNITS[input.unit], order_interval_frequency: count, charge_interval_frequency: count } });
    return this.afterWrite(externalId);
  }
  async reschedule(externalId: string, nextBillingAt: Date) {
    await this.call(`/subscriptions/${externalId}/set_next_charge_date`, { method: "POST", body: { date: nextBillingAt.toISOString().slice(0, 10) } });
    return this.afterWrite(externalId);
  }
  async sendPaymentUpdateLink(externalId: string) {
    const d = await this.call<{ subscription: Rec }>(`/subscriptions/${externalId}`);
    await this.call(`/customers/${d.subscription.customer_id}/notifications`, { method: "POST", body: { type: "email", template_type: "shopify_update_payment_information" } });
    return { sent: true };
  }
}

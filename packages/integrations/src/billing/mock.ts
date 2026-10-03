import { createHash } from "node:crypto";
import type { CatalogItem } from "@hullwise/core";
import type { BillingCustomerInput, BillingInvoiceInput, BillingProvider, CatalogSyncResult, CheckoutInput, CheckoutSession, InvoiceSnapshot, SubscriptionItemSnapshot, SubscriptionSnapshot, SubscriptionStartInput } from "./types";

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const withParam = (url: string, k: string, v: string) => `${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

/** Mock price ids carry the lookup key and the amount, so a mock subscription can be rebuilt from them. */
export function mockPriceId(lookupKey: string, amountMinor: number): string {
  return `mock_price_${lookupKey}__${amountMinor}`;
}
export function parseMockPriceId(priceId: string): { lookupKey: string; amountMinor: number } | null {
  const m = /^mock_price_(.+)__(\d+)$/.exec(priceId);
  return m ? { lookupKey: m[1]!, amountMinor: Number(m[2]) } : null;
}

function mockItem(priceId: string, currency: string, n: number, subscriptionId: string): SubscriptionItemSnapshot {
  const p = parseMockPriceId(priceId);
  return { itemId: `mock_si_${short(`${subscriptionId}:${priceId}:${n}`)}`, priceId, lookupKey: p?.lookupKey ?? null, unitAmountMinor: p?.amountMinor ?? 0, currency, interval: "month", quantity: 1 };
}

/**
 * Default provider: no processor, no network. Ids are deterministic; Hullwise's mirror is the only
 * state. Hullwise-ledger invoices are marked paid by the super-admin; Stripe-style subscriptions are
 * completed by the console's "simulate" actions, which feed Stripe-shaped events (./objects)
 * through the same webhook processing as Stripe.
 */
export class MockBillingProvider implements BillingProvider {
  readonly provider = "mock" as const;
  readonly mode = "mock" as const;
  readonly paid = new Set<string>();
  constructor(private readonly currency = "USD") {}

  async ensureCustomer(input: BillingCustomerInput): Promise<string> {
    return `mock_cus_${input.tenantId.slice(0, 8)}`;
  }
  async syncCatalog(items: readonly CatalogItem[]): Promise<CatalogSyncResult[]> {
    return items.map((i) => ({ lookupKey: i.lookupKey, productId: i.productId, priceId: mockPriceId(i.lookupKey, i.amountMinor), amountMinor: i.amountMinor, currency: i.currency, interval: i.interval, outcome: "unchanged", archivedPriceId: null }));
  }
  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession> {
    const id = `mock_cs_${short(input.idempotencyKey)}`;
    return { id, url: withParam(input.successUrl, "mock_checkout", id), expiresAt: new Date(Date.now() + 24 * 3600_000) };
  }
  async createInvoicedSubscription(input: SubscriptionStartInput & { daysUntilDue: number }): Promise<SubscriptionSnapshot> {
    const id = `mock_sub_${short(input.idempotencyKey)}`;
    const now = new Date();
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { id, customerId: input.customerId, status: input.trialDays ? "trialing" : "active", collectionMethod: "send_invoice", currentPeriodStart: now, currentPeriodEnd: input.trialDays ? new Date(now.getTime() + input.trialDays * 864e5) : end, trialEnd: input.trialDays ? new Date(now.getTime() + input.trialDays * 864e5) : null, cancelAtPeriodEnd: false, canceledAt: null, cancellationReason: null, items: input.priceIds.map((p, n) => mockItem(p, this.currency, n, id)), metadata: { hullwise_tenant_id: input.tenantId }, paymentMethodSummary: null, latestInvoiceId: null };
  }
  async updateSubscriptionItems(subscriptionId: string, changes: { add: string[]; remove: string[]; swap: { itemId: string; priceId: string }[]; currentItems?: SubscriptionItemSnapshot[] }): Promise<SubscriptionSnapshot> {
    const kept = (changes.currentItems ?? []).filter((i) => !changes.remove.includes(i.itemId)).map((i) => {
      const s = changes.swap.find((x) => x.itemId === i.itemId);
      return s ? { ...mockItem(s.priceId, this.currency, 0, subscriptionId), itemId: i.itemId } : i;
    });
    const items = [...kept, ...changes.add.map((p, n) => mockItem(p, this.currency, n + kept.length, subscriptionId))];
    // empty customer and status: the caller keeps what its mirror has
    return { id: subscriptionId, customerId: "", status: "", collectionMethod: "charge_automatically", currentPeriodStart: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, canceledAt: null, cancellationReason: null, items, metadata: {}, paymentMethodSummary: null, latestInvoiceId: null };
  }
  async createPortalSession(_customerId: string, returnUrl: string): Promise<{ url: string }> {
    return { url: withParam(returnUrl, "mock_portal", "1") };
  }
  async fetchSubscription(): Promise<SubscriptionSnapshot | null> {
    return null;
  }
  readonly cancelled = new Set<string>();
  async cancelSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    this.cancelled.add(subscriptionId);
    const now = new Date();
    return { id: subscriptionId, customerId: "", status: "canceled", collectionMethod: "charge_automatically", currentPeriodStart: null, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, canceledAt: now, cancellationReason: "cancellation_requested", items: [], metadata: {}, paymentMethodSummary: null, latestInvoiceId: null };
  }
  async listInvoices(): Promise<InvoiceSnapshot[]> {
    return [];
  }
  async setCustomerTaxExempt(): Promise<void> {}
  async createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }> {
    return { externalId: `mock_in_${input.number}`, hostedUrl: null };
  }
  async fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible"> {
    return this.paid.has(externalId) ? "paid" : "open";
  }
}

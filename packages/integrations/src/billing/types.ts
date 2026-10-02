import type { CatalogItem } from "@hullwise/core";

/** mock = no processor (default); test / live = Stripe, from the key prefix. */
export type BillingMode = "mock" | "test" | "live";

export interface BillingCustomerInput {
  tenantId: string;
  name: string;
  email?: string | null;
  /** Language of Stripe's emails, Checkout and portal for this customer. */
  locale?: string | null;
}

export interface CatalogSyncResult {
  lookupKey: string;
  productId: string;
  priceId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | null;
  outcome: "created" | "updated" | "unchanged";
  archivedPriceId: string | null;
}

export interface SubscriptionStartInput {
  customerId: string;
  tenantId: string;
  /** Recurring prices (plan, add-ons). */
  priceIds: string[];
  /** One-off prices added to the first invoice (setup fee). */
  oneOffPriceIds: string[];
  trialDays: number | null;
  /** Stripe Tax computes VAT (reverse charge for verified EU VAT ids included). */
  automaticTax: boolean;
  idempotencyKey: string;
}

export interface CheckoutInput extends SubscriptionStartInput {
  successUrl: string;
  cancelUrl: string;
  locale: string | null;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date | null;
}

export interface SubscriptionItemSnapshot {
  itemId: string;
  priceId: string;
  lookupKey: string | null;
  unitAmountMinor: number;
  currency: string;
  interval: "month" | null;
  quantity: number;
}

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  collectionMethod: "charge_automatically" | "send_invoice";
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** cancellation_requested | payment_failed | payment_disputed | null */
  cancellationReason: string | null;
  items: SubscriptionItemSnapshot[];
  metadata: Record<string, string>;
  /** "visa •••• 4242", when expanded. */
  paymentMethodSummary: string | null;
  latestInvoiceId: string | null;
}

export interface InvoiceLineSnapshot {
  priceId: string | null;
  lookupKey: string | null;
  description: string | null;
  amountMinor: number;
  proration: boolean;
}

export interface InvoiceSnapshot {
  id: string;
  number: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  /** draft | open | paid | void | uncollectible */
  status: string;
  collectionMethod: string | null;
  billingReason: string | null;
  currency: string;
  totalMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  attemptCount: number;
  nextPaymentAttemptAt: Date | null;
  createdAt: Date;
  finalizedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  lines: InvoiceLineSnapshot[];
  lastPaymentError: string | null;
  metadata: Record<string, string>;
  /** Tenant id from the subscription's metadata, when Stripe copies it onto the invoice. */
  subscriptionTenantId: string | null;
}

export interface CustomerSnapshot {
  id: string;
  email: string | null;
  name: string | null;
  country: string | null;
  taxExempt: string | null;
  taxIds: { type: string; value: string; verified: boolean }[];
  metadata: Record<string, string>;
}

export interface CheckoutSnapshot {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  clientReferenceId: string | null;
  status: string | null;
  paymentStatus: string | null;
  metadata: Record<string, string>;
}

export interface BillingInvoiceInput {
  customerId: string;
  number: string;
  currency: string;
  lines: { key: string; label: string; amountMinor: number }[];
  dueAt: Date;
}

/**
 * Payment processor contract (#53). Stripe subscriptions own collection (card on file, retries,
 * dunning, proration); Hullwise mirrors them from webhooks. The mock (default) keeps everything inside
 * Hullwise: the console simulates the webhooks it would receive.
 */
export interface BillingProvider {
  readonly provider: "mock" | "stripe";
  readonly mode: BillingMode;
  ensureCustomer(input: BillingCustomerInput): Promise<string>;
  syncCatalog(items: readonly CatalogItem[]): Promise<CatalogSyncResult[]>;
  /** Checkout in subscription mode (card on file); the setup fee is a one-off line of the first invoice. */
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession>;
  /** Bank-transfer customers: Stripe emails each invoice with payment terms (`send_invoice`). */
  createInvoicedSubscription(input: SubscriptionStartInput & { daysUntilDue: number }): Promise<SubscriptionSnapshot>;
  /** Plan and add-on changes, prorated. `add` and `swap` carry price ids; `currentItems` lets the mock rebuild the result. */
  updateSubscriptionItems(subscriptionId: string, changes: { add: string[]; remove: string[]; swap: { itemId: string; priceId: string }[]; currentItems?: SubscriptionItemSnapshot[] }, idempotencyKey: string): Promise<SubscriptionSnapshot>;
  createPortalSession(customerId: string, returnUrl: string, locale: string | null): Promise<{ url: string }>;
  fetchSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  listInvoices(customerId: string, limit?: number): Promise<InvoiceSnapshot[]>;
  setCustomerTaxExempt(customerId: string, value: "none" | "exempt" | "reverse"): Promise<void>;
  /** Hullwise-ledger invoices (the mock model's monthly run). */
  createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }>;
  fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible">;
}

export class BillingProviderError extends Error {
  constructor(readonly code: "not_configured" | "not_found" | "invalid_request" | "network", message: string) {
    super(message);
    this.name = "BillingProviderError";
  }
}

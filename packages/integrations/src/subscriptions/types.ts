import type { SubscriptionCapabilities, SubscriptionInterval, SubscriptionPaymentError, SubscriptionStatus } from "@hullwise/core";
import type { ConnectionTest, Page, SyncQuery, VerifiedWebhook } from "../types";

/**
 * Subscription apps (`addon.subscriptions`, issue #67): Hullwise reads contracts, billing attempts and
 * cancellations from the app the merchant already uses and sends customer-care actions back
 * through it. Hullwise never charges a card, edits selling plans or replaces the customer portal.
 */
export const SUBSCRIPTION_PROVIDERS = ["shopify_subscriptions", "recharge", "loop"] as const;
export type SubscriptionProviderKey = (typeof SUBSCRIPTION_PROVIDERS)[number];
export function isSubscriptionProvider(v: unknown): v is SubscriptionProviderKey {
  return typeof v === "string" && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(v);
}

export interface NormalizedSubscriptionLine {
  externalId: string;
  variantExternalId: string | null;
  productExternalId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  /** Price per unit charged at each renewal, after line discounts. */
  unitPriceMinor: number;
}

export interface NormalizedSubscriptionContract {
  externalId: string;
  status: SubscriptionStatus;
  customer: { externalId: string | null; email: string | null; firstName: string | null; lastName: string | null; phone: string | null } | null;
  currency: string;
  lines: NormalizedSubscriptionLine[];
  intervalUnit: SubscriptionInterval;
  intervalCount: number;
  nextBillingAt: Date | null;
  /** Total charged per renewal (lines × quantity − contract discounts + delivery). */
  priceMinor: number;
  discounts: { code: string | null; title: string | null; amountMinor: number }[];
  createdAt: Date;
  /** When the contract stopped being live (cancelled, expired, failed). */
  endedAt: Date | null;
  pausedAt: Date | null;
  cancellationReasonRaw: string | null;
  /** The provider ended it after failed payments (involuntary churn). */
  cancelledForNonPayment: boolean;
  /** Order that created the contract (the first subscription order). */
  originOrderExternalId: string | null;
  updatedAt: Date;
}

export interface NormalizedBillingAttempt {
  externalId: string;
  contractExternalId: string;
  status: "success" | "failed" | "pending";
  errorCode: SubscriptionPaymentError | null;
  errorMessage: string | null;
  amountMinor: number;
  currency: string;
  /** Renewal order the charge created (success only). */
  orderExternalId: string | null;
  attemptedAt: Date;
  /** When the provider will retry a failed charge; null when it gave up or succeeded. */
  nextRetryAt: Date | null;
  /** The billing cycle (scheduled date, `YYYY-MM-DD`) the attempt belongs to; retries share it. */
  cycleKey: string;
}

export interface SubscriptionWebhook extends VerifiedWebhook {
  /** Contract to read back after the event (every topic carries it). */
  contractExternalId: string | null;
}

export interface SubscriptionProvider {
  readonly provider: SubscriptionProviderKey | "mock";
  readonly capabilities: SubscriptionCapabilities;
  testConnection(): Promise<ConnectionTest>;
  /** Contracts updated since `updatedSince` (all when null), oldest first, paged by an opaque cursor. */
  fetchContracts(q: SyncQuery): Promise<Page<NormalizedSubscriptionContract>>;
  fetchContract(externalId: string): Promise<NormalizedSubscriptionContract | null>;
  /** Billing attempts (successes and failures with reason) since `createdSince`. */
  fetchBillingAttempts(q: SyncQuery): Promise<Page<NormalizedBillingAttempt>>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<SubscriptionWebhook>;
  // customer-care actions: each answers the contract as the provider holds it afterwards (present only with the capability)
  pause?(externalId: string, opts: { resumeAt?: Date | null }): Promise<NormalizedSubscriptionContract>;
  resume?(externalId: string): Promise<NormalizedSubscriptionContract>;
  skipNext?(externalId: string): Promise<NormalizedSubscriptionContract>;
  swapVariant?(externalId: string, input: { lineExternalId: string; variantExternalId: string; quantity?: number }): Promise<NormalizedSubscriptionContract>;
  changeFrequency?(externalId: string, input: { unit: SubscriptionInterval; count: number }): Promise<NormalizedSubscriptionContract>;
  reschedule?(externalId: string, nextBillingAt: Date): Promise<NormalizedSubscriptionContract>;
  cancel?(externalId: string, input: { reason: string; note?: string | null }): Promise<NormalizedSubscriptionContract>;
  /** Sends the customer the provider's own payment-method update email or link. */
  sendPaymentUpdateLink?(externalId: string): Promise<{ sent: boolean }>;
}

/** Scopes or permissions per provider, shown in the activation guide (vendor UIs change: "to verify"). */
export const SUBSCRIPTION_SCOPES: Record<SubscriptionProviderKey, string[]> = {
  shopify_subscriptions: ["read_own_subscription_contracts", "write_own_subscription_contracts", "read_customer_payment_methods", "read_orders", "read_customers"],
  recharge: ["read_subscriptions", "write_subscriptions", "read_charges", "read_customers", "write_customers", "read_orders"],
  loop: ["subscriptions:read", "subscriptions:write", "orders:read", "customers:read"],
};

/** Webhook topics Hullwise subscribes to per provider. */
export const SUBSCRIPTION_WEBHOOK_TOPICS: Record<SubscriptionProviderKey, string[]> = {
  shopify_subscriptions: ["subscription_contracts/create", "subscription_contracts/update", "subscription_billing_attempts/success", "subscription_billing_attempts/failure", "subscription_billing_attempts/challenged"],
  recharge: ["subscription/created", "subscription/updated", "subscription/cancelled", "subscription/activated", "subscription/skipped", "charge/paid", "charge/failed"],
  loop: ["subscription.created", "subscription.updated", "subscription.cancelled", "subscription.paused", "subscription.resumed", "order.billing_failed", "order.billing_succeeded"],
};

/** Maps provider decline codes and messages onto Hullwise's normalized payment errors. */
export function normalizePaymentError(code: string | null | undefined, message?: string | null): SubscriptionPaymentError | null {
  const t = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (!t.trim()) return null;
  if (/expired/.test(t)) return "card_expired";
  if (/insufficient|funds/.test(t)) return "insufficient_funds";
  if (/authenticat|3ds|challenge|action_required/.test(t)) return "authentication_required";
  if (/declin|do_not_honor|refused|invalid_payment|card_error|payment_method/.test(t)) return "card_declined";
  if (/processing|gateway|unexpected|timeout/.test(t)) return "processing_error";
  return "other";
}

export function normalizeInterval(unit: string | null | undefined): SubscriptionInterval {
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("day")) return "day";
  if (u.startsWith("week")) return "week";
  if (u.startsWith("year")) return "year";
  return "month";
}

export const minorFrom = (amount: unknown) => Math.round(Number(amount ?? 0) * 100);
export const dateOrNull = (v: unknown) => (v ? new Date(String(v)) : null);

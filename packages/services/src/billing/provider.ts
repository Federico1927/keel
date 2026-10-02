import { stripeKeyMode } from "@hullwise/core";
import { MockBillingProvider, MockInvoicingProvider, StripeBillingProvider, type BillingProvider, type InvoicingProvider } from "@hullwise/integrations";

export { MockBillingProvider, StripeBillingProvider, type BillingProvider, type BillingInvoiceInput } from "@hullwise/integrations";

/**
 * Billing configuration from the environment (#53). Keys are Railway variables only, never in the
 * repository: STRIPE_SECRET_KEY (a restricted `rk_` key is enough), STRIPE_WEBHOOK_SECRET.
 * Without a key Hullwise bills through the mock (default for dev, tests and the demo).
 */
export interface BillingSettings {
  provider: "mock" | "stripe";
  /** mock | test | live, from the key prefix: the console shows it as a badge. */
  mode: "mock" | "test" | "live";
  webhookConfigured: boolean;
  /** Stripe Tax on Checkout and subscriptions (`STRIPE_TAX=off` turns it off: Hullwise then sets reverse charge itself). */
  automaticTax: boolean;
  /** Country of the company that issues Hullwise's invoices, for the VAT treatment; no default. */
  sellerCountry: string | null;
  /** Italian e-invoicing connector (InvoicingProvider): none unless BILLING_EINVOICING is set. */
  einvoicing: "none" | "mock";
}

export function billingSettings(env: Record<string, string | undefined> = process.env): BillingSettings {
  const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);
  return {
    provider: mode ? "stripe" : "mock",
    mode: mode ?? "mock",
    webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET?.trim()),
    automaticTax: mode ? env.STRIPE_TAX !== "off" : false,
    sellerCountry: env.BILLING_SELLER_COUNTRY?.trim().toUpperCase() || null,
    einvoicing: env.BILLING_EINVOICING === "mock" ? "mock" : "none",
  };
}

let cached: BillingProvider | null = null;
export function getBillingProvider(): BillingProvider {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  cached = key && stripeKeyMode(key) ? new StripeBillingProvider(key, { maxRetries: 2 }) : new MockBillingProvider();
  return cached;
}

/** Tests and scripts swap the provider; null restores the environment's. */
export function setBillingProvider(provider: BillingProvider | null): void {
  cached = provider;
}

let invoicing: InvoicingProvider | null | undefined;
/** The e-invoicing connector, or null when none is configured. */
export function getInvoicingProvider(): InvoicingProvider | null {
  if (invoicing === undefined) invoicing = billingSettings().einvoicing === "mock" ? new MockInvoicingProvider() : null;
  return invoicing;
}
export function setInvoicingProvider(provider: InvoicingProvider | null | undefined): void {
  invoicing = provider;
}

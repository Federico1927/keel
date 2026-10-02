/**
 * Stripe billing (#53). Stripe subscriptions collect the money (card on file, automatic charges,
 * Smart Retries, dunning, proration); Hullwise keeps the plan and add-on catalog here and in `plans.ts`
 * / `modules.ts`, and a ledger mirrored from Stripe webhooks. Product names travel to Stripe
 * (Checkout, invoices, the customer portal), which shows one name per product: English.
 */
export const BILLING_PRODUCT_NAMES: Record<string, string> = {
  "addon.cod": "Cash on delivery",
  "addon.customer_campaigns": "Customer campaigns",
  "addon.subscriptions": "Subscription analytics",
};

/** Trial days offered by default when a super-admin starts a subscription (editable in the dialog). */
export const DEFAULT_SUBSCRIPTION_TRIAL_DAYS = 0;
/** Payment terms of bank-transfer customers (Stripe `send_invoice` collection). */
export const DEFAULT_PAYMENT_TERMS_DAYS = 14;
/** Signed webhook timestamps older than this are refused (replay protection). */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
/** Renewals within this many days are listed as "upcoming" in the console. */
export const UPCOMING_RENEWAL_DAYS = 14;

import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

/**
 * Platform billing. Rows are written by the super-admin console and the billing job through
 * the admin connection; the tenant can read its own subscription and invoices (RLS).
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    ...tenantColumns(),
    planKey: text("plan_key").notNull(),
    /** trialing | active | past_due | suspended | cancelled */
    status: text("status").notNull().default("trialing"),
    /** mock | stripe */
    provider: text("provider").notNull().default("mock"),
    externalCustomerId: text("external_customer_id"),
    externalSubscriptionId: text("external_subscription_id"),
    currency: text("currency").notNull().default("EUR"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    setupFeeMinor: integer("setup_fee_minor").notNull().default(0),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /* Stripe mirror (#53), written by the webhook processing: Stripe owns collection. */
    /** Raw Stripe status: trialing | active | past_due | unpaid | canceled | incomplete | incomplete_expired | paused. */
    externalStatus: text("external_status"),
    /** charge_automatically (card on file) | send_invoice (bank transfer with payment terms) */
    collectionMethod: text("collection_method"),
    paymentTermsDays: integer("payment_terms_days"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    billingEmail: text("billing_email"),
    /** [{ itemId, priceId, lookupKey, unitAmountMinor, currency, interval, quantity }] */
    items: jsonb("items").$type<{ itemId: string; priceId: string; lookupKey: string | null; unitAmountMinor: number; currency: string; interval: "month" | null; quantity: number }[]>().notNull().default(sql`'[]'::jsonb`),
    /** "visa •••• 4242": what the owner sees, never the card itself. */
    paymentMethodSummary: text("payment_method_summary"),
    /** Pending Checkout started from the console. */
    checkoutSessionId: text("checkout_session_id"),
    checkoutUrl: text("checkout_url"),
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    /** What the pending Checkout sells: recurring and one-off price ids, trial days. */
    checkoutItems: jsonb("checkout_items").$type<{ priceIds: string[]; oneOffPriceIds: string[]; trialDays: number }>(),
    /** Customer details mirrored for VAT: country and tax ids collected at Checkout. */
    customerCountry: text("customer_country"),
    customerTaxIds: jsonb("customer_tax_ids").$type<{ type: string; value: string; verified: boolean }[]>().notNull().default(sql`'[]'::jsonb`),
    taxExempt: text("tax_exempt"),
    /** Creation time of the last Stripe event applied: older, out-of-order events are skipped. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_tenant_uq").on(t.tenantId), index("subscriptions_external_customer_idx").on(t.externalCustomerId), index("subscriptions_external_sub_idx").on(t.externalSubscriptionId), tenantIsolation("subscriptions")],
).enableRLS();

export const invoices = pgTable(
  "invoices",
  {
    ...tenantColumns(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    provider: text("provider").notNull().default("mock"),
    externalId: text("external_id"),
    hostedUrl: text("hosted_url"),
    /** open | paid | void | uncollectible */
    status: text("status").notNull().default("open"),
    /** setup | subscription | adjustment */
    kind: text("kind").notNull().default("subscription"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /** [{ kind: plan|addon|setup, key, label, amountMinor }] */
    lines: jsonb("lines").notNull().default(sql`'[]'::jsonb`),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /* Stripe mirror (#53). */
    pdfUrl: text("pdf_url"),
    subtotalMinor: integer("subtotal_minor"),
    taxMinor: integer("tax_minor"),
    collectionMethod: text("collection_method"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextPaymentAttemptAt: timestamp("next_payment_attempt_at", { withTimezone: true }),
    /** Set when a charge failed (Stripe retries it); cleared when paid. */
    paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
    /** Set when the bank asks the customer to authenticate (SCA); cleared when paid. */
    actionRequiredAt: timestamp("action_required_at", { withTimezone: true }),
    lastPaymentError: text("last_payment_error"),
    /** Italian e-invoicing (InvoicingProvider slot): queued | accepted | rejected, and the intermediary's id. */
    einvoiceStatus: text("einvoice_status"),
    einvoiceRef: text("einvoice_ref"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoices_tenant_number_uq").on(t.tenantId, t.number), uniqueIndex("invoices_tenant_external_uq").on(t.tenantId, t.externalId), index("invoices_tenant_status_idx").on(t.tenantId, t.status, t.dueAt), tenantIsolation("invoices")],
).enableRLS();

/**
 * Tenant lifecycle history (#48): one row per state change, with reason and note, plus a snapshot
 * of plan, add-ons and monthly charge so the console can rebuild MRR, active tenants and add-on
 * adoption month by month. Plan and add-on changes write a row with an unchanged status.
 */
export const tenantLifecycleEvents = pgTable(
  "tenant_lifecycle_events",
  {
    ...tenantColumns(),
    /** null on the first row (creation). */
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    planKey: text("plan_key").notNull(),
    addons: jsonb("addons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    monthlyMinor: integer("monthly_minor").notNull().default(0),
    actorUserId: uuid("actor_user_id"),
    /** super_admin | system */
    actorType: text("actor_type").notNull().default("system"),
    createdAt: createdAt(),
  },
  (t) => [index("tenant_lifecycle_events_tenant_idx").on(t.tenantId, t.createdAt), index("tenant_lifecycle_events_created_idx").on(t.createdAt), tenantIsolation("tenant_lifecycle_events")],
).enableRLS();

/**
 * Stripe webhook events (#53), platform rows: stored once the signature checks out (unique on
 * provider + event id, so a redelivery is a no-op), answered with 200 at once and processed in the
 * background like the Shopify and email webhooks. `object` is the event's `data.object`; processed
 * rows are purged after the platform retention window.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: id(),
    /** stripe | mock (the console's simulated events) */
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    livemode: boolean("livemode").notNull().default(false),
    /** Tenant the event was matched to (not a tenant-owned row: no RLS, admin connection only). */
    tenantRef: uuid("tenant_ref"),
    object: jsonb("object").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** pending | processed | ignored | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("billing_events_dedup_uq").on(t.provider, t.eventId), index("billing_events_status_idx").on(t.status, t.receivedAt), index("billing_events_received_idx").on(t.receivedAt)],
);

/**
 * The Stripe catalog as last synced (#53): one row per lookup key (plan monthly, setup fee, add-on
 * monthly) with the current price id. Checkout and subscription changes read price ids from here.
 */
export const billingPrices = pgTable(
  "billing_prices",
  {
    id: id(),
    provider: text("provider").notNull(),
    lookupKey: text("lookup_key").notNull(),
    /** plan | setup | addon */
    kind: text("kind").notNull(),
    itemKey: text("item_key").notNull(),
    productId: text("product_id").notNull(),
    priceId: text("price_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    interval: text("interval"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("billing_prices_provider_key_uq").on(t.provider, t.lookupKey), index("billing_prices_price_idx").on(t.priceId)],
);

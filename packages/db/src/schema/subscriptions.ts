import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { customers } from "./customers";
import { productVariants, products } from "./catalog";
import { orders } from "./orders";

/**
 * Tables of `addon.subscriptions` (issue #67): the merchant's subscription contracts as their
 * subscription app (Shopify Subscriptions, Recharge, Loop) holds them. Hullwise is not the billing
 * engine: these rows mirror the provider and record what Hullwise's team did through it.
 */
export const subscriptionContracts = pgTable(
  "subscription_contracts",
  {
    ...tenantColumns(),
    /** shopify_subscriptions | recharge | loop | mock */
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** active | paused | cancelled | expired | failed (provider's status, normalized) */
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    /** Charged per renewal, after discounts. */
    priceMinor: integer("price_minor").notNull().default(0),
    /** Monthly equivalent of the price (MRR contribution while active). */
    mrrMinor: integer("mrr_minor").notNull().default(0),
    /** day | week | month | year */
    intervalUnit: text("interval_unit").notNull().default("month"),
    intervalCount: integer("interval_count").notNull().default(1),
    nextBillingAt: timestamp("next_billing_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** When the contract stopped being live (cancelled, expired, failed). */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** voluntary | involuntary (payment failures) */
    cancellationKind: text("cancellation_kind"),
    /** Code of the tenant's reason list (`subscription_cancellation_reasons`); the provider's text stays in `cancellation_reason_raw`. */
    cancellationReasonCode: text("cancellation_reason_code"),
    cancellationReasonRaw: text("cancellation_reason_raw"),
    discounts: jsonb("discounts").notNull().default(sql`'[]'::jsonb`),
    originOrderId: uuid("origin_order_id").references(() => orders.id, { onDelete: "set null" }),
    originOrderExternalId: text("origin_order_external_id"),
    /** Successful renewals (orders after the first). */
    renewalsCount: integer("renewals_count").notNull().default(0),
    skipsCount: integer("skips_count").notNull().default(0),
    /** Open failed-payment episode: since when the latest cycle has been failing (null when paid). */
    paymentFailingSince: timestamp("payment_failing_since", { withTimezone: true }),
    /** Recovery queue: who follows the failed payment up, and when the customer was last contacted. */
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    /** Churn risk (low | medium | high) and retention score in basis points, refreshed by the add-on's job (CRM model + subscription signals). */
    churnRisk: text("churn_risk"),
    churnRetentionBps: integer("churn_retention_bps"),
    churnFactors: jsonb("churn_factors").notNull().default(sql`'[]'::jsonb`),
    churnComputedAt: timestamp("churn_computed_at", { withTimezone: true }),
    platformUpdatedAt: timestamp("platform_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("subscription_contracts_external_uq").on(t.tenantId, t.provider, t.externalId),
    index("subscription_contracts_status_idx").on(t.tenantId, t.status),
    index("subscription_contracts_customer_idx").on(t.tenantId, t.customerId),
    index("subscription_contracts_next_idx").on(t.tenantId, t.nextBillingAt),
    tenantIsolation("subscription_contracts"),
  ],
).enableRLS();

export const subscriptionContractLines = pgTable(
  "subscription_contract_lines",
  {
    ...tenantColumns(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => subscriptionContracts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    variantExternalId: text("variant_external_id"),
    sku: text("sku"),
    title: text("title").notNull(),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull().default(1),
    unitPriceMinor: integer("unit_price_minor").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscription_contract_lines_uq").on(t.tenantId, t.contractId, t.externalId), index("subscription_contract_lines_variant_idx").on(t.tenantId, t.variantId), tenantIsolation("subscription_contract_lines")],
).enableRLS();

export const subscriptionBillingAttempts = pgTable(
  "subscription_billing_attempts",
  {
    ...tenantColumns(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => subscriptionContracts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    /** success | failed | pending */
    status: text("status").notNull(),
    /** Normalized decline reason (card_expired, insufficient_funds, …); the provider's message is kept. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    orderExternalId: text("order_external_id"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    /** Billing cycle (scheduled date) the attempt belongs to; retries share it. */
    cycleKey: text("cycle_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("subscription_billing_attempts_uq").on(t.tenantId, t.externalId), index("subscription_billing_attempts_contract_idx").on(t.contractId, t.attemptedAt), index("subscription_billing_attempts_status_idx").on(t.tenantId, t.status, t.attemptedAt), tenantIsolation("subscription_billing_attempts")],
).enableRLS();

/** The contract's timeline: what happened, who did it (customer, staff, system, provider) and the field diff. */
export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    ...tenantColumns(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => subscriptionContracts.id, { onDelete: "cascade" }),
    /** created | paused | resumed | skipped | swapped | frequency_changed | rescheduled | cancelled | reactivated | price_changed | payment_failed | payment_recovered | payment_link_sent | note | assigned */
    type: text("type").notNull(),
    /** customer | staff | system | provider */
    authorType: text("author_type").notNull().default("system"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("subscription_events_contract_idx").on(t.contractId, t.occurredAt), index("subscription_events_type_idx").on(t.tenantId, t.type, t.occurredAt), tenantIsolation("subscription_events")],
).enableRLS();

/** The tenant's own list of cancellation reasons (editable); provider text is normalized onto it by keywords. */
export const subscriptionCancellationReasons = pgTable(
  "subscription_cancellation_reasons",
  {
    ...tenantColumns(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** voluntary | involuntary */
    kind: text("kind").notNull().default("voluntary"),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscription_cancellation_reasons_uq").on(t.tenantId, t.code), tenantIsolation("subscription_cancellation_reasons")],
).enableRLS();

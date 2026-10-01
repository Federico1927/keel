import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_tenant_uq").on(t.tenantId), tenantIsolation("subscriptions")],
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
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoices_tenant_number_uq").on(t.tenantId, t.number), index("invoices_tenant_status_idx").on(t.tenantId, t.status, t.dueAt), tenantIsolation("invoices")],
).enableRLS();

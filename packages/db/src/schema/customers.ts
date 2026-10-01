import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

export const customers = pgTable(
  "customers",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    country: text("country"),
    city: text("city"),
    zip: text("zip"),
    acceptsMarketing: boolean("accepts_marketing").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ordersCount: integer("orders_count").notNull().default(0),
    totalSpentMinor: integer("total_spent_minor").notNull().default(0),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    platformCreatedAt: timestamp("platform_created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customers_tenant_external_uq").on(t.tenantId, t.externalId),
    index("customers_email_idx").on(t.tenantId, t.emailNormalized),
    index("customers_phone_idx").on(t.tenantId, t.phoneE164),
    index("customers_last_order_idx").on(t.tenantId, t.lastOrderAt),
    /** Global search by name or email (⌘K); the expression must match `customerSearchExpr` in services. */
    index("customers_search_trgm_idx").using("gin", sql`(lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, ''))) gin_trgm_ops`),
    tenantIsolation("customers"),
  ],
).enableRLS();

/**
 * Per-customer predictions (MBG/NBD + Gamma-Gamma, see packages/core/src/predictions.ts),
 * recomputed nightly and on demand. One row per customer; absent until the model has run.
 */
export const customerPredictions = pgTable(
  "customer_predictions",
  {
    ...tenantColumns(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    pAlive: doublePrecision("p_alive").notNull(),
    expectedOrders90: doublePrecision("expected_orders_90").notNull(),
    expectedOrders365: doublePrecision("expected_orders_365").notNull(),
    expectedOrderValueMinor: integer("expected_order_value_minor").notNull(),
    predictedValue365Minor: integer("predicted_value_365_minor").notNull(),
    /** low | medium | high */
    churnRisk: text("churn_risk").notNull(),
    nextOrderAt: timestamp("next_order_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_predictions_customer_uq").on(t.tenantId, t.customerId),
    index("customer_predictions_risk_idx").on(t.tenantId, t.churnRisk),
    tenantIsolation("customer_predictions"),
  ],
).enableRLS();

/** The fitted model of a tenant: parameters, fit size and the back-test shown next to the predictions. */
export const customerPredictionModels = pgTable(
  "customer_prediction_models",
  {
    ...tenantColumns(),
    /** ok | insufficient_data */
    status: text("status").notNull(),
    params: jsonb("params"),
    customers: integer("customers").notNull().default(0),
    logLikelihood: doublePrecision("log_likelihood"),
    calibration: jsonb("calibration"),
    durationMs: integer("duration_ms"),
    fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_prediction_models_tenant_uq").on(t.tenantId), tenantIsolation("customer_prediction_models")],
).enableRLS();

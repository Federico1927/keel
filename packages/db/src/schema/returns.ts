import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { orderLines, orders } from "./orders";
import { locations } from "./catalog";
import { users } from "./auth";

export const returnReasons = pgTable(
  "return_reasons",
  {
    ...tenantColumns(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** merchant | customer | undetermined */
    defaultFault: text("default_fault").notNull().default("undetermined"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    /** Labels shown on the customer portal per language ({"it": "Taglia sbagliata"}); falls back to `label`. */
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Reason sent to the commerce platform (Shopify ReturnReason enum value); null = OTHER. */
    platformReason: text("platform_reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("return_reasons_tenant_code_uq").on(t.tenantId, t.code), tenantIsolation("return_reasons")],
).enableRLS();

export const returnRequests = pgTable(
  "return_requests",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    externalId: text("external_id"),
    status: text("status").notNull().default("requested"),
    reasonCode: text("reason_code").notNull(),
    resolution: text("resolution").notNull().default("refund"),
    fault: text("fault").notNull().default("undetermined"),
    customerNote: text("customer_note"),
    staffNote: text("staff_note"),
    proposedAmountMinor: integer("proposed_amount_minor").notNull().default(0),
    refundedAmountMinor: integer("refunded_amount_minor"),
    voucherCode: text("voucher_code"),
    exchangeOrderId: uuid("exchange_order_id"),
    restockLocationId: uuid("restock_location_id").references(() => locations.id, { onDelete: "set null" }),
    outOfWindow: boolean("out_of_window").notNull().default(false),
    /** staff | portal | platform */
    source: text("source").notNull().default("staff"),
    /** Return shipping deducted because the fault is the customer's. */
    deductionMinor: integer("deduction_minor").notNull().default(0),
    trackingCode: text("tracking_code"),
    trackingCarrier: text("tracking_carrier"),
    /** What the customer wants in exchange (size, colour, product). */
    exchangeNote: text("exchange_note"),
    /** Answers to the tenant's custom portal fields. */
    customFields: jsonb("custom_fields").$type<Record<string, string | boolean>>().notNull().default(sql`'{}'::jsonb`),
    /** Account holder and IBAN for refunds of orders paid on delivery or by transfer, AES-GCM encrypted. */
    bankDetailsEnc: text("bank_details_enc"),
    customerLocale: text("customer_locale"),
    idempotencyKey: text("idempotency_key"),
    /** Write-back to the commerce platform: not_required | pending | synced | error */
    platformSyncStatus: text("platform_sync_status").notNull().default("not_required"),
    /** Last state written on the platform: requested | approved | declined | closed */
    platformStatus: text("platform_status"),
    platformError: text("platform_error"),
    platformSyncedAt: timestamp("platform_synced_at", { withTimezone: true }),
    platformRefundId: text("platform_refund_id"),
    /** Customer return risk at creation (none | watch | high) and why. */
    riskLevel: text("risk_level"),
    riskReasons: jsonb("risk_reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Set by an automation or by hand: someone should look before deciding. */
    needsReview: boolean("needs_review").notNull().default(false),
    /** Automations applied: [{ id, name, action }]. */
    automations: jsonb("automations").$type<{ id: string; name: string; action: string }[]>().notNull().default(sql`'[]'::jsonb`),
    /** Refunded or credited without the goods coming back. */
    returnless: boolean("returnless").notNull().default(false),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("return_requests_tenant_number_uq").on(t.tenantId, t.number),
    index("return_requests_order_idx").on(t.orderId),
    index("return_requests_tenant_status_idx").on(t.tenantId, t.status, t.requestedAt),
    uniqueIndex("return_requests_idempotency_uq").on(t.tenantId, t.idempotencyKey),
    index("return_requests_sync_idx").on(t.tenantId, t.platformSyncStatus),
    tenantIsolation("return_requests"),
  ],
).enableRLS();

export const returnLines = pgTable(
  "return_lines",
  {
    ...tenantColumns(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => returnRequests.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    inspectionOutcome: text("inspection_outcome"),
    inspectionAmountMinor: integer("inspection_amount_minor"),
    restocked: boolean("restocked").notNull().default(false),
    /** Line id of the return on the platform, and whether the restock was written there. */
    externalId: text("external_id"),
    platformRestocked: boolean("platform_restocked").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("return_lines_return_idx").on(t.returnId), tenantIsolation("return_lines")],
).enableRLS();

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Configuration of the public return portal (one row per tenant). */
export const returnPortalSettings = pgTable(
  "return_portal_settings",
  {
    ...tenantColumns(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("return_portal_settings_tenant_uq").on(t.tenantId), tenantIsolation("return_portal_settings")],
).enableRLS();

/** Photos the customer uploads with a return request (compressed client side, max 1.5 MB). */
export const returnEvidence = pgTable(
  "return_evidence",
  {
    ...tenantColumns(),
    /** Null until the request is submitted; bound to the portal session meanwhile. */
    returnId: uuid("return_id").references(() => returnRequests.id, { onDelete: "cascade" }),
    sessionNonce: text("session_nonce").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("return_evidence_return_idx").on(t.tenantId, t.returnId), index("return_evidence_session_idx").on(t.tenantId, t.sessionNonce), tenantIsolation("return_evidence")],
).enableRLS();

/** Fixed-window counters for public endpoints (failed order lookups per IP and per order number). */
export const publicRateLimits = pgTable(
  "public_rate_limits",
  {
    ...tenantColumns(),
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("public_rate_limits_uq").on(t.tenantId, t.key), tenantIsolation("public_rate_limits")],
).enableRLS();

/** Return policy of the tenant: windows, exclusions, final sale, customer limit, risk, automations (core schema). */
export const returnPolicies = pgTable(
  "return_policies",
  {
    ...tenantColumns(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("return_policies_tenant_uq").on(t.tenantId), tenantIsolation("return_policies")],
).enableRLS();

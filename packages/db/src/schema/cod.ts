import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { orders } from "./orders";
import { users } from "./auth";

/**
 * Tables of `addon.cod` (cash-on-delivery confirmation). Nothing in the core reads them;
 * they only exist for tenants with the add-on active.
 */
export const codSettings = pgTable(
  "cod_settings",
  {
    ...tenantColumns(),
    /** Parsed by the add-on's zod schema (weights, thresholds, risk parameters). */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cod_settings_tenant_uq").on(t.tenantId), tenantIsolation("cod_settings")],
).enableRLS();

export const codQueueItems = pgTable(
  "cod_queue_items",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** pending | scheduled | unreachable | confirmed | cancelled | left */
    status: text("status").notNull().default("pending"),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    attemptsCount: integer("attempts_count").notNull().default(0),
    noAnswerCount: integer("no_answer_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    callBackAt: timestamp("call_back_at", { withTimezone: true }),
    score: integer("score"),
    scoreBreakdown: jsonb("score_breakdown").notNull().default(sql`'{}'::jsonb`),
    riskTier: text("risk_tier"),
    /** Platform tag that pulled the order into the queue (lower-cased), null when it entered by canonical status. */
    entryTag: text("entry_tag"),
    /** Confirmation agreed for a later day (tenant-local ISO date): the daily job confirms it that morning. */
    scheduledConfirmOn: text("scheduled_confirm_on"),
    /** Local day the job last tried and failed (a failed platform call keeps the date for the next day's run). */
    scheduledConfirmTriedOn: text("scheduled_confirm_tried_on"),
    scheduledConfirmError: text("scheduled_confirm_error"),
    /** Escalated to an admin by the operator; cleared when an admin reassigns or de-escalates. */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalatedBy: uuid("escalated_by").references(() => users.id, { onDelete: "set null" }),
    escalationReason: text("escalation_reason"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cod_queue_items_order_uq").on(t.orderId), index("cod_queue_items_tenant_status_idx").on(t.tenantId, t.status, t.enteredAt), index("cod_queue_items_assigned_idx").on(t.tenantId, t.assignedTo), tenantIsolation("cod_queue_items")],
).enableRLS();

export const codAttempts = pgTable(
  "cod_attempts",
  {
    ...tenantColumns(),
    queueItemId: uuid("queue_item_id")
      .notNull()
      .references(() => codQueueItems.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    operatorId: uuid("operator_id").references(() => users.id, { onDelete: "set null" }),
    attemptNumber: integer("attempt_number").notNull(),
    /** confirmed | no_answer | call_back | cancelled | modified */
    outcome: text("outcome").notNull(),
    channel: text("channel").notNull().default("phone"),
    note: text("note"),
    callBackAt: timestamp("call_back_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("cod_attempts_order_idx").on(t.orderId, t.createdAt), index("cod_attempts_operator_idx").on(t.tenantId, t.operatorId, t.createdAt), tenantIsolation("cod_attempts")],
).enableRLS();

export const codOperatorCapacity = pgTable(
  "cod_operator_capacity",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isActive: integer("is_active").notNull().default(1),
    /** Hours per weekday, Sunday first: [sun, mon, …, sat]. */
    dailyHours: jsonb("daily_hours").notNull().default(sql`'[0,8,8,8,8,8,0]'::jsonb`),
    /** Queue tags this operator may receive; empty = any order. */
    allowedTags: jsonb("allowed_tags").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cod_operator_capacity_user_uq").on(t.tenantId, t.userId), tenantIsolation("cod_operator_capacity")],
).enableRLS();

export const codCapacityExceptions = pgTable(
  "cod_capacity_exceptions",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ISO date in the tenant timezone. */
    date: text("date").notNull(),
    /** off | extra */
    kind: text("kind").notNull(),
    hours: integer("hours"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cod_capacity_exceptions_uq").on(t.tenantId, t.userId, t.date), tenantIsolation("cod_capacity_exceptions")],
).enableRLS();

export const codAssignmentLog = pgTable(
  "cod_assignment_log",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    /** webhook | cron | manual | backfill */
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cod_assignment_log_day_idx").on(t.tenantId, t.assignedTo, t.assignedAt), tenantIsolation("cod_assignment_log")],
).enableRLS();

export const codRecipientProfiles = pgTable(
  "cod_recipient_profiles",
  {
    ...tenantColumns(),
    /** Phone in E.164, or `email:<normalized>` when no phone is known. Never the name. */
    recipientKey: text("recipient_key").notNull(),
    ordersTotal: integer("orders_total").notNull().default(0),
    ordersDelivered: integer("orders_delivered").notNull().default(0),
    ordersReturned: integer("orders_returned").notNull().default(0),
    /** Returns weighted by age (recent 1.0, older 0.5), floored. */
    weightedReturns: integer("weighted_returns").notNull().default(0),
    consecutiveDeliveries: integer("consecutive_deliveries").notNull().default(0),
    /** clean | watch | high_risk | blacklisted */
    tier: text("tier").notNull().default("clean"),
    /** force_clean | force_blacklist */
    override: text("override"),
    overrideReason: text("override_reason"),
    lastReturnAt: timestamp("last_return_at", { withTimezone: true }),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    linkedKeys: text("linked_keys").array().notNull().default(sql`'{}'::text[]`),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cod_recipient_profiles_key_uq").on(t.tenantId, t.recipientKey), index("cod_recipient_profiles_tier_idx").on(t.tenantId, t.tier), tenantIsolation("cod_recipient_profiles")],
).enableRLS();

/**
 * Confirmation messages sent from the COD card through the tenant's `MessagingChannel` (mock until a
 * provider is sold per account). Each send is also a `cod_attempts` row; the status follows the
 * provider's delivery webhooks.
 */
export const codMessages = pgTable(
  "cod_messages",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    queueItemId: uuid("queue_item_id").references(() => codQueueItems.id, { onDelete: "set null" }),
    templateKey: text("template_key").notNull(),
    provider: text("provider").notNull(),
    recipient: text("recipient").notNull(),
    body: text("body").notNull(),
    providerMessageId: text("provider_message_id"),
    /** sent | delivered | read | failed */
    status: text("status").notNull().default("sent"),
    statusAt: timestamp("status_at", { withTimezone: true }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("cod_messages_order_idx").on(t.tenantId, t.orderId, t.createdAt), index("cod_messages_provider_idx").on(t.tenantId, t.providerMessageId), tenantIsolation("cod_messages")],
).enableRLS();

/**
 * Delivery outcomes imported from a carrier's billing or COD remittance file (generic CSV). They
 * take precedence over the outcome read from the order when recipient risk is recomputed.
 */
export const codCarrierOutcomes = pgTable(
  "cod_carrier_outcomes",
  {
    ...tenantColumns(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    /** As found in the file: tracking number or order name. */
    reference: text("reference").notNull(),
    /** delivered | refused */
    outcome: text("outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** What the carrier billed for the parcel (shipping and return), in the tenant currency. */
    costMinor: integer("cost_minor"),
    importBatch: text("import_batch").notNull(),
    importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cod_carrier_outcomes_ref_uq").on(t.tenantId, t.reference), index("cod_carrier_outcomes_order_idx").on(t.tenantId, t.orderId), tenantIsolation("cod_carrier_outcomes")],
).enableRLS();

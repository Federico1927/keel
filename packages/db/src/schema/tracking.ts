import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { customers } from "./customers";
import { orders } from "./orders";

/** First-party pixel of a store: the public key in the snippet, and where events may come from. */
export const pixelSettings = pgTable(
  "pixel_settings",
  {
    ...tenantColumns(),
    publicKey: text("public_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Storefront origins allowed to post events; empty = any (the key is public anyway). */
    allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
    /** Days of browsing before an order that count towards it. */
    lookbackDays: integer("lookback_days").notNull().default(30),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pixel_settings_tenant_uq").on(t.tenantId), uniqueIndex("pixel_settings_key_uq").on(t.publicKey), tenantIsolation("pixel_settings")],
).enableRLS();

/** Raw pixel events, kept for diagnostics and identity; attribution reads the session touchpoints. */
export const pixelEvents = pgTable(
  "pixel_events",
  {
    ...tenantColumns(),
    anonymousId: text("anonymous_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** page_view | product_view | add_to_cart | checkout_started | checkout_completed | identify */
    event: text("event").notNull(),
    url: text("url"),
    referrer: text("referrer"),
    props: jsonb("props").notNull().default(sql`'{}'::jsonb`),
    ipHash: text("ip_hash"),
    /** Kept only on checkout events, for server-side conversions. */
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pixel_events_anon_idx").on(t.tenantId, t.anonymousId, t.occurredAt), index("pixel_events_time_idx").on(t.tenantId, t.occurredAt), tenantIsolation("pixel_events")],
).enableRLS();

/** Links a browser (anonymous id) to an order, a checkout or a hashed email: the base for cross-visit stitching. */
export const pixelIdentities = pgTable(
  "pixel_identities",
  {
    ...tenantColumns(),
    anonymousId: text("anonymous_id").notNull(),
    orderExternalId: text("order_external_id"),
    checkoutToken: text("checkout_token"),
    emailSha256: text("email_sha256"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pixel_identities_anon_idx").on(t.tenantId, t.anonymousId), index("pixel_identities_order_idx").on(t.tenantId, t.orderExternalId), index("pixel_identities_email_idx").on(t.tenantId, t.emailSha256), tenantIsolation("pixel_identities")],
).enableRLS();

/** Server-side conversions per platform: on/off, destination ids, consent rule. Credentials stay on the integration row. */
export const conversionSettings = pgTable(
  "conversion_settings",
  {
    ...tenantColumns(),
    /** meta | google */
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Meta: dataset (pixel) id. Google: conversion action id. */
    destinationId: text("destination_id"),
    testEventCode: text("test_event_code"),
    /** Send only orders of customers who accept marketing. */
    requireConsent: boolean("require_consent").notNull().default(true),
    /** Orders older than this are not sent (Meta accepts up to 7 days). */
    lookbackDays: integer("lookback_days").notNull().default(7),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversion_settings_uq").on(t.tenantId, t.provider), tenantIsolation("conversion_settings")],
).enableRLS();

/** Delivery log and retry queue: one row per order and platform. Payload holds hashed identifiers only. */
export const conversionEvents = pgTable(
  "conversion_events",
  {
    ...tenantColumns(),
    provider: text("provider").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    /** pending | sent | failed | skipped */
    status: text("status").notNull().default("pending"),
    /** no_consent | no_identifier | too_old when skipped */
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    payload: jsonb("payload"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversion_events_uq").on(t.tenantId, t.provider, t.eventId), index("conversion_events_due_idx").on(t.tenantId, t.status, t.nextAttemptAt), tenantIsolation("conversion_events")],
).enableRLS();

/** Post-purchase survey of a store: texts and options (packages/core/src/survey.ts) and the secret that signs links. */
export const surveySettings = pgTable(
  "survey_settings",
  {
    ...tenantColumns(),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").notNull(),
    /** HMAC secret for survey links; the store's email template signs the order id with it. */
    secret: text("secret").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("survey_settings_tenant_uq").on(t.tenantId), tenantIsolation("survey_settings")],
).enableRLS();

/** One answer per order: the first one counts. */
export const surveyResponses = pgTable(
  "survey_responses",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    answerKey: text("answer_key").notNull(),
    /** Channel key the answer maps to, frozen at answer time. */
    channel: text("channel").notNull(),
    otherText: text("other_text"),
    locale: text("locale"),
    /** email_link | thank_you | staff | seed */
    source: text("source").notNull().default("email_link"),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("survey_responses_order_uq").on(t.tenantId, t.orderId), index("survey_responses_time_idx").on(t.tenantId, t.respondedAt), tenantIsolation("survey_responses")],
).enableRLS();

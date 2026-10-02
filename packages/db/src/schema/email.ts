import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, hullwiseApp, tenantPredicate, updatedAt } from "./_common";
import { tenants } from "./tenants";

/**
 * Delivery log of the platform email sender (issue #51): one row per email Hullwise queues, tenant
 * emails and platform emails (tenant null: sign-in links, console test emails). The recipient is
 * stored as a keyed hash plus a masked form for the console; the body, the links and the props
 * are never stored here. The idempotency key (template, recipient, event) makes a second queue
 * attempt a no-op. Rows are inserted in the tenant transaction (RLS: a tenant reads and appends
 * only its own rows) and advanced by the platform sender through the admin connection.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    template: text("template").notNull(),
    /** Suppression category: a notification type, `supplier_po`, `digest`, `transactional`, `security`. */
    category: text("category").notNull(),
    /** security | transactional | notification */
    kind: text("kind").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    recipientMasked: text("recipient_masked").notNull(),
    locale: text("locale").notNull().default("en"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** queued | sending | sent | delivered | delivery_delayed | bounced | complained | failed | suppressed | expired */
    status: text("status").notNull().default("queued"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** EmailErrorCode of the last failure (rate_limit, invalid_recipient, …). */
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    /** Security emails: after this instant the link is dead and the email is never (re)sent. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_messages_idempotency_uq").on(t.idempotencyKey),
    index("email_messages_created_idx").on(t.createdAt),
    index("email_messages_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("email_messages_provider_id_idx").on(t.providerMessageId),
    index("email_messages_recipient_idx").on(t.recipientHash),
    pgPolicy("email_messages_tenant_select", { for: "select", to: hullwiseApp, using: tenantPredicate }),
    pgPolicy("email_messages_tenant_insert", { for: "insert", to: hullwiseApp, withCheck: tenantPredicate }),
  ],
).enableRLS();

/**
 * Delivery events posted by the provider (delivered, bounced, complained), stored as soon as the
 * signature checks out and processed in the background. Unique on (provider, event id): a
 * redelivered webhook is a no-op. Recipients are kept as hashes only.
 */
export const emailEvents = pgTable(
  "email_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    providerMessageId: text("provider_message_id"),
    recipientHashes: jsonb("recipient_hashes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** hard | soft (bounces only) */
    bounce: text("bounce"),
    tags: jsonb("tags").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** pending | processed | failed | ignored */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("email_events_dedup_uq").on(t.provider, t.eventId), index("email_events_status_idx").on(t.status, t.receivedAt)],
);

/**
 * Platform-wide suppression of addresses the provider reported: a hard bounce blocks every
 * email to the address, a complaint every email except security ones (sign-in, email change).
 * Per-tenant opt-outs (unsubscribes, manual entries) stay in `email_suppressions`.
 */
export const emailAddressSuppressions = pgTable(
  "email_address_suppressions",
  {
    id: id(),
    emailHash: text("email_hash").notNull(),
    emailMasked: text("email_masked").notNull(),
    /** bounce | complaint */
    reason: text("reason").notNull(),
    /** provider | admin */
    source: text("source").notNull().default("provider"),
    providerMessageId: text("provider_message_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_address_suppressions_uq").on(t.emailHash, t.reason)],
);

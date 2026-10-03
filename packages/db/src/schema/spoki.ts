import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { customers } from "./customers";
import { orders } from "./orders";
import { retentionCampaigns } from "./marketing";

/**
 * Tables of `addon.whatsapp_spoki` (issue #9). Only `@hullwise/addon-spoki` reads and writes them;
 * they hold rows only for tenants with the add-on. Inbound webhooks reuse `webhook_events`
 * (source `spoki`) for idempotency and retries.
 */
export const spokiSettings = pgTable(
  "spoki_settings",
  {
    ...tenantColumns(),
    /** Parsed by the add-on's zod schema: sender, template language, template per event, notifications, opt-out keywords. */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /** Approved and pending templates last read from the account ("Resync"). */
    templates: jsonb("templates").notNull().default(sql`'[]'::jsonb`),
    templatesSyncedAt: timestamp("templates_synced_at", { withTimezone: true }),
    /** Order notifications: status changes up to this instant have been looked at (set at activation, so history is never messaged). */
    notifiedUntil: timestamp("notified_until", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("spoki_settings_tenant_uq").on(t.tenantId), tenantIsolation("spoki_settings")],
).enableRLS();

/**
 * Message log: every WhatsApp message sent through Spoki and every customer message received,
 * with the delivery status moving forward only (sent → delivered → read → replied; failed).
 * Unique on the provider id (webhook upserts) and on the sender's idempotency key (no double send).
 */
export const spokiMessages = pgTable(
  "spoki_messages",
  {
    ...tenantColumns(),
    /** outbound | inbound */
    direction: text("direction").notNull(),
    /** cod | order_confirmed | order_shipped | order_delivered | campaign | test | manual (a team reply) | reply | external */
    purpose: text("purpose").notNull(),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key"),
    /** E.164 */
    phone: text("phone").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => retentionCampaigns.id, { onDelete: "set null" }),
    templateId: text("template_id"),
    templateName: text("template_name"),
    body: text("body"),
    /** queued | sent | failed | delivered | read | replied (outbound) · received (inbound) */
    status: text("status").notNull(),
    statusAt: timestamp("status_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Inbound: the provider id of the message it answers (quick-reply button or quoted reply). */
    replyToMessageId: text("reply_to_message_id"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spoki_messages_provider_uq").on(t.tenantId, t.providerMessageId).where(sql`${t.providerMessageId} is not null`),
    uniqueIndex("spoki_messages_key_uq").on(t.tenantId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    index("spoki_messages_order_idx").on(t.tenantId, t.orderId, t.occurredAt),
    index("spoki_messages_customer_idx").on(t.tenantId, t.customerId, t.occurredAt),
    index("spoki_messages_phone_idx").on(t.tenantId, t.phone, t.occurredAt),
    tenantIsolation("spoki_messages"),
  ],
).enableRLS();

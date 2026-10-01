import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Per user, per type: channel overrides. Null = the type's default (packages/config NOTIFICATION_TYPES). */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    inApp: boolean("in_app"),
    email: boolean("email"),
    slack: boolean("slack"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_preferences_uq").on(t.tenantId, t.userId, t.type), tenantIsolation("notification_preferences")],
).enableRLS();

/**
 * Addresses that must not receive email from this tenant: bounces and complaints block every
 * category, an unsubscribe blocks its category (`all` = every optional email). Transactional mail
 * the person asked for (magic link, invite) ignores unsubscribes but not bounces.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    ...tenantColumns(),
    email: text("email").notNull(),
    /** bounce | complaint | unsubscribe | manual */
    reason: text("reason").notNull(),
    category: text("category").notNull().default("all"),
    source: text("source").notNull().default("app"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_suppressions_uq").on(t.tenantId, t.email, t.category), tenantIsolation("email_suppressions")],
).enableRLS();

/** Internal notes with @mentions on records other than orders (purchase orders, returns). Orders keep `order_notes`. */
export const recordNotes = pgTable(
  "record_notes",
  {
    ...tenantColumns(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    mentions: uuid("mentions").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [index("record_notes_entity_idx").on(t.tenantId, t.entityType, t.entityId, t.createdAt), tenantIsolation("record_notes")],
).enableRLS();

/** One row per person mentioned in a note on any record: the "My mentions" inbox. */
export const mentions = pgTable(
  "mentions",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** order | purchase_order | return */
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    entityLabel: text("entity_label").notNull(),
    noteId: uuid("note_id"),
    excerpt: text("excerpt").notNull(),
    link: text("link").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mentions_user_idx").on(t.tenantId, t.userId, t.readAt, t.createdAt), tenantIsolation("mentions")],
).enableRLS();

/** Tenant rules that open staff tasks on record events and close them when the record moves on (core `taskRuleSchema`). */
export const taskRules = pgTable(
  "task_rules",
  {
    ...tenantColumns(),
    /** Set on the default rules so they are created once and can be restored. */
    key: text("key"),
    entityType: text("entity_type").notNull(),
    statuses: jsonb("statuses").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    minHoursInStatus: integer("min_hours_in_status").notNull().default(0),
    overdueAfterHours: integer("overdue_after_hours"),
    title: text("title").notNull(),
    description: text("description"),
    dueInHours: integer("due_in_hours").notNull().default(24),
    /** role | record_owner | user | none */
    assigneeMode: text("assignee_mode").notNull().default("role"),
    assigneeRole: text("assignee_role"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("task_rules_key_uq").on(t.tenantId, t.key), index("task_rules_entity_idx").on(t.tenantId, t.entityType), tenantIsolation("task_rules")],
).enableRLS();

/** Staff task, optionally linked to a record (order, return, purchase order, product). */
export const tasks = pgTable(
  "tasks",
  {
    ...tenantColumns(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    entityLabel: text("entity_label"),
    title: text("title").notNull(),
    description: text("description"),
    /** open | in_progress | done | cancelled */
    status: text("status").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    ruleId: uuid("rule_id").references(() => taskRules.id, { onDelete: "set null" }),
    /** Record episode the rule fired on (core `TaskRecordState.episode`). */
    episode: text("episode"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    /** done | cancelled | auto (closed by its rule) */
    closedReason: text("closed_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_assignee_idx").on(t.tenantId, t.assigneeId, t.status, t.dueAt),
    index("tasks_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("tasks_rule_idx").on(t.tenantId, t.ruleId, t.entityId),
    tenantIsolation("tasks"),
  ],
).enableRLS();

/** A tenant's request to the platform owner. Answered from `/admin/support` through the admin connection. */
export const supportTickets = pgTable(
  "support_tickets",
  {
    ...tenantColumns(),
    number: integer("number").notNull(),
    subject: text("subject").notNull(),
    /** question | problem | billing | feature */
    category: text("category").notNull().default("question"),
    /** open (waiting for the platform) | answered (waiting for the tenant) | closed */
    status: text("status").notNull().default("open"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("support_tickets_number_uq").on(t.tenantId, t.number), index("support_tickets_status_idx").on(t.status, t.lastMessageAt), tenantIsolation("support_tickets")],
).enableRLS();

/** Messages of a ticket; one optional small attachment per message, stored in the database (size-limited). */
export const supportMessages = pgTable(
  "support_messages",
  {
    ...tenantColumns(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** tenant | platform */
    side: text("side").notNull(),
    body: text("body").notNull(),
    attachmentName: text("attachment_name"),
    attachmentType: text("attachment_type"),
    attachmentSize: integer("attachment_size"),
    attachmentData: bytea("attachment_data"),
    createdAt: createdAt(),
  },
  (t) => [index("support_messages_ticket_idx").on(t.tenantId, t.ticketId, t.createdAt), tenantIsolation("support_messages")],
).enableRLS();

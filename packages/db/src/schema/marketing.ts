import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { products } from "./catalog";
import { customers } from "./customers";
import { users } from "./auth";

export const campaigns = pgTable(
  "campaigns",
  {
    ...tenantColumns(),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    accountExternalId: text("account_external_id"),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    objective: text("objective"),
    dailyBudgetMinor: integer("daily_budget_minor"),
    currency: text("currency"),
    platformCreatedAt: timestamp("platform_created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("campaigns_tenant_platform_external_uq").on(t.tenantId, t.platform, t.externalId), index("campaigns_tenant_status_idx").on(t.tenantId, t.status), tenantIsolation("campaigns")],
).enableRLS();

export const adMetricsDaily = pgTable(
  "ad_metrics_daily",
  {
    ...tenantColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    spendMinor: integer("spend_minor").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    viewContent: integer("view_content").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    purchaseValueMinor: integer("purchase_value_minor").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ad_metrics_daily_campaign_date_uq").on(t.campaignId, t.date), index("ad_metrics_daily_tenant_date_idx").on(t.tenantId, t.date), tenantIsolation("ad_metrics_daily")],
).enableRLS();

export const campaignProductLinks = pgTable(
  "campaign_product_links",
  {
    ...tenantColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** manual | suggested | auto */
    source: text("source").notNull().default("manual"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("campaign_product_links_uq").on(t.campaignId, t.productId), tenantIsolation("campaign_product_links")],
).enableRLS();

export const segments = pgTable(
  "segments",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    description: text("description"),
    rules: jsonb("rules").notNull().default(sql`'{"match":"all","conditions":[]}'::jsonb`),
    holdoutPercentage: integer("holdout_percentage").notNull().default(0),
    holdoutSalt: text("holdout_salt").notNull().default("holdout"),
    lastCount: integer("last_count"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("segments_tenant_idx").on(t.tenantId, t.name), tenantIsolation("segments")],
).enableRLS();

/** Stable assignment of a customer to a segment and to its treated/holdout group. */
export const segmentMemberships = pgTable(
  "segment_memberships",
  {
    ...tenantColumns(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** treated | holdout */
    groupName: text("group_name").notNull().default("treated"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("segment_memberships_uq").on(t.segmentId, t.customerId), tenantIsolation("segment_memberships")],
).enableRLS();

export const notifications = pgTable(
  "notifications",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.tenantId, t.userId, t.readAt, t.createdAt), tenantIsolation("notifications")],
).enableRLS();

import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    /** Re-evaluated within minutes when customers' orders change, and fully every night. */
    liveUpdates: boolean("live_updates").notNull().default(false),
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
    /** False when the user switched the in-app channel off for this type: the row only records the other deliveries. */
    inApp: boolean("in_app").notNull().default(true),
    /** Outcome per outbound channel: { email: "sent" | "mock" | "suppressed" | "error", slack: … }. */
    delivered: jsonb("delivered").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.tenantId, t.userId, t.readAt, t.createdAt), tenantIsolation("notifications")],
).enableRLS();

/**
 * Visits with a known source before a purchase: the order's own landing data, earlier visits
 * of the same customer, and (once the Web Pixel extension is installed) sessions collected by
 * the pixel. One table serves the attribution engine and the pixel store.
 */
export const touchpoints = pgTable(
  "touchpoints",
  {
    ...tenantColumns(),
    orderId: uuid("order_id"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** Pixel client id (first-party cookie) for anonymous visits stitched later. */
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    channel: text("channel").notNull().default("unknown"),
    source: text("source"),
    medium: text("medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    campaignId: uuid("campaign_id"),
    creativeId: uuid("creative_id"),
    clickId: text("click_id"),
    /** True for a paid ad click a platform would claim. */
    paid: boolean("paid").notNull().default(false),
    landingUrl: text("landing_url"),
    /** order_landing | pixel | survey | seed */
    origin: text("origin").notNull().default("order_landing"),
    createdAt: createdAt(),
  },
  (t) => [index("touchpoints_tenant_order_idx").on(t.tenantId, t.orderId), index("touchpoints_tenant_customer_idx").on(t.tenantId, t.customerId, t.occurredAt), index("touchpoints_tenant_time_idx").on(t.tenantId, t.occurredAt), tenantIsolation("touchpoints")],
).enableRLS();

/** One ad / creative per row (Meta ad, Google ad), with the naming-convention tags used for grouping. */
export const adCreatives = pgTable(
  "ad_creatives",
  {
    ...tenantColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    adsetExternalId: text("adset_external_id"),
    adsetName: text("adset_name"),
    name: text("name").notNull(),
    /** image | video | carousel | collection | text | other */
    format: text("format").notNull().default("other"),
    hook: text("hook"),
    angle: text("angle"),
    headline: text("headline"),
    body: text("body"),
    thumbnailUrl: text("thumbnail_url"),
    status: text("status").notNull().default("active"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ad_creatives_uq").on(t.tenantId, t.platform, t.externalId), index("ad_creatives_campaign_idx").on(t.tenantId, t.campaignId), tenantIsolation("ad_creatives")],
).enableRLS();

export const adCreativeMetricsDaily = pgTable(
  "ad_creative_metrics_daily",
  {
    ...tenantColumns(),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => adCreatives.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    spendMinor: integer("spend_minor").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    reach: integer("reach").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    purchaseValueMinor: integer("purchase_value_minor").notNull().default(0),
    videoViews3s: integer("video_views_3s").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ad_creative_metrics_daily_uq").on(t.creativeId, t.date), index("ad_creative_metrics_tenant_date_idx").on(t.tenantId, t.date), tenantIsolation("ad_creative_metrics_daily")],
).enableRLS();

/** Alert rules on a metric (threshold or anomaly), delivered in-app and optionally by email or Slack. */
export const alertRules = pgTable(
  "alert_rules",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    metric: text("metric").notNull(),
    /** tenant | campaign */
    scope: text("scope").notNull().default("tenant"),
    scopeId: uuid("scope_id"),
    condition: jsonb("condition").notNull(),
    /** ["in_app","email","slack"] */
    channels: jsonb("channels").notNull().default(sql`'["in_app"]'::jsonb`),
    /** user ids for in-app/email; Slack goes to the tenant's webhook */
    recipients: jsonb("recipients").notNull().default(sql`'[]'::jsonb`),
    cooldownHours: integer("cooldown_hours").notNull().default(24),
    isActive: boolean("is_active").notNull().default(true),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("alert_rules_tenant_idx").on(t.tenantId, t.isActive), tenantIsolation("alert_rules")],
).enableRLS();

export const alertEvents = pgTable(
  "alert_events",
  {
    ...tenantColumns(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    value: text("value"),
    baseline: text("baseline"),
    score: text("score"),
    reason: text("reason").notNull(),
    /** delivery outcome per channel */
    delivered: jsonb("delivered").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("alert_events_tenant_time_idx").on(t.tenantId, t.firedAt), tenantIsolation("alert_events")],
).enableRLS();

/** Tenant-defined metrics: a formula over base metrics (see @keel/core formula). */
export const customMetrics = pgTable(
  "custom_metrics",
  {
    ...tenantColumns(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    formula: text("formula").notNull(),
    /** money | ratio | percent | number */
    format: text("format").notNull().default("number"),
    description: text("description"),
    /** Order filters the bases are computed over (channel, country, payment method, product, campaign, platform, new/returning): `MetricFilters` in @keel/config. */
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    /** Drives the colour of the trend. */
    higherIsBetter: boolean("higher_is_better").notNull().default(true),
    /** Optional label per locale (`{ "it": "…" }`); `label` is shown otherwise. */
    translations: jsonb("translations").notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("custom_metrics_uq").on(t.tenantId, t.key), tenantIsolation("custom_metrics")],
).enableRLS();

/** Monthly targets per metric (base key or `custom:<key>`); a month without its own row carries the latest earlier one. */
export const metricTargets = pgTable(
  "metric_targets",
  {
    ...tenantColumns(),
    metric: text("metric").notNull(),
    /** `YYYY-MM` in the tenant time zone. */
    month: text("month").notNull(),
    /** In the metric's unit: minor units for money, a fraction for percent. */
    target: doublePrecision("target").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("metric_targets_uq").on(t.tenantId, t.metric, t.month), tenantIsolation("metric_targets")],
).enableRLS();

/**
 * Dashboards (issue #43). `scope`: `tenant` (the home or an extra dashboard everyone, or the roles
 * listed, can open), `role` (a home variant for the roles listed), `personal` (one user's copy;
 * `user_id` set). `layout_version` 1 rows are the old per-user `[{ metric }]` lists; version 2 stores
 * widgets (`DashboardWidget` in @keel/config). `draft_widgets` holds unpublished edits.
 */
export const dashboards = pgTable(
  "dashboards",
  {
    ...tenantColumns(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("personal"),
    roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
    isHome: boolean("is_home").notNull().default(false),
    layoutVersion: integer("layout_version").notNull().default(1),
    name: text("name").notNull(),
    widgets: jsonb("widgets").notNull().default(sql`'[]'::jsonb`),
    draftWidgets: jsonb("draft_widgets"),
    /** `{ period }`: the dashboard period widgets follow unless they have their own. */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dashboards_user_idx").on(t.tenantId, t.userId), index("dashboards_scope_idx").on(t.tenantId, t.scope, t.isHome), tenantIsolation("dashboards")],
).enableRLS();

/**
 * Customer campaigns sent to a segment and measured against the segment's control group
 * (see packages/core/src/retention.ts). Drafts are editable; a sent campaign is immutable.
 */
export const retentionCampaigns = pgTable(
  "retention_campaigns",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    segmentId: uuid("segment_id").references(() => segments.id, { onDelete: "set null" }),
    /** email | sms | whatsapp | manual (sent outside Keel, measured here) */
    channel: text("channel").notNull(),
    message: text("message").notNull().default(""),
    discountCode: text("discount_code"),
    costPerMessageMinor: integer("cost_per_message_minor").notNull().default(0),
    attributionDays: integer("attribution_days").notNull().default(14),
    /** draft | sent */
    status: text("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    treatedCount: integer("treated_count").notNull().default(0),
    holdoutCount: integer("holdout_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("retention_campaigns_tenant_idx").on(t.tenantId, t.createdAt), tenantIsolation("retention_campaigns")],
).enableRLS();

/** One row per customer of a sent campaign: their group, what happened to the message, when. */
export const retentionExposures = pgTable(
  "retention_exposures",
  {
    ...tenantColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => retentionCampaigns.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** treated | holdout */
    groupName: text("group_name").notNull(),
    /** sent | failed | skipped (no address) | held_out */
    status: text("status").notNull(),
    messageId: text("message_id"),
    error: text("error"),
    exposedAt: timestamp("exposed_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("retention_exposures_uq").on(t.campaignId, t.customerId), index("retention_exposures_customer_idx").on(t.tenantId, t.customerId), tenantIsolation("retention_exposures")],
).enableRLS();

/** A segment pushed to an external audience (ad platform or email tool). Only the treated group is pushed. */
export const segmentDestinations = pgTable(
  "segment_destinations",
  {
    ...tenantColumns(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    /** meta_custom_audience | google_customer_match | email_tool */
    provider: text("provider").notNull(),
    audienceName: text("audience_name").notNull(),
    externalAudienceId: text("external_audience_id"),
    /** Sync after every live re-evaluation (otherwise only on demand). */
    autoSync: boolean("auto_sync").notNull().default(true),
    /** never | ok | error */
    status: text("status").notNull().default("never"),
    memberCount: integer("member_count").notNull().default(0),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastAdded: integer("last_added").notNull().default(0),
    lastRemoved: integer("last_removed").notNull().default(0),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("segment_destinations_segment_idx").on(t.tenantId, t.segmentId), tenantIsolation("segment_destinations")],
).enableRLS();

/** Who the destination currently holds, as far as Keel pushed it: the base for add/remove diffs. */
export const segmentDestinationMembers = pgTable(
  "segment_destination_members",
  {
    ...tenantColumns(),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => segmentDestinations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("segment_destination_members_uq").on(t.destinationId, t.customerId), tenantIsolation("segment_destination_members")],
).enableRLS();

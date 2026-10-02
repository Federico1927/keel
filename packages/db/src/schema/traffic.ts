import { date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

/**
 * Daily web traffic from a web analytics platform (GA4, #86): one row per day, property, default channel
 * group, source / medium / campaign and landing path (the landing page without its query string).
 * Strings are GA4's (`(not set)` when missing); `channel` is the Hullwise attribution channel of the
 * group (`channelOfGa4Group`). A sync replaces the days of its window, so GA4's late restatements land
 * without duplicates. `total_users` summed over rows is an upper bound (GA4 users are not additive).
 */
export const analyticsTrafficDaily = pgTable(
  "analytics_traffic_daily",
  {
    ...tenantColumns(),
    provider: text("provider").notNull().default("ga4"),
    propertyId: text("property_id").notNull(),
    date: date("date").notNull(),
    channelGroup: text("channel_group").notNull(),
    channel: text("channel").notNull().default("unknown"),
    source: text("source").notNull(),
    medium: text("medium").notNull(),
    campaignName: text("campaign_name").notNull(),
    landingPath: text("landing_path").notNull(),
    sessions: integer("sessions").notNull().default(0),
    totalUsers: integer("total_users").notNull().default(0),
    engagedSessions: integer("engaged_sessions").notNull().default(0),
    addToCarts: integer("add_to_carts").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("analytics_traffic_daily_uq").on(t.tenantId, t.provider, t.propertyId, t.date, t.channelGroup, t.source, t.medium, t.campaignName, t.landingPath),
    index("analytics_traffic_daily_date_idx").on(t.tenantId, t.provider, t.propertyId, t.date),
    index("analytics_traffic_daily_channel_idx").on(t.tenantId, t.channel, t.date),
    tenantIsolation("analytics_traffic_daily"),
  ],
).enableRLS();
